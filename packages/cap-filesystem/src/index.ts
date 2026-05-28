/**
 * @pa/cap-filesystem — FileSystem Capability(支撑域)
 *
 * 暴露一组 pi AgentTool。本版只做**只读**工具(list_dir / read_file),
 * 风险等级 ReadOnly,会被 Trust 守门人自动放行。
 * 破坏性工具(rename/move/delete/write)留待接入 Reversibility 后再开。
 */
import { mkdir, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join } from "node:path";
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

// ── agentic 搜索(grep / glob,只读)──────────────────────────
const WALK_MAX_FILES = 5000; // 扫描文件上限,防失控
const WALK_MAX_DEPTH = 10;
const GREP_MAX_RESULTS = 100;
const GREP_MAX_FILE_BYTES = 1_000_000; // 单文件超此大小跳过
const SKIP_DIRS = new Set(["node_modules", ".git", ".cache", "Library", ".Trash"]);

/** glob(仅 * 和 ?,匹配 basename)→ 大小写不敏感正则 */
function globToRegExp(glob: string): RegExp {
  const re = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${re}$`, "i");
}

/** 递归收集文件路径(带深度/数量上限,跳过常见噪声目录)*/
async function walkFiles(root: string): Promise<string[]> {
  const out: string[] = [];
  async function recurse(dir: string, depth: number): Promise<void> {
    if (depth > WALK_MAX_DEPTH || out.length >= WALK_MAX_FILES) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (out.length >= WALK_MAX_FILES) return;
      const full = join(dir, e.name);
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) await recurse(full, depth + 1);
      } else if (e.isFile()) {
        out.push(full);
      }
    }
  }
  await recurse(root, 0);
  return out;
}

const findFilesParams = Type.Object({
  dir: Type.String({ description: "要搜索的目录绝对路径" }),
  namePattern: Type.String({ description: "文件名 glob,如 *.pdf、报销*.xlsx、*。支持 * 和 ?" })
});

const findFilesTool: AgentTool<typeof findFilesParams> = {
  name: "find_files",
  label: "查找文件",
  description: "在目录(含子目录)下按文件名模式查找文件(只读)。用于'找出所有 xxx 文件'这类需求。",
  parameters: findFilesParams,
  execute: async (_id, { dir, namePattern }) => {
    const re = globToRegExp(namePattern);
    const all = await walkFiles(dir);
    const matched = all.filter((p) => re.test(basename(p)));
    const text = matched.length ? matched.join("\n") : "(未找到匹配文件)";
    return textResult(text, { dir, namePattern, count: matched.length, scanned: all.length });
  }
};

const grepFilesParams = Type.Object({
  dir: Type.String({ description: "要搜索的目录绝对路径" }),
  query: Type.String({ description: "要在文件内容中查找的文本(大小写不敏感子串)" }),
  namePattern: Type.Optional(Type.String({ description: "可选:仅在匹配此文件名 glob 的文件中搜索,如 *.txt" }))
});

const grepFilesTool: AgentTool<typeof grepFilesParams> = {
  name: "grep_files",
  label: "搜索内容",
  description: "在目录(含子目录)下按内容搜索文本,返回 文件:行号:匹配行(只读)。用于'哪些文件提到了 xxx'。",
  parameters: grepFilesParams,
  execute: async (_id, { dir, query, namePattern }) => {
    const nameRe = namePattern ? globToRegExp(namePattern) : undefined;
    const needle = query.toLowerCase();
    const files = (await walkFiles(dir)).filter((p) => !nameRe || nameRe.test(basename(p)));
    const hits: string[] = [];
    for (const file of files) {
      if (hits.length >= GREP_MAX_RESULTS) break;
      try {
        const st = await stat(file);
        if (st.size > GREP_MAX_FILE_BYTES) continue;
        const buf = await readFile(file);
        if (buf.includes(0)) continue; // 二进制启发式:含 NUL 跳过
        const lines = buf.toString("utf8").split("\n");
        for (let i = 0; i < lines.length; i++) {
          if (lines[i]!.toLowerCase().includes(needle)) {
            hits.push(`${file}:${i + 1}: ${lines[i]!.trim().slice(0, 200)}`);
            if (hits.length >= GREP_MAX_RESULTS) break;
          }
        }
      } catch {
        /* 跳过读不了的文件 */
      }
    }
    const text = hits.length ? hits.join("\n") : "(未找到匹配内容)";
    return textResult(text, { dir, query, count: hits.length });
  }
};

const writeFileParams = Type.Object({
  path: Type.String({ description: "要写入的文件绝对路径" }),
  content: Type.String({ description: "写入的完整文本内容" }),
  overwrite: Type.Optional(
    Type.Boolean({
      description:
        "目标已存在时是否覆盖原文件。默认 false:自动改用带版本号的新文件名(如「报告 (2).md」),不动原文件。只有用户明确要替换/更新原文件时才传 true。"
    })
  )
});

/** 在同目录里找一个未被占用的带版本号文件名:「stem (2).ext」「stem (3).ext」… */
function versionedPath(path: string): string {
  const dir = dirname(path);
  const ext = extname(path);
  const stem = basename(path, ext);
  for (let n = 2; ; n++) {
    const candidate = join(dir, `${stem} (${n})${ext}`);
    if (!existsSync(candidate)) return candidate;
  }
}

const writeFileTool: AgentTool<typeof writeFileParams> = {
  name: "write_file",
  label: "写入文件",
  description:
    "把文本内容写入文件。目标已存在且未传 overwrite 时,自动改用带版本号的新文件名(不覆盖原文件)并回报最终路径;需要原地替换/更新原文件时才传 overwrite:true。目标目录不存在会自动创建。有副作用,需审批。",
  parameters: writeFileParams,
  execute: async (_id, { path, content, overwrite }) => {
    // 捕获 before 状态用于回滚:存在则记旧内容,不存在则记"新建"
    let prevContent: string | undefined;
    let existed = true;
    try {
      prevContent = await readFile(path, "utf8");
    } catch {
      existed = false;
    }

    // 同名已存在且未要求覆盖:自动改名加版本号,避免粗暴覆盖(写的是全新文件)
    let target = path;
    let renamed = false;
    if (existed && !overwrite) {
      target = versionedPath(path);
      renamed = true;
      existed = false;
      prevContent = undefined;
    }

    await mkdir(dirname(target), { recursive: true }); // 自动创建父目录
    await writeFile(target, content, "utf8");
    const reversal = existed
      ? { kind: "fs.restore", path: target, prevContent }
      : { kind: "fs.delete-created", path: target };
    const note = renamed ? `(同名「${basename(path)}」已存在,已改名避免覆盖;要替换原文件请带 overwrite:true)` : "";
    return textResult(`已写入 ${target}(${Buffer.byteLength(content)} 字节)${note}`, {
      path: target,
      bytes: Buffer.byteLength(content),
      renamedFrom: renamed ? path : undefined,
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
export const filesystemTools: AgentTool<any>[] = [
  listDirTool,
  readFileTool,
  findFilesTool,
  grepFilesTool,
  writeFileTool
];

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
  find_files: "ReadOnly",
  grep_files: "ReadOnly",
  write_file: "ReversibleMutating"
  // plan_file_changes 不在此:它在执行内部自行做批量预览审批(见 main 的 riskOf 特例)
};

/** 注入系统提示的「能力使用指南」(跨工具编排,由组合根收集)*/
export const filesystemGuidelines = `## 文件操作
- 写入或移动文件时,缺失的目标目录会自动创建——你不需要、也无法单独创建目录,直接写/移到目标路径即可。

## 搜索(找东西时这样做)
- 把语义意图拆成多个字面查询:同义词、中英文、文件名/扩展名、可能目录。例如"报税相关"→ 试 发票、报销、tax、invoice、*.pdf。
- 一次性并行发起多个 find_files / grep_files(放在同一轮),快速铺开,而不是一个一个试。
- 拿到结果后迭代:命中就深入(read_file / 再 grep);没命中就换关键词、换目录、放宽模式重试——绝不搜一次就放弃或下结论。
- 组合使用:list_dir 摸清结构 → find_files 定位候选 → grep_files 看内容。搜索是只读、零代价的,宁可多搜几次也别凭猜测回答。`;

export { CAPABILITY as filesystemCapability };
