/**
 * 把持久化的 transcript(pi 的 AgentMessage[])映射回渲染层的 timeline。
 * 在主进程做映射,使 pi 的 Message 类型不外泄到渲染层 —— 渲染层只认
 * { kind:"msg" } / { kind:"step" } 这套与实时事件一致的形状。
 *
 * 规则:
 * - user 消息 → 文本气泡
 * - assistant 消息:文本块 → 气泡;toolCall 块 → 归入「本轮」一个 step
 * - toolResult 消息 → 按 toolCallId 回填对应动作的成功/失败状态
 */
import type { AgentMessage } from "@pa/ctx-task";
import type { Capability } from "@pa/domain-core";

/** 结果可在 artifact 面板查看的工具(产出文本内容的只读类)。 */
export const VIEWABLE_TOOLS: ReadonlySet<string> = new Set([
  "read_file",
  "extract_document",
  "list_dir",
  "find_files",
  "grep_files",
  "web_search",
  "web_fetch"
]);

interface TimelineAction {
  id: string;
  stepId: string;
  tool: string;
  capability: Capability;
  status: "done" | "failed";
  error?: string;
  /** 工具结果文本(仅 VIEWABLE_TOOLS),供"查看"按钮在 artifact 面板展示 */
  resultBody?: string;
}
type TimelineItem =
  | { kind: "msg"; id: string; role: "user" | "assistant"; content: string }
  | { kind: "step"; stepId: string; index: number; actions: TimelineAction[] };

type AnyMsg = AgentMessage & { role?: string; content?: unknown; toolCallId?: string; toolName?: string; isError?: boolean };

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => (b as { type?: string })?.type === "text")
    .map((b) => b.text)
    .join("");
}

export function transcriptToTimeline(
  transcript: unknown,
  capabilityOf: (tool: string) => Capability
): TimelineItem[] {
  if (!Array.isArray(transcript)) return [];
  const items: TimelineItem[] = [];
  const actionIndex = new Map<string, TimelineAction>(); // toolCallId → action(供 toolResult 回填)
  let stepCount = 0;
  let msgCount = 0;

  for (const raw of transcript as AnyMsg[]) {
    if (raw.role === "user") {
      const text = textOf(raw.content);
      if (text.trim()) items.push({ kind: "msg", id: `m${msgCount++}`, role: "user", content: text });
    } else if (raw.role === "assistant") {
      const text = textOf(raw.content);
      if (text.trim()) items.push({ kind: "msg", id: `m${msgCount++}`, role: "assistant", content: text });

      const calls = Array.isArray(raw.content)
        ? (raw.content as { type?: string; id?: string; name?: string }[]).filter(
            // propose_plan / ask_user 在 live 有专门交互卡,轨迹里不重复呈现(与实时一致)
            (b) => b.type === "toolCall" && b.name !== "propose_plan" && b.name !== "ask_user"
          )
        : [];
      if (calls.length) {
        const stepId = `step-${stepCount}`;
        const actions: TimelineAction[] = calls.map((c) => {
          const a: TimelineAction = {
            id: c.id ?? crypto.randomUUID(),
            stepId,
            tool: c.name ?? "tool",
            capability: capabilityOf(c.name ?? ""),
            status: "done"
          };
          actionIndex.set(a.id, a);
          return a;
        });
        items.push({ kind: "step", stepId, index: ++stepCount, actions });
      }
    } else if (raw.role === "toolResult" && raw.toolCallId) {
      const a = actionIndex.get(raw.toolCallId);
      if (a && raw.isError) {
        a.status = "failed";
        a.error = textOf(raw.content);
      } else if (a && VIEWABLE_TOOLS.has(a.tool)) {
        const body = textOf(raw.content);
        if (body.trim()) a.resultBody = body;
      }
    }
  }
  return items;
}
