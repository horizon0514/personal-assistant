import { useEffect, useRef, useState } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
}

interface ActionRow {
  id: string;
  tool: string;
  capability: string;
  status: "running" | "awaiting" | "done" | "failed";
  riskLevel?: string;
  error?: string;
}

export function App(): JSX.Element {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [model, setModel] = useState("");
  const [actions, setActions] = useState<ActionRow[]>([]);
  const scrollRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void window.pa.chat.model().then(setModel);
  }, []);

  // 订阅任务/动作领域事件 → 右侧工作区
  useEffect(() => {
    const off = window.pa.domain.onEvent((ev) => {
      if (ev.type === "ActionProposed") {
        setActions((prev) => [
          ...prev,
          { id: ev.action.id, tool: ev.action.tool, capability: ev.action.capability, status: "running" }
        ]);
      } else if (ev.type === "ActionExecuted") {
        setActions((prev) => prev.map((a) => (a.id === ev.actionId ? { ...a, status: "done" } : a)));
      } else if (ev.type === "ActionFailed") {
        setActions((prev) =>
          prev.map((a) => (a.id === ev.actionId ? { ...a, status: "failed", error: ev.error } : a))
        );
      }
    });
    return off;
  }, []);

  // 订阅审批请求 → 把对应卡片切到"待审批"
  useEffect(() => {
    const off = window.pa.approval.onRequest((req) => {
      setActions((prev) => {
        const exists = prev.some((a) => a.id === req.actionId);
        const patched = prev.map((a) =>
          a.id === req.actionId ? { ...a, status: "awaiting" as const, riskLevel: req.riskLevel } : a
        );
        return exists
          ? patched
          : [
              ...patched,
              {
                id: req.actionId,
                tool: req.tool,
                capability: req.capability,
                status: "awaiting" as const,
                riskLevel: req.riskLevel
              }
            ];
      });
    });
    return off;
  }, []);

  const respond = (id: string, approved: boolean): void => {
    window.pa.approval.resolve(id, approved);
    setActions((prev) =>
      prev.map((a) =>
        a.id === id ? { ...a, status: approved ? "running" : "failed", error: approved ? undefined : "已拒绝" } : a
      )
    );
  };

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
    <div className="flex h-screen w-screen flex-col bg-[#f3f7f5] text-slate-800 dark:bg-[#0e1411] dark:text-slate-100">
      {/* 可拖拽顶栏(macOS 红绿灯区)*/}
      <div className="drag flex h-12 shrink-0 items-center justify-between border-b border-slate-200/70 pl-20 pr-4 dark:border-slate-800">
        <span className="text-[13px] font-medium text-slate-600 dark:text-slate-300">个人助理</span>
        {model && (
          <span className="no-drag rounded-full bg-emerald-100 px-2.5 py-1 text-[11px] font-medium text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
            {model}
          </span>
        )}
      </div>

      <div className="flex min-h-0 flex-1">
        {/* 左:Chat */}
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
                    <div className="prose prose-sm max-w-none text-[13px] leading-relaxed dark:prose-invert prose-headings:my-1.5 prose-headings:font-semibold prose-h1:text-[15px] prose-h2:text-[14px] prose-h3:text-[13px] prose-p:my-1.5 prose-p:text-[13px] prose-ul:my-1 prose-ol:my-1 prose-li:my-0.5 prose-li:text-[13px] prose-pre:my-2 prose-pre:bg-slate-900 prose-pre:text-[12px] prose-code:rounded prose-code:bg-slate-100 prose-code:px-1 prose-code:py-0.5 prose-code:text-[12px] prose-code:font-normal prose-code:before:content-[''] prose-code:after:content-[''] dark:prose-code:bg-slate-700">
                      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
                        {m.content}
                      </ReactMarkdown>
                    </div>
                  ) : streaming ? (
                    <Dots />
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          {/* 输入区 */}
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

        {/* 右:计划 / 工作区面板 */}
        <section className="flex w-1/2 flex-col">
          <div className="px-5 py-4 text-[13px] font-medium text-slate-500 dark:text-slate-400">计划 / 工作区</div>
          {actions.length === 0 ? (
            <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-slate-400 dark:text-slate-500">
              助理执行的动作会在这里实时显示。
            </div>
          ) : (
            <div className="flex-1 space-y-2 overflow-auto px-4 pb-5">
              {actions.map((a) => (
                <div
                  key={a.id}
                  className="flex items-start gap-3 rounded-xl border border-slate-200/70 bg-white px-3 py-2.5 text-[13px] dark:border-slate-800 dark:bg-slate-800/60"
                >
                  <StatusDot status={a.status} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-700 dark:text-slate-100">{a.tool}</span>
                      <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500 dark:bg-slate-700 dark:text-slate-300">
                        {a.capability}
                      </span>
                      {a.riskLevel && a.status === "awaiting" && (
                        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] text-amber-700 dark:bg-amber-500/20 dark:text-amber-300">
                          {a.riskLevel}
                        </span>
                      )}
                    </div>
                    {a.status === "awaiting" && (
                      <div className="mt-2 flex gap-2">
                        <button
                          className="rounded-lg bg-emerald-500 px-2.5 py-1 text-[12px] font-medium text-white hover:bg-emerald-600"
                          onClick={() => respond(a.id, true)}
                        >
                          同意
                        </button>
                        <button
                          className="rounded-lg bg-slate-100 px-2.5 py-1 text-[12px] font-medium text-slate-600 hover:bg-slate-200 dark:bg-slate-700 dark:text-slate-200 dark:hover:bg-slate-600"
                          onClick={() => respond(a.id, false)}
                        >
                          拒绝
                        </button>
                      </div>
                    )}
                    {a.error && <p className="mt-1 break-words text-[12px] text-rose-500">{a.error}</p>}
                  </div>
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

function StatusDot({ status }: { status: ActionRow["status"] }): JSX.Element {
  if (status === "awaiting")
    return <span className="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-sky-400" />;
  if (status === "running")
    return <span className="mt-1.5 h-2 w-2 shrink-0 animate-pulse rounded-full bg-amber-400" />;
  if (status === "done")
    return <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-emerald-500" />;
  return <span className="mt-1.5 h-2 w-2 shrink-0 rounded-full bg-rose-500" />;
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
