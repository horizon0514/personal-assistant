/**
 * @pa/cap-document — Document Extraction Capability(支撑域)
 *
 * 把本地文档(PDF / 纯文本类)抽成可进上下文的文本,服务"调研→产出"主线。
 * 只读、不联网、不需 key,风险 ReadOnly(Trust 守门人自动放行)。
 *
 * PDF 走 liteparse(Rust/PDFium,napi 预编译):比旧 pdf-parse 更快、版面更干净、
 * 中文正常。OCR(扫描件)能力 liteparse 内置 Tesseract 但**不随包带 traineddata**
 * (实测缺 eng.traineddata 即失败),故先关掉 OCR——扫描件仍如实回"抽不出",零回归;
 * 要 OCR 见 README/follow-up:随包 eng/chi_sim.traineddata + 设 tessdataPath 再开 ocrEnabled。
 * docx/xlsx 需另装 LibreOffice,不在开箱即用范围,暂不支持。
 */
import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Capability, RiskLevel } from "@pa/domain-core";
import { LiteParse } from "@llamaindex/liteparse";

/**
 * 单例 LiteParse(构造时加载原生 .node;懒建,避免无 PDF 任务时白加载,也便于隔离加载失败)。
 * outputFormat:text → 版面保留的纯文本;ocrEnabled:false → 见文件头说明。
 */
let liteParser: LiteParse | null = null;
function getPdfParser(): LiteParse {
  if (!liteParser) liteParser = new LiteParse({ outputFormat: "text", ocrEnabled: false });
  return liteParser;
}

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
      let parsed: { text: string; pages: { length: number } };
      try {
        parsed = await getPdfParser().parse(buf);
      } catch (err) {
        // 原生加载/解析失败(不支持的平台、损坏文件等)→ 如实报错,不连累纯文本提取。
        return textResult(`PDF 解析失败:${err instanceof Error ? err.message : String(err)}`, {
          path,
          kind: "pdf",
          error: true
        });
      }
      const { text, truncated } = clip(parsed.text.trim());
      return textResult(text || "(未提取到文本,可能是扫描件/图片型 PDF;OCR 暂未启用)", {
        path,
        kind: "pdf",
        pages: parsed.pages.length,
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
