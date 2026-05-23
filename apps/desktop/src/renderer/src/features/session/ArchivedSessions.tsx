import { useEffect, useState } from "react";
import { ArchiveRestore, ChevronRight } from "lucide-react";
import type { SessionRecord } from "../../../../preload";
import { useShell } from "../shell/store";

/**
 * 已归档会话:SessionList 底部可展开区。归档会话从活跃列表隐藏但保留 transcript,
 * 这里查看并恢复。随 workspace 切换与活跃列表变化(归档/恢复后)重新拉取;空则整段不显示。
 */
export function ArchivedSessions(): JSX.Element | null {
  const { activeWorkspaceId, sessions } = useShell();
  const [archived, setArchived] = useState<SessionRecord[]>([]);
  const [open, setOpen] = useState(false);

  // sessions/workspace 变化即重拉(归档一条 → 活跃列表变 → 这里同步出现)
  useEffect(() => {
    void window.pa.session.listArchived().then(setArchived);
  }, [activeWorkspaceId, sessions]);

  if (archived.length === 0) return null;

  const restore = (id: string): void => {
    void window.pa.session.unarchive(id).then(() => window.pa.session.listArchived().then(setArchived));
  };

  return (
    <div className="no-drag border-t border-stone-200/70 px-2 py-1.5 dark:border-white/5">
      <button
        className="flex w-full items-center gap-1.5 px-2 py-1 text-left text-[11.5px] font-medium text-stone-500 transition hover:text-stone-700 dark:text-stone-500 dark:hover:text-stone-300"
        onClick={() => setOpen((o) => !o)}
      >
        <ChevronRight size={12} className={"shrink-0 transition " + (open ? "rotate-90" : "")} />
        已归档 ({archived.length})
      </button>

      {open && (
        <div className="mt-0.5 max-h-48 space-y-0.5 overflow-auto">
          {archived.map((s) => (
            <div
              key={s.id}
              className="group flex items-center rounded-lg pr-1 transition hover:bg-stone-100 dark:hover:bg-ink-800"
            >
              <span
                className="min-w-0 flex-1 truncate px-3 py-1.5 text-[12.5px] text-stone-500 dark:text-stone-400"
                title={s.title}
              >
                {s.title}
              </span>
              <button
                className="shrink-0 rounded p-1 text-stone-500 opacity-0 transition hover:text-ember-600 group-hover:opacity-100"
                onClick={() => restore(s.id)}
                title="恢复会话(重回列表)"
                aria-label="恢复会话"
              >
                <ArchiveRestore size={14} />
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
