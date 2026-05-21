import { AlertCircle, Check, Clock, Loader2 } from "lucide-react";

/** 对话内联的执行轨迹:工具调用按 step 归组,只读展示(审批在输入框下方横幅完成) */

export interface ActionRow {
  id: string;
  stepId: string;
  tool: string;
  capability: string;
  status: "running" | "awaiting" | "done" | "failed";
  riskLevel?: string;
  error?: string;
}

export interface StepGroup {
  stepId: string;
  index: number; // 第几步(从 1 起)
  actions: ActionRow[];
}

function StatusIcon({ status }: { status: ActionRow["status"] }): JSX.Element {
  if (status === "awaiting") return <Clock size={14} className="mt-0.5 shrink-0 text-sky-500" />;
  if (status === "running")
    return <Loader2 size={14} className="mt-0.5 shrink-0 animate-spin text-amber-500" />;
  if (status === "done") return <Check size={14} className="mt-0.5 shrink-0 text-emerald-500" />;
  return <AlertCircle size={14} className="mt-0.5 shrink-0 text-rose-500" />;
}

function ActionLine({ a }: { a: ActionRow }): JSX.Element {
  return (
    <div className="flex items-start gap-2.5 text-[12.5px]">
      <StatusIcon status={a.status} />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-1.5">
          <span className="font-medium text-slate-700 dark:text-slate-100">{a.tool}</span>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-700 dark:text-slate-300">
            {a.capability}
          </span>
          {a.riskLevel && a.status === "awaiting" && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
              待审批 · {a.riskLevel}
            </span>
          )}
        </div>
        {a.error && <p className="mt-0.5 break-words text-[11.5px] text-rose-500">{a.error}</p>}
      </div>
    </div>
  );
}

/** 单个 step 的内联块:可折叠,默认展开 */
export function StepTrace({ group }: { group: StepGroup }): JSX.Element {
  return (
    <div className="rounded-xl border border-slate-200/70 bg-white/60 px-3 py-2.5 dark:border-slate-800 dark:bg-slate-800/40">
      <div className="mb-1.5 flex items-center gap-2">
        <span className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
          步骤 {group.index}
        </span>
        <span className="h-px flex-1 bg-slate-200/70 dark:bg-slate-700/70" />
      </div>
      <div className="space-y-1.5">
        {group.actions.map((a) => (
          <ActionLine key={a.id} a={a} />
        ))}
      </div>
    </div>
  );
}
