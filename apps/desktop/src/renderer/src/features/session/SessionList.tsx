import { useEffect, useRef } from "react";
import { Archive, SquarePen } from "lucide-react";
import { useShell } from "../shell/store";
import { WorkspaceSwitcher } from "./WorkspaceSwitcher";
import { ArchivedSessions } from "./ArchivedSessions";

/** 最左栏:当前 workspace 的会话列表 + 左下角 workspace 切换/设置。可折叠、可调宽。 */
export function SessionList(): JSX.Element {
  const { sessions, activeSessionId, setActiveSession, newSession, archiveSession, sidebarWidth, setSidebarWidth } =
    useShell();
  const dragging = useRef(false);

  useEffect(() => {
    const onMove = (e: MouseEvent): void => {
      if (dragging.current) setSidebarWidth(e.clientX);
    };
    const onUp = (): void => {
      dragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [setSidebarWidth]);

  return (
    <nav
      className="relative flex shrink-0 flex-col border-r border-slate-200/70 bg-white/40 dark:border-slate-800 dark:bg-slate-900/30"
      style={{ width: sidebarWidth }}
    >
      {/* 顶部留白避开 macOS 红绿灯 */}
      <div className="drag h-12 shrink-0" />

      <div className="no-drag px-3 pb-2">
        <button
          className="flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed border-slate-300 py-2 text-[12.5px] font-medium text-slate-700 transition hover:border-emerald-300 hover:text-emerald-600 dark:border-slate-700 dark:text-slate-400 dark:hover:border-emerald-500/50"
          onClick={newSession}
        >
          <SquarePen size={15} strokeWidth={2} />
          新会话
        </button>
      </div>

      <div className="flex-1 space-y-0.5 overflow-auto px-2 pb-2">
        {sessions.length === 0 ? (
          <p className="px-3 py-4 text-center text-[12px] text-slate-500 dark:text-slate-500">还没有会话</p>
        ) : (
          sessions.map((s) => (
            <div
              key={s.id}
              className={
                "group flex items-center rounded-lg pr-1 transition " +
                (s.id === activeSessionId
                  ? "bg-emerald-100/70 dark:bg-emerald-500/15"
                  : "hover:bg-slate-100 dark:hover:bg-slate-800")
              }
            >
              <button
                className={
                  "min-w-0 flex-1 truncate px-3 py-2 text-left text-[13px] " +
                  (s.id === activeSessionId
                    ? "font-medium text-emerald-800 dark:text-emerald-200"
                    : "text-slate-700 dark:text-slate-300")
                }
                onClick={() => setActiveSession(s.id)}
                title={s.title}
              >
                {s.title}
              </button>
              <button
                className="shrink-0 rounded p-1 text-slate-500 opacity-0 transition hover:text-amber-500 group-hover:opacity-100"
                onClick={() => archiveSession(s.id)}
                title="归档会话(从列表隐藏,不删除)"
                aria-label="归档会话"
              >
                <Archive size={14} />
              </button>
            </div>
          ))
        )}
      </div>

      <ArchivedSessions />

      <WorkspaceSwitcher />

      {/* 拖拽调宽手柄 */}
      <div
        className="no-drag absolute -right-1 top-0 h-full w-2 cursor-col-resize"
        onMouseDown={() => {
          dragging.current = true;
          document.body.style.cursor = "col-resize";
          document.body.style.userSelect = "none";
        }}
      >
        <div className="mx-auto h-full w-px bg-transparent transition hover:bg-emerald-400/40" />
      </div>
    </nav>
  );
}
