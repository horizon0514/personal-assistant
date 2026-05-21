import { StatusDot } from "./StatusDot";
import type { ActionRow } from "./types";

/** 单个动作卡片(含「待审批」状态下的同意/拒绝)*/
export function ActionCard({
  action: a,
  onRespond
}: {
  action: ActionRow;
  onRespond: (id: string, approved: boolean) => void;
}): JSX.Element {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-slate-200/70 bg-white px-3 py-2.5 text-[13px] dark:border-slate-800 dark:bg-slate-800/60">
      <StatusDot status={a.status} />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="font-medium text-slate-700 dark:text-slate-100">{a.tool}</span>
          <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-700 dark:text-slate-300">
            {a.capability}
          </span>
          {a.riskLevel && a.status === "awaiting" && (
            <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
              {a.riskLevel}
            </span>
          )}
        </div>
        {a.status === "awaiting" && (
          <div className="mt-2 flex gap-2">
            <button
              className="rounded-lg bg-emerald-500 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-emerald-600"
              onClick={() => onRespond(a.id, true)}
            >
              同意
            </button>
            <button
              className="rounded-lg bg-slate-100 px-2.5 py-1 text-[12px] font-medium text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
              onClick={() => onRespond(a.id, false)}
            >
              拒绝
            </button>
          </div>
        )}
        {a.error && <p className="mt-1 break-words text-[12px] text-rose-500">{a.error}</p>}
      </div>
    </div>
  );
}
