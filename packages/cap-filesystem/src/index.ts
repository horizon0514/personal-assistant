/**
 * @pa/cap-filesystem — FileSystem Capability(支撑域)
 *
 * 暴露一组 pi AgentTool。本版只做**只读**工具(list_dir / read_file),
 * 风险等级 ReadOnly,会被 Trust 守门人自动放行。
 * 破坏性工具(rename/move/delete/write)留待接入 Reversibility 后再开。
 */
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { Type, type Static } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Capability, RiskLevel } from "@pa/domain-core";

/** 软删除回收区(避免硬删,可恢复)*/
const TRASH_DIR = join(tmpdir(), "pa-trash");

const CAPABILITY: Capability = "filesystem";

/** 单文件读取上限,避免撑爆上下文 */
const MAX_READ_BYTES = 200_000;

function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

const listDirParams = Type.Object({
  path: Type.String({ description: "目录的绝对路径" })
});

const listDirTool: AgentTool<typeof listDirParams> = {
  name: "list_dir",
  label: "列出目录",
  description: "列出指定目录下的文件与子目录(只读)。",
  parameters: listDirParams,
  execute: async (_id, { path }) => {
    const entries = await readdir(path, { withFileTypes: true });
    const lines = entries.map((e) => `${e.isDirectory() ? "📁" : "📄"} ${e.name}`);
    const text = lines.length ? lines.join("\n") : "(空目录)";
    return textResult(text, { path, count: entries.length });
  }
};

const readFileParams = Type.Object({
  path: Type.String({ description: "文件的绝对路径" })
});

const readFileTool: AgentTool<typeof readFileParams> = {
  name: "read_file",
  label: "读取文件",
  description: "读取一个文本文件的内容(只读,超长会截断)。",
  parameters: readFileParams,
  execute: async (_id, { path }) => {
    const buf = await readFile(path);
    const truncated = buf.byteLength > MAX_READ_BYTES;
    const text = buf.subarray(0, MAX_READ_BYTES).toString("utf8");
    return textResult(truncated ? `${text}\n\n…(已截断,文件共 ${buf.byteLength} 字节)` : text, {
      path,
      bytes: buf.byteLength,
      truncated
    });
  }
};

const writeFileParams = Type.Object({
  path: Type.String({ description: "要写入的文件绝对路径" }),
  content: Type.String({ description: "写入的完整文本内容(会覆盖原文件)" })
});

const writeFileTool: AgentTool<typeof writeFileParams> = {
  name: "write_file",
  label: "写入文件",
  description: "把文本内容写入文件(会创建或覆盖,目标目录不存在时自动创建)。有副作用,需审批。",
  parameters: writeFileParams,
  execute: async (_id, { path, content }) => {
    // 捕获 before 状态用于回滚:存在则记旧内容,不存在则记"新建"
    let prevContent: string | undefined;
    let existed = true;
    try {
      prevContent = await readFile(path, "utf8");
    } catch {
      existed = false;
    }
    await mkdir(dirname(path), { recursive: true }); // 自动创建父目录
    await writeFile(path, content, "utf8");
    const reversal = existed
      ? { kind: "fs.restore", path, prevContent }
      : { kind: "fs.delete-created", path };
    return textResult(`已写入 ${path}(${Buffer.byteLength(content)} 字节)`, {
      path,
      bytes: Buffer.byteLength(content),
      reversal
    });
  }
};

// ── 批量改动(diff 预览整批审批)──────────────────────────────
const fileChangeOp = Type.Union([
  Type.Object({
    op: Type.Literal("move"),
    from: Type.String({ description: "源路径" }),
    to: Type.String({ description: "目标路径" })
  }),
  Type.Object({
    op: Type.Literal("delete"),
    path: Type.String({ description: "要删除的文件路径(实为移入回收区)" })
  })
]);

/** 一次批量文件改动中的单项操作 */
export type FileChangeOp = Static<typeof fileChangeOp>;

const planParams = Type.Object({
  operations: Type.Array(fileChangeOp, {
    description: "要批量执行的文件改动列表(移动/重命名 用 move,删除 用 delete)"
  })
});

/** 批量审批桥:把改动列表交给 UI 预览,等用户整批同意/拒绝 */
export type RequestBatchApproval = (req: {
  actionId: string;
  operations: FileChangeOp[];
}) => Promise<boolean>;

/** 应用单个操作,返回其回滚计划 */
async function applyOp(op: FileChangeOp): Promise<{ kind: string } & Record<string, unknown>> {
  if (op.op === "move") {
    await mkdir(dirname(op.to), { recursive: true }); // 自动创建目标目录
    await rename(op.from, op.to);
    return { kind: "fs.move-back", from: op.from, to: op.to };
  }
  await mkdir(TRASH_DIR, { recursive: true });
  const trashed = join(TRASH_DIR, `${Date.now()}-${basename(op.path)}`);
  await rename(op.path, trashed);
  return { kind: "fs.untrash", original: op.path, trashed };
}

/**
 * 批量文件改动工具:模型一次提交全部改动,工具内发起 diff 预览整批审批,
 * 批准后原子执行(任一失败则回滚已执行项),记一条批量回滚日志。
 */
export function createPlanFileChangesTool(requestBatchApproval: RequestBatchApproval): AgentTool<typeof planParams> {
  return {
    name: "plan_file_changes",
    label: "批量文件改动",
    description:
      "对多个文件做移动/重命名/删除时,用本工具一次性提交全部改动。" +
      "会向用户展示完整改动预览并整批审批,批准后统一执行、可一键撤销。" +
      "凡涉及移动或删除文件(无论一个还是多个),都用本工具,不要逐个操作。",
    parameters: planParams,
    execute: async (toolCallId, { operations }) => {
      const approved = await requestBatchApproval({ actionId: toolCallId, operations });
      if (!approved) {
        return textResult("用户拒绝了这批改动,未执行任何操作。", { rejected: true });
      }
      const reversals: ({ kind: string } & Record<string, unknown>)[] = [];
      try {
        for (const op of operations) reversals.push(await applyOp(op));
      } catch (err) {
        // 失败回滚已执行项(逆序)
        for (const r of [...reversals].reverse()) {
          try {
            await filesystemReverser(r);
          } catch {
            /* 尽力回滚 */
          }
        }
        throw new Error(`批量改动执行失败,已回滚已执行项:${String(err)}`);
      }
      return textResult(`已执行 ${operations.length} 项改动`, {
        count: operations.length,
        reversal: { kind: "fs.batch", reversals }
      });
    }
  };
}

/** 静态工具集(只读 + 单文件写)。批量改动工具经 createPlanFileChangesTool 注入。 */
export const filesystemTools: AgentTool<any>[] = [listDirTool, readFileTool, writeFileTool];

/** 回滚器:按 reversal.kind 执行对应的逆操作 */
export async function filesystemReverser(plan: { kind: string } & Record<string, unknown>): Promise<void> {
  switch (plan.kind) {
    case "fs.restore":
      await writeFile(plan.path as string, plan.prevContent as string, "utf8");
      return;
    case "fs.delete-created":
      await unlink(plan.path as string);
      return;
    case "fs.untrash":
      await rename(plan.trashed as string, plan.original as string);
      return;
    case "fs.move-back":
      await rename(plan.to as string, plan.from as string);
      return;
    case "fs.batch": {
      const reversals = (plan.reversals as ({ kind: string } & Record<string, unknown>)[]) ?? [];
      for (const r of [...reversals].reverse()) await filesystemReverser(r);
      return;
    }
    default:
      throw new Error(`未知的回滚类型:${plan.kind}`);
  }
}

/** 工具名 → Capability 的映射(含批量工具,供 ctx-task 的 capabilityOf 使用)*/
export const filesystemToolNames: ReadonlySet<string> = new Set([
  ...filesystemTools.map((t) => t.name),
  "plan_file_changes"
]);

/** 工具名 → 风险等级(供 Trust 风险分级)。能力最懂自己操作的性质。 */
export const filesystemToolRisk: Readonly<Record<string, RiskLevel>> = {
  list_dir: "ReadOnly",
  read_file: "ReadOnly",
  write_file: "ReversibleMutating"
  // plan_file_changes 不在此:它在执行内部自行做批量预览审批(见 main 的 riskOf 特例)
};

export { CAPABILITY as filesystemCapability };
