import { useEffect, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Markdown } from "./Markdown";
import { StepTrace, type ActionRow, type StepGroup } from "./StepTrace";
import { EmptyState } from "./EmptyState";
import { useShell } from "../shell/store";

type MsgItem = { kind: "msg"; id: string; role: "user" | "assistant"; content: string };
type StepItem = { kind: "step" } & StepGroup;
type TimelineItem = MsgItem | StepItem;
type JournalRow = { actionId: string; reverted: boolean };

const base = (p: string): string => p.split(/[/\\]/).pop() || p;

/** 从工具参数提取一句关键摘要(查询词 / 文件名 / 内容),供 step 行展示。 */
function argSummary(tool: string, args: unknown): string {
  const a = (args ?? {}) as Record<string, unknown>;
  const s = (k: string): string => (typeof a[k] === "string" ? (a[k] as string) : "");
  let out = "";
  switch (tool) {
    case "find_files":
    case "grep_files":
      out = s("query") || s("pattern") || s("glob");
      break;
    case "read_file":
    case "extract_document":
    case "list_dir":
    case "write_file":
    case "delete":
      out = base(s("path"));
      break;
    case "move_file":
      out = `${base(s("from"))} → ${base(s("to"))}`;
      break;
    case "remember":
      out = s("content");
      break;
    case "update_memory":
      out = s("newContent");
      break;
    case "forget_memory":
      out = s("reason");
      break;
    case "search_memory":
    case "web_search":
      out = s("query");
      break;
    case "web_fetch":
      out = s("url");
      break;
    default:
      out = (Object.values(a).find((v) => typeof v === "string") as string) ?? "";
  }
  return out.length > 48 ? out.slice(0, 48) + "…" : out;
}

/** 会话面板:消息流 + 内联执行轨迹(step,审批/撤销内联到对应 action 行) */
export function ChatPane(): JSX.Element {
  const { activeSessionId, ensureSession, openArtifact } = useShell();
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [journal, setJournal] = useState<JournalRow[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // 标记:本次 activeSessionId 变化是「为发送而新建会话」,items 已乐观填充,勿回盘清空
  const sentIntoNewSession = useRef(false);

  // 撤销态:已撤销集合 + 当前可撤销(LIFO 栈顶)的 actionId
  const revertedIds = new Set(journal.filter((e) => e.reverted).map((e) => e.actionId));
  const undoableId = [...journal].reverse().find((e) => !e.reverted)?.actionId;

  // 切换会话:载入持久化 timeline(空 id → 清空)
  useEffect(() => {
    if (!activeSessionId) {
      setItems([]);
      return;
    }
    // 发送时刚创建的会话:磁盘还没 transcript,重载会清掉乐观消息与流式内容,跳过这一次
    if (sentIntoNewSession.current) {
      sentIntoNewSession.current = false;
      return;
    }
    void window.pa.session.open(activeSessionId).then((loaded) => setItems(loaded as TimelineItem[]));
  }, [activeSessionId]);

  // 流式消息
  useEffect(() => {
    return window.pa.chat.onStream((event) => {
      if (event.type === "delta") {
        setItems((prev) => appendToLastAssistant(prev, event.text));
      } else if (event.type === "error") {
        setItems((prev) => appendToLastAssistant(prev, `\n\n⚠️ 出错:${event.message}`));
        setStreaming(false);
      } else if (event.type === "done") {
        setStreaming(false);
      }
    });
  }, []);

  // 领域事件 → 内联 step 块
  useEffect(() => {
    return window.pa.domain.onEvent((ev) => {
      if (ev.type === "ActionProposed") {
        setItems((prev) =>
          upsertAction(prev, {
            id: ev.action.id,
            stepId: ev.action.stepId,
            tool: ev.action.tool,
            capability: ev.action.capability,
            status: "running",
            summary: argSummary(ev.action.tool, ev.action.args)
          })
        );
      } else if (ev.type === "ActionExecuted") {
        setItems((prev) => patchAction(prev, ev.actionId, { status: "done" }));
      } else if (ev.type === "ActionFailed") {
        setItems((prev) => patchAction(prev, ev.actionId, { status: "failed", error: ev.error }));
      }
    });
  }, []);

  // 审批请求 → 把对应内联动作切到「待审批」(决策按钮内联在该 action 行)
  useEffect(() => {
    return window.pa.approval.onRequest((req) => {
      setItems((prev) =>
        upsertAction(prev, {
          id: req.actionId,
          stepId: "pending",
          tool: req.tool,
          capability: req.capability,
          status: "awaiting",
          riskLevel: req.riskLevel,
          summary: argSummary(req.tool, req.args)
        })
      );
    });
  }, []);

  // 可查看工具的结果文本(live)→ 回填到对应 action,供"查看"按钮
  useEffect(() => {
    return window.pa.step.onResult((res) => {
      setItems((prev) => patchAction(prev, res.actionId, { resultBody: res.body }));
    });
  }, []);

  // journal(撤销态)
  useEffect(() => {
    void window.pa.reversibility.list().then(setJournal);
    return window.pa.reversibility.onChanged(setJournal);
  }, []);

  const onApprove = (actionId: string, approved: boolean): void => {
    window.pa.approval.resolve(actionId, approved);
    setItems((prev) =>
      patchAction(prev, actionId, approved ? { status: "running" } : { status: "failed", error: "已拒绝" })
    );
  };

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [items]);

  // 示例卡:把提示填进输入框并聚焦,让用户补全(网页调研/读 PDF 等需要具体目标)后再发送
  const pickExample = (text: string): void => {
    setInput(text);
    requestAnimationFrame(() => {
      const el = inputRef.current;
      if (el) {
        el.focus();
        el.setSelectionRange(el.value.length, el.value.length);
      }
    });
  };

  const send = (textArg?: string): void => {
    const text = (textArg ?? input).trim();
    if (!text || streaming) return;
    // 无会话时本次发送会创建会话并切换 activeSessionId;同步置标记,避免 reload effect 清空乐观消息
    if (!activeSessionId) sentIntoNewSession.current = true;
    setItems((prev) => [
      ...prev,
      { kind: "msg", id: crypto.randomUUID(), role: "user", content: text },
      { kind: "msg", id: crypto.randomUUID(), role: "assistant", content: "" }
    ]);
    setInput("");
    setStreaming(true);
    void ensureSession().then((sessionId) => window.pa.chat.send(sessionId, text));
  };

  const stop = (): void => {
    if (activeSessionId) window.pa.chat.stop(activeSessionId);
  };

  const empty = items.length === 0;

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-[760px] space-y-4 px-5 py-6">
          {empty && <EmptyState onPick={pickExample} />}
          {items.map((it) =>
            it.kind === "step" ? (
              <StepTrace
                key={it.stepId}
                group={it}
                onApprove={onApprove}
                undoableId={undoableId}
                revertedIds={revertedIds}
                onUndo={() => void window.pa.reversibility.undoLast()}
                onView={(art) => openArtifact({ id: art.id, kind: "text", title: art.title, body: art.body })}
              />
            ) : (
              <div key={it.id} className={it.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div
                  className={
                    "max-w-[88%] select-text rounded-xl px-4 py-2.5 text-[13.5px] leading-relaxed " +
                    (it.role === "user"
                      ? "whitespace-pre-wrap bg-stone-100 text-stone-800 ring-1 ring-black/[0.04] dark:bg-ink-800 dark:text-stone-100 dark:ring-white/10"
                      : "bg-white text-stone-700 ring-1 ring-stone-200/70 dark:bg-ink-900 dark:text-stone-100 dark:ring-white/5")
                  }
                >
                  {it.role === "user" ? (
                    it.content
                  ) : it.content ? (
                    <Markdown>{it.content}</Markdown>
                  ) : streaming ? (
                    <Dots />
                  ) : null}
                </div>
              </div>
            )
          )}
        </div>
      </div>

      <div className="shrink-0">
        <div className="mx-auto w-full max-w-[760px] px-4 pb-5 pt-2">
          <div className="no-drag flex items-end gap-2 rounded-xl border border-stone-200 bg-white p-2 transition focus-within:border-ember-400 focus-within:ring-2 focus-within:ring-ember-500/15 dark:border-white/10 dark:bg-ink-900 dark:focus-within:border-ember-500/60 dark:focus-within:ring-ember-500/20">
            <textarea
              ref={inputRef}
              rows={1}
              className="max-h-32 flex-1 resize-none bg-transparent px-2 py-1.5 text-[13.5px] text-stone-700 outline-none placeholder:text-stone-500 dark:text-stone-100 dark:placeholder:text-stone-500"
              placeholder="发消息给助理…  (Enter 发送 · Shift+Enter 换行)"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            {streaming ? (
              <button
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-stone-700 text-white transition hover:bg-stone-800 dark:bg-ink-700 dark:hover:bg-ink-600"
                onClick={stop}
                aria-label="停止"
                title="停止"
              >
                <Square size={14} strokeWidth={2.5} className="fill-current" />
              </button>
            ) : (
              <button
                className="flex h-8 w-8 items-center justify-center rounded-lg bg-ember-500 text-ink-900 shadow-glow transition hover:bg-ember-400 disabled:opacity-30 disabled:shadow-none"
                onClick={() => send()}
                disabled={input.trim() === ""}
                aria-label="发送"
              >
                <ArrowUp size={16} strokeWidth={2.5} />
              </button>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

function Dots(): JSX.Element {
  return (
    <span className="inline-flex gap-1">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-stone-300 [animation-delay:-0.3s] dark:bg-ink-600" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-stone-300 [animation-delay:-0.15s] dark:bg-ink-600" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-stone-300 dark:bg-ink-600" />
    </span>
  );
}

function appendToLastAssistant(items: TimelineItem[], text: string): TimelineItem[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (!it) continue;
    if (it.kind === "msg" && it.role === "assistant") {
      const next = items.slice();
      next[i] = { ...it, content: it.content + text };
      return next;
    }
    if (it.kind === "msg" && it.role === "user") break;
  }
  return items;
}

/** 按 stepId 归组插入/更新动作:已有 step 块则追加,否则新建带递增序号的 step 块 */
function upsertAction(items: TimelineItem[], action: ActionRow): TimelineItem[] {
  const existingById = items.some(
    (it) => it.kind === "step" && it.actions.some((a) => a.id === action.id)
  );
  if (existingById) return patchAction(items, action.id, action);

  const idx = items.findIndex((it) => it.kind === "step" && it.stepId === action.stepId);
  if (idx >= 0) {
    const step = items[idx] as StepItem;
    const next = items.slice();
    next[idx] = { ...step, actions: [...step.actions, action] };
    return next;
  }
  const stepCount = items.filter((it) => it.kind === "step").length;
  return [...items, { kind: "step", stepId: action.stepId, index: stepCount + 1, actions: [action] }];
}

function patchAction(
  items: TimelineItem[],
  actionId: string,
  patch: Partial<ActionRow>
): TimelineItem[] {
  return items.map((it) => {
    if (it.kind !== "step" || !it.actions.some((a) => a.id === actionId)) return it;
    return { ...it, actions: it.actions.map((a) => (a.id === actionId ? { ...a, ...patch } : a)) };
  });
}
