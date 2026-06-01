/**
 * search_history —— 跨对话深度回忆(第 3 层)。
 *
 * 只读工具:在**本 workspace 的历史会话 transcript** 里按关键词检索,把命中的对话片段拉回上下文。
 * 补"无法查历史对话"那个洞——「近期线索」(滚动摘要)给被动连续性,这个给主动深挖。
 *
 * 刻意只搜 **用户 + 助理的对话文本**,不搜工具结果:既聚焦"意图/决策/聊过啥"这类高信号,
 * 又避开历史里 web_fetch 等外部内容带来的注入面(那是另一条线要单独围栏处理的)。
 */
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { SessionStore } from "@pa/infra";

export const searchHistoryToolName = "search_history";

export interface SearchHistoryDeps {
  /** 当前 workspace 的会话仓(检索其 transcript)。 */
  readonly sessions: SessionStore;
  /** 当前会话 id —— 排除它,它已在上下文里。 */
  readonly currentSessionId: string;
}

const MAX_SESSIONS = 6; // 最多回报几个会话
const MAX_SNIPPETS_PER_SESSION = 3; // 每个会话最多几条片段
const SNIPPET_WINDOW = 140; // 片段窗口字符数

const params = Type.Object({
  query: Type.String({ description: "要在历史对话里搜的关键词(可空格分隔多个词,需全部命中)" }),
  limit: Type.Optional(Type.Number({ description: `最多回报几个历史会话(默认 ${MAX_SESSIONS})` }))
});

/** 从一条消息 content 抽纯文本(string 或 text 块数组)。 */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => (b as { type?: string })?.type === "text")
    .map((b) => b.text)
    .join("");
}

/** 命中 = 所有词(小写)都在文本里。 */
function matches(text: string, terms: string[]): boolean {
  const low = text.toLowerCase();
  return terms.every((t) => low.includes(t));
}

/** 截一段以首个命中词为中心的窗口,前后省略号。 */
function excerpt(text: string, terms: string[]): string {
  const low = text.toLowerCase();
  const idx = Math.min(...terms.map((t) => low.indexOf(t)).filter((i) => i >= 0));
  const start = Math.max(0, idx - SNIPPET_WINDOW / 2);
  const end = Math.min(text.length, start + SNIPPET_WINDOW);
  const body = text.slice(start, end).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + body + (end < text.length ? "…" : "");
}

function ymd(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function result(text: string, details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

/** 创建 search_history 工具(只读;在组合根用当前 ws 的 SessionStore + 当前 sessionId 注入)。 */
export function createSearchHistoryTool(deps: SearchHistoryDeps): AgentTool<typeof params> {
  return {
    name: searchHistoryToolName,
    label: "搜历史对话",
    description:
      "在你和这位用户**过往的对话**里按关键词检索,拿回相关片段。当用户提到'之前/上次/我们聊过/那个…'、" +
      "或你需要回忆早先对话里的意图/决策/细节、而当前上下文和『近期线索』里没有时,用它。只读、不改任何东西。",
    parameters: params,
    execute: async (_id, { query, limit }): Promise<AgentToolResult<unknown>> => {
      const terms = query
        .toLowerCase()
        .split(/\s+/)
        .map((t) => t.trim())
        .filter(Boolean);
      if (!terms.length) return result("请给出要搜索的关键词。", { query, hits: 0 });

      // 搜全部会话(含已归档——回忆正是要翻被收起来的),排除当前会话。
      const records = [...deps.sessions.list(), ...deps.sessions.listArchived()]
        .filter((r) => r.id !== deps.currentSessionId)
        .sort((a, b) => b.updatedAt - a.updatedAt);

      const max = Math.max(1, Math.min(limit ?? MAX_SESSIONS, 12));
      const blocks: string[] = [];
      let hitSessions = 0;

      for (const rec of records) {
        if (hitSessions >= max) break;
        const transcript = deps.sessions.loadTranscript(rec.id);
        if (!Array.isArray(transcript)) continue;
        const snippets: string[] = [];
        for (const m of transcript as { role?: string; content?: unknown }[]) {
          if (m.role !== "user" && m.role !== "assistant") continue; // 只搜对话文本,不碰工具结果
          const text = textOf(m.content).trim();
          if (!text || !matches(text, terms)) continue;
          const who = m.role === "user" ? "用户" : "助理";
          snippets.push(`- ${who}:${excerpt(text, terms)}`);
          if (snippets.length >= MAX_SNIPPETS_PER_SESSION) break;
        }
        if (snippets.length) {
          hitSessions++;
          blocks.push(`## 《${rec.title}》 · ${ymd(rec.updatedAt)}\n${snippets.join("\n")}`);
        }
      }

      if (!blocks.length) {
        return result(`没有在历史对话里找到与「${query}」相关的内容。`, { query, hits: 0 });
      }
      const header = `在 ${hitSessions} 个历史会话里找到与「${query}」相关的片段(越靠前越近):`;
      return result(`${header}\n\n${blocks.join("\n\n")}`, { query, hits: hitSessions });
    }
  };
}
