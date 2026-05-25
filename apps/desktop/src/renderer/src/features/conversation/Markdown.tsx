import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

const PROSE =
  "prose prose-sm max-w-none text-[13px] leading-relaxed dark:prose-invert " +
  "prose-headings:my-1.5 prose-headings:font-semibold prose-h1:text-[15px] prose-h2:text-[14px] prose-h3:text-[13px] " +
  "prose-p:my-1.5 prose-p:text-[13px] prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-li:text-[13px] " +
  "prose-pre:my-2 prose-pre:bg-ink-900 prose-pre:text-[12px] " +
  "prose-code:rounded prose-code:bg-stone-100 prose-code:px-1 prose-code:py-0.5 prose-code:text-[12px] " +
  "prose-code:font-normal prose-code:before:content-[''] prose-code:after:content-[''] dark:prose-code:bg-ink-700";

/** 助理消息的 Markdown 渲染(GFM + 语法高亮)*/
export function Markdown({ children }: { children: string }): JSX.Element {
  return (
    <div className={PROSE}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
