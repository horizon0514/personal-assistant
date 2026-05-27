import { useEffect, useMemo, useState } from "react";
import { FolderTree, Globe, FileText } from "lucide-react";
import { AkariMark } from "../shell/AkariMark";

/** 「点一盏灯」主题下的陪伴文案池,每次进空白页随机取一句。 */
const COMPANION_LINES = [
  "难办的事,先点一盏灯",
  "把杂活交给我,你去做更要紧的事",
  "说一声,我替你跑这一趟",
  "要查什么、整理什么,告诉我就好",
  "今天,想从哪件事开始?"
];

/** 示例能力卡:都落在真实工具上,点一下把提示填进输入框,补全后发送。 */
const EXAMPLES = [
  { Icon: FolderTree, label: "整理下载文件夹", prompt: "帮我看看「下载」文件夹里都有什么,按类型归一下类。" },
  { Icon: Globe, label: "网页调研", prompt: "帮我调研一下 " },
  { Icon: FileText, label: "读 PDF 提要点", prompt: "帮我读一个 PDF 并总结要点,路径是 " }
];

/** 按时段问候,可带系统账户名。 */
function greeting(name: string): string {
  const h = new Date().getHours();
  const part =
    h < 5 ? "夜深了" : h < 11 ? "上午好" : h < 13 ? "中午好" : h < 18 ? "下午好" : h < 23 ? "晚上好" : "夜深了";
  return name ? `${part},${name}` : part;
}

/**
 * 新会话空白页:点亮的徽标 + 时段问候 + 轮换陪伴文案 + 示例能力卡。
 * onPick 把示例提示交回 ChatPane(填入输入框并聚焦,让用户补全后发送)。
 */
export function EmptyState({ onPick }: { onPick: (text: string) => void }): JSX.Element {
  const [name, setName] = useState("");
  const line = useMemo(() => COMPANION_LINES[Math.floor(Math.random() * COMPANION_LINES.length)]!, []);

  useEffect(() => {
    void window.pa.userName().then(setName);
  }, []);

  return (
    <div className="flex h-[60vh] flex-col items-center justify-center text-center">
      <AkariMark className="lamp-glow mb-5 h-14 w-14 rounded-2xl" />
      <h1 className="text-[19px] font-semibold tracking-tight text-stone-700 dark:text-stone-100">
        {greeting(name)}
      </h1>
      <p className="mt-1.5 text-[14px] text-stone-500 dark:text-stone-400">{line}</p>

      <div className="mt-7 flex flex-wrap items-center justify-center gap-2">
        {EXAMPLES.map((ex) => (
          <button
            key={ex.label}
            onClick={() => onPick(ex.prompt)}
            className="flex items-center gap-1.5 rounded-full border border-stone-200 bg-white px-3.5 py-1.5 text-[12.5px] text-stone-600 transition hover:border-ember-300 hover:text-ember-700 hover:shadow-sm dark:border-white/10 dark:bg-ink-900 dark:text-stone-300 dark:hover:border-ember-500/50 dark:hover:text-ember-200"
          >
            <ex.Icon size={14} strokeWidth={2} className="text-ember-500" />
            {ex.label}
          </button>
        ))}
      </div>
    </div>
  );
}
