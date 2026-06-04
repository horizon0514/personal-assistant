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
 * - OCR 原生运行时(onnxruntime + canvas + opencv ≈ 90–100MB)**也按需下载、不随 app 包**(打包后注入 ocrRuntime):
 *   首个扫描件触发时按平台下到 <userData>/ocr-runtime/<ver>,再从该目录动态加载——把 app 首装包瘦掉这一坨。
 *
 * docx/xlsx 需另装 LibreOffice,不在开箱即用范围,暂不支持。
 */
import { execFile } from "node:child_process";
import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { extname, join } from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Capability, RiskLevel } from "@pa/domain-core";
import { LiteParse, type ParseResult } from "@llamaindex/liteparse";
// PaddleOCR 栈(onnxruntime ~65MB + @napi-rs/canvas + opencv-js ≈ 90–100MB)不随 app 包:
// 打包时从 electron-builder 排除,首个扫描件触发时按平台下载到 <userData>/ocr-runtime/<ver> 再加载。
// 仅取类型(import type 运行时擦除,不引入运行时依赖);构造器经 ocrCtor() 动态 import 拿到。
import type { PaddleOcrService } from "ppu-paddle-ocr";
type PaddleModule = typeof import("ppu-paddle-ocr");
type PaddleCtor = PaddleModule["PaddleOcrService"];

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

/**
 * OCR 原生运行时(PaddleOCR 栈)的外置位置。组合根在「打包后」注入;dev/未打包时不传(null/undefined)
 * → OCR 栈走常规模块解析(node_modules / 打包内),不下载。
 */
export interface OcrRuntime {
  /** 解压目标目录(组合根注入,如 <userData>/ocr-runtime/<appVersion>);内含 node_modules/。 */
  readonly dir: string;
  /** 运行时压缩包 URL(平台+架构+版本特定的 .tar.gz,见 release workflow 产出)。 */
  readonly url: string;
}

export interface DocumentToolsOptions {
  /** PaddleOCR 模型缓存目录(组合根注入,如 <userData>/paddleocr)。OCR 是基础能力,故必选。 */
  readonly ocrModelDir: string;
  /**
   * OCR 原生运行时外置位置(打包后注入)。不传则从常规模块解析加载 OCR 栈(dev)。
   * 见 OcrRuntime。
   */
  readonly ocrRuntime?: OcrRuntime | null;
  /**
   * 执行中进度上报(actionId = execute 的第一个参数 = 渲染层 step 行 id)。
   * OCR(尤其首次下模型 / 逐页识别)耗时,经此把"正在识别…"亮给用户,避免看着像静默跳过。
   */
  readonly onProgress?: (actionId: string, note: string) => void;
}

/** 接地引用的最小单位:某页(或某段)的文本。PDF 按页;纯文本类为单段(page=1)。 */
export interface PageText {
  readonly page: number;
  readonly text: string;
}

/**
 * 结构化抽取结果 —— Notebook(来源集)接地引用的地基:保住逐页文本而非拍平成一坨。
 * 见 research/notebook-design.md §4 M0。
 */
export interface ExtractResult {
  readonly path: string;
  readonly kind: "pdf" | "text" | "unsupported";
  /** 逐页/分段文本(已去空页;纯文本类未 trim,保原样)。unsupported/解析失败为空。 */
  readonly pages: PageText[];
  /** PDF 总页数;可能 > pages.length(空页被滤、或扫描件仅 OCR 了前 N 页)。 */
  readonly pageCount?: number;
  /** 是否走了扫描件 OCR。 */
  readonly ocr: boolean;
  /** 解析失败(加密/损坏 PDF)。 */
  readonly error?: boolean;
  /** 失败原因 / 不支持格式的说明(供工具层回给用户)。 */
  readonly note?: string;
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

// ── OCR 原生运行时外置:按需下载 + 解压,再从该目录动态加载 PaddleOCR 栈 ──────────
const execFileAsync = promisify(execFile);

// 运行时下载并发去重 + 就绪标记(.ready):标记在则视为已解压可用,跳过重复下载。
let runtimeInflight: Promise<void> | null = null;
function ensureOcrRuntime(rt: OcrRuntime): Promise<void> {
  const ready = join(rt.dir, ".ready");
  if (existsSync(ready)) return Promise.resolve();
  if (!runtimeInflight) {
    runtimeInflight = (async () => {
      mkdirSync(rt.dir, { recursive: true });
      const tmp = join(rt.dir, "runtime.tar.gz.tmp");
      const res = await fetch(rt.url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      // 系统 tar 解压(mac/linux 自带;Windows 10 1803+ 自带 bsdtar)。包内顶层即 node_modules/。
      await execFileAsync("tar", ["-xzf", tmp, "-C", rt.dir]);
      rmSync(tmp, { force: true });
      writeFileSync(ready, new Date().toISOString());
    })().catch((err: unknown) => {
      runtimeInflight = null;
      throw err;
    });
  }
  return runtimeInflight;
}

// PaddleOCR 构造器懒加载:打包后从外置运行时目录解析(createRequire 锚在该 node_modules,
// 其传递依赖 onnxruntime-node/ppu-ocv 作为同级解析);dev/未外置则走常规模块解析。
let ctorPromise: Promise<PaddleCtor> | null = null;
function loadPaddleCtor(rt: OcrRuntime | null | undefined): Promise<PaddleCtor> {
  if (!ctorPromise) {
    ctorPromise = (async () => {
      if (!rt) {
        const mod = (await import("ppu-paddle-ocr")) as PaddleModule;
        return mod.PaddleOcrService;
      }
      await ensureOcrRuntime(rt);
      // createRequire 的锚文件无需真实存在,仅用于确定模块解析根(rt.dir/node_modules)。
      const req = createRequire(join(rt.dir, "node_modules", "__pa_resolve__.cjs"));
      const entry = req.resolve("ppu-paddle-ocr");
      const mod = (await import(pathToFileURL(entry).href)) as PaddleModule;
      return mod.PaddleOcrService;
    })().catch((err: unknown) => {
      ctorPromise = null;
      throw err;
    });
  }
  return ctorPromise;
}

let paddlePromise: Promise<PaddleOcrService> | null = null;
/** 懒建 PaddleOCR 服务(加载原生 onnxruntime + 模型);初始化失败不缓存,下次可重试。 */
function getPaddle(dir: string, rt: OcrRuntime | null | undefined): Promise<PaddleOcrService> {
  if (!paddlePromise) {
    paddlePromise = (async () => {
      const Ctor = await loadPaddleCtor(rt);
      const svc = new Ctor({
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

/** 扫描件 OCR:逐页渲染成图 → PaddleOCR 读。返回逐页文本(失败/无模型 → 空数组)。 */
async function ocrScannedPdf(
  buf: Buffer,
  pageCount: number,
  modelRoot: string,
  rt: OcrRuntime | null | undefined,
  onNote: (note: string) => void
): Promise<PageText[]> {
  const dir = join(modelRoot, MODEL_VARIANT); // 变体子目录,换模型自动重下
  // 首次运行需联网:模型(~21MB)+(外置时)OCR 运行时(~90MB)都按需下载。
  const needRuntime = !!rt && !existsSync(join(rt.dir, ".ready"));
  const needModels = PADDLE_MODELS.some((m) => !existsSync(join(dir, m.file)));
  onNote(
    needRuntime
      ? "扫描件:首次需下载 OCR 运行时(约 90MB),稍候…"
      : needModels
        ? "扫描件:首次需下载 OCR 模型(约 21MB),稍候…"
        : "扫描件:正在 OCR 识别…"
  );
  if (!(await ensurePaddleModels(dir))) return [];

  const svc = await getPaddle(dir, rt);
  const total = Math.min(pageCount || 1, MAX_OCR_PAGES);
  const nums = Array.from({ length: total }, (_, i) => i + 1);
  onNote(`扫描件:正在 OCR 识别(共 ${total} 页)…`);
  const shots = await getRenderParser().screenshot(buf, nums);

  const pages: PageText[] = [];
  for (const shot of shots) {
    const r = await svc.recognize(toArrayBuffer(shot.imageBuffer));
    const t = r.text.trim();
    if (t) pages.push({ page: shot.pageNum, text: t });
  }
  return pages;
}

/**
 * 结构化抽取:把一份本地文档抽成**逐页文本**(ExtractResult),保住页码以支撑引用接地。
 *
 * 这是无状态、可复用的核心入口 —— Notebook(来源集)入库时直接调它拿逐页缓存,
 * 不必走 agent 的 extract_document 工具(那层只是把它拍平成给模型读的扁平文本)。见 notebook-design.md §4 M0。
 *
 * @param actionId 仅用于 OCR 进度上报(透传给 onProgress);非 OCR 路径无副作用。
 */
export async function extractDocument(
  path: string,
  opts: DocumentToolsOptions,
  actionId = ""
): Promise<ExtractResult> {
  const ext = extname(path).toLowerCase();

  if (ext === ".pdf") {
    const buf = await readFile(path);
    // 第一遍:数字抽取(快,不 OCR)。有嵌入文本就直接返回,绝大多数 PDF 走这条。
    let parsed: ParseResult;
    try {
      parsed = await getDigitalParser().parse(buf);
    } catch (err) {
      return {
        path,
        kind: "pdf",
        pages: [],
        ocr: false,
        error: true,
        note: `PDF 解析失败:${err instanceof Error ? err.message : String(err)}`
      };
    }
    const pageCount = parsed.pages.length;
    // 逐页文本(liteparse 的 pages[].text);滤掉空页,但页码保留原值。
    const digital = parsed.pages.map((p) => ({ page: p.pageNum, text: p.text.trim() })).filter((p) => p.text);
    if (digital.length) {
      return { path, kind: "pdf", pages: digital, pageCount, ocr: false };
    }

    // 抽不到文本 = 扫描件/图片型 → PaddleOCR(按需下模型 + 逐页读图)。
    try {
      const ocrPages = await ocrScannedPdf(buf, pageCount, opts.ocrModelDir, opts.ocrRuntime, (note) =>
        opts.onProgress?.(actionId, note)
      );
      if (ocrPages.length) {
        return { path, kind: "pdf", pages: ocrPages, pageCount, ocr: true };
      }
    } catch (err) {
      console.warn(`[cap-document] OCR 失败: ${String(err)}`);
    }
    return {
      path,
      kind: "pdf",
      pages: [],
      pageCount,
      ocr: true,
      note: "(扫描件/图片型 PDF,OCR 未能识别出文本;若刚联网下载模型失败可稍后重试)"
    };
  }

  if (PLAINTEXT_EXT.has(ext)) {
    const raw = await readFile(path, "utf8"); // 原样不 trim(纯文本即正文,首尾空白可能有意义)
    return { path, kind: "text", pages: [{ page: 1, text: raw }], ocr: false };
  }

  return {
    path,
    kind: "unsupported",
    pages: [],
    ocr: false,
    note: `不支持的文档格式:${ext || "(无扩展名)"}。当前支持 PDF(含扫描件)与纯文本类。`
  };
}

/**
 * 把逐页结构拍平成给模型读的扁平文本:多页 PDF 加「第 N 页」锚(让模型作答时能引用页码),
 * 单页 PDF / 纯文本不加锚。扫描件仅 OCR 了前 N 页时补一行说明(沿用旧行为)。
 */
function flattenPages(r: ExtractResult): string {
  if (r.pages.length === 0) return r.note ?? "";
  const multi = r.kind === "pdf" && r.pages.length > 1;
  const body = r.pages.map((p) => (multi ? `【第 ${p.page} 页】\n${p.text}` : p.text)).join("\n\n");
  if (r.ocr && r.pageCount && r.pageCount > MAX_OCR_PAGES) {
    return `${body}\n\n(文档共 ${r.pageCount} 页,仅 OCR 了前 ${MAX_OCR_PAGES} 页)`;
  }
  return body;
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
      const r = await extractDocument(path, opts, id);

      if (r.kind === "unsupported") {
        return textResult(r.note ?? "不支持的文档格式。", { path, kind: "unsupported" });
      }
      if (r.error) {
        return textResult(r.note ?? "解析失败。", { path, kind: r.kind, error: true });
      }

      const { text, truncated } = clip(flattenPages(r));

      if (r.kind === "text") {
        return textResult(text, { path, kind: "text", chars: text.length, truncated });
      }
      // PDF:pages 为空 = 扫描件未识别出文本(text 此时是说明文案,chars 记 0)。
      if (r.pages.length === 0) {
        return textResult(text, { path, kind: "pdf", pages: r.pageCount ?? 0, chars: 0 });
      }
      return textResult(text, {
        path,
        kind: "pdf",
        pages: r.pageCount ?? r.pages.length,
        chars: text.length,
        truncated,
        ocr: r.ocr
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
- 大文档会被截断;只关心局部就先 extract 看全貌再按需定位。
- 多页 PDF 的抽取结果按「第 N 页」分段标注;**引用某句话时带上页码**(如「据第 3 页…」),别让用户回去自己翻。`;

export { CAPABILITY as documentCapability };
