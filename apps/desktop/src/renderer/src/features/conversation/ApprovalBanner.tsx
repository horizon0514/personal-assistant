import { useEffect, useState } from "react";
import { ShieldAlert } from "lucide-react";
import type { ApprovalRequest } from "../../../../preload";

/**
 * 审批常驻横幅:置于输入框下方,贴近用户操作。
 * 单工具审批的决策点(批量 diff 走右侧 artifact)。多个请求排队,逐个处理。
 */
export function ApprovalBanner(): JSX.Element | null {
  const [queue, setQueue] = useState<ApprovalRequest[]>([]);

  useEffect(() => {
    return window.pa.approval.onRequest((req) => setQueue((prev) => [...prev, req]));
  }, []);

  const current = queue[0];
  if (!current) return null;

  const respond = (approved: boolean): void => {
    window.pa.approval.resolve(current.actionId, approved);
    setQueue((prev) => prev.slice(1));
  };

  return (
    <div className="no-drag mx-4 mb-2 flex items-center gap-3 rounded-xl border border-amber-300/70 bg-amber-50 px-3 py-2.5 dark:border-amber-500/40 dark:bg-amber-500/10">
      <ShieldAlert size={16} className="shrink-0 text-amber-500" />
      <div className="min-w-0 flex-1 text-[12.5px] text-amber-900 dark:text-amber-200">
        <span className="font-medium">{current.tool}</span>
        <span className="ml-1.5 rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
          {current.riskLevel}
        </span>
        <span className="ml-1.5 text-amber-700/80 dark:text-amber-300/70">需要你确认后执行</span>
        {queue.length > 1 && (
          <span className="ml-1.5 text-amber-600/70 dark:text-amber-400/60">· 还有 {queue.length - 1} 项</span>
        )}
      </div>
      <button
        className="shrink-0 rounded-lg bg-emerald-500 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-emerald-600"
        onClick={() => respond(true)}
      >
        同意
      </button>
      <button
        className="shrink-0 rounded-lg bg-white px-2.5 py-1 text-[12px] font-medium text-slate-600 ring-1 ring-slate-200 hover:bg-slate-50 dark:bg-slate-700 dark:text-slate-200 dark:ring-slate-600 dark:hover:bg-slate-600"
        onClick={() => respond(false)}
      >
        拒绝
      </button>
    </div>
  );
}
