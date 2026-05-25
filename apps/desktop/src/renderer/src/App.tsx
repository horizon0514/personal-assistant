import { useEffect, useState } from "react";
import { PanelLeft, Sun, Moon, Monitor } from "lucide-react";
import type { ThemeSource } from "../../preload";
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

/** 顶栏主题切换:浅 → 深 → 跟随系统 循环,弱化模型(不再显示 model 信息)。 */
const THEME_CYCLE: { value: ThemeSource; Icon: typeof Sun; label: string }[] = [
  { value: "light", Icon: Sun, label: "浅色" },
  { value: "dark", Icon: Moon, label: "深色" },
  { value: "system", Icon: Monitor, label: "跟随系统" }
];

function Shell(): JSX.Element {
  const { sidebarCollapsed, toggleSidebar } = useShell();
  const [theme, setTheme] = useState<ThemeSource>("system");

  useEffect(() => {
    void window.pa.settings.getTheme().then(setTheme);
  }, []);

  const current = THEME_CYCLE.find((t) => t.value === theme) ?? THEME_CYCLE[2]!;
  const cycleTheme = (): void => {
    const next = THEME_CYCLE[(THEME_CYCLE.findIndex((t) => t.value === theme) + 1) % THEME_CYCLE.length]!;
    setTheme(next.value);
    void window.pa.settings.setTheme(next.value);
  };

  return (
    <div className="flex h-screen w-screen bg-[#fafafa] text-stone-800 dark:bg-[#0b0c0e] dark:text-stone-100">
      {!sidebarCollapsed && <SessionList />}

      <div className="flex min-w-0 flex-1 flex-col">
        <div
          className={
            "drag flex h-12 shrink-0 items-center justify-between border-b border-stone-200/70 pr-4 dark:border-white/5 " +
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
          <button
            className="no-drag rounded-lg p-1.5 text-stone-500 transition hover:bg-stone-100 hover:text-stone-500 dark:hover:bg-ink-800"
            onClick={cycleTheme}
            title={`主题:${current.label}(点击切换)`}
            aria-label={`切换主题,当前${current.label}`}
          >
            <current.Icon size={16} strokeWidth={2} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          <ChatPane />
          <ArtifactPanel />
        </div>
      </div>
    </div>
  );
}
