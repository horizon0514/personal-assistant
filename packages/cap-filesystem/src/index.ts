/**
 * @pa/cap-filesystem — FileSystem Capability(支撑域)
 *
 * 暴露一组 pi AgentTool。本版只做**只读**工具(list_dir / read_file),
 * 风险等级 ReadOnly,会被 Trust 守门人自动放行。
 * 破坏性工具(rename/move/delete/write)留待接入 Reversibility 后再开。
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Capability, RiskLevel } from "@pa/domain-core";

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
  description: "把文本内容写入文件(会创建或覆盖)。这是有副作用的操作,需经用户审批。",
  parameters: writeFileParams,
  execute: async (_id, { path, content }) => {
    await writeFile(path, content, "utf8");
    return textResult(`已写入 ${path}(${Buffer.byteLength(content)} 字节)`, {
      path,
      bytes: Buffer.byteLength(content)
    });
  }
};

/** 本能力暴露的工具集 */
export const filesystemTools: AgentTool<any>[] = [listDirTool, readFileTool, writeFileTool];

/** 工具名 → Capability 的映射(供 ctx-task 的 capabilityOf 使用)*/
export const filesystemToolNames: ReadonlySet<string> = new Set(filesystemTools.map((t) => t.name));

/** 工具名 → 风险等级(供 Trust 风险分级)。能力最懂自己操作的性质。 */
export const filesystemToolRisk: Readonly<Record<string, RiskLevel>> = {
  list_dir: "ReadOnly",
  read_file: "ReadOnly",
  write_file: "ReversibleMutating"
};

export { CAPABILITY as filesystemCapability };
