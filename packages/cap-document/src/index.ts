/**
 * @pa/cap-document — Document Extraction Capability(支撑域)
 *
 * 把本地文档(PDF / 纯文本类)抽成可进上下文的文本,服务"调研→产出"主线。
 * 只读、不联网、不需 key,风险 ReadOnly(Trust 守门人自动放行)。
 * 图片 OCR、docx 留待后续。
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Capability, RiskLevel } from "@pa/domain-core";
// pdf-parse 无随包类型;走子路径规避其 index.js 的调试代码(否则被引入时会去读测试 PDF)。
// @ts-expect-error 子路径无声明文件
import pdfParseUntyped from "pdf-parse/lib/pdf-parse.js";

const pdfParse = pdfParseUntyped as (data: Buffer | Uint8Array) => Promise<{ text: string; numpages: number }>;

const CAPABILITY: Capability = "document";

/** 提取文本上限,避免撑爆上下文(与 cap-filesystem 对齐)。 */
const MAX_TEXT_CHARS = 200_000;

/** 纯文本类扩展名:直接按 utf8 读。 */
const PLAINTEXT_EXT = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log", ".xml", ".yaml", ".yml"]);

function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_TEXT_CHARS) + "\n…(内容过长已截断)", truncated: true };
}

const extractParams = Type.Object({
  path: Type.String({ description: "文档的绝对路径。支持 PDF 及纯文本类(.txt/.md/.csv/.json 等)。" })
});

const extractDocumentTool: AgentTool<typeof extractParams> = {
  name: "extract_document",
  label: "提取文档",
  description:
    "把本地文档抽成纯文本以便阅读/总结/再加工。支持 PDF(逐页文本)与纯文本类文件。" +
    "需要理解一份文档内容时用它,而不是猜测。",
  parameters: extractParams,
  execute: async (_id, { path }) => {
    const ext = extname(path).toLowerCase();

    if (ext === ".pdf") {
      const buf = await readFile(path);
      const parsed = await pdfParse(buf);
      const { text, truncated } = clip(parsed.text.trim());
      return textResult(text || "(未提取到文本,可能是扫描件/图片型 PDF)", {
        path,
        kind: "pdf",
        pages: parsed.numpages,
        chars: text.length,
        truncated
      });
    }

    if (PLAINTEXT_EXT.has(ext)) {
      const raw = await readFile(path, "utf8");
      const { text, truncated } = clip(raw);
      return textResult(text, { path, kind: "text", chars: text.length, truncated });
    }

    return textResult(`不支持的文档格式:${ext || "(无扩展名)"}。当前支持 PDF 与纯文本类。`, {
      path,
      kind: "unsupported"
    });
  }
};

export const documentTools: AgentTool<any>[] = [extractDocumentTool];

export const documentToolNames: ReadonlySet<string> = new Set(documentTools.map((t) => t.name));

export const documentToolRisk: Readonly<Record<string, RiskLevel>> = {
  extract_document: "ReadOnly"
};

export const documentGuidelines = `## 文档提取
- 需要理解某份文档(PDF/报告/合同等)的内容时,用 extract_document 抽成文本再读。
- 提取的是纯文本:扫描件/图片型 PDF 可能抽不出内容,这种情况如实说明,不要编造。
- 大文档会被截断;若只关心局部,先 extract 看全貌,再按需结合其它工具定位。`;

export { CAPABILITY as documentCapability };
