import { useEffect, useState } from "react";
import { PanelLeft } from "lucide-react";
import { ShellProvider, useShell } from "./features/shell/store";
import { SessionList } from "./features/session/SessionList";
import { ChatPane } from "./features/conversation/ChatPane";
import { ArtifactPanel } from "./features/artifact/ArtifactPanel";

/** 布局外壳:会话列表 / 对话 / artifact(按需)三栏 + 设置浮层 */
export function App(): JSX.Element {
  return (
    <ShellProvider>
      <Shell />
    </ShellProvider>
  );
}

function Shell(): JSX.Element {
  const { sidebarCollapsed, toggleSidebar } = useShell();
  const [model, setModel] = useState("");

  useEffect(() => {
    void window.pa.chat.model().then(setModel);
  }, []);

  return (
    <div className="flex h-screen w-screen bg-[#f3f7f5] text-stone-800 dark:bg-[#0e1411] dark:text-stone-100">
      {!sidebarCollapsed && <SessionList />}

      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className={
            "drag flex h-12 shrink-0 items-center justify-between border-b border-stone-200/70 pr-4 dark:border-ink-700 " +
            // 折叠后顶栏从窗口最左开始,需让出 macOS 红绿灯
            (sidebarCollapsed ? "pl-[78px]" : "pl-3")
          }
        >
          <button
            className="no-drag rounded-lg p-1.5 text-stone-500 transition hover:bg-stone-100 hover:text-stone-500 dark:hover:bg-ink-800"
            onClick={toggleSidebar}
            title={sidebarCollapsed ? "展开会话列表" : "收起会话列表"}
            aria-label="切换会话列表"
          >
            <PanelLeft size={17} strokeWidth={2} />
          </button>
          {model && (
            <span className="no-drag rounded-full bg-ember-100 px-2.5 py-1 text-[11px] font-medium text-ember-700 dark:bg-ember-500/15 dark:text-ember-300">
              {model}
            </span>
          )}
        </div>

        <div className="flex min-h-0 flex-1">
          <ChatPane />
          <ArtifactPanel />
        </div>
      </div>
    </div>
  );
}
