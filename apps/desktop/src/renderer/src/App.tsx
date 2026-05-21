import { useState } from "react";

/**
 * 最小骨架 UI:左 Chat、右 计划/工作区面板。
 * 仅占位,验证两栏布局与 IPC 桥通路;领域接入后再填充。
 */
export function App(): JSX.Element {
  const [pong, setPong] = useState<string>("");

  return (
    <div className="flex h-screen w-screen bg-zinc-50 text-zinc-900">
      {/* 左:Chat */}
      <section className="flex w-1/2 flex-col border-r border-zinc-200">
        <header className="border-b border-zinc-200 px-4 py-3 text-sm font-medium">
          对话
        </header>
        <div className="flex-1 overflow-auto p-4 text-sm text-zinc-500">
          这里是 Chat 流(占位)。
        </div>
        <footer className="border-t border-zinc-200 p-3">
          <input
            className="w-full rounded-md border border-zinc-300 px-3 py-2 text-sm outline-none focus:border-zinc-500"
            placeholder="让助理帮你做点什么…"
          />
        </footer>
      </section>

      {/* 右:计划 / 工作区面板 */}
      <section className="flex w-1/2 flex-col">
        <header className="border-b border-zinc-200 px-4 py-3 text-sm font-medium">
          计划 / 工作区
        </header>
        <div className="flex-1 overflow-auto p-4 text-sm text-zinc-500">
          这里展示计划步骤、文件 diff 预览、来源卡片、浏览器动作(占位)。
        </div>
        <footer className="border-t border-zinc-200 p-3">
          <button
            className="rounded-md bg-zinc-900 px-3 py-2 text-sm text-white"
            onClick={async () => setPong(await window.pa.ping())}
          >
            测试 IPC 桥
          </button>
          {pong && <span className="ml-3 text-xs text-emerald-600">main 回应:{pong}</span>}
        </footer>
      </section>
    </div>
  );
}
