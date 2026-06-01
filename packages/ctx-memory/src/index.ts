/**
 * @pa/ctx-memory — Personal Memory(核心域)
 *
 * 本地、可见可编辑的拟人记忆:语义层(content)+ 情景层(episode)+ 修订史(revisions)。
 * - 增/改/忘 由 agent 工具触发(remember / update_memory / forget_memory),自动执行、可见、可逆。
 * - 遗忘是软删(status=forgotten,可恢复),不真删,保留痕迹以可检视。
 * - 召回:render() 注入精简语义层;情景/历史经 search 懒加载(见 ctx-task / 组合根)。
 * 设计见 research/design-discussion.md「拟人记忆」、domain-model.md 3.5。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export type MemoryKind = "preference" | "fact";
export type MemoryStatus = "active" | "forgotten";

/** 情景层:这条记忆"如何习得"的现场。 */
export interface Episode {
  /** agent 写的"当时在做什么"。 */
  situation?: string;
  /** 触发这条记忆的原话。 */
  quote?: string;
  /** 源会话链接(主进程写入当前 activeSessionId)。 */
  sourceSessionId?: string;
}

/** 一次修订:记下改之前是什么、为什么改。 */
export interface Revision {
  prevContent: string;
  reason: string;
  at: number;
}

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  content: string;
  episode: Episode;
  revisions: Revision[];
  status: MemoryStatus;
  forgottenReason?: string;
  createdAt: number;
  updatedAt: number;
}

/** 公开给 UI 的视图:精简 + 最近一次变更(完整历史按需展开)。 */
export interface MemoryView {
  id: string;
  kind: MemoryKind;
  content: string;
  situation?: string;
  quote?: string;
  sourceSessionId?: string;
  status: MemoryStatus;
  forgottenReason?: string;
  /** 最近一次修订(UI 默认露这条)。 */
  lastChange?: Revision;
  /** 完整修订史(供 UI 展开;注入 prompt 不用它,只用 lastChange)。 */
  revisions: Revision[];
  revisionCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface AddMemoryInput {
  kind: MemoryKind;
  content: string;
  situation?: string;
  quote?: string;
  sourceSessionId?: string;
}

/** 迁移:把旧记录(id/kind/content/createdAt/enabled)补齐到新结构。 */
function normalize(raw: Partial<MemoryItem> & { enabled?: boolean }): MemoryItem {
  const createdAt = raw.createdAt ?? Date.now();
  return {
    id: raw.id ?? crypto.randomUUID(),
    kind: raw.kind ?? "fact",
    content: raw.content ?? "",
    episode: raw.episode ?? {},
    revisions: raw.revisions ?? [],
    status: raw.status ?? (raw.enabled === false ? "forgotten" : "active"),
    forgottenReason: raw.forgottenReason,
    createdAt,
    updatedAt: raw.updatedAt ?? createdAt
  };
}

function toView(i: MemoryItem): MemoryView {
  return {
    id: i.id,
    kind: i.kind,
    content: i.content,
    situation: i.episode.situation,
    quote: i.episode.quote,
    sourceSessionId: i.episode.sourceSessionId,
    status: i.status,
    forgottenReason: i.forgottenReason,
    lastChange: i.revisions[i.revisions.length - 1],
    revisions: i.revisions,
    revisionCount: i.revisions.length,
    createdAt: i.createdAt,
    updatedAt: i.updatedAt
  };
}

export class MemoryStore {
  private items: MemoryItem[] = [];

  constructor(private readonly filePath: string) {
    try {
      const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown[];
      this.items = Array.isArray(raw) ? raw.map((r) => normalize(r as MemoryItem)) : [];
    } catch {
      this.items = [];
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.items, null, 2));
  }

  private find(id: string): MemoryItem | undefined {
    return this.items.find((i) => i.id === id);
  }

  /** 新增一条记忆(含情景)。 */
  add(input: AddMemoryInput): MemoryItem {
    const now = Date.now();
    const item: MemoryItem = {
      id: crypto.randomUUID(),
      kind: input.kind,
      content: input.content,
      episode: { situation: input.situation, quote: input.quote, sourceSessionId: input.sourceSessionId },
      revisions: [],
      status: "active",
      createdAt: now,
      updatedAt: now
    };
    this.items.push(item);
    this.persist();
    return item;
  }

  /** 修订:追加一条 revision(记旧值+原因),更新当前值。 */
  update(id: string, newContent: string, reason: string): MemoryItem | undefined {
    const item = this.find(id);
    if (!item) return undefined;
    item.revisions.push({ prevContent: item.content, reason, at: Date.now() });
    item.content = newContent;
    item.updatedAt = Date.now();
    this.persist();
    return item;
  }

  /** 软遗忘:标记 forgotten(可恢复),不真删。 */
  forget(id: string, reason?: string): void {
    const item = this.find(id);
    if (!item) return;
    item.status = "forgotten";
    item.forgottenReason = reason;
    item.updatedAt = Date.now();
    this.persist();
  }

  /** UI 删除沿用软遗忘语义。 */
  remove(id: string): void {
    this.forget(id);
  }

  /** 恢复一条已遗忘的记忆。 */
  restore(id: string): void {
    const item = this.find(id);
    if (!item) return;
    item.status = "active";
    item.forgottenReason = undefined;
    item.updatedAt = Date.now();
    this.persist();
  }

  /** 活跃记忆视图(UI 主列表)。 */
  list(): MemoryView[] {
    return this.items.filter((i) => i.status === "active").map(toView);
  }

  /** 已遗忘记忆视图(UI"已遗忘"区)。 */
  listForgotten(): MemoryView[] {
    return this.items.filter((i) => i.status === "forgotten").map(toView);
  }

  /** 关键词检索(content / situation / quote),返回完整项供 agent 看来龙去脉。 */
  search(query: string): MemoryItem[] {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    return this.items.filter((i) => {
      if (i.status !== "active") return false;
      const hay = [i.content, i.episode.situation ?? "", i.episode.quote ?? ""].join(" ").toLowerCase();
      return hay.includes(q);
    });
  }

  /**
   * 渲染为上下文注入块(精简语义层,每条带 [id] 供 update/forget 引用);
   * 情景/历史不注入,需 search_memory 拉取。无活跃记忆则返回 undefined。
   */
  render(): string | undefined {
    const active = this.items.filter((i) => i.status === "active");
    if (active.length === 0) return undefined;
    const line = (i: MemoryItem): string => `- [${i.id}] ${i.content}`;
    const prefs = active.filter((i) => i.kind === "preference");
    const facts = active.filter((i) => i.kind === "fact");
    let s = "# 关于这位用户(你之前记住的,据此个性化你的行为;改/忘某条用其 [id])\n";
    if (prefs.length) s += `偏好:\n${prefs.map(line).join("\n")}\n`;
    if (facts.length) s += `事实:\n${facts.map(line).join("\n")}`;
    return s.trim();
  }
}

/** 全部记忆工具名(供组合根登记 Capability / 风险分级)。 */
export const memoryToolNames: ReadonlySet<string> = new Set([
  "remember",
  "update_memory",
  "forget_memory",
  "search_memory"
]);

/** 注入系统提示的记忆使用指南(由组合根收集)*/
export const memoryGuidelines = `## 记忆(像人一样地记)
- **主动记**,别等用户开口。聊着聊着冒出这些就顺手 remember 下来,并写清 situation(当时在做什么)、有原话就记 quote:
  - 用户的持久**偏好/习惯**(preference);关于用户的客观**事实**(fact);
  - 用户**正在推进的项目/目标**、以及影响你以后做法的**决策**(用 fact 记,如"用户在做跨对话记忆功能,已完成滚动摘要与历史检索")。
- 记**跨会话还有用**的;**一次性的任务细节别记**(那些用户需要时能另查,记了只会让记忆变臃肿)。拿不准就先不记。
- **先巩固,再新增**:上文"关于这位用户"段落里每条记忆都带一个 [id]。新信息与某条已有记忆**矛盾或细化**(如改了归档目录、项目又推进了一步),用 update_memory 改那条(写清 reason),不要堆一条打架的新记忆。
- 记忆**过时/不再成立**时用 forget_memory 忘掉它(写清 reason)。遗忘是软的、可恢复,但不要随意忘。
- 想了解某条记忆的来龙去脉(情景、改过几次、为什么改)时,用 search_memory 查它的完整历史,而不是只看注入的那一行。`;

const rememberParams = Type.Object({
  kind: Type.Union([Type.Literal("preference"), Type.Literal("fact")], {
    description: "preference=用户偏好/习惯;fact=关于用户的客观事实"
  }),
  content: Type.String({ description: "要记住的一句话,简洁具体" }),
  situation: Type.String({ description: "当时的情景:用户在做什么、为何提到。例:整理下载文件夹时" }),
  quote: Type.Optional(Type.String({ description: "触发这条记忆的原话(若有)" }))
});

const updateParams = Type.Object({
  id: Type.String({ description: "要修订的记忆 id(见注入列表里的 [id] 或 search_memory 结果)" }),
  newContent: Type.String({ description: "更新后的内容" }),
  reason: Type.String({ description: "为什么改:如『用户把归档目录从 C 盘换到 D 盘』" })
});

const forgetParams = Type.Object({
  id: Type.String({ description: "要遗忘的记忆 id" }),
  reason: Type.String({ description: "为什么不再需要:如『项目已结束』" })
});

const searchParams = Type.Object({
  query: Type.String({ description: "关键词;匹配记忆内容/情景/原话" })
});

function renderHit(i: MemoryItem): string {
  const lines = [`[${i.id}] (${i.kind}) ${i.content}`];
  if (i.episode.situation) lines.push(`  情景:${i.episode.situation}`);
  if (i.episode.quote) lines.push(`  原话:「${i.episode.quote}」`);
  for (const r of i.revisions) {
    lines.push(`  改动:从「${r.prevContent}」→ 因「${r.reason}」`);
  }
  return lines.join("\n");
}

/**
 * 创建记忆工具:remember / update_memory / forget_memory / search_memory。
 * @param onChange 通知 UI 刷新(增/改/忘后)
 * @param getSourceSessionId 取当前会话 id,写入新记忆的情景(在 #13 由组合根接入)
 */
export function createMemoryTools(
  store: MemoryStore,
  onChange?: () => void,
  getSourceSessionId?: () => string | undefined
): AgentTool<any>[] {
  const remember: AgentTool<typeof rememberParams> = {
    name: "remember",
    label: "记住",
    description:
      "记下关于用户的持久偏好或事实(例如默认归档规则、常用目录、格式偏好)。" +
      "只记长期有用的,不记一次性临时信息。记之前先确认它不是对已有记忆的修订(那种用 update_memory)。",
    parameters: rememberParams,
    execute: async (_id, { kind, content, situation, quote }) => {
      const item = store.add({ kind, content, situation, quote, sourceSessionId: getSourceSessionId?.() });
      onChange?.();
      return { content: [{ type: "text", text: `已记住(${kind}):${content}` }], details: { id: item.id } };
    }
  };

  const updateMemory: AgentTool<typeof updateParams> = {
    name: "update_memory",
    label: "更新记忆",
    description: "当某条已有记忆被新信息推翻或细化时,修订它(保留旧值与原因)。优先于堆一条矛盾的新记忆。",
    parameters: updateParams,
    execute: async (_id, { id, newContent, reason }) => {
      const item = store.update(id, newContent, reason);
      onChange?.();
      const text = item ? `已更新记忆:${newContent}(原因:${reason})` : `未找到记忆 ${id}`;
      return { content: [{ type: "text", text }], details: { id, ok: !!item } };
    }
  };

  const forgetMemory: AgentTool<typeof forgetParams> = {
    name: "forget_memory",
    label: "遗忘",
    description: "当某条记忆过时或不再成立时,忘掉它(软删除,可恢复)。",
    parameters: forgetParams,
    execute: async (_id, { id, reason }) => {
      store.forget(id, reason);
      onChange?.();
      return { content: [{ type: "text", text: `已忘掉记忆 ${id}(原因:${reason})` }], details: { id } };
    }
  };

  const searchMemory: AgentTool<typeof searchParams> = {
    name: "search_memory",
    label: "查记忆",
    description: "按关键词查记忆的完整来龙去脉(情景、原话、历次修订),用于了解某条记忆怎么来的、怎么变的。",
    parameters: searchParams,
    execute: async (_id, { query }) => {
      const hits = store.search(query);
      const text = hits.length ? hits.map(renderHit).join("\n\n") : `没有匹配「${query}」的记忆。`;
      return { content: [{ type: "text", text }], details: { count: hits.length } };
    }
  };

  return [remember, updateMemory, forgetMemory, searchMemory];
}
