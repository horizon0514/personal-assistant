import { useState } from "react";
import { AlertCircle, Check, ChevronRight, Clock, Loader2, Undo2 } from "lucide-react";

/** 对话内联执行轨迹:工具按 step 归组。完成即折叠;审批/撤销内联到对应 action 行。 */

export interface ActionRow {
  id: string;
  stepId: string;
  tool: string;
  capability: string;
  status: "running" | "awaiting" | "done" | "failed";
  summary?: string; // 关键参数摘要(如查询词 / 文件名)
  riskLevel?: string;
  error?: string;
}

export interface StepGroup {
  stepId: string;
  index: number;
  actions: ActionRow[];
}

export interface StepTraceProps {
  group: StepGroup;
  onApprove: (actionId: string, approved: boolean) => void;
  /** 当前可撤销(LIFO 栈顶)的 actionId */
  undoableId?: string;
  /** 已撤销的 actionId 集合 */
  revertedIds: Set<string>;
  onUndo: () => void;
}

/** 工具名 → 中文动词(折叠摘要 + 行内展示用) */
const TOOL_LABELS: Record<string, string> = {
  list_dir: "列目录",
  read_file: "读取",
  find_files: "搜索",
  grep_files: "搜索",
  write_file: "写入",
  move_file: "移动",
  delete: "删除",
  plan_file_changes: "批量改动",
  extract_document: "提取文档",
  remember: "记忆",
  update_memory: "更新记忆",
  forget_memory: "遗忘",
  search_memory: "查记忆"
};
const verbOf = (tool: string): string => TOOL_LABELS[tool] ?? tool;

function StatusIcon({ status }: { status: ActionRow["status"] }): JSX.Element {
  if (status === "awaiting") return <Clock size={13} className="shrink-0 text-sky-500" />;
  if (status === "running") return <Loader2 size={13} className="shrink-0 animate-spin text-amber-500" />;
  if (status === "done") return <Check size={13} className="shrink-0 text-emerald-500" />;
  return <AlertCircle size={13} className="shrink-0 text-rose-500" />;
}

export function StepTrace({ group, onApprove, undoableId, revertedIds, onUndo }: StepTraceProps): JSX.Element {
  const { actions } = group;
  const active = actions.some((a) => a.status === "running" || a.status === "awaiting");
  const failed = actions.some((a) => a.status === "failed");
  const [override, setOverride] = useState<boolean | null>(null);
  const open = override ?? active; // 活跃步骤默认展开;完成后自动折叠(除非用户手动开)

  // 折叠摘要:不同动词(最多 2 个)+ 总数
  const verbs = [...new Set(actions.map((a) => verbOf(a.tool)))];
  const summary = verbs.slice(0, 2).join(" · ") + (verbs.length > 2 ? "…" : "");

  return (
    <div className="pl-1">
      <button
        className="flex w-full items-center gap-1.5 py-0.5 text-left text-[11px] text-slate-500 transition hover:text-slate-500 dark:text-slate-500"
        onClick={() => setOverride(!open)}
      >
        <ChevronRight size={12} className={"shrink-0 transition " + (open ? "rotate-90" : "")} />
        <span className="font-medium">步骤 {group.index}</span>
        {!open && (
          <span className="truncate text-slate-500 dark:text-slate-500">
            · {summary} ×{actions.length}
          </span>
        )}
        <span className="ml-auto shrink-0">
          {active ? null : failed ? (
            <AlertCircle size={12} className="text-rose-400" />
          ) : (
            <Check size={12} className="text-emerald-400" />
          )}
        </span>
      </button>

      {open && (
        <div className="ml-[7px] space-y-1 border-l border-slate-200/70 py-0.5 pl-3 dark:border-slate-700/60">
          {actions.map((a) => (
            <ActionLine
              key={a.id}
              a={a}
              onApprove={onApprove}
              undoable={a.id === undoableId}
              reverted={revertedIds.has(a.id)}
              onUndo={onUndo}
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
  onUndo
}: {
  a: ActionRow;
  onApprove: (id: string, approved: boolean) => void;
  undoable: boolean;
  reverted: boolean;
  onUndo: () => void;
}): JSX.Element {
  return (
    <div className="text-[12.5px]">
      <div className="flex items-center gap-2">
        <StatusIcon status={a.status} />
        <span className="shrink-0 font-mono text-[11.5px] text-slate-500 dark:text-slate-400">{a.tool}</span>
        {a.summary && (
          <span className="min-w-0 flex-1 truncate text-slate-700 dark:text-slate-200" title={a.summary}>
            {a.summary}
          </span>
        )}
        <span className={a.summary ? "shrink-0" : "ml-auto shrink-0"}>
          {a.status === "awaiting" ? (
            <span className="flex items-center gap-1.5">
              {a.riskLevel && (
                <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
                  {a.riskLevel}
                </span>
              )}
              <button
                className="rounded-md bg-emerald-500 px-2 py-0.5 text-[11px] font-medium text-white hover:bg-emerald-600"
                onClick={() => onApprove(a.id, true)}
              >
                同意
              </button>
              <button
                className="rounded-md bg-slate-100 px-2 py-0.5 text-[11px] text-slate-500 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
                onClick={() => onApprove(a.id, false)}
              >
                拒绝
              </button>
            </span>
          ) : reverted ? (
            <span className="text-[11px] text-slate-500 dark:text-slate-500">已撤销</span>
          ) : undoable ? (
            <button
              className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-slate-500 transition hover:bg-slate-100 hover:text-slate-700 dark:text-slate-400 dark:hover:bg-slate-800"
              onClick={onUndo}
              title="撤销这一步(可逆操作)"
            >
              <Undo2 size={12} />
              撤销
            </button>
          ) : null}
        </span>
      </div>
      {a.error && <p className="ml-[22px] break-words text-[11.5px] text-rose-500">{a.error}</p>}
    </div>
  );
}
