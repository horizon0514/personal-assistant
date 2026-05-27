import { useEffect, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";
import { Markdown } from "./Markdown";
import { TurnTrace, type ActionRow, type StepGroup } from "./StepTrace";
import { EmptyState } from "./EmptyState";
import { useShell } from "../shell/store";

type MsgItem = { kind: "msg"; id: string; role: "user" | "assistant"; content: string };
type StepItem = { kind: "step" } & StepGroup;
type VerdictItem = {
  kind: "verdict";
  id: string;
  status: "running" | "pass" | "fail";
  issues: string[];
  summary: string;
  retrying: boolean;
};
type ContractItem = {
  kind: "contract";
  id: string; // requestId
  status: "awaiting" | "confirmed" | "cancelled";
  deliverables: string[];
  criteria: string[];
};
type TimelineItem = MsgItem | StepItem | VerdictItem | ContractItem;
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
        // propose_contract 有专门的确认卡(contract:request),不再在 step 轨迹里重复一行
        if (ev.action.tool === "propose_contract") return;
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
        setItems((prev) =>
          upsertVerdict(prev, {
            id: `verdict:${ev.taskId}:${ev.round}`,
            status: "running",
            issues: [],
            summary: "",
            retrying: false
          })
        );
      } else if (ev.type === "EvaluationCompleted") {
        setItems((prev) => {
          const next = upsertVerdict(prev, {
            id: `verdict:${ev.taskId}:${ev.round}`,
            status: ev.verdict === "pass" ? "pass" : "fail",
            issues: ev.issues,
            summary: ev.summary,
            retrying: ev.retrying
          });
          // 自动返工:补一个空 assistant 气泡,让返工的回答落在验收结论之后
          return ev.retrying
            ? [...next, { kind: "msg", id: crypto.randomUUID(), role: "assistant", content: "" }]
            : next;
        });
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

  // Sprint Contract:执行器动手前起草 → 弹可编辑的确认卡
  useEffect(() => {
    return window.pa.contract.onRequest((req) => {
      setItems((prev) => [
        ...prev,
        {
          kind: "contract",
          id: req.requestId,
          status: "awaiting",
          deliverables: req.deliverables,
          criteria: req.criteria
        }
      ]);
    });
  }, []);

  const onConfirmContract = (requestId: string, deliverables: string[], criteria: string[]): void => {
    window.pa.contract.resolve(requestId, { deliverables, criteria });
    setItems((prev) => patchContract(prev, requestId, { status: "confirmed", deliverables, criteria }));
  };
  const onCancelContract = (requestId: string): void => {
    window.pa.contract.resolve(requestId, null);
    setItems((prev) => patchContract(prev, requestId, { status: "cancelled" }));
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
          {groupTimeline(items).map((it) =>
            it.kind === "turn" ? (
              <TurnTrace
                key={it.groups[0]?.stepId ?? it.key}
                groups={it.groups}
                onApprove={onApprove}
                undoableId={undoableId}
                revertedIds={revertedIds}
                onUndo={() => void window.pa.reversibility.undoLast()}
                onView={(art) => openArtifact({ id: art.id, kind: "text", title: art.title, body: art.body })}
              />
            ) : it.kind === "verdict" ? (
              <VerdictRow key={it.id} item={it} />
            ) : it.kind === "contract" ? (
              <ContractCard
                key={it.id}
                item={it}
                onConfirm={onConfirmContract}
                onCancel={onCancelContract}
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

/** 独立验收结论行(执行后核查;不持久化,仅本次会话可见)。 */
function VerdictRow({ item }: { item: VerdictItem }): JSX.Element {
  const label =
    item.status === "running"
      ? "独立验收中…"
      : item.status === "pass"
        ? "已独立验收"
        : item.retrying
          ? `验收发现 ${item.issues.length} 处问题,正在自动返工…`
          : `验收发现 ${item.issues.length} 处问题`;
  const tone =
    item.status === "pass"
      ? "text-emerald-700 ring-emerald-200/70 dark:text-emerald-300 dark:ring-emerald-500/20"
      : item.status === "fail"
        ? "text-amber-700 ring-amber-200/70 dark:text-amber-300 dark:ring-amber-500/20"
        : "text-stone-500 ring-stone-200/70 dark:text-stone-400 dark:ring-white/10";
  return (
    <div className="flex justify-start">
      <div className={"max-w-[88%] rounded-xl bg-white px-3 py-2 text-[12.5px] ring-1 dark:bg-ink-900 " + tone}>
        <div className="flex items-center gap-1.5 font-medium">
          <span>{item.status === "pass" ? "✓" : item.status === "fail" ? "⚠" : "○"}</span>
          <span>{label}</span>
        </div>
        {item.summary && <p className="mt-1 text-stone-600 dark:text-stone-300">{item.summary}</p>}
        {item.issues.length > 0 && (
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-stone-600 dark:text-stone-300">
            {item.issues.map((iss, i) => (
              <li key={i}>{iss}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Sprint Contract 确认卡:待确认时可编辑交付物/验收标准,确认后只读留痕。 */
function ContractCard({
  item,
  onConfirm,
  onCancel
}: {
  item: ContractItem;
  onConfirm: (requestId: string, deliverables: string[], criteria: string[]) => void;
  onCancel: (requestId: string) => void;
}): JSX.Element {
  const [deliverables, setDeliverables] = useState(item.deliverables.join("\n"));
  const [criteria, setCriteria] = useState(item.criteria.join("\n"));
  const toLines = (s: string): string[] =>
    s
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

  if (item.status !== "awaiting") {
    const confirmed = item.status === "confirmed";
    return (
      <div className="flex justify-start">
        <div
          className={
            "max-w-[88%] rounded-xl bg-white px-3 py-2 text-[12.5px] ring-1 dark:bg-ink-900 " +
            (confirmed
              ? "text-stone-600 ring-stone-200/70 dark:text-stone-300 dark:ring-white/10"
              : "text-stone-400 ring-stone-200/70 dark:text-stone-500 dark:ring-white/10")
          }
        >
          <div className="font-medium">{confirmed ? "📋 已签约,按此交付" : "已取消契约"}</div>
          {confirmed && (
            <>
              <ContractList title="交付物" items={item.deliverables} />
              <ContractList title="验收标准" items={item.criteria} />
            </>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="flex justify-start">
      <div className="max-w-[88%] rounded-xl bg-white px-3 py-2.5 text-[12.5px] text-stone-700 ring-1 ring-ember-200/70 dark:bg-ink-900 dark:text-stone-200 dark:ring-ember-500/25">
        <div className="mb-1.5 font-medium">📋 动手前先确认这一程的交付契约</div>
        <label className="mb-0.5 block text-stone-500 dark:text-stone-400">交付物(每行一条)</label>
        <textarea
          className="mb-2 w-full resize-y rounded-md border border-stone-200 bg-transparent px-2 py-1 text-[12.5px] outline-none focus:border-ember-400 dark:border-white/10"
          rows={Math.max(2, item.deliverables.length)}
          value={deliverables}
          onChange={(e) => setDeliverables(e.target.value)}
        />
        <label className="mb-0.5 block text-stone-500 dark:text-stone-400">验收标准(每行一条)</label>
        <textarea
          className="mb-2 w-full resize-y rounded-md border border-stone-200 bg-transparent px-2 py-1 text-[12.5px] outline-none focus:border-ember-400 dark:border-white/10"
          rows={Math.max(2, item.criteria.length)}
          value={criteria}
          onChange={(e) => setCriteria(e.target.value)}
        />
        <div className="flex gap-2">
          <button
            className="rounded-md bg-ember-500 px-3 py-1 font-medium text-ink-900 transition hover:bg-ember-400 disabled:opacity-30"
            disabled={toLines(deliverables).length === 0}
            onClick={() => onConfirm(item.id, toLines(deliverables), toLines(criteria))}
          >
            确认,开干
          </button>
          <button
            className="rounded-md px-3 py-1 text-stone-500 ring-1 ring-stone-200 transition hover:bg-stone-50 dark:text-stone-400 dark:ring-white/10 dark:hover:bg-ink-800"
            onClick={() => onCancel(item.id)}
          >
            取消
          </button>
        </div>
      </div>
    </div>
  );
}

function ContractList({ title, items }: { title: string; items: string[] }): JSX.Element {
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

function patchContract(
  items: TimelineItem[],
  requestId: string,
  patch: Partial<Omit<ContractItem, "kind" | "id">>
): TimelineItem[] {
  return items.map((it) =>
    it.kind === "contract" && it.id === requestId ? { ...it, ...patch } : it
  );
}

function upsertVerdict(items: TimelineItem[], v: Omit<VerdictItem, "kind">): TimelineItem[] {
  const idx = items.findIndex((it) => it.kind === "verdict" && it.id === v.id);
  if (idx >= 0) {
    const next = items.slice();
    next[idx] = { kind: "verdict", ...v };
    return next;
  }
  return [...items, { kind: "verdict", ...v }];
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
type RenderUnit = MsgItem | VerdictItem | ContractItem | TurnUnit;

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
