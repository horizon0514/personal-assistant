import { useEffect, useRef, useState } from "react";
import { ArrowUp, Undo2 } from "lucide-react";
import { Markdown } from "./Markdown";
import { ApprovalBanner } from "./ApprovalBanner";
import { StepTrace, type ActionRow, type StepGroup } from "./StepTrace";
import { useShell } from "../shell/store";

type MsgItem = { kind: "msg"; id: string; role: "user" | "assistant"; content: string };
type StepItem = { kind: "step" } & StepGroup;
type TimelineItem = MsgItem | StepItem;

/** 会话面板:消息流 + 内联执行轨迹(step) + 输入 + 审批横幅 */
export function ChatPane(): JSX.Element {
  const { activeSessionId, ensureSession } = useShell();
  const [items, setItems] = useState<TimelineItem[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [undoable, setUndoable] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  // 切换会话:载入持久化 timeline(空 id → 清空)
  useEffect(() => {
    if (!activeSessionId) {
      setItems([]);
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
            status: "running"
          })
        );
      } else if (ev.type === "ActionExecuted") {
        setItems((prev) => patchAction(prev, ev.actionId, { status: "done" }));
      } else if (ev.type === "ActionFailed") {
        setItems((prev) => patchAction(prev, ev.actionId, { status: "failed", error: ev.error }));
      }
    });
  }, []);

  // 审批请求 → 把对应内联动作切到「待审批」(决策按钮在 ApprovalBanner)
  useEffect(() => {
    return window.pa.approval.onRequest((req) => {
      setItems((prev) =>
        upsertAction(prev, {
          id: req.actionId,
          stepId: "pending",
          tool: req.tool,
          capability: req.capability,
          status: "awaiting",
          riskLevel: req.riskLevel
        })
      );
    });
  }, []);

  // 撤销可用性
  useEffect(() => {
    void window.pa.reversibility.list().then((j) => setUndoable(j.some((x) => !x.reverted)));
    return window.pa.reversibility.onChanged((j) => setUndoable(j.some((x) => !x.reverted)));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [items]);

  const send = (): void => {
    const text = input.trim();
    if (!text || streaming) return;
    setItems((prev) => [
      ...prev,
      { kind: "msg", id: crypto.randomUUID(), role: "user", content: text },
      { kind: "msg", id: crypto.randomUUID(), role: "assistant", content: "" }
    ]);
    setInput("");
    setStreaming(true);
    void ensureSession().then((sessionId) => window.pa.chat.send(sessionId, text));
  };

  const empty = items.length === 0;

  return (
    <section className="flex min-w-0 flex-1 flex-col">
      <div ref={scrollRef} className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-[760px] space-y-4 px-5 py-6">
          {empty && (
            <div className="flex h-[60vh] flex-col items-center justify-center text-center">
              <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-2xl dark:bg-emerald-500/15">
                🌿
              </div>
              <p className="text-sm text-slate-400 dark:text-slate-500">想让我帮你做点什么?</p>
            </div>
          )}
          {items.map((it) =>
            it.kind === "step" ? (
              <StepTrace key={it.stepId} group={it} />
            ) : (
              <div key={it.id} className={it.role === "user" ? "flex justify-end" : "flex justify-start"}>
                <div
                  className={
                    "max-w-[88%] rounded-2xl px-4 py-2.5 text-[13.5px] leading-relaxed " +
                    (it.role === "user"
                      ? "whitespace-pre-wrap bg-emerald-500 text-white shadow-sm shadow-emerald-500/20 dark:bg-emerald-600"
                      : "bg-white text-slate-700 shadow-sm ring-1 ring-slate-200/80 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700")
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
          <ApprovalBanner />
          {undoable && (
            <div className="no-drag mb-2 flex justify-end">
              <button
                className="rounded-lg border border-slate-200 px-2.5 py-1 text-[12px] text-slate-600 transition hover:bg-slate-100 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
                onClick={() => void window.pa.reversibility.undoLast()}
                title="撤销最近一次可逆操作"
              >
                <Undo2 size={13} className="mr-1 inline" />
                撤销上一步
              </button>
            </div>
          )}
          <div className="no-drag flex items-end gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm focus-within:border-emerald-300 focus-within:ring-2 focus-within:ring-emerald-100 dark:border-slate-700 dark:bg-slate-800 dark:focus-within:border-emerald-500/60 dark:focus-within:ring-emerald-500/20">
            <textarea
              rows={1}
              className="max-h-32 flex-1 resize-none bg-transparent px-2 py-1.5 text-[13.5px] text-slate-700 outline-none placeholder:text-slate-400 dark:text-slate-100 dark:placeholder:text-slate-500"
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
            <button
              className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-500 text-white transition hover:bg-emerald-600 disabled:opacity-30"
              onClick={send}
              disabled={streaming || input.trim() === ""}
              aria-label="发送"
            >
              <ArrowUp size={16} strokeWidth={2.5} />
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}

function Dots(): JSX.Element {
  return (
    <span className="inline-flex gap-1">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-300 [animation-delay:-0.3s] dark:bg-slate-600" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-300 [animation-delay:-0.15s] dark:bg-slate-600" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-300 dark:bg-slate-600" />
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
