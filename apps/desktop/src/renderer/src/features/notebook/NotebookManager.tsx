import { useEffect, useState } from "react";
import { BookOpen, ChevronRight, FileText, Loader2, ScanText, X, AlertTriangle } from "lucide-react";
import type { NotebookView, SourceView, NotebookSourceContent } from "../../../../preload";
import { SourceReader } from "./SourceReader";

/**
 * 知识库管理面板(模态浮层,只读浏览):
 * 左栏 = 知识库树(库 → 展开看来源);右栏 = 选中来源的逐页全文。
 * 增删仍走对话(让 agent 加资料);此处经 notebook:changed 实时同步。
 */
export function NotebookManager({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }): JSX.Element {
  const [notebooks, setNotebooks] = useState<NotebookView[]>([]);
  const [openNb, setOpenNb] = useState<string>(""); // 展开的库名
  const [selected, setSelected] = useState<{ notebook: string; source: SourceView } | null>(null);
  const [content, setContent] = useState<NotebookSourceContent | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const refresh = (): void => void window.pa.notebook.list(workspaceId).then(setNotebooks);
    refresh();
    return window.pa.notebook.onChanged((p) => {
      if (p.wsId === workspaceId) setNotebooks(p.notebooks);
    });
  }, [workspaceId]);

  const openSource = (notebook: string, source: SourceView): void => {
    setSelected({ notebook, source });
    setContent(null);
    setLoading(true);
    void window.pa.notebook.readSource(workspaceId, notebook, source.id).then((c) => {
      setContent(c);
      setLoading(false);
    });
  };

  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-6 backdrop-blur-sm" onClick={onClose}>
      <div
        className="flex h-[82vh] w-[880px] max-w-[94vw] flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-2xl dark:border-white/10 dark:bg-ink-900"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-stone-200/70 px-5 py-3.5 dark:border-white/5">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-stone-800 dark:text-stone-100">
            <BookOpen size={17} strokeWidth={2} className="text-ember-500" />
            知识库
          </div>
          <button
            className="rounded-lg p-1 text-stone-500 transition hover:bg-stone-100 dark:hover:bg-ink-800"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={17} />
          </button>
        </div>

        <div className="flex min-h-0 flex-1">
          {/* 左:知识库树 */}
          <div className="w-72 shrink-0 overflow-auto border-r border-stone-200/70 p-2 dark:border-white/5">
            {notebooks.length === 0 ? (
              <p className="px-2 py-8 text-center text-[12px] leading-relaxed text-stone-500">
                还没有知识库。在对话里说「把这份 PDF 加进知识库『X』」即可创建。
              </p>
            ) : (
              notebooks.map((nb) => (
                <NotebookNode
                  key={nb.id}
                  nb={nb}
                  open={openNb === nb.name}
                  selectedSourceId={selected?.notebook === nb.name ? selected.source.id : ""}
                  onToggle={() => setOpenNb((cur) => (cur === nb.name ? "" : nb.name))}
                  onPick={(s) => openSource(nb.name, s)}
                />
              ))
            )}
          </div>

          {/* 右:来源全文 */}
          <div className="min-w-0 flex-1 overflow-auto p-5">
            {!selected ? (
              <p className="px-1 py-10 text-center text-[12.5px] text-stone-500">选择左侧某份来源查看其内容。</p>
            ) : (
              <>
                <div className="mb-3 border-b border-stone-200/70 pb-2 dark:border-white/5">
                  <div className="flex items-center gap-1.5 text-[13.5px] font-medium text-stone-800 dark:text-stone-100">
                    {selected.source.ocr ? <ScanText size={14} className="text-stone-400" /> : <FileText size={14} className="text-stone-400" />}
                    {selected.source.name}
                  </div>
                  <div className="mt-0.5 text-[11px] text-stone-400">
                    {selected.source.pageCount} 页 · {selected.source.chars} 字 · {selected.notebook}
                  </div>
                </div>
                {loading ? (
                  <div className="flex items-center justify-center gap-2 py-10 text-[12.5px] text-stone-500">
                    <Loader2 size={14} className="animate-spin" /> 读取中…
                  </div>
                ) : content ? (
                  <SourceReader pages={content.pages} />
                ) : (
                  <p className="py-10 text-center text-[12.5px] text-stone-500">读不到这份来源(可能已被移除)。</p>
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function NotebookNode({
  nb,
  open,
  selectedSourceId,
  onToggle,
  onPick
}: {
  nb: NotebookView;
  open: boolean;
  selectedSourceId: string;
  onToggle: () => void;
  onPick: (s: SourceView) => void;
}): JSX.Element {
  return (
    <div className="mb-0.5">
      <button
        className="flex w-full items-center gap-1 rounded-lg px-2 py-1.5 text-left text-[13px] text-stone-700 transition hover:bg-stone-100 dark:text-stone-200 dark:hover:bg-ink-800"
        onClick={onToggle}
      >
        <ChevronRight size={13} className={"shrink-0 text-stone-400 transition " + (open ? "rotate-90" : "")} />
        <span className="min-w-0 flex-1 truncate font-medium">{nb.name}</span>
        <span className="shrink-0 text-[11px] text-stone-400">{nb.sourceCount}</span>
      </button>
      {open && (
        <div className="ml-3 mt-0.5 space-y-0.5 border-l border-stone-200/70 pl-2 dark:border-white/5">
          {nb.sources.length === 0 ? (
            <p className="px-2 py-1 text-[11.5px] text-stone-400">(空)</p>
          ) : (
            nb.sources.map((s) => (
              <button
                key={s.id}
                className={
                  "flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[12px] transition " +
                  (s.id === selectedSourceId
                    ? "bg-ember-100/70 text-ember-700 dark:bg-ember-500/15 dark:text-ember-100"
                    : "text-stone-600 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-ink-800")
                }
                onClick={() => onPick(s)}
                title={s.path}
              >
                {s.error ? (
                  <AlertTriangle size={12} className="shrink-0 text-amber-500" />
                ) : s.ocr ? (
                  <ScanText size={12} className="shrink-0 text-stone-400" />
                ) : (
                  <FileText size={12} className="shrink-0 text-stone-400" />
                )}
                <span className="min-w-0 flex-1 truncate">{s.name}</span>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
