import type { BatchState } from "./types";

/** 批量改动 diff 预览 + 整批同意/拒绝 */
export function BatchPreview({
  batch,
  onRespond
}: {
  batch: BatchState;
  onRespond: (approved: boolean) => void;
}): JSX.Element {
  return (
    <div className="mx-4 mb-3 rounded-xl border border-amber-300/70 bg-amber-50 p-3 dark:border-amber-500/40 dark:bg-amber-500/10">
      <div className="mb-2 text-[13px] font-semibold text-amber-800 dark:text-amber-300">
        批量改动预览 · 共 {batch.operations.length} 项
      </div>
      <div className="max-h-56 space-y-1 overflow-auto rounded-lg bg-white/70 p-2 font-mono text-[12px] dark:bg-slate-900/40">
        {batch.operations.map((op, i) => (
          <div key={i} className="text-slate-700 dark:text-slate-200">
            {op.op === "move" ? (
              <>
                <span className="text-sky-600 dark:text-sky-400">移动</span> {op.from}{" "}
                <span className="text-slate-400">→</span> {op.to}
              </>
            ) : (
              <>
                <span className="text-rose-600 dark:text-rose-400">删除</span> {op.path}{" "}
                <span className="text-slate-400">→ 回收区</span>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="mt-2.5 flex gap-2">
        <button
          className="rounded-lg bg-emerald-500 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-emerald-600"
          onClick={() => onRespond(true)}
        >
          全部同意
        </button>
        <button
          className="rounded-lg bg-slate-100 px-3 py-1.5 text-[12px] font-medium text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
          onClick={() => onRespond(false)}
        >
          全部拒绝
        </button>
      </div>
    </div>
  );
}
