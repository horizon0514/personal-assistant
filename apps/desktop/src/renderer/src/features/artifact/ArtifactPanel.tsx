import { X } from "lucide-react";
import { useShell } from "../shell/store";
import type { BatchState } from "../shell/types";

/**
 * 右侧 artifact 面板:默认折叠,一次一个。
 * 批量 diff 自动弹出(store 订阅 batch:request);其余内容手动点开。
 */
export function ArtifactPanel(): JSX.Element | null {
  const { artifact, closeArtifact } = useShell();
  if (!artifact) return null;

  const resolveBatch = (batch: BatchState, approved: boolean): void => {
    window.pa.batch.resolve(batch.actionId, approved);
    closeArtifact();
  };

  return (
    <aside className="flex w-[400px] shrink-0 flex-col border-l border-slate-200/70 bg-white/40 dark:border-slate-800 dark:bg-slate-900/30">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-slate-200/70 px-4 dark:border-slate-800">
        <span className="truncate text-[13px] font-medium text-slate-500 dark:text-slate-300">
          {artifact.title}
        </span>
        <button
          className="no-drag rounded-lg px-2 py-1 text-[13px] text-slate-500 transition hover:bg-slate-100 hover:text-slate-500 dark:hover:bg-slate-800"
          onClick={closeArtifact}
          aria-label="关闭"
        >
          <X size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-auto p-4">
        {artifact.kind === "batch" ? (
          <BatchView batch={artifact.batch} onRespond={(ok) => resolveBatch(artifact.batch, ok)} />
        ) : (
          <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] text-slate-700 dark:text-slate-200">
            {artifact.body}
          </pre>
        )}
      </div>
    </aside>
  );
}

function BatchView({
  batch,
  onRespond
}: {
  batch: BatchState;
  onRespond: (approved: boolean) => void;
}): JSX.Element {
  return (
    <div>
      <p className="mb-2 text-[12px] text-slate-500 dark:text-slate-400">
        助理想批量修改 {batch.operations.length} 项,确认后执行(可整批回滚)。
      </p>
      <div className="space-y-1 rounded-xl bg-slate-50 p-3 font-mono text-[12px] dark:bg-slate-800/50">
        {batch.operations.map((op, i) => (
          <div key={i} className="break-words text-slate-700 dark:text-slate-200">
            {op.op === "move" ? (
              <>
                <span className="text-sky-600 dark:text-sky-400">移动</span> {op.from}{" "}
                <span className="text-slate-500">→</span> {op.to}
              </>
            ) : (
              <>
                <span className="text-rose-600 dark:text-rose-400">删除</span> {op.path}{" "}
                <span className="text-slate-500">→ 回收区</span>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <button
          className="flex-1 rounded-lg bg-emerald-500 px-3 py-2 text-[13px] font-medium text-white hover:bg-emerald-600"
          onClick={() => onRespond(true)}
        >
          全部同意
        </button>
        <button
          className="flex-1 rounded-lg bg-slate-100 px-3 py-2 text-[13px] font-medium text-slate-500 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
          onClick={() => onRespond(false)}
        >
          全部拒绝
        </button>
      </div>
    </div>
  );
}
