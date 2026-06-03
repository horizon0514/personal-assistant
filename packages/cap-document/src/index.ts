/**
 * @pa/cap-document — Document Extraction Capability(支撑域)
 *
 * 把本地文档(PDF / 纯文本类)抽成可进上下文的文本,服务"调研→产出"主线。
 * 只读、风险 ReadOnly(Trust 守门人自动放行)。
 *
 * PDF 数字版走 liteparse(Rust/PDFium,napi 预编译):快、版面干净、中文正常。
 *
 * 扫描件/图片型 PDF 的 OCR 走 **PaddleOCR(PP-OCRv5,onnxruntime-node)**——基础能力,无开关:
 * - 中文 + 表格识别远强于 Tesseract(实测中文资助表的企业名/金额准确读出,conf~0.99)。纯本地、不出机、无 LLM、无 Python。
 * - 流水线:liteparse 把页面渲染成图 → PaddleOCR 读图(detection + recognition)。
 * - 模型(det+rec+dict ~21MB)**按需下载、不随 app 包**:首个扫描件触发时下到缓存目录(组合根注入 ocrModelDir),之后复用。
 *
 * docx/xlsx 需另装 LibreOffice,不在开箱即用范围,暂不支持。
 */
import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Capability, RiskLevel } from "@pa/domain-core";
import { LiteParse } from "@llamaindex/liteparse";
import { PaddleOcrService } from "ppu-paddle-ocr";

const CAPABILITY: Capability = "document";

/** 提取文本上限,避免撑爆上下文(与 cap-filesystem 对齐)。 */
const MAX_TEXT_CHARS = 200_000;

/** 纯文本类扩展名:直接按 utf8 读。 */
const PLAINTEXT_EXT = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log", ".xml", ".yaml", ".yml"]);

// ── PaddleOCR 模型(按需下载,不随包)─────────────────────────────
const MODEL_LFS = "https://media.githubusercontent.com/media/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main";
const MODEL_RAW = "https://raw.githubusercontent.com/PT-Perkasa-Pilar-Utama/ppu-paddle-ocr-models/main";
/** PP-OCRv5 mobile:det 语言无关;rec + dict 决定字符集(ppocrv5_dict 覆盖中文+英文+数字+多语言)。 */
const PADDLE_MODELS = [
  { file: "det.onnx", url: `${MODEL_LFS}/detection/PP-OCRv5_mobile_det_infer.onnx` },
  { file: "rec.onnx", url: `${MODEL_LFS}/recognition/PP-OCRv5_mobile_rec_infer.onnx` },
  { file: "dict.txt", url: `${MODEL_RAW}/recognition/ppocrv5_dict.txt` }
] as const;
/** 模型变体缓存子目录。换模型(版本/大小)就改这个名 → 自动走新目录重下,旧缓存不被误用。 */
const MODEL_VARIANT = "ppocrv5-mobile";
/** OCR 逐页耗时,封顶防超长扫描件卡死;超出部分只 OCR 前 N 页并标注。 */
const MAX_OCR_PAGES = 20;
/** 渲染给 OCR 的 DPI(200 实测对中文足够清晰)。 */
const OCR_RENDER_DPI = 200;

export interface DocumentToolsOptions {
  /** PaddleOCR 模型缓存目录(组合根注入,如 <userData>/paddleocr)。OCR 是基础能力,故必选。 */
  readonly ocrModelDir: string;
  /**
   * 执行中进度上报(actionId = execute 的第一个参数 = 渲染层 step 行 id)。
   * OCR(尤其首次下模型 / 逐页识别)耗时,经此把"正在识别…"亮给用户,避免看着像静默跳过。
   */
  readonly onProgress?: (actionId: string, note: string) => void;
}

function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_TEXT_CHARS) + "\n…(内容过长已截断)", truncated: true };
}

function toArrayBuffer(b: Buffer): ArrayBuffer {
  // Node Buffer 实际由 ArrayBuffer 支撑(非 SharedArrayBuffer),切片后 cast 安全。
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

/** 懒单例:首用时构造,之后复用(LiteParse 构造会加载原生 .node,懒建避免无谓加载 + 隔离失败)。 */
function lazy<T>(make: () => T): () => T {
  let v: T | null = null;
  return () => (v ??= make());
}
// 数字版抽取(ocrEnabled:false,快);页面渲染成图(喂 PaddleOCR 做 OCR)。
const getDigitalParser = lazy(() => new LiteParse({ outputFormat: "text", ocrEnabled: false }));
const getRenderParser = lazy(() => new LiteParse({ dpi: OCR_RENDER_DPI }));

// ── PaddleOCR 模型按需下载 + 服务单例 ─────────────────────────────
// 并发去重(同一文件不重复下),写临时文件再 rename(防半成品被当成可用)。
const inflight = new Map<string, Promise<boolean>>();
function ensureFile(dir: string, file: string, url: string): Promise<boolean> {
  const dest = join(dir, file);
  if (existsSync(dest)) return Promise.resolve(true);
  let p = inflight.get(dest);
  if (!p) {
    p = (async (): Promise<boolean> => {
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      mkdirSync(dir, { recursive: true });
      const tmp = `${dest}.tmp`;
      writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      renameSync(tmp, dest);
      return true;
    })()
      .catch((err: unknown) => {
        console.warn(`[cap-document] OCR 模型下载失败 ${file}: ${String(err)}`);
        return false;
      })
      .finally(() => inflight.delete(dest));
    inflight.set(dest, p);
  }
  return p;
}
async function ensurePaddleModels(dir: string): Promise<boolean> {
  const oks = await Promise.all(PADDLE_MODELS.map((m) => ensureFile(dir, m.file, m.url)));
  return oks.every(Boolean);
}

let paddlePromise: Promise<PaddleOcrService> | null = null;
/** 懒建 PaddleOCR 服务(加载原生 onnxruntime + 模型);初始化失败不缓存,下次可重试。 */
function getPaddle(dir: string): Promise<PaddleOcrService> {
  if (!paddlePromise) {
    paddlePromise = (async () => {
      const svc = new PaddleOcrService({
        model: {
          detection: join(dir, "det.onnx"),
          recognition: join(dir, "rec.onnx"),
          charactersDictionary: join(dir, "dict.txt")
        }
      });
      await svc.initialize();
      return svc;
    })().catch((err: unknown) => {
      paddlePromise = null;
      throw err;
    });
  }
  return paddlePromise;
}

/** 扫描件 OCR:逐页渲染成图 → PaddleOCR 读。返回拼好的文本(失败/无模型 → 空串)。 */
async function ocrScannedPdf(
  buf: Buffer,
  pageCount: number,
  modelRoot: string,
  onNote: (note: string) => void
): Promise<string> {
  const dir = join(modelRoot, MODEL_VARIANT); // 变体子目录,换模型自动重下
  const needDownload = PADDLE_MODELS.some((m) => !existsSync(join(dir, m.file)));
  onNote(needDownload ? "扫描件:首次需下载 OCR 模型(约 21MB),稍候…" : "扫描件:正在 OCR 识别…");
  if (!(await ensurePaddleModels(dir))) return "";

  const svc = await getPaddle(dir);
  const total = Math.min(pageCount || 1, MAX_OCR_PAGES);
  const nums = Array.from({ length: total }, (_, i) => i + 1);
  onNote(`扫描件:正在 OCR 识别(共 ${total} 页)…`);
  const shots = await getRenderParser().screenshot(buf, nums);

  const parts: string[] = [];
  for (const shot of shots) {
    const r = await svc.recognize(toArrayBuffer(shot.imageBuffer));
    const t = r.text.trim();
    if (t) parts.push(total > 1 ? `【第 ${shot.pageNum} 页】\n${t}` : t);
  }
  if (pageCount > MAX_OCR_PAGES) parts.push(`(文档共 ${pageCount} 页,仅 OCR 了前 ${MAX_OCR_PAGES} 页)`);
  return parts.join("\n\n");
}

const extractParams = Type.Object({
  path: Type.String({ description: "文档的绝对路径。支持 PDF(含扫描件,自动 OCR)及纯文本类(.txt/.md/.csv/.json 等)。" })
});

function createExtractDocumentTool(opts: DocumentToolsOptions): AgentTool<typeof extractParams> {
  return {
    name: "extract_document",
    label: "提取文档",
    description:
      "把本地文档抽成纯文本以便阅读/总结/再加工。支持 PDF(含扫描件,自动 OCR)与纯文本类文件。" +
      "需要理解一份文档内容时用它,而不是猜测。",
    parameters: extractParams,
    execute: async (id, { path }) => {
      const ext = extname(path).toLowerCase();

      if (ext === ".pdf") {
        const buf = await readFile(path);
        // 第一遍:数字抽取(快,不 OCR)。有嵌入文本就直接返回,绝大多数 PDF 走这条。
        let parsed: { text: string; pages: { length: number } };
        try {
          parsed = await getDigitalParser().parse(buf);
        } catch (err) {
          return textResult(`PDF 解析失败:${err instanceof Error ? err.message : String(err)}`, {
            path,
            kind: "pdf",
            error: true
          });
        }
        const digital = clip(parsed.text.trim());
        if (digital.text) {
          return textResult(digital.text, {
            path,
            kind: "pdf",
            pages: parsed.pages.length,
            chars: digital.text.length,
            truncated: digital.truncated,
            ocr: false
          });
        }

        // 抽不到文本 = 扫描件/图片型 → PaddleOCR(按需下模型 + 逐页读图)。
        try {
          const text = await ocrScannedPdf(buf, parsed.pages.length, opts.ocrModelDir, (note) =>
            opts.onProgress?.(id, note)
          );
          const ocr = clip(text);
          if (ocr.text) {
            return textResult(ocr.text, {
              path,
              kind: "pdf",
              pages: parsed.pages.length,
              chars: ocr.text.length,
              truncated: ocr.truncated,
              ocr: true
            });
          }
        } catch (err) {
          console.warn(`[cap-document] OCR 失败: ${String(err)}`);
        }
        return textResult("(扫描件/图片型 PDF,OCR 未能识别出文本;若刚联网下载模型失败可稍后重试)", {
          path,
          kind: "pdf",
          pages: parsed.pages.length,
          chars: 0
        });
      }

      if (PLAINTEXT_EXT.has(ext)) {
        const raw = await readFile(path, "utf8");
        const { text, truncated } = clip(raw);
        return textResult(text, { path, kind: "text", chars: text.length, truncated });
      }

      return textResult(`不支持的文档格式:${ext || "(无扩展名)"}。当前支持 PDF(含扫描件)与纯文本类。`, {
        path,
        kind: "unsupported"
      });
    }
  };
}
/**
 * 创建文档工具集(extract_document)。ocrModelDir = PaddleOCR 模型缓存目录(组合根注入)。
 */
export function createDocumentTools(opts: DocumentToolsOptions): AgentTool<any>[] {
  return [createExtractDocumentTool(opts)];
}

export const documentToolNames: ReadonlySet<string> = new Set(["extract_document"]);

export const documentToolRisk: Readonly<Record<string, RiskLevel>> = {
  extract_document: "ReadOnly"
};

export const documentGuidelines = `## 文档提取
- 理解某份文档(PDF/报告/合同/扫描件)用 extract_document 抽成文本再读,别猜。
- 扫描件/图片型 PDF 它会自动 OCR(PaddleOCR,中文与表格识别强;首次会联网下模型,稍慢)。识别不清处如实说明,别编造。
- **别自己用 shell 调 tesseract / pdftotext / pdftoppm / pytesseract 等去"重试 OCR"**:extract_document 内建的就是更强的方案,
  shell 兜底只会更慢更乱、还依赖用户机器装没装。读不准就如实说明。
- 大文档会被截断;只关心局部就先 extract 看全貌再按需定位。`;

export { CAPABILITY as documentCapability };
