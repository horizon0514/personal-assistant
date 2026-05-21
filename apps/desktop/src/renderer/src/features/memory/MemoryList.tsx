import { useEffect, useState } from "react";

interface MemoryItem {
  id: string;
  kind: "preference" | "fact";
  content: string;
}

/** 个人记忆:可见可编辑(查看 + 删除)。本地存储,隐私不出本机。 */
export function MemoryList(): JSX.Element {
  const [items, setItems] = useState<MemoryItem[]>([]);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    void window.pa.memory.list().then(setItems);
    const off = window.pa.memory.onChanged(setItems);
    return off;
  }, []);

  return (
    <div className="border-b border-slate-200/70 px-4 py-2 dark:border-slate-800">
      <button
        className="flex w-full items-center gap-1.5 text-[12px] font-medium text-slate-500 dark:text-slate-400"
        onClick={() => setOpen((o) => !o)}
      >
        <span className={"transition " + (open ? "rotate-90" : "")}>▸</span>
        🧠 记忆 <span className="text-slate-400">({items.length})</span>
      </button>
      {open && (
        <div className="mt-2 space-y-1">
          {items.length === 0 ? (
            <p className="px-1 text-[12px] text-slate-400 dark:text-slate-500">
              助理会在对话中记住你的偏好与关键事实(纯本地)。
            </p>
          ) : (
            items.map((m) => (
              <div
                key={m.id}
                className="group flex items-start gap-2 rounded-lg bg-slate-50 px-2 py-1.5 text-[12px] dark:bg-slate-800/50"
              >
                <span
                  className={
                    "mt-0.5 shrink-0 rounded px-1 text-[10px] " +
                    (m.kind === "preference"
                      ? "bg-emerald-100 text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300"
                      : "bg-sky-100 text-sky-700 dark:bg-sky-500/15 dark:text-sky-300")
                  }
                >
                  {m.kind === "preference" ? "偏好" : "事实"}
                </span>
                <span className="min-w-0 flex-1 break-words text-slate-700 dark:text-slate-200">{m.content}</span>
                <button
                  className="shrink-0 text-slate-300 opacity-0 transition hover:text-rose-500 group-hover:opacity-100"
                  onClick={() => window.pa.memory.remove(m.id)}
                  title="忘掉这条"
                >
                  ✕
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
