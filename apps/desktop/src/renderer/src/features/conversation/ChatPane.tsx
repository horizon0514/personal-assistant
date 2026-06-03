import { useEffect, useRef, useState } from "react";
import { ArrowUp, HelpCircle, Paperclip, Square, X } from "lucide-react";
import { Markdown } from "./Markdown";
import { TurnTrace, type ActionRow, type StepGroup } from "./StepTrace";
import { EmptyState } from "./EmptyState";
import { useShell } from "../shell/store";

type MsgItem = { kind: "msg"; id: string; role: "user" | "assistant"; content: string };
type StepItem = { kind: "step" } & StepGroup;
type PlanItem = {
  kind: "plan";
  id: string; // requestId
  // awaiting:刚收到,展示三按钮
  // awaiting-feedback:用户点了「调一下」,卡片保持可见 + 等主输入框反馈(agent 仍挂着)
  // revised:用户已提交反馈,等新版本(留痕)
  // confirmed/cancelled:终态,留痕
  status: "awaiting" | "awaiting-feedback" | "revised" | "confirmed" | "cancelled";
  deliverables: string[];
  criteria: string[];
};
type AskItem = {
  kind: "ask";
  id: string; // requestId
  question: string;
  options: string[];
  status: "awaiting" | "answered";
  answer?: string;
};
type TimelineItem = MsgItem | StepItem | PlanItem | AskItem;
/** 自查指示器状态:idle 隐藏;reviewing 显示"自查中…";retrying 显示"在修一些问题…"。 */
type ReviewState = "idle" | "reviewing" | "retrying";
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
  // 拖入的附件:{ 显示名, 本地源路径 };发送时 main 会拷进会话附件目录并把绝对路径喂 agent。
  const [attachments, setAttachments] = useState<{ name: string; path: string }[]>([]);
  const [dragOver, setDragOver] = useState(false);
  const [streaming, setStreaming] = useState(false);
  const [reviewState, setReviewState] = useState<ReviewState>("idle");
  // 当前是否有 plan 在等主输入框反馈(用户点了「不对,调一下」):
  // 有 → 下一条主输入消息作为 plan feedback 喂回工具,而非开新一轮 chat
  const [pendingPlanFeedbackId, setPendingPlanFeedbackId] = useState<string | null>(null);
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
        setReviewState("idle");
      } else if (event.type === "done") {
        setStreaming(false);
        setReviewState("idle");
      }
    });
  }, []);

  // 领域事件 → 内联 step 块
  useEffect(() => {
    return window.pa.domain.onEvent((ev) => {
      if (ev.type === "ActionProposed") {
        // propose_plan / ask_user 有专门的交互卡,不再在 step 轨迹里重复一行
        if (ev.action.tool === "propose_plan" || ev.action.tool === "ask_user") return;
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
      } else if (ev.type === "EvaluationStarted") {
        // 内部质量门:不展示 verdict 详情,只在末尾显示一个轻量"自查中"指示
        setReviewState("reviewing");
      } else if (ev.type === "EvaluationCompleted") {
        if (ev.retrying) {
          // 乐观流式回滚:这段已流式呈现的 final 汇报未通过自查 → 撤回(清空该气泡),
          // 状态切到"在修一些问题",修正版本随后流式补入同一气泡。
          setReviewState("retrying");
          setItems((prev) => clearLastAssistant(prev));
        } else {
          // 通过 / 已耗尽 retry:收掉指示器,pendingFinal 由 ctx-task flush 进当前 assistant 气泡
          setReviewState("idle");
        }
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

  // 工具执行中的进度提示(如扫描件 OCR / 下载语言包)→ 显示在对应 step 行(仅 running 时)
  useEffect(() => {
    return window.pa.step.onProgress((p) => {
      setItems((prev) => patchAction(prev, p.actionId, { note: p.note }));
    });
  }, []);

  // Work Plan:执行器动手前起草 → 弹可编辑的对齐卡
  useEffect(() => {
    return window.pa.plan.onRequest((req) => {
      setItems((prev) => [
        ...prev,
        {
          kind: "plan",
          id: req.requestId,
          status: "awaiting",
          deliverables: req.deliverables,
          criteria: req.criteria
        }
      ]);
    });
  }, []);

  const onConfirmPlan = (requestId: string, deliverables: string[], criteria: string[]): void => {
    window.pa.plan.resolve(requestId, { kind: "confirm", plan: { deliverables, criteria } });
    setItems((prev) => patchPlan(prev, requestId, { status: "confirmed", deliverables, criteria }));
    if (pendingPlanFeedbackId === requestId) setPendingPlanFeedbackId(null);
  };
  const onCancelPlan = (requestId: string): void => {
    window.pa.plan.resolve(requestId, { kind: "cancel" });
    setItems((prev) => patchPlan(prev, requestId, { status: "cancelled" }));
    if (pendingPlanFeedbackId === requestId) setPendingPlanFeedbackId(null);
  };
  // 「不对,调一下」:不立刻 resolve agent,卡片保持可见切到 awaiting-feedback,
  // 主输入框 hijack 下一条消息作为反馈(走 plan:resolve feedback 路径)
  const onAdjustPlan = (requestId: string): void => {
    setItems((prev) => patchPlan(prev, requestId, { status: "awaiting-feedback" }));
    setPendingPlanFeedbackId(requestId);
    requestAnimationFrame(() => inputRef.current?.focus());
  };

  // ask_user:执行中需用户拍板 → 弹提问卡(暂停 agent 直到回答)
  useEffect(() => {
    return window.pa.ask.onRequest((req) => {
      setItems((prev) => [
        ...prev,
        { kind: "ask", id: req.requestId, question: req.question, options: req.options, status: "awaiting" }
      ]);
    });
  }, []);

  const onAnswer = (requestId: string, answer: string): void => {
    const text = answer.trim();
    if (!text) return;
    window.pa.ask.resolve(requestId, text);
    setItems((prev) => patchAsk(prev, requestId, { status: "answered", answer: text }));
  };

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

  // 防止拖文件到窗口任意处时 Electron 把整窗导航到 file:// (覆盖默认行为,只在 drop 区接管)
  useEffect(() => {
    const prevent = (e: DragEvent): void => e.preventDefault();
    window.addEventListener("dragover", prevent);
    window.addEventListener("drop", prevent);
    return () => {
      window.removeEventListener("dragover", prevent);
      window.removeEventListener("drop", prevent);
    };
  }, []);

  const onDragOver = (e: React.DragEvent): void => {
    if (!Array.from(e.dataTransfer.types).includes("Files")) return; // 只接管拖文件,不接管选区拖拽
    e.preventDefault();
    setDragOver(true);
  };
  const onDrop = (e: React.DragEvent): void => {
    e.preventDefault();
    setDragOver(false);
    const next = Array.from(e.dataTransfer.files)
      .map((f) => ({ name: f.name, path: window.pa.files.pathForDropped(f) }))
      .filter((a) => a.path); // 取不到本地路径的(非真实文件)跳过
    if (next.length) setAttachments((prev) => [...prev, ...next]);
  };
  const removeAttachment = (i: number): void => setAttachments((prev) => prev.filter((_, idx) => idx !== i));

  const send = (textArg?: string): void => {
    const text = (textArg ?? input).trim();
    const atts = attachments;
    if (!text && atts.length === 0) return;

    // Hijack:plan 在等反馈 → 把消息喂回 plan 工具,不开新一轮 chat(agent loop 仍挂着等回应)
    if (pendingPlanFeedbackId) {
      if (!text) return; // 改计划只走文本,附件在此场景无意义
      const planId = pendingPlanFeedbackId;
      window.pa.plan.resolve(planId, { kind: "feedback", text });
      setItems((prev) => [
        ...patchPlan(prev, planId, { status: "revised" }),
        { kind: "msg", id: crypto.randomUUID(), role: "user", content: text }
      ]);
      setInput("");
      setPendingPlanFeedbackId(null);
      return;
    }

    // 自查/返工期间(reviewState 非 idle)final 汇报早已流式呈现,放用户发新消息——
    // 这等于"这版我认了 / 换个方向",后端会打断验收闭环、按新消息接着开。其余流式态仍拦着。
    if (streaming && reviewState === "idle") return;
    // 无会话时本次发送会创建会话并切换 activeSessionId;同步置标记,避免 reload effect 清空乐观消息
    if (!activeSessionId) sentIntoNewSession.current = true;
    // 乐观气泡内容须与 main 落盘的用户消息一致(text + 文件名 📎),否则重开会话会跳一下。
    const names = atts.map((a) => a.name);
    const content = names.length > 0 ? `${text}${text ? "\n\n" : ""}📎 附件:${names.join("、")}` : text;
    setItems((prev) => [
      ...prev,
      { kind: "msg", id: crypto.randomUUID(), role: "user", content },
      { kind: "msg", id: crypto.randomUUID(), role: "assistant", content: "" }
    ]);
    setInput("");
    setAttachments([]);
    setStreaming(true);
    setReviewState("idle"); // 若是在自查/返工期发的:本轮验收即将被后端打断,先把指示器收掉
    const paths = atts.map((a) => a.path);
    void ensureSession().then((sessionId) => window.pa.chat.send(sessionId, text, paths.length ? paths : undefined));
  };

  const stop = (): void => {
    if (activeSessionId) window.pa.chat.stop(activeSessionId);
  };

  const empty = items.length === 0;

  return (
    <section
      className="relative flex min-w-0 flex-1 flex-col"
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        // 仅当真正离开整个 section(而非进入子元素)才收起拖拽态
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false);
      }}
      onDrop={onDrop}
    >
      {dragOver && (
        <div className="pointer-events-none absolute inset-2.5 z-50 flex items-center justify-center rounded-2xl border-2 border-dashed border-ember-400/80 bg-ember-50/70 backdrop-blur-[1px] dark:border-ember-500/60 dark:bg-ember-500/10">
          <div className="flex items-center gap-2 text-[13.5px] font-medium text-ember-700 dark:text-ember-200">
            <Paperclip size={16} />
            松开以添加为附件
          </div>
        </div>
      )}
      <div ref={scrollRef} className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-[760px] space-y-4 px-5 py-6">
          {empty && <EmptyState onPick={pickExample} />}
          {groupTimeline(items).map((it, idx, arr) =>
            // 空的 assistant 气泡:仅当它是队尾且仍在流式时显示「思考中」(Dots);否则(已被 step
            // 或后续文字接管)直接跳过,避免重建时不存在、实时却冒出空气泡
            it.kind === "msg" && it.role === "assistant" && !it.content && !(streaming && idx === arr.length - 1) ? null : it.kind === "turn" ? (
              <TurnTrace
                key={it.groups[0]?.stepId ?? it.key}
                groups={it.groups}
                onApprove={onApprove}
                undoableId={undoableId}
                revertedIds={revertedIds}
                onUndo={() => void window.pa.reversibility.undoLast()}
                onView={(art) => openArtifact({ id: art.id, kind: "text", title: art.title, body: art.body })}
              />
            ) : it.kind === "plan" ? (
              <PlanCard
                key={it.id}
                item={it}
                onConfirm={onConfirmPlan}
                onAdjust={onAdjustPlan}
                onCancel={onCancelPlan}
              />
            ) : it.kind === "ask" ? (
              <AskCard key={it.id} item={it} onAnswer={onAnswer} />
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
                    <span className="inline-flex items-center gap-2">
                      <Dots />
                      {reviewState === "reviewing" && (
                        <span className="text-[12px] text-stone-500 dark:text-stone-400">自查中…</span>
                      )}
                      {reviewState === "retrying" && (
                        <span className="text-[12px] text-stone-500 dark:text-stone-400">在修一些问题…</span>
                      )}
                    </span>
                  ) : null}
                </div>
              </div>
            )
          )}
        </div>
      </div>

      <div className="shrink-0">
        <div className="mx-auto w-full max-w-[760px] px-4 pb-5 pt-2">
          {attachments.length > 0 && (
            <div className="no-drag mb-1.5 flex flex-wrap gap-1.5">
              {attachments.map((a, i) => (
                <span
                  key={`${a.path}-${i}`}
                  className="flex max-w-[220px] items-center gap-1.5 rounded-lg bg-stone-100 py-1 pl-2 pr-1 text-[12px] text-stone-600 ring-1 ring-black/[0.04] dark:bg-ink-800 dark:text-stone-300 dark:ring-white/10"
                  title={a.name}
                >
                  <Paperclip size={12} className="shrink-0 text-stone-400" />
                  <span className="truncate">{a.name}</span>
                  <button
                    className="flex h-4 w-4 shrink-0 items-center justify-center rounded text-stone-400 transition hover:bg-stone-200 hover:text-stone-600 dark:hover:bg-ink-700"
                    onClick={() => removeAttachment(i)}
                    aria-label={`移除 ${a.name}`}
                  >
                    <X size={11} strokeWidth={2.5} />
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="no-drag flex items-end gap-2 rounded-xl border border-stone-200 bg-white p-2 transition focus-within:border-ember-400 focus-within:ring-2 focus-within:ring-ember-500/15 dark:border-white/10 dark:bg-ink-900 dark:focus-within:border-ember-500/60 dark:focus-within:ring-ember-500/20">
            <textarea
              ref={inputRef}
              rows={1}
              className="max-h-32 flex-1 resize-none bg-transparent px-2 py-1.5 text-[13.5px] text-stone-700 outline-none placeholder:text-stone-500 dark:text-stone-100 dark:placeholder:text-stone-500"
              placeholder={
                pendingPlanFeedbackId
                  ? "告诉它怎么调上面的计划…  (Enter 发送)"
                  : "发消息给助理…  (Enter 发送 · Shift+Enter 换行)"
              }
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send();
                }
              }}
            />
            {streaming && reviewState === "idle" && !pendingPlanFeedbackId ? (
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
                disabled={input.trim() === "" && attachments.length === 0}
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

/** 开工对齐卡:只展示 AI 提案 + 三按钮;调整走自然语言(关卡片、focus 输入框,让用户输入反馈,模型自己再起草新版本)。 */
function PlanCard({
  item,
  onConfirm,
  onAdjust,
  onCancel
}: {
  item: PlanItem;
  onConfirm: (requestId: string, deliverables: string[], criteria: string[]) => void;
  onAdjust: (requestId: string) => void;
  onCancel: (requestId: string) => void;
}): JSX.Element {
  // 终态:留痕显示
  if (item.status === "confirmed" || item.status === "cancelled" || item.status === "revised") {
    const tone =
      item.status === "confirmed"
        ? "text-stone-600 ring-stone-200/70 dark:text-stone-300 dark:ring-white/10"
        : "text-stone-400 ring-stone-200/70 dark:text-stone-500 dark:ring-white/10";
    const label =
      item.status === "confirmed"
        ? "📋 已对齐,按此交付"
        : item.status === "revised"
          ? "✏️ 已示意调整,看下方新版本"
          : "已取消";
    return (
      <div className={"w-full rounded-xl bg-white px-3.5 py-2.5 text-[12.5px] ring-1 dark:bg-ink-900 " + tone}>
        <div className="font-medium">{label}</div>
        {item.status === "confirmed" && (
          <>
            <PlanList title="交付物" items={item.deliverables} />
            <PlanList title="验收标准" items={item.criteria} />
          </>
        )}
      </div>
    );
  }

  // awaiting / awaiting-feedback:展示 plan + 按钮(awaiting-feedback 时禁用主操作 + 提示在下方输入反馈)
  const isAwaitingFeedback = item.status === "awaiting-feedback";
  return (
    <div className="w-full rounded-xl bg-white px-3.5 py-3 text-[12.5px] text-stone-700 ring-1 ring-ember-200/70 dark:bg-ink-900 dark:text-stone-200 dark:ring-ember-500/25">
      <div className="mb-2 font-medium">📋 动手前先对齐一下这次要交付什么</div>
      <PlanList title="交付物" items={item.deliverables} />
      <PlanList title="验收标准" items={item.criteria} />
      {isAwaitingFeedback && (
        <div className="mt-2.5 rounded-md bg-ember-50/60 px-2.5 py-1.5 text-[12px] text-stone-600 dark:bg-ember-500/10 dark:text-stone-300">
          💬 在下方输入你的反馈(例如:加一条 X / 把交付物 2 改成…),发送后让它重新起草
        </div>
      )}
      <div className="mt-3 flex flex-wrap gap-2">
        <button
          className="rounded-md bg-ember-500 px-3 py-1 font-medium text-ink-900 transition hover:bg-ember-400"
          onClick={() => onConfirm(item.id, item.deliverables, item.criteria)}
        >
          {isAwaitingFeedback ? "改主意了,就这么干" : "就这么干"}
        </button>
        {!isAwaitingFeedback && (
          <button
            className="rounded-md px-3 py-1 text-stone-600 ring-1 ring-stone-200 transition hover:bg-stone-50 dark:text-stone-300 dark:ring-white/10 dark:hover:bg-ink-800"
            onClick={() => onAdjust(item.id)}
          >
            不对,调一下
          </button>
        )}
        <button
          className="ml-auto rounded-md px-3 py-1 text-stone-400 transition hover:text-stone-600 dark:text-stone-500 dark:hover:text-stone-300"
          onClick={() => onCancel(item.id)}
        >
          取消
        </button>
      </div>
    </div>
  );
}

function PlanList({ title, items }: { title: string; items: string[] }): JSX.Element {
  return (
    <div className="mt-1">
      <span className="text-stone-500 dark:text-stone-400">{title}:</span>
      <ul className="list-disc space-y-0.5 pl-4">
        {items.map((x, i) => (
          <li key={i}>{x}</li>
        ))}
      </ul>
    </div>
  );
}

/** ask_user 提问卡:待回答时给选项按钮 + 自由输入;回答后只读留痕。 */
function AskCard({
  item,
  onAnswer
}: {
  item: AskItem;
  onAnswer: (requestId: string, answer: string) => void;
}): JSX.Element {
  const [text, setText] = useState("");

  if (item.status === "answered") {
    return (
      <div className="flex justify-start">
        <div className="max-w-[88%] rounded-xl bg-white px-3 py-2 text-[12.5px] text-stone-600 ring-1 ring-stone-200/70 dark:bg-ink-900 dark:text-stone-300 dark:ring-white/10">
          <div className="flex items-center gap-1.5 font-medium">
            <HelpCircle size={13} className="text-stone-400" />
            <span>{item.question}</span>
          </div>
          <p className="mt-1 text-stone-500 dark:text-stone-400">你的回答:{item.answer}</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[88%] rounded-xl bg-white px-3 py-2.5 text-[12.5px] text-stone-700 ring-1 ring-ember-200/70 dark:bg-ink-900 dark:text-stone-200 dark:ring-ember-500/25">
        <div className="mb-2 flex items-center gap-1.5 font-medium">
          <HelpCircle size={14} className="text-ember-500" />
          <span>{item.question}</span>
        </div>
        {item.options.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-1.5">
            {item.options.map((opt, i) => (
              <button
                key={i}
                className="rounded-md bg-ember-500 px-2.5 py-1 text-[11.5px] font-medium text-ink-900 transition hover:bg-ember-400"
                onClick={() => onAnswer(item.id, opt)}
              >
                {opt}
              </button>
            ))}
          </div>
        )}
        <div className="flex items-end gap-2">
          <textarea
            rows={1}
            className="max-h-24 flex-1 resize-none rounded-md border border-stone-200 bg-transparent px-2 py-1 text-[12.5px] outline-none focus:border-ember-400 dark:border-white/10"
            placeholder={item.options.length > 0 ? "或自己补充…" : "输入你的回答…"}
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                onAnswer(item.id, text);
              }
            }}
          />
          <button
            className="rounded-md bg-stone-100 px-3 py-1 text-[11.5px] text-stone-600 transition hover:bg-stone-200 disabled:opacity-30 dark:bg-ink-700 dark:text-stone-200 dark:hover:bg-ink-600"
            disabled={text.trim() === ""}
            onClick={() => onAnswer(item.id, text)}
          >
            回答
          </button>
        </div>
      </div>
    </div>
  );
}

function patchPlan(
  items: TimelineItem[],
  requestId: string,
  patch: Partial<Omit<PlanItem, "kind" | "id">>
): TimelineItem[] {
  return items.map((it) =>
    it.kind === "plan" && it.id === requestId ? { ...it, ...patch } : it
  );
}

function patchAsk(
  items: TimelineItem[],
  requestId: string,
  patch: Partial<Omit<AskItem, "kind" | "id">>
): TimelineItem[] {
  return items.map((it) => (it.kind === "ask" && it.id === requestId ? { ...it, ...patch } : it));
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

/** 渲染单元:把连续的 step 块合并成「一轮」,交给 TurnTrace 收成 live 行 / 折叠 chip */
type TurnUnit = { kind: "turn"; key: string; groups: StepGroup[] };
type RenderUnit = MsgItem | PlanItem | AskItem | TurnUnit;

function groupTimeline(items: TimelineItem[]): RenderUnit[] {
  const out: RenderUnit[] = [];
  for (const it of items) {
    if (it.kind === "step") {
      const last = out[out.length - 1];
      if (last && last.kind === "turn") last.groups.push(it);
      else out.push({ kind: "turn", key: it.stepId, groups: [it] });
    } else {
      out.push(it);
    }
  }
  return out;
}

/**
 * 把流式增量并进当前 assistant 气泡。
 * 关键:只追加到「队尾」的 assistant 气泡;若队尾已是 step/卡片(中间穿插了工具调用),
 * 则另起一个新气泡 —— 让实时分段与磁盘重建(每条 assistant 消息 = 一段文字 + 一组 step)一致,
 * 而不是把整轮文字黏成一坨。
 */
function appendToLastAssistant(items: TimelineItem[], text: string): TimelineItem[] {
  const last = items[items.length - 1];
  if (last && last.kind === "msg" && last.role === "assistant") {
    const next = items.slice();
    next[items.length - 1] = { ...last, content: last.content + text };
    return next;
  }
  return [...items, { kind: "msg", id: crypto.randomUUID(), role: "assistant", content: text }];
}

/** 撤回最后一条 assistant 气泡的内容(乐观流式回滚:清空未通过自查的 final 汇报,修正版本将流式补入)。 */
function clearLastAssistant(items: TimelineItem[]): TimelineItem[] {
  for (let i = items.length - 1; i >= 0; i--) {
    const it = items[i];
    if (it && it.kind === "msg" && it.role === "assistant") {
      const next = items.slice();
      next[i] = { ...it, content: "" };
      return next;
    }
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
