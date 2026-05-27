import { useEffect, useRef, useState } from "react";
import { AlertCircle, Check, ChevronRight, Clock, Eye, Loader2, Undo2 } from "lucide-react";

/**
 * 对话内联执行轨迹。
 * - 活跃中:只显示一条会原地更新的 live 行(最新动作),不让历史步骤堆积。
 * - 一轮结束后:整轮收成一个「执行了 N 步」chip,点开就地展开全部动作。
 * - 说人话:弱化原始工具名,用自然语言动词("搜索了「xxx」""读了 report.pdf")。
 */

export interface ActionRow {
  id: string;
  stepId: string;
  tool: string;
  capability: string;
  status: "running" | "awaiting" | "done" | "failed";
  summary?: string; // 关键参数摘要(如查询词 / 文件名)
  riskLevel?: string;
  error?: string;
  /** 工具结果文本(可查看工具);存在则该行显示"查看",点开到 artifact 面板 */
  resultBody?: string;
}

export interface StepGroup {
  stepId: string;
  index: number;
  actions: ActionRow[];
}

export interface TurnTraceProps {
  /** 同一轮里连续的若干 step 块 */
  groups: StepGroup[];
  onApprove: (actionId: string, approved: boolean) => void;
  /** 当前可撤销(LIFO 栈顶)的 actionId */
  undoableId?: string;
  /** 已撤销的 actionId 集合 */
  revertedIds: Set<string>;
  onUndo: () => void;
  /** 点击"查看":把该动作的结果文本重开到 artifact 面板 */
  onView: (artifact: { id: string; title: string; body: string }) => void;
}

/** 工具名 → 自然语言动词(现在时 / 过去时) */
const TOOL_PHRASE: Record<string, { now: string; past: string }> = {
  list_dir: { now: "查看目录", past: "查看了目录" },
  read_file: { now: "读取", past: "读了" },
  find_files: { now: "查找文件", past: "查找了文件" },
  grep_files: { now: "搜索", past: "搜索了" },
  write_file: { now: "写入", past: "写入了" },
  move_file: { now: "移动", past: "移动了" },
  delete: { now: "删除", past: "删除了" },
  plan_file_changes: { now: "规划改动", past: "规划了改动" },
  extract_document: { now: "提取文档", past: "提取了文档" },
  remember: { now: "记住", past: "记住了" },
  update_memory: { now: "更新记忆", past: "更新了记忆" },
  forget_memory: { now: "清除记忆", past: "清除了记忆" },
  search_memory: { now: "查记忆", past: "查了记忆" },
  web_search: { now: "搜索", past: "搜索了" },
  web_fetch: { now: "打开网页", past: "打开了网页" }
};
/** 摘要是「查询词」性质的工具:用「」引号包裹更像人话;否则(文件名/URL)直接跟在后面 */
const QUOTE_TOOLS = new Set(["web_search", "search_memory", "grep_files", "find_files", "remember", "update_memory"]);

/** 一条动作的自然语言短句(不含原始工具名) */
function phraseOf(a: ActionRow): string {
  const p = TOOL_PHRASE[a.tool];
  const verb = p ? (a.status === "done" ? p.past : p.now) : a.tool;
  const prefix = a.status === "running" ? "正在" : "";
  const tail = a.status === "running" ? "…" : "";
  let arg = "";
  if (a.summary) arg = QUOTE_TOOLS.has(a.tool) ? `「${a.summary}」` : ` ${a.summary}`;
  return `${prefix}${verb}${arg}${tail}`;
}

function StatusIcon({ status }: { status: ActionRow["status"] }): JSX.Element {
  if (status === "awaiting") return <Clock size={13} className="shrink-0 text-sky-500" />;
  if (status === "running") return <Loader2 size={13} className="shrink-0 animate-spin text-amber-500" />;
  if (status === "done") return <Check size={13} className="shrink-0 text-emerald-500" />;
  return <AlertCircle size={13} className="shrink-0 text-rose-500" />;
}

export function TurnTrace({ groups, onApprove, undoableId, revertedIds, onUndo, onView }: TurnTraceProps): JSX.Element {
  const actions = groups.flatMap((g) => g.actions);
  const active = actions.some((a) => a.status === "running" || a.status === "awaiting");
  const failed = actions.some((a) => a.status === "failed");
  const [expanded, setExpanded] = useState(false);
  const liveRef = useRef<HTMLDivElement>(null);

  const shared = { onApprove, onUndo, onView };

  // 活跃中:固定高度的自动滚动框 —— 看得到步骤内容,新步骤往下加并自动滚到底,但不撑大页面
  // (auto-scroll 跟随活跃步骤数变化)
  useEffect(() => {
    if (active && liveRef.current) liveRef.current.scrollTop = liveRef.current.scrollHeight;
  }, [active, actions.length, actions[actions.length - 1]?.status]);

  if (active) {
    return (
      <div className="pl-1">
        <div
          ref={liveRef}
          className="max-h-28 space-y-1 overflow-auto border-l border-stone-200/70 py-0.5 pl-3 dark:border-white/5"
        >
          {actions.map((a) => (
            <ActionLine key={a.id} a={a} undoable={false} reverted={false} {...shared} />
          ))}
        </div>
      </div>
    );
  }

  // 结算后只有单步:直接显示这一行,不必折成 chip 再点开
  if (!active && actions.length === 1 && actions[0]) {
    const a = actions[0];
    return (
      <div className="pl-1">
        <ActionLine a={a} undoable={a.id === undoableId} reverted={revertedIds.has(a.id)} {...shared} />
      </div>
    );
  }

  // 结算后多步:默认折叠成 chip;或用户手动展开
  return (
    <div className="pl-1">
      <button
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-[11px] text-stone-500 transition hover:text-stone-600 dark:text-stone-500 dark:hover:text-stone-300"
        onClick={() => setExpanded(!expanded)}
      >
        <ChevronRight size={12} className={"shrink-0 transition " + (expanded ? "rotate-90" : "")} />
        <span className="font-medium">执行了 {actions.length} 步</span>
        <span className="ml-auto shrink-0">
          {failed ? (
            <AlertCircle size={12} className="text-rose-400" />
          ) : (
            <Check size={12} className="text-emerald-400" />
          )}
        </span>
      </button>

      {expanded && (
        <div className="ml-[7px] space-y-1 border-l border-stone-200/70 py-0.5 pl-3 dark:border-white/5">
          {actions.map((a) => (
            <ActionLine
              key={a.id}
              a={a}
              undoable={a.id === undoableId}
              reverted={revertedIds.has(a.id)}
              {...shared}
            />
          ))}
        </div>
      )}
    </div>
  );
}

function ActionLine({
  a,
  onApprove,
  undoable,
  reverted,
  onUndo,
  onView
}: {
  a: ActionRow;
  onApprove: (id: string, approved: boolean) => void;
  undoable: boolean;
  reverted: boolean;
  onUndo: () => void;
  onView: (artifact: { id: string; title: string; body: string }) => void;
}): JSX.Element {
  const viewable = a.status === "done" && !!a.resultBody;
  const view = (): void => onView({ id: a.id, title: phraseOf({ ...a, status: "done" }), body: a.resultBody ?? "" });
  return (
    <div className="text-[12.5px]">
      <div className="flex items-center gap-2">
        <StatusIcon status={a.status} />
        <span
          className="min-w-0 flex-1 truncate text-stone-700 dark:text-stone-200"
          title={`${a.tool}${a.summary ? " · " + a.summary : ""}`}
        >
          {phraseOf(a)}
        </span>
        <span className="shrink-0">
          {a.status === "awaiting" ? (
            <span className="flex items-center gap-1.5">
              {a.riskLevel && (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
                  {a.riskLevel}
                </span>
              )}
              <button
                className="rounded-md bg-ember-500 px-2 py-0.5 text-[11px] font-medium text-ink-900 hover:bg-ember-600"
                onClick={() => onApprove(a.id, true)}
              >
                同意
              </button>
              <button
                className="rounded-md bg-stone-100 px-2 py-0.5 text-[11px] text-stone-500 hover:bg-stone-200 dark:bg-ink-700 dark:text-stone-200 dark:hover:bg-ink-600"
                onClick={() => onApprove(a.id, false)}
              >
                拒绝
              </button>
            </span>
          ) : reverted ? (
            <span className="text-[11px] text-stone-500 dark:text-stone-500">已撤销</span>
          ) : undoable ? (
            <button
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-stone-500 transition hover:bg-stone-100 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-ink-800"
              onClick={onUndo}
              title="撤销这一步(可逆操作)"
            >
              <Undo2 size={12} />
              撤销
            </button>
          ) : viewable ? (
            <button
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-stone-500 transition hover:bg-stone-100 hover:text-stone-700 dark:text-stone-400 dark:hover:bg-ink-800"
              onClick={view}
              title="查看结果"
            >
              <Eye size={12} />
              查看
            </button>
          ) : null}
        </span>
      </div>
      {a.error && <p className="ml-[22px] break-words text-[11.5px] text-rose-500">{a.error}</p>}
    </div>
  );
}
