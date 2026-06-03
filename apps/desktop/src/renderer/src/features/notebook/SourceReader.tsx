import { useEffect, useRef } from "react";
import type { PageText } from "../../../../preload";

/**
 * 来源阅读器:逐页渲染(带「第 N 页」锚),可选滚动到某页(引用跳转用)。
 * 复用于知识库管理面板的详情栏与右侧 artifact(引用跳转)。
 */
export function SourceReader({
  pages,
  scrollToPage,
  highlight
}: {
  pages: PageText[];
  scrollToPage?: number;
  highlight?: string;
}): JSX.Element {
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!scrollToPage || !containerRef.current) return;
    const el = containerRef.current.querySelector(`[data-page="${scrollToPage}"]`);
    el?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [scrollToPage, pages]);

  if (pages.length === 0) {
    return <p className="px-1 py-6 text-center text-[12.5px] text-stone-500">这份来源没有可显示的文本。</p>;
  }

  return (
    <div ref={containerRef} className="space-y-4">
      {pages.map((p) => (
        <div key={p.page} data-page={p.page} className="scroll-mt-2">
          <div className="mb-1 select-none text-[11px] font-medium uppercase tracking-wide text-stone-400 dark:text-stone-500">
            第 {p.page} 页
          </div>
          <p className="whitespace-pre-wrap break-words text-[12.5px] leading-relaxed text-stone-700 dark:text-stone-200">
            {highlight ? highlightText(p.text, highlight) : p.text}
          </p>
        </div>
      ))}
    </div>
  );
}

/** 把命中关键词高亮(大小写不敏感);无命中原样返回。 */
function highlightText(text: string, term: string): (string | JSX.Element)[] {
  const q = term.trim();
  if (!q) return [text];
  const out: (string | JSX.Element)[] = [];
  const lower = text.toLowerCase();
  const ql = q.toLowerCase();
  let i = 0;
  let k = lower.indexOf(ql);
  let n = 0;
  while (k !== -1) {
    if (k > i) out.push(text.slice(i, k));
    out.push(
      <mark key={n++} className="rounded bg-ember-200/70 px-0.5 text-stone-900 dark:bg-ember-500/40 dark:text-stone-50">
        {text.slice(k, k + q.length)}
      </mark>
    );
    i = k + q.length;
    k = lower.indexOf(ql, i);
  }
  if (i < text.length) out.push(text.slice(i));
  return out;
}
