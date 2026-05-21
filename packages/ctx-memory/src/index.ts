/**
 * @pa/ctx-memory — Personal Memory(核心域)
 *
 * 本地、可见可编辑的轻量记忆:只存"用户偏好 + 关键事实",纯本地 JSON。
 * - remember 工具:agent 主动记下持久信息(非静默:会显示为动作并进记忆列表)
 * - render():把记忆渲染成可注入上下文的提示块(经 transformContext 召回)
 * 详见 research/domain-model.md。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool } from "@earendil-works/pi-agent-core";

export type MemoryKind = "preference" | "fact";

export interface MemoryItem {
  id: string;
  kind: MemoryKind;
  content: string;
  createdAt: number;
  enabled: boolean;
}

/** 公开给 UI 的精简视图 */
export interface MemoryView {
  id: string;
  kind: MemoryKind;
  content: string;
}

export class MemoryStore {
  private items: MemoryItem[] = [];

  constructor(private readonly filePath: string) {
    try {
      this.items = JSON.parse(readFileSync(filePath, "utf8")) as MemoryItem[];
    } catch {
      this.items = [];
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    writeFileSync(this.filePath, JSON.stringify(this.items, null, 2));
  }

  add(kind: MemoryKind, content: string): MemoryItem {
    const item: MemoryItem = { id: crypto.randomUUID(), kind, content, createdAt: Date.now(), enabled: true };
    this.items.push(item);
    this.persist();
    return item;
  }

  remove(id: string): void {
    this.items = this.items.filter((i) => i.id !== id);
    this.persist();
  }

  /** UI 视图(仅启用项)*/
  list(): MemoryView[] {
    return this.items.filter((i) => i.enabled).map((i) => ({ id: i.id, kind: i.kind, content: i.content }));
  }

  /** 渲染为上下文注入块;无记忆则返回 undefined */
  render(): string | undefined {
    const active = this.items.filter((i) => i.enabled);
    if (active.length === 0) return undefined;
    const prefs = active.filter((i) => i.kind === "preference");
    const facts = active.filter((i) => i.kind === "fact");
    let s = "# 关于这位用户(你之前记住的,据此个性化你的行为)\n";
    if (prefs.length) s += `偏好:\n${prefs.map((p) => `- ${p.content}`).join("\n")}\n`;
    if (facts.length) s += `事实:\n${facts.map((f) => `- ${f.content}`).join("\n")}`;
    return s.trim();
  }
}

const rememberParams = Type.Object({
  kind: Type.Union([Type.Literal("preference"), Type.Literal("fact")], {
    description: "preference=用户偏好/习惯;fact=关于用户的客观事实"
  }),
  content: Type.String({ description: "要记住的一句话,简洁具体" })
});

/** 创建记忆工具(remember)。onChange 用于通知 UI 刷新。 */
export function createMemoryTools(store: MemoryStore, onChange?: () => void): AgentTool<any>[] {
  const remember: AgentTool<typeof rememberParams> = {
    name: "remember",
    label: "记住",
    description:
      "当你了解到关于用户的、未来仍有用的持久偏好或事实时,用它记下来" +
      "(例如默认归档规则、常用目录、文档格式偏好)。只记长期有用的,不要记一次性临时信息。",
    parameters: rememberParams,
    execute: async (_id, { kind, content }) => {
      const item = store.add(kind, content);
      onChange?.();
      return { content: [{ type: "text", text: `已记住(${kind}):${content}` }], details: { id: item.id } };
    }
  };
  return [remember];
}
