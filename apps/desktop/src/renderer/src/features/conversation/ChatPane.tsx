import { useEffect, useRef, useState } from "react";
import { Markdown } from "./Markdown";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

/** 会话面板:消息流 + 输入 + 流式拼接 */
export function ChatPane(): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const off = window.pa.chat.onStream((event) => {
      if (event.type === "delta") {
        setMessages((prev) => appendToLastAssistant(prev, event.text));
      } else if (event.type === "error") {
        setMessages((prev) => appendToLastAssistant(prev, `\n\n⚠️ 出错:${event.message}`));
        setStreaming(false);
      } else if (event.type === "done") {
        setStreaming(false);
      }
    });
    return off;
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const send = (): void => {
    const text = input.trim();
    if (!text || streaming) return;
    setMessages((prev) => [
      ...prev,
      { id: crypto.randomUUID(), role: "user", content: text },
      { id: crypto.randomUUID(), role: "assistant", content: "" }
    ]);
    setInput("");
    setStreaming(true);
    window.pa.chat.send(text);
  };

  return (
    <section className="flex w-1/2 flex-col border-r border-slate-200/70 dark:border-slate-800">
      <div ref={scrollRef} className="flex-1 space-y-5 overflow-auto px-5 py-6">
        {messages.length === 0 && (
          <div className="flex h-full flex-col items-center justify-center text-center">
            <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-2xl bg-emerald-100 text-2xl dark:bg-emerald-500/15">
              🌿
            </div>
            <p className="text-sm text-slate-400 dark:text-slate-500">想让我帮你做点什么?</p>
          </div>
        )}
        {messages.map((m) => (
          <div key={m.id} className={m.role === "user" ? "flex justify-end" : "flex justify-start"}>
            <div
              className={
                "max-w-[82%] rounded-2xl px-4 py-2.5 text-[13.5px] leading-relaxed " +
                (m.role === "user"
                  ? "whitespace-pre-wrap bg-emerald-500 text-white shadow-sm shadow-emerald-500/20 dark:bg-emerald-600"
                  : "bg-white text-slate-700 shadow-sm ring-1 ring-slate-200/80 dark:bg-slate-800 dark:text-slate-100 dark:ring-slate-700")
              }
            >
              {m.role === "user" ? (
                m.content
              ) : m.content ? (
                <Markdown>{m.content}</Markdown>
              ) : streaming ? (
                <Dots />
              ) : null}
            </div>
          </div>
        ))}
      </div>

      <div className="shrink-0 px-4 pb-5 pt-2">
        <div className="no-drag flex items-end gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm focus-within:border-emerald-300 focus-within:ring-2 focus-within:ring-emerald-100 dark:border-slate-700 dark:bg-slate-800 dark:focus-within:border-emerald-500/60 dark:focus-within:ring-emerald-500/20">
          <textarea
            rows={1}
            className="max-h-32 flex-1 resize-none bg-transparent px-2 py-1.5 text-[13.5px] text-slate-700 outline-none placeholder:text-slate-400 dark:text-slate-100 dark:placeholder:text-slate-500"
            placeholder="发消息给助理…  (Enter 发送 · Shift+Enter 换行)"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                send();
              }
            }}
          />
          <button
            className="flex h-8 w-8 items-center justify-center rounded-xl bg-emerald-500 text-white transition hover:bg-emerald-600 disabled:opacity-30"
            onClick={send}
            disabled={streaming || input.trim() === ""}
            aria-label="发送"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
              <path
                d="M5 12h14M13 6l6 6-6 6"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </button>
        </div>
      </div>
    </section>
  );
}

function Dots(): JSX.Element {
  return (
    <span className="inline-flex gap-1">
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-300 [animation-delay:-0.3s] dark:bg-slate-600" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-300 [animation-delay:-0.15s] dark:bg-slate-600" />
      <span className="h-1.5 w-1.5 animate-bounce rounded-full bg-slate-300 dark:bg-slate-600" />
    </span>
  );
}

function appendToLastAssistant(messages: ChatMessage[], text: string): ChatMessage[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant") return messages;
  return [...messages.slice(0, -1), { ...last, content: last.content + text }];
}
