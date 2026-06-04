import { useEffect, useState } from "react";
import { Trash2 } from "lucide-react";
import type { AllowEntry } from "../../../../preload";

/**
 * 已记住的「允许」操作:用户在审批卡点过「总是同意」的同类操作,以后免审批。
 * 这里查看 / 逐条移除 / 全部清空 —— 把放宽的信任边界摊在明面上,可随时收回。
 */
export function ApprovalsPanel(): JSX.Element {
  const [list, setList] = useState<AllowEntry[]>([]);

  useEffect(() => {
    void window.pa.approvals.list().then(setList);
  }, []);

  const remove = (id: string): void => void window.pa.approvals.remove(id).then(setList);
  const clear = (): void => void window.pa.approvals.clear().then(setList);

  if (list.length === 0) {
    return (
      <p className="text-[12.5px] leading-relaxed text-stone-500 dark:text-stone-500">
        还没有记住的操作。审批某个操作时点「总是同意」,同类操作(改参数也算)以后就不再询问 —— 会列在这里,可随时移除。
      </p>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <span className="text-[12px] text-stone-500 dark:text-stone-400">{list.length} 类操作已免审批</span>
        <button
          className="rounded-lg px-2.5 py-1 text-[12px] text-rose-500 ring-1 ring-rose-200 transition hover:bg-rose-50 dark:ring-rose-500/30 dark:hover:bg-rose-500/10"
          onClick={clear}
        >
          全部清空
        </button>
      </div>
      <ul className="space-y-1.5">
        {list.map((e) => (
          <li
            key={e.id}
            className="flex items-center gap-2 rounded-lg border border-stone-200 bg-white px-3 py-2 dark:border-white/10 dark:bg-ink-900"
          >
            <span className="min-w-0 flex-1 truncate text-[12.5px] text-stone-700 dark:text-stone-200" title={e.id}>
              {e.label}
            </span>
            <button
              className="shrink-0 rounded-md p-1 text-stone-500 transition hover:bg-stone-100 hover:text-rose-500 dark:hover:bg-ink-800"
              title="移除(以后该类操作恢复询问)"
              onClick={() => remove(e.id)}
            >
              <Trash2 size={14} />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
