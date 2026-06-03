/**
 * @pa/cap-document — Document Extraction Capability(支撑域)
 *
 * 把本地文档(PDF / 纯文本类)抽成可进上下文的文本,服务"调研→产出"主线。
 * 只读、风险 ReadOnly(Trust 守门人自动放行)。
 *
 * PDF 走 liteparse(Rust/PDFium,napi 预编译):比旧 pdf-parse 更快、版面更干净、中文正常。
 *
 * OCR(扫描件/图片型 PDF):
 * - 引擎用 liteparse **自带的** Tesseract(已静态编进 .node),不依赖系统 tesseract、不 shell 装任何东西。
 * - 但 liteparse **不随包带语言包(traineddata)**。我们的策略:**按需下载,不随 app 包**——
 *   首个扫描件触发时,从官方标准 tessdata 下载需要的语言(默认 chi_sim+eng)到本地缓存目录,之后复用。
 *   用标准版(非 _fast)+ DPI 300 + 收 CJK 字间空格,中文扫描件识别质量明显更好。数字版 PDF 不碰 OCR。
 * - 缓存目录由组合根注入(ocrTessdataDir);不注入则 OCR 关闭(扫描件如实回"抽不出",零回归)。
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

const CAPABILITY: Capability = "document";

/** 提取文本上限,避免撑爆上下文(与 cap-filesystem 对齐)。 */
const MAX_TEXT_CHARS = 200_000;

/** 纯文本类扩展名:直接按 utf8 读。 */
const PLAINTEXT_EXT = new Set([".txt", ".md", ".markdown", ".csv", ".tsv", ".json", ".log", ".xml", ".yaml", ".yml"]);

/** 默认 OCR 语言(中文场景):简体中文 + 英文。 */
const DEFAULT_OCR_LANGS = ["chi_sim", "eng"] as const;
/** OCR 渲染 DPI:Tesseract 在 ~300 DPI 上识别明显优于 liteparse 默认的 150(实测中文扫描件)。 */
const OCR_DPI = 300;
/**
 * 官方**标准**语言包(integer LSTM)下载源——比 _fast 变体准不少(实测同页抓到的字数翻倍),
 * 代价是体积(chi_sim ~44MB、eng ~23MB)。按需下载到缓存、不随 app 包,故体积换精度值。
 */
const TESSDATA_BASE = "https://github.com/tesseract-ocr/tessdata/raw/main";

export interface DocumentToolsOptions {
  /** OCR 语言包缓存目录(组合根注入,如 <userData>/tessdata)。不给 → OCR 关闭。 */
  readonly ocrTessdataDir?: string;
  /** OCR 语言(Tesseract 语言码),默认 chi_sim+eng。 */
  readonly ocrLanguages?: readonly string[];
}

function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

function clip(text: string): { text: string; truncated: boolean } {
  if (text.length <= MAX_TEXT_CHARS) return { text, truncated: false };
  return { text: text.slice(0, MAX_TEXT_CHARS) + "\n…(内容过长已截断)", truncated: true };
}

/**
 * OCR 后处理:Tesseract 对中文常逐字插空格(版面模式下尤甚),收掉「两个汉字之间」的空白,
 * 大幅提升可读性(也省 token)。只动汉字之间的空白,不碰中英/中数之间的分隔。
 */
function densifyCjk(text: string): string {
  return text.replace(/([一-鿿])\s+(?=[一-鿿])/g, "$1");
}

// ── LiteParse 实例(构造时加载原生 .node;懒建,隔离加载失败)─────────────
// 数字版抽取(ocrEnabled:false,快);OCR 版按「目录+语言」缓存,ocrLanguage 决定识别哪些语言。
let digitalParser: LiteParse | null = null;
function getDigitalParser(): LiteParse {
  if (!digitalParser) digitalParser = new LiteParse({ outputFormat: "text", ocrEnabled: false });
  return digitalParser;
}
const ocrParsers = new Map<string, LiteParse>();
function getOcrParser(tessdataDir: string, langs: string[]): LiteParse {
  const key = `${tessdataDir}|${langs.join("+")}`;
  let p = ocrParsers.get(key);
  if (!p) {
    p = new LiteParse({
      outputFormat: "text",
      ocrEnabled: true,
      ocrLanguage: langs.join("+"),
      tessdataPath: tessdataDir,
      dpi: OCR_DPI
    });
    ocrParsers.set(key, p);
  }
  return p;
}

// ── 语言包按需下载 ─────────────────────────────────────────────
// 首个扫描件触发;已存在则跳过。并发去重(同一文件不重复下),写临时文件再 rename(防半成品)。
const inflight = new Map<string, Promise<boolean>>();
function ensureLang(dir: string, lang: string): Promise<boolean> {
  const dest = join(dir, `${lang}.traineddata`);
  if (existsSync(dest)) return Promise.resolve(true);
  let p = inflight.get(dest);
  if (!p) {
    p = (async (): Promise<boolean> => {
      const res = await fetch(`${TESSDATA_BASE}/${lang}.traineddata`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      mkdirSync(dir, { recursive: true });
      const tmp = `${dest}.tmp`;
      writeFileSync(tmp, buf);
      renameSync(tmp, dest); // 原子落地:半下载的不会被当成可用
      return true;
    })()
      .catch((err: unknown) => {
        console.warn(`[cap-document] OCR 语言包下载失败 ${lang}: ${String(err)}`);
        return false;
      })
      .finally(() => inflight.delete(dest));
    inflight.set(dest, p);
  }
  return p;
}
/** 确保所需语言包就位,返回实际可用的语言(下载失败的剔除)。 */
async function ensureTraineddata(dir: string, langs: readonly string[]): Promise<string[]> {
  const got = await Promise.all(langs.map((l) => ensureLang(dir, l).then((ok) => (ok ? l : null))));
  return got.filter((l): l is string => l !== null);
}

const extractParams = Type.Object({
  path: Type.String({ description: "文档的绝对路径。支持 PDF(含扫描件)及纯文本类(.txt/.md/.csv/.json 等)。" })
});

function createExtractDocumentTool(opts: DocumentToolsOptions): AgentTool<typeof extractParams> {
  const ocrLangs = opts.ocrLanguages ?? DEFAULT_OCR_LANGS;
  return {
    name: "extract_document",
    label: "提取文档",
    description:
      "把本地文档抽成纯文本以便阅读/总结/再加工。支持 PDF(含扫描件,自动 OCR)与纯文本类文件。" +
      "需要理解一份文档内容时用它,而不是猜测。",
    parameters: extractParams,
    execute: async (_id, { path }) => {
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

        // 抽不到文本 = 扫描件/图片型 → 按需 OCR(liteparse 自带引擎 + 按需下载的语言包)。
        if (opts.ocrTessdataDir) {
          try {
            const langs = await ensureTraineddata(opts.ocrTessdataDir, ocrLangs);
            if (langs.length > 0) {
              const ocrParsed = await getOcrParser(opts.ocrTessdataDir, langs).parse(buf);
              const ocr = clip(densifyCjk(ocrParsed.text).trim());
              if (ocr.text) {
                return textResult(ocr.text, {
                  path,
                  kind: "pdf",
                  pages: ocrParsed.pages.length,
                  chars: ocr.text.length,
                  truncated: ocr.truncated,
                  ocr: true
                });
              }
            }
          } catch (err) {
            console.warn(`[cap-document] OCR 失败: ${String(err)}`);
          }
        }
        return textResult("(扫描件/图片型 PDF,OCR 未能识别出文本;若刚联网下载语言包失败可稍后重试)", {
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
 * 创建文档工具集。ocrTessdataDir 注入语言包缓存目录(开启扫描件按需 OCR);
 * 不传 → OCR 关闭(扫描件如实回"抽不出")。
 */
export function createDocumentTools(opts: DocumentToolsOptions = {}): AgentTool<any>[] {
  return [createExtractDocumentTool(opts)];
}

/** 便捷默认实例(无 OCR):测试 / 不需扫描件的场景用。生产由组合根经 createDocumentTools 注入缓存目录。 */
export const documentTools: AgentTool<any>[] = createDocumentTools();

export const documentToolNames: ReadonlySet<string> = new Set(["extract_document"]);

export const documentToolRisk: Readonly<Record<string, RiskLevel>> = {
  extract_document: "ReadOnly"
};

export const documentGuidelines = `## 文档提取
- 需要理解某份文档(PDF/报告/合同等)的内容时,用 extract_document 抽成文本再读。
- 扫描件/图片型 PDF 也用 extract_document —— 它已内建 OCR(自带引擎,首次会联网下载语言包,稍慢)。
  **这就是本机能做到的 OCR 上限**:扫描件 OCR 难免有错字、表格/公章/花体尤其差,这是客观限制,不是工具没选对。
  **严禁**再自己用 shell 调 tesseract / pdftotext / pdftoppm / pytesseract 等去"重试 OCR"——内建用的就是同一个 Tesseract,
  你 shell 兜底只会更慢、更乱、还依赖用户机器装没装,结果不会更好。
- 正确做法:就用 extract_document 这一次的结果,基于它能认出的部分如实总结;识别不清的地方明说"扫描件此处识别不清",
  别为了凑完整去 shell 折腾,也别编造。
- 大文档会被截断;若只关心局部,先 extract 看全貌,再按需结合其它工具定位。`;

export { CAPABILITY as documentCapability };
