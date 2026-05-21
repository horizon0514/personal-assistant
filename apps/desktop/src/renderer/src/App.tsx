import { useEffect, useState } from "react";
import { ChatPane } from "./features/conversation/ChatPane";
import { WorkspacePanel } from "./features/workspace/WorkspacePanel";

/** 布局外壳:可拖拽标题栏 + 左 会话 / 右 工作区 */
export function App(): JSX.Element {
  const [model, setModel] = useState("");

  useEffect(() => {
    void window.pa.chat.model().then(setModel);
  }, []);

  return (
    <div className="flex h-screen w-screen flex-col bg-[#f3f7f5] text-slate-800 dark:bg-[#0e1411] dark:text-slate-100">
      <div className="drag flex h-12 shrink-0 items-center justify-between border-b border-slate-200/70 pl-20 pr-4 dark:border-slate-800">
        <span className="text-[13px] font-medium text-slate-600 dark:text-slate-300">个人助理</span>
        {model && (
          <span className="no-drag rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
            {model}
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        <ChatPane />
        <WorkspacePanel />
      </div>
    </div>
  );
}
