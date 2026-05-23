import { useState } from "react";
import { Check, ChevronsUpDown, Pencil, Plus, Settings, Trash2 } from "lucide-react";
import { useShell } from "../shell/store";

/** 左下角:弹出式 workspace 切换器 + 设置入口(不另起图标竖栏) */
export function WorkspaceSwitcher(): JSX.Element {
  const {
    workspaces,
    activeWorkspaceId,
    setActiveWorkspace,
    createWorkspace,
    renameWorkspace,
    deleteWorkspace,
    canDeleteWorkspace
  } = useShell();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"none" | "create" | "rename">("none");
  const [draft, setDraft] = useState("");
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const active = workspaces.find((w) => w.id === activeWorkspaceId);

  const closePopover = (): void => {
    setOpen(false);
    setMode("none");
    setDraft("");
    setConfirmDeleteId(null);
  };

  const submit = (): void => {
    const name = draft.trim();
    if (name) {
      if (mode === "create") createWorkspace(name);
      else if (mode === "rename") renameWorkspace(activeWorkspaceId, name);
    }
    closePopover();
  };

  const startMode = (m: "create" | "rename"): void => {
    setMode(m);
    setDraft(m === "rename" ? (active?.name ?? "") : "");
  };

  return (
    <div className="no-drag relative border-t border-stone-200/70 p-2 dark:border-ink-700">
      {open && (
        <>
          <div className="fixed inset-0 z-10" onClick={closePopover} />
          <div className="absolute bottom-[calc(100%-0.25rem)] left-2 right-2 z-20 overflow-hidden rounded-xl border border-stone-200 bg-white shadow-lg dark:border-ink-600 dark:bg-ink-800">
            <div className="px-3 pb-1 pt-2 text-[11px] font-medium text-stone-500 dark:text-stone-400">
              工作空间
            </div>
            {workspaces.map((w) =>
              confirmDeleteId === w.id ? (
                <div
                  key={w.id}
                  className="flex items-center gap-2 px-3 py-2 text-[13px] text-rose-600 dark:text-rose-300"
                >
                  <span className="min-w-0 flex-1 truncate">删除「{w.name}」?</span>
                  <button
                    className="shrink-0 rounded-md px-2 py-0.5 text-[13px] font-medium text-rose-600 hover:bg-rose-50 dark:text-rose-300 dark:hover:bg-rose-500/10"
                    onClick={() => {
                      deleteWorkspace(w.id);
                      setConfirmDeleteId(null);
                    }}
                  >
                    删除
                  </button>
                  <button
                    className="shrink-0 rounded-md px-2 py-0.5 text-[13px] text-stone-500 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-ink-700"
                    onClick={() => setConfirmDeleteId(null)}
                  >
                    取消
                  </button>
                </div>
              ) : (
                <div
                  key={w.id}
                  className={
                    "group flex items-center pr-1 transition hover:bg-stone-100 dark:hover:bg-ink-700 " +
                    (w.id === activeWorkspaceId ? "text-ember-700 dark:text-ember-300" : "text-stone-700 dark:text-stone-200")
                  }
                >
                  <button
                    className="flex min-w-0 flex-1 items-center gap-2 px-3 py-1.5 text-left text-[13px]"
                    onClick={() => {
                      setActiveWorkspace(w.id);
                      setOpen(false);
                    }}
                  >
                    <WsAvatar name={w.name} size="sm" />
                    <span className="min-w-0 flex-1 truncate">{w.name}</span>
                    {w.id === activeWorkspaceId && <Check size={14} className="shrink-0 text-ember-500" />}
                  </button>
                  {canDeleteWorkspace && (
                    <button
                      className="shrink-0 rounded p-1 text-stone-400 opacity-0 transition hover:text-rose-500 group-hover:opacity-100"
                      onClick={() => setConfirmDeleteId(w.id)}
                      title="删除工作空间"
                      aria-label="删除工作空间"
                    >
                      <Trash2 size={14} />
                    </button>
                  )}
                </div>
              )
            )}
            {mode !== "none" ? (
              <div className="px-2 py-2">
                <input
                  autoFocus
                  className="w-full rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-[13px] text-stone-700 outline-none focus:border-ember-300 dark:border-ink-600 dark:bg-ink-900 dark:text-stone-100"
                  placeholder={mode === "create" ? "新工作空间名称" : "重命名工作空间"}
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") submit();
                    else if (e.key === "Escape") setMode("none");
                  }}
                  onBlur={submit}
                />
              </div>
            ) : (
              <>
                <button
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-stone-600 transition hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-ink-700"
                  onClick={() => startMode("create")}
                >
                  <Plus size={14} className="shrink-0 text-stone-400" />
                  新建工作空间
                </button>
                <button
                  className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-stone-600 transition hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-ink-700"
                  onClick={() => startMode("rename")}
                >
                  <Pencil size={14} className="shrink-0 text-stone-400" />
                  重命名当前
                </button>
              </>
            )}
            <div className="my-1 h-px bg-stone-200/70 dark:bg-ink-700" />
            <button
              className="flex w-full items-center gap-2 px-3 py-1.5 text-left text-[13px] text-stone-600 transition hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-ink-700"
              onClick={() => {
                void window.pa.settings.open();
                closePopover();
              }}
            >
              <Settings size={14} className="shrink-0 text-stone-400" />
              设置
            </button>
          </div>
        </>
      )}

      <button
        className="flex w-full items-center gap-2 rounded-xl px-2 py-2 text-left transition hover:bg-stone-100 dark:hover:bg-ink-800"
        onClick={() => setOpen((o) => !o)}
      >
        <WsAvatar name={active?.name ?? "?"} />
        <span className="flex-1 truncate text-[13px] font-medium text-stone-700 dark:text-stone-200">
          {active?.name ?? "工作空间"}
        </span>
        <ChevronsUpDown size={15} className="text-stone-500" />
      </button>
    </div>
  );
}

function WsAvatar({ name, size = "md" }: { name: string; size?: "sm" | "md" }): JSX.Element {
  const dim = size === "sm" ? "h-[22px] w-[22px] text-[11px]" : "h-7 w-7 text-[13px]";
  return (
    <span
      className={
        "flex shrink-0 items-center justify-center rounded-lg bg-ember-100 font-semibold text-ember-700 dark:bg-ember-500/15 dark:text-ember-300 " +
        dim
      }
    >
      {name.slice(0, 1)}
    </span>
  );
}
