/**
 * @pa/ctx-notebook — Notebook(来源集)
 *
 * 把若干本地文档攒成一个「来源集」,服务 NotebookLM 式的「对一组资料持续问答、带引用」。
 * 对标 Personal Memory:**本地、可见可恢复、每 workspace 一份**的有状态集合,而非无状态 Capability。
 *
 * 检索沿用既定决策(agentic search,非向量 RAG):入库时把文档抽成**逐页文本缓存**(免重跑 OCR),
 * 之后(M2)在 notebook 范围内做关键词检索 + 带页码引用作答。设计见 research/notebook-design.md。
 *
 * 本文件 = M1:领域 + 持久化 + 增删工具(notebook_add_source / notebook_list / notebook_remove_source)。
 * 抽取本身由组合根注入(DocumentExtractor),本包不依赖 cap-document,保持解耦。
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

// ── 领域类型 ─────────────────────────────────────────────────
/** 接地引用的最小单位:某页(或某段)的文本。 */
export interface PageText {
  readonly page: number;
  readonly text: string;
}

export type SourceKind = "pdf" | "text";
export type SourceStatus = "active" | "removed";

/** 来源集里的一份资料(实体):路径 + 逐页文本缓存 + 元数据。 */
export interface Source {
  id: string;
  /** 原文件绝对路径(引用/重抽取时用;本机改动不追踪)。 */
  path: string;
  /** 展示名(默认 basename),引用时用。 */
  name: string;
  kind: SourceKind;
  /** 是否走了扫描件 OCR。 */
  ocr: boolean;
  /** 总页数(纯文本类为 1)。 */
  pageCount: number;
  /** 逐页文本缓存(M2 检索的数据源)。 */
  pages: PageText[];
  /** 缓存总字数(元数据,列表展示用,免遍历 pages)。 */
  chars: number;
  /** 抽取失败/未识别(如扫描件 OCR 空):标记而非静默丢,留待用户处置。 */
  error?: boolean;
  /** 失败/部分识别的说明。 */
  note?: string;
  status: SourceStatus;
  removedReason?: string;
  addedAt: number;
  extractedAt: number;
}

/** 来源集(聚合根)。 */
export interface Notebook {
  id: string;
  name: string;
  sources: Source[];
  createdAt: number;
  updatedAt: number;
}

/** 入库前由组合根抽取出的资料内容(store 不做抽取,只持久化)。 */
export interface NewSourceInput {
  path: string;
  name: string;
  kind: SourceKind;
  ocr: boolean;
  pageCount: number;
  pages: PageText[];
  error?: boolean;
  note?: string;
}

// ── 视图(给 UI / 工具回报:不含逐页全文,避免撑爆)──────────────
export interface SourceView {
  id: string;
  name: string;
  path: string;
  kind: SourceKind;
  ocr: boolean;
  pageCount: number;
  chars: number;
  error?: boolean;
  note?: string;
  status: SourceStatus;
  addedAt: number;
}

export interface NotebookView {
  id: string;
  name: string;
  /** 活跃来源数。 */
  sourceCount: number;
  sources: SourceView[];
  createdAt: number;
  updatedAt: number;
}

/** 库内检索命中:定位到 来源 + 页 + 片段。 */
export interface SearchHit {
  sourceId: string;
  sourceName: string;
  page: number;
  /** 命中处上下文片段(已压平换行)。 */
  snippet: string;
  /** 该页命中次数。 */
  matchCount: number;
}

/** 提取文本上限(读全文时;与 cap-filesystem / cap-document 对齐)。 */
const MAX_READ_CHARS = 200_000;
/** 检索片段单侧上下文字数。 */
const SNIPPET_PAD = 80;

/** 命中处上下文片段:首个匹配位置前后各取 SNIPPET_PAD 字,压平换行、加省略号。 */
function snippet(text: string, idx: number, qlen: number): string {
  const start = Math.max(0, idx - SNIPPET_PAD);
  const end = Math.min(text.length, idx + qlen + SNIPPET_PAD);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${body}${end < text.length ? "…" : ""}`;
}

function toSourceView(s: Source): SourceView {
  return {
    id: s.id,
    name: s.name,
    path: s.path,
    kind: s.kind,
    ocr: s.ocr,
    pageCount: s.pageCount,
    chars: s.chars,
    error: s.error,
    note: s.note,
    status: s.status,
    addedAt: s.addedAt
  };
}

function toNotebookView(nb: Notebook): NotebookView {
  const active = nb.sources.filter((s) => s.status === "active");
  return {
    id: nb.id,
    name: nb.name,
    sourceCount: active.length,
    sources: active.map(toSourceView),
    createdAt: nb.createdAt,
    updatedAt: nb.updatedAt
  };
}

// ── 抽取端口(组合根注入 cap-document 的 extractDocument 适配器)──
/** 抽取结果(结构上兼容 cap-document 的 ExtractResult,故根可直接透传)。 */
export interface ExtractedDoc {
  kind: "pdf" | "text" | "unsupported";
  pages: PageText[];
  pageCount?: number;
  ocr: boolean;
  error?: boolean;
  note?: string;
}
/** path + actionId(供 OCR 进度上报)→ 抽取结果。 */
export type DocumentExtractor = (path: string, actionId: string) => Promise<ExtractedDoc>;

// ── 持久化:每 workspace 一个 notebooks/ 目录,每个 notebook 一份 <id>.json ──
export class NotebookStore {
  private notebooks: Notebook[] = [];

  /** @param dir 形如 <userData>/workspaces/<wsId>/notebooks */
  constructor(private readonly dir: string) {
    if (!existsSync(dir)) return;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const nb = JSON.parse(readFileSync(join(dir, f), "utf8")) as Notebook;
        if (nb && nb.id) this.notebooks.push(nb);
      } catch {
        // 损坏文件跳过,不让一份坏数据拖垮整个 workspace。
      }
    }
  }

  private persist(nb: Notebook): void {
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${nb.id}.json`), JSON.stringify(nb, null, 2));
  }

  private findByName(name: string): Notebook | undefined {
    const n = name.trim().toLowerCase();
    return this.notebooks.find((nb) => nb.name.trim().toLowerCase() === n);
  }

  /** 取或建 notebook(按名,大小写不敏感)。 */
  ensureNotebook(name: string): Notebook {
    const existing = this.findByName(name);
    if (existing) return existing;
    const now = Date.now();
    const nb: Notebook = { id: crypto.randomUUID(), name: name.trim(), sources: [], createdAt: now, updatedAt: now };
    this.notebooks.push(nb);
    this.persist(nb);
    return nb;
  }

  /** 该 notebook 内是否已有同 path 的活跃来源(避免重复抽取/入库)。 */
  findActiveSourceByPath(notebookName: string, path: string): Source | undefined {
    const nb = this.findByName(notebookName);
    return nb?.sources.find((s) => s.status === "active" && s.path === path);
  }

  /** 入库一份(已抽取的)来源。 */
  addSource(notebookName: string, input: NewSourceInput): { notebook: Notebook; source: Source } {
    const nb = this.ensureNotebook(notebookName);
    const now = Date.now();
    const source: Source = {
      id: crypto.randomUUID(),
      path: input.path,
      name: input.name,
      kind: input.kind,
      ocr: input.ocr,
      pageCount: input.pageCount,
      pages: input.pages,
      chars: input.pages.reduce((n, p) => n + p.text.length, 0),
      error: input.error,
      note: input.note,
      status: "active",
      addedAt: now,
      extractedAt: now
    };
    nb.sources.push(source);
    nb.updatedAt = now;
    this.persist(nb);
    return { notebook: nb, source };
  }

  /** 在 notebook 内按 ref(id / 展示名 / 路径子串,大小写不敏感)定位一份活跃来源。 */
  private matchSource(nb: Notebook, ref: string): Source | undefined {
    const r = ref.trim().toLowerCase();
    return nb.sources.find(
      (s) =>
        s.status === "active" &&
        (s.id === ref || s.name.toLowerCase() === r || s.name.toLowerCase().includes(r) || s.path.toLowerCase().includes(r))
    );
  }

  /**
   * 软删一份来源(留痕,可恢复;原文件从不触碰,只是停止追踪)。
   * ref 可为 source id、展示名或路径(子串,大小写不敏感)。
   */
  removeSource(notebookName: string, ref: string, reason?: string): Source | undefined {
    const nb = this.findByName(notebookName);
    if (!nb) return undefined;
    const source = this.matchSource(nb, ref);
    if (!source) return undefined;
    source.status = "removed";
    source.removedReason = reason;
    nb.updatedAt = Date.now();
    this.persist(nb);
    return source;
  }

  /**
   * 库内关键词检索(agentic search,非向量):逐页大小写不敏感子串匹配,
   * 每个命中页回一条带页码的片段。供模型定位后再 getSource 读全页、带页码引用作答。
   * @param limit 命中上限(防一个高频词刷屏)。
   */
  search(notebookName: string, query: string, limit = 20): SearchHit[] {
    const nb = this.findByName(notebookName);
    if (!nb) return [];
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const hits: SearchHit[] = [];
    for (const s of nb.sources) {
      if (s.status !== "active") continue;
      for (const p of s.pages) {
        const hay = p.text.toLowerCase();
        const first = hay.indexOf(q);
        if (first === -1) continue;
        let count = 0;
        for (let k = first; k !== -1; k = hay.indexOf(q, k + q.length)) count++;
        hits.push({ sourceId: s.id, sourceName: s.name, page: p.page, snippet: snippet(p.text, first, q.length), matchCount: count });
        if (hits.length >= limit) return hits;
      }
    }
    return hits;
  }

  /** 取一份来源(含逐页全文),供 notebook_read_source 读全文/指定页。 */
  getSource(notebookName: string, ref: string): Source | undefined {
    const nb = this.findByName(notebookName);
    return nb ? this.matchSource(nb, ref) : undefined;
  }

  /** 全部 notebook 视图(UI 列表 / 概览)。 */
  listNotebooks(): NotebookView[] {
    return this.notebooks.map(toNotebookView);
  }

  /** 单个 notebook 视图(按名)。 */
  getNotebook(name: string): NotebookView | undefined {
    const nb = this.findByName(name);
    return nb ? toNotebookView(nb) : undefined;
  }
}

// ── 工具 ─────────────────────────────────────────────────────
/** 全部 notebook 工具名(供组合根登记 Capability / 风险:均自动执行、可见、可逆,视同 ReadOnly)。 */
export const notebookToolNames: ReadonlySet<string> = new Set([
  "notebook_add_source",
  "notebook_list",
  "notebook_search",
  "notebook_read_source",
  "notebook_remove_source"
]);

export const notebookGuidelines = `## 知识库(Notebook / 来源集)
当用户想「把这几份资料攒起来反复问 / 基于这批文档做问答或产出」时,用 notebook 把它们收进一个**来源集**,而不是每次重新 extract。

**管理来源**
- **notebook_add_source**:把一份 PDF/文本加进指定知识库(按名,不存在则自动新建)。入库会抽取并缓存逐页文本——之后问它无需重抽、扫描件也不必重跑 OCR。一次加一份;多份就多次调用。
- **notebook_list**:不带参数列出所有知识库及其来源数;带 notebook 名则列出该库内来源清单。动手问答前先看看库里有什么。
- **notebook_remove_source**:把某份来源移出知识库(软删除,原文件不动,可恢复)。
- 加资料是用户的明确动作,别自作主张把无关文件塞进知识库;拿不准放哪个库就先 notebook_list 或问用户。

**基于知识库问答(核心:接地、带引用、不编造)**
- 回答关于某知识库的问题时,**只依据该库里的来源**,不要用你的先验知识补全或想当然。
- 流程:先 **notebook_search** 用关键词在库内定位(回「来源:第 N 页」+ 片段)→ 再 **notebook_read_source** 把命中来源的相应页读全 → 据原文作答。一个关键词搜不到就换词多搜几轮,别急着说没有。
- **每个论断都标出处**,形如「据《xx.pdf》第 3 页…」或句末 \`[xx.pdf, p.3]\`,让用户能回原文核对。
- 库里**确实没有**相关内容时,直说「这批资料里没有提到 X」,并说明你搜了哪些词——**不要**用通用知识硬答。
- 跨多份来源时,分别标清每条结论来自哪份、哪页;有冲突就如实指出。`;

const addParams = Type.Object({
  notebook: Type.String({ description: "知识库名称(不存在则自动新建,如「2024报销」「项目X调研」)" }),
  path: Type.String({ description: "要加入的文档绝对路径(PDF 含扫描件,或 .txt/.md/.csv 等纯文本类)" })
});

const listParams = Type.Object({
  notebook: Type.Optional(
    Type.String({ description: "可选:某个知识库名。不填=列出所有知识库;填了=列出该库内的来源清单" })
  )
});

/** 解析页码选择串(「3」「2-5」「1,4,7」)→ 页码集合;空/无效返回 null(=全选)。 */
function parsePageSpec(spec: string | undefined): Set<number> | null {
  if (!spec || !spec.trim()) return null;
  const set = new Set<number>();
  for (const part of spec.split(",")) {
    const seg = part.trim();
    const range = /^(\d+)\s*-\s*(\d+)$/.exec(seg);
    if (range) {
      const lo = Number(range[1]);
      const hi = Number(range[2]);
      for (let p = Math.min(lo, hi); p <= Math.max(lo, hi); p++) set.add(p);
    } else if (/^\d+$/.test(seg)) {
      set.add(Number(seg));
    }
  }
  return set.size > 0 ? set : null;
}

/** 把逐页拼成带「第 N 页」锚的文本,超 MAX_READ_CHARS 截断。 */
function renderPages(pages: PageText[]): { text: string; truncated: boolean } {
  const body = pages.map((p) => `【第 ${p.page} 页】\n${p.text}`).join("\n\n");
  if (body.length <= MAX_READ_CHARS) return { text: body, truncated: false };
  return { text: body.slice(0, MAX_READ_CHARS) + "\n…(内容过长已截断)", truncated: true };
}

const searchParams = Type.Object({
  notebook: Type.String({ description: "要检索的知识库名称" }),
  query: Type.String({ description: "关键词(库内逐页大小写不敏感子串匹配)。搜不到就换词多试几轮" })
});

const readParams = Type.Object({
  notebook: Type.String({ description: "知识库名称" }),
  source: Type.String({ description: "要读的来源:其展示名、文件名片段或路径片段" }),
  pages: Type.Optional(
    Type.String({ description: "可选:页码范围,如「3」「2-5」「1,4,7」。不填=读全文(超长会截断)" })
  )
});

const removeParams = Type.Object({
  notebook: Type.String({ description: "知识库名称" }),
  source: Type.String({ description: "要移出的来源:其展示名、文件名片段或路径片段" }),
  reason: Type.Optional(Type.String({ description: "可选:为什么移除" }))
});

/** addSourceToNotebook 的结果(工具层/UI 层各自渲染成自己的回报)。 */
export type AddSourceOutcome =
  | { status: "reused"; source: Source }
  | { status: "unsupported"; note: string }
  | { status: "added"; source: Source; hasText: boolean };

/**
 * 提取并入库一份来源 —— **对话工具与 UI 共用**的单一入口:
 * 去重(同 path 不重抽)→ 抽取 → 不支持格式拒收 → 抽不到文本(扫描件 OCR 空/解析失败)标 error 留痕。
 */
export async function addSourceToNotebook(
  store: NotebookStore,
  extract: DocumentExtractor,
  notebook: string,
  path: string,
  actionId = ""
): Promise<AddSourceOutcome> {
  const existing = store.findActiveSourceByPath(notebook, path);
  if (existing) return { status: "reused", source: existing };

  const doc = await extract(path, actionId);
  if (doc.kind === "unsupported") return { status: "unsupported", note: doc.note ?? `不支持的格式:${path}` };

  const hasText = doc.pages.length > 0;
  const { source } = store.addSource(notebook, {
    path,
    name: basename(path),
    kind: doc.kind === "pdf" ? "pdf" : "text",
    ocr: doc.ocr,
    pageCount: doc.pageCount ?? doc.pages.length,
    pages: doc.pages,
    error: doc.error || !hasText,
    note: hasText ? undefined : doc.note ?? "未能抽出文本(扫描件未识别或解析失败)"
  });
  return { status: "added", source, hasText };
}

/**
 * 创建 notebook 工具集。
 * @param store      该 workspace 的 NotebookStore
 * @param extract    组合根注入的抽取器(适配 cap-document 的 extractDocument)
 * @param onChange   增删后通知 UI 刷新(可选;M3 接面板)
 */
export function createNotebookTools(
  store: NotebookStore,
  extract: DocumentExtractor,
  onChange?: () => void
): AgentTool<any>[] {
  const addSource: AgentTool<typeof addParams> = {
    name: "notebook_add_source",
    label: "加入知识库",
    description:
      "把一份本地文档(PDF/含扫描件,或纯文本类)加进指定知识库(来源集);" +
      "知识库不存在会自动新建。入库会抽取并缓存逐页文本,便于之后基于这批资料反复问答。一次加一份。",
    parameters: addParams,
    execute: async (id, { notebook, path }) => {
      const r = await addSourceToNotebook(store, extract, notebook, path, id);
      if (r.status === "reused") {
        return {
          content: [{ type: "text", text: `「${r.source.name}」已在知识库「${notebook}」中,未重复添加。` }],
          details: { reused: true, sourceId: r.source.id }
        };
      }
      if (r.status === "unsupported") {
        return { content: [{ type: "text", text: r.note }], details: { added: false, reason: "unsupported" } };
      }
      onChange?.();
      const s = r.source;
      const text = r.hasText
        ? `已加入知识库「${notebook}」:${s.name}(${s.pageCount} 页 / ${s.chars} 字${s.ocr ? "、扫描件 OCR" : ""})`
        : `已加入知识库「${notebook}」:${s.name}，但${s.note}。可移除后换可识别的版本重试。`;
      return { content: [{ type: "text", text }], details: { added: true, sourceId: s.id, error: s.error } };
    }
  };

  const listSources: AgentTool<typeof listParams> = {
    name: "notebook_list",
    label: "看知识库",
    description:
      "查看知识库。不带参数=列出所有知识库及其来源数;带 notebook 名=列出该库内的来源清单(页数/字数/是否扫描件)。",
    parameters: listParams,
    execute: async (_id, { notebook }) => {
      if (!notebook) {
        const all = store.listNotebooks();
        if (all.length === 0) {
          return { content: [{ type: "text", text: "还没有任何知识库。用 notebook_add_source 把资料加进来即可新建。" }], details: { count: 0 } };
        }
        const lines = all.map((nb) => `- ${nb.name}(${nb.sourceCount} 份来源)`);
        return { content: [{ type: "text", text: `知识库:\n${lines.join("\n")}` }], details: { count: all.length } };
      }
      const nb = store.getNotebook(notebook);
      if (!nb) {
        return { content: [{ type: "text", text: `没有名为「${notebook}」的知识库。` }], details: { found: false } };
      }
      if (nb.sources.length === 0) {
        return { content: [{ type: "text", text: `知识库「${nb.name}」里还没有来源。` }], details: { found: true, count: 0 } };
      }
      const lines = nb.sources.map((s) => {
        const tags = [`${s.pageCount} 页`, `${s.chars} 字`];
        if (s.ocr) tags.push("扫描件");
        if (s.error) tags.push("⚠ 未识别");
        return `- ${s.name}(${tags.join(" / ")})\n  ${s.path}`;
      });
      return {
        content: [{ type: "text", text: `知识库「${nb.name}」的来源:\n${lines.join("\n")}` }],
        details: { found: true, count: nb.sources.length }
      };
    }
  };

  const search: AgentTool<typeof searchParams> = {
    name: "notebook_search",
    label: "搜知识库",
    description:
      "在指定知识库内按关键词检索,返回命中的「来源 : 第 N 页 : 片段」。" +
      "基于知识库问答时先用它定位,再用 notebook_read_source 读全页、据原文带页码作答。",
    parameters: searchParams,
    execute: async (_id, { notebook, query }) => {
      if (!store.getNotebook(notebook)) {
        return { content: [{ type: "text", text: `没有名为「${notebook}」的知识库。` }], details: { found: false } };
      }
      const hits = store.search(notebook, query);
      if (hits.length === 0) {
        return {
          content: [{ type: "text", text: `在知识库「${notebook}」里没找到匹配「${query}」的内容。可换个说法/关键词再搜。` }],
          details: { count: 0 }
        };
      }
      const lines = hits.map((h) => `- 《${h.sourceName}》第 ${h.page} 页${h.matchCount > 1 ? `(${h.matchCount} 处)` : ""}:${h.snippet}`);
      return {
        content: [{ type: "text", text: `在「${notebook}」中命中「${query}」:\n${lines.join("\n")}` }],
        details: { count: hits.length }
      };
    }
  };

  const readSource: AgentTool<typeof readParams> = {
    name: "notebook_read_source",
    label: "读知识库来源",
    description:
      "读知识库里某份来源的全文或指定页(带「第 N 页」锚)。" +
      "用于 notebook_search 定位后把相关页读全,据原文作答并引用页码。",
    parameters: readParams,
    execute: async (_id, { notebook, source, pages }) => {
      const src = store.getSource(notebook, source);
      if (!src) {
        return {
          content: [{ type: "text", text: `在知识库「${notebook}」里没找到匹配「${source}」的来源。` }],
          details: { found: false }
        };
      }
      const sel = parsePageSpec(pages);
      const chosen = sel ? src.pages.filter((p) => sel.has(p.page)) : src.pages;
      if (chosen.length === 0) {
        return {
          content: [{ type: "text", text: `《${src.name}》没有匹配「${pages}」的页(共 ${src.pageCount} 页)。` }],
          details: { found: true, pages: 0 }
        };
      }
      const { text, truncated } = renderPages(chosen);
      return {
        content: [{ type: "text", text: `《${src.name}》${sel ? `(第 ${pages} 页)` : ""}:\n${text}` }],
        details: { found: true, pages: chosen.length, truncated }
      };
    }
  };

  const removeSource: AgentTool<typeof removeParams> = {
    name: "notebook_remove_source",
    label: "移出知识库",
    description: "把某份来源移出知识库(软删除,原文件不动,可恢复)。",
    parameters: removeParams,
    execute: async (_id, { notebook, source, reason }) => {
      const removed = store.removeSource(notebook, source, reason);
      onChange?.();
      const text = removed
        ? `已从知识库「${notebook}」移出:${removed.name}${reason ? `(原因:${reason})` : ""}`
        : `在知识库「${notebook}」里没找到匹配「${source}」的来源。`;
      return { content: [{ type: "text", text }], details: { removed: !!removed } };
    }
  };

  return [addSource, listSources, search, readSource, removeSource];
}
