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

  /**
   * 软删一份来源(留痕,可恢复;原文件从不触碰,只是停止追踪)。
   * ref 可为 source id、展示名或路径(子串,大小写不敏感)。
   */
  removeSource(notebookName: string, ref: string, reason?: string): Source | undefined {
    const nb = this.findByName(notebookName);
    if (!nb) return undefined;
    const r = ref.trim().toLowerCase();
    const source = nb.sources.find(
      (s) =>
        s.status === "active" &&
        (s.id === ref || s.name.toLowerCase() === r || s.name.toLowerCase().includes(r) || s.path.toLowerCase().includes(r))
    );
    if (!source) return undefined;
    source.status = "removed";
    source.removedReason = reason;
    nb.updatedAt = Date.now();
    this.persist(nb);
    return source;
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
  "notebook_remove_source"
]);

export const notebookGuidelines = `## 知识库(Notebook / 来源集)
- 当用户想「把这几份资料攒起来反复问 / 基于这批文档做问答或产出」时,用 notebook 把它们收进一个**来源集**,而不是每次重新 extract。
- **notebook_add_source**:把一份 PDF/文本加进指定知识库(按名,不存在则自动新建)。入库会抽取并缓存逐页文本——之后问它无需重抽、扫描件也不必重跑 OCR。一次加一份;多份就多次调用。
- **notebook_list**:不带参数列出所有知识库及其来源数;带 notebook 名则列出该库内的来源清单(含页数/字数/是否扫描件)。动手问答前先看看库里有什么。
- **notebook_remove_source**:把某份来源移出知识库(软删除,原文件不动,可恢复)。
- 加资料是用户的明确动作,别自作主张把无关文件塞进知识库;拿不准放哪个库就先 notebook_list 看看或问用户。
- (基于知识库内容的检索/带引用问答会在后续版本提供;当前先把"攒资料、看清单"做扎实。)`;

const addParams = Type.Object({
  notebook: Type.String({ description: "知识库名称(不存在则自动新建,如「2024报销」「项目X调研」)" }),
  path: Type.String({ description: "要加入的文档绝对路径(PDF 含扫描件,或 .txt/.md/.csv 等纯文本类)" })
});

const listParams = Type.Object({
  notebook: Type.Optional(
    Type.String({ description: "可选:某个知识库名。不填=列出所有知识库;填了=列出该库内的来源清单" })
  )
});

const removeParams = Type.Object({
  notebook: Type.String({ description: "知识库名称" }),
  source: Type.String({ description: "要移出的来源:其展示名、文件名片段或路径片段" }),
  reason: Type.Optional(Type.String({ description: "可选:为什么移除" }))
});

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
      // 已在库里就别重抽(省 OCR/解析)。
      const existing = store.findActiveSourceByPath(notebook, path);
      if (existing) {
        return {
          content: [{ type: "text", text: `「${basename(path)}」已在知识库「${notebook}」中,未重复添加。` }],
          details: { reused: true, sourceId: existing.id }
        };
      }

      const doc = await extract(path, id);
      if (doc.kind === "unsupported") {
        return {
          content: [{ type: "text", text: doc.note ?? `不支持的格式,未加入知识库:${path}` }],
          details: { added: false, reason: "unsupported" }
        };
      }

      const kind: SourceKind = doc.kind === "pdf" ? "pdf" : "text";
      const pageCount = doc.pageCount ?? doc.pages.length;
      const hasText = doc.pages.length > 0;
      const { notebook: nb, source } = store.addSource(notebook, {
        path,
        name: basename(path),
        kind,
        ocr: doc.ocr,
        pageCount,
        pages: doc.pages,
        // 抽不到文本(扫描件 OCR 空 / 解析失败)→ 标记 error 留痕,而非静默丢。
        error: doc.error || !hasText,
        note: hasText ? undefined : doc.note ?? "未能抽出文本(扫描件未识别或解析失败)"
      });
      onChange?.();

      const text = hasText
        ? `已加入知识库「${nb.name}」:${source.name}(${source.pageCount} 页 / ${source.chars} 字${source.ocr ? "、扫描件 OCR" : ""})`
        : `已加入知识库「${nb.name}」:${source.name}，但${source.note}。可移除后换可识别的版本重试。`;
      return { content: [{ type: "text", text }], details: { added: true, sourceId: source.id, error: source.error } };
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

  return [addSource, listSources, removeSource];
}
