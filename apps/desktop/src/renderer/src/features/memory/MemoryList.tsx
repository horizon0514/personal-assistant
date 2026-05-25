import { useEffect, useState } from "react";
import { ChevronRight, Trash2, Undo2 } from "lucide-react";
import type { MemoryView } from "../../../../preload";

/**
 * 记忆(中等档):活跃记忆显示 content + kind + 情景 + 可展开(原话/修改历史);
 * 软遗忘(可恢复);底部弱化的"已遗忘"折叠区做误忘兜底。纯本地、可见。
 */
export function MemoryList({ workspaceId }: { workspaceId: string }): JSX.Element {
  const [items, setItems] = useState<MemoryView[]>([]);
  const [forgotten, setForgotten] = useState<MemoryView[]>([]);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [showForgotten, setShowForgotten] = useState(false);

  useEffect(() => {
    const refresh = (): void => {
      void window.pa.memory.list(workspaceId).then(setItems);
      void window.pa.memory.listForgotten(workspaceId).then(setForgotten);
    };
    refresh();
    // 仅当变化的 workspace 是当前所选时才重拉(含 agent 后台写入)
    return window.pa.memory.onChanged((payload) => {
      if (payload.wsId === workspaceId) refresh();
    });
  }, [workspaceId]);

  const toggle = (id: string): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });

  return (
    <div className="space-y-1.5">
      {items.length === 0 ? (
        <p className="px-1 text-[12px] text-stone-500 dark:text-stone-500">
          助理会在对话中记住你的偏好与关键事实(纯本地,可见可删)。
        </p>
      ) : (
        items.map((m) => (
          <MemoryRow
            key={m.id}
            m={m}
            open={expanded.has(m.id)}
            onToggle={() => toggle(m.id)}
            onForget={() => window.pa.memory.remove(workspaceId, m.id)}
          />
        ))
      )}

      {forgotten.length > 0 && (
        <div className="pt-1">
          <button
            className="flex items-center gap-1 text-[11px] text-stone-500 transition hover:text-stone-500 dark:text-stone-500"
            onClick={() => setShowForgotten((s) => !s)}
          >
            <ChevronRight size={12} className={"transition " + (showForgotten ? "rotate-90" : "")} />
            已遗忘({forgotten.length})
          </button>
          {showForgotten && (
            <div className="mt-1 space-y-1">
              {forgotten.map((m) => (
                <div
                  key={m.id}
                  className="group flex items-start gap-2 rounded-lg bg-stone-50/60 px-2 py-1.5 text-[12px] dark:bg-ink-800/30"
                >
                  <span className="min-w-0 flex-1 break-words text-stone-500 line-through dark:text-stone-500">
                    {m.content}
                    {m.forgottenReason && <span className="ml-1 no-underline">· {m.forgottenReason}</span>}
                  </span>
                  <button
                    className="shrink-0 rounded p-0.5 text-stone-500 opacity-0 transition hover:text-ember-500 group-hover:opacity-100"
                    onClick={() => window.pa.memory.restore(workspaceId, m.id)}
                    title="恢复这条记忆"
                  >
                    <Undo2 size={13} />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function MemoryRow({
  m,
  open,
  onToggle,
  onForget
}: {
  m: MemoryView;
  open: boolean;
  onToggle: () => void;
  onForget: () => void;
}): JSX.Element {
  const hasDetail = !!m.quote || m.revisionCount > 0 || !!m.sourceSessionId;

  return (
    <div className="group rounded-lg bg-stone-50 px-2 py-1.5 text-[12px] dark:bg-ink-800/50">
      <div className="flex items-start gap-2">
        <span
          className={
            "mt-0.5 shrink-0 rounded px-1 text-[10px] " +
            (m.kind === "preference"
              ? "bg-ember-100 text-ember-700 dark:bg-ember-500/15 dark:text-ember-300"
              : "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300")
          }
        >
          {m.kind === "preference" ? "偏好" : "事实"}
        </span>
        <div className="min-w-0 flex-1">
          <div className="select-text break-words text-stone-700 dark:text-stone-200">{m.content}</div>
          {m.situation && (
            <div className="mt-0.5 text-[11px] text-stone-500 dark:text-stone-500">情景:{m.situation}</div>
          )}
        </div>
        {hasDetail && (
          <button
            className="shrink-0 rounded p-0.5 text-stone-300 transition hover:text-stone-500 dark:text-stone-600"
            onClick={onToggle}
            title="展开来龙去脉"
          >
            <ChevronRight size={13} className={"transition " + (open ? "rotate-90" : "")} />
          </button>
        )}
        <button
          className="shrink-0 rounded p-0.5 text-stone-300 opacity-0 transition hover:text-rose-500 group-hover:opacity-100"
          onClick={onForget}
          title="遗忘(可恢复)"
        >
          <Trash2 size={13} />
        </button>
      </div>

      {open && hasDetail && (
        <div className="ml-7 mt-1.5 space-y-1 border-l border-stone-200 pl-2.5 text-[11px] dark:border-white/10">
          {m.quote && <div className="text-stone-500 dark:text-stone-400">原话:「{m.quote}」</div>}
          {m.revisions.map((r, i) => (
            <div key={i} className="text-stone-500 dark:text-stone-400">
              改动:从「{r.prevContent}」· 因{r.reason}
            </div>
          ))}
          {m.sourceSessionId && (
            <div className="text-stone-500 dark:text-stone-500">来源会话:{m.sourceSessionId.slice(0, 8)}</div>
          )}
        </div>
      )}
    </div>
  );
}
