import { useEffect, useState } from "react";
import { BookOpen, ChevronRight, FilePlus2, FileText, Loader2, Plus, ScanText, Trash2, Upload, X, AlertTriangle } from "lucide-react";
import type { NotebookView, SourceView, NotebookSourceContent } from "../../../../preload";
import { SourceReader } from "./SourceReader";

/**
 * 知识库管理面板(模态浮层):
 * 左栏 = 知识库树(库 → 展开看来源);右栏 = 选中来源的逐页全文。
 * 增删来源:UI 选文件/拖入(→ 抽取入库)或在对话里让 agent 加;经 notebook:changed 实时同步。
 */
/** 绝对路径 → file:// URL(逐段编码,处理空格/特殊字符)。 */
function toFileUrl(path: string): string {
  return "file://" + path.split("/").map(encodeURIComponent).join("/");
}

export function NotebookManager({ workspaceId, onClose }: { workspaceId: string; onClose: () => void }): JSX.Element {
  const [notebooks, setNotebooks] = useState<NotebookView[]>([]);
  const [openNb, setOpenNb] = useState<string>("");
  const [selected, setSelected] = useState<{ notebook: string; source: SourceView } | null>(null);
  const [content, setContent] = useState<NotebookSourceContent | null>(null);
  const [loading, setLoading] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(""); // 导入中提示;空=空闲
  const [rightDragOver, setRightDragOver] = useState(false);
  const [view, setView] = useState<"original" | "parsed">("original"); // 预览:原件优先,可切解析文本

  // 右侧拖入/添加绑定的知识库:优先正在看的来源所属库,否则当前展开的库。
  const activeNb = selected?.notebook || openNb;

  useEffect(() => {
    void window.pa.notebook.list(workspaceId).then(setNotebooks);
    return window.pa.notebook.onChanged((p) => {
      if (p.wsId === workspaceId) setNotebooks(p.notebooks);
    });
  }, [workspaceId]);

  const openSource = (notebook: string, source: SourceView): void => {
    setSelected({ notebook, source });
    setView("original"); // 默认看原件;解析文本按需切
    setContent(null);
    setLoading(true);
    void window.pa.notebook.readSource(workspaceId, notebook, source.id).then((c) => {
      setContent(c);
      setLoading(false);
    });
  };

  const createNotebook = (): void => {
    const name = newName.trim();
    if (!name) return;
    void window.pa.notebook.create(workspaceId, name).then(() => {
      setOpenNb(name);
      setNewName("");
      setCreating(false);
    });
  };

  /** 把若干文件加进某知识库(选文件/拖入共用):逐个抽取入库,失败汇总提示。 */
  const addFiles = async (notebook: string, paths: string[]): Promise<void> => {
    if (paths.length === 0) return;
    setOpenNb(notebook);
    const skipped: string[] = [];
    for (let i = 0; i < paths.length; i++) {
      setBusy(`正在导入(${i + 1}/${paths.length})…`);
      const r = await window.pa.notebook.addSource(workspaceId, notebook, paths[i]!);
      if (r.status === "unsupported") skipped.push(r.note ?? paths[i]!);
    }
    setBusy(skipped.length ? `已导入;${skipped.length} 个被跳过(格式不支持)` : "");
    if (skipped.length) setTimeout(() => setBusy(""), 4000);
  };

  const pickAndAdd = async (notebook: string): Promise<void> => {
    const paths = await window.pa.notebook.pickFiles();
    await addFiles(notebook, paths);
  };

  const dropFiles = (notebook: string, e: React.DragEvent): void => {
    e.preventDefault();
    e.stopPropagation();
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.pa.files.pathForDropped(f))
      .filter(Boolean);
    void addFiles(notebook, paths);
  };

  const removeSource = (notebook: string, source: SourceView): void => {
    void window.pa.notebook.removeSource(workspaceId, notebook, source.id).then(() => {
      if (selected?.source.id === source.id) {
        setSelected(null);
        setContent(null);
      }
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
            {busy && (
              <span className="ml-2 inline-flex items-center gap-1 text-[11.5px] font-normal text-stone-500">
                <Loader2 size={12} className="animate-spin" />
                {busy}
              </span>
            )}
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
          {/* 左:知识库树 + 新建 */}
          <div className="flex w-72 shrink-0 flex-col border-r border-stone-200/70 dark:border-white/5">
            <div className="border-b border-stone-200/70 p-2 dark:border-white/5">
              {creating ? (
                <div className="flex items-center gap-1">
                  <input
                    autoFocus
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") createNotebook();
                      if (e.key === "Escape") setCreating(false);
                    }}
                    placeholder="知识库名称"
                    className="min-w-0 flex-1 rounded-lg border border-stone-200 bg-white px-2 py-1 text-[12.5px] outline-none focus:border-ember-300 dark:border-white/10 dark:bg-ink-800 dark:text-stone-100"
                  />
                  <button
                    className="shrink-0 rounded-lg bg-ember-500 px-2 py-1 text-[12px] font-medium text-ink-900 hover:bg-ember-600"
                    onClick={createNotebook}
                  >
                    建
                  </button>
                </div>
              ) : (
                <button
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-dashed border-stone-300 py-1.5 text-[12px] text-stone-600 transition hover:border-ember-300 hover:text-ember-600 dark:border-white/10 dark:text-stone-300"
                  onClick={() => setCreating(true)}
                >
                  <Plus size={13} strokeWidth={2.2} />
                  新建知识库
                </button>
              )}
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-2">
              {notebooks.length === 0 ? (
                <p className="px-2 py-8 text-center text-[12px] leading-relaxed text-stone-500">
                  还没有知识库。点上方「新建知识库」,或在对话里让助理把资料加进来。
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
                    onAddFiles={() => void pickAndAdd(nb.name)}
                    onDropFiles={(e) => dropFiles(nb.name, e)}
                    onRemove={(s) => removeSource(nb.name, s)}
                  />
                ))
              )}
            </div>
          </div>

          {/* 右:来源预览(原件为主,可切解析文本)+ 拖入区(绑定 activeNb,拖到整块任意位置都能加) */}
          <div
            className="relative flex min-w-0 flex-1 flex-col"
            onDragOver={(e) => {
              if (!activeNb || !Array.from(e.dataTransfer.types).includes("Files")) return;
              e.preventDefault();
              setRightDragOver(true);
            }}
            onDragLeave={(e) => {
              if (e.currentTarget.contains(e.relatedTarget as Node)) return;
              setRightDragOver(false);
            }}
            onDrop={(e) => {
              setRightDragOver(false);
              if (activeNb) dropFiles(activeNb, e);
            }}
          >
            {rightDragOver && activeNb && (
              <div className="pointer-events-none absolute inset-3 z-10 flex flex-col items-center justify-center gap-2 rounded-2xl border-2 border-dashed border-ember-400 bg-ember-50/85 text-ember-700 backdrop-blur-sm dark:bg-ember-500/10 dark:text-ember-200">
                <Upload size={28} strokeWidth={1.8} />
                <span className="text-[13px] font-medium">松开即可加入「{activeNb}」</span>
              </div>
            )}
            {!selected ? (
              activeNb ? (
                <div className="flex flex-1 flex-col items-center justify-center px-6">
                  <button
                    onClick={() => void pickAndAdd(activeNb)}
                    className="flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed border-stone-300 px-14 py-12 text-stone-500 transition hover:border-ember-400 hover:bg-ember-50/40 hover:text-ember-600 dark:border-white/10 dark:hover:bg-ember-500/5"
                  >
                    <FilePlus2 size={34} strokeWidth={1.5} />
                    <span className="text-[13.5px] font-medium">点击选择文件,加入「{activeNb}」</span>
                    <span className="text-[11.5px] text-stone-400">或把 PDF / 文本直接拖到这里</span>
                  </button>
                </div>
              ) : (
                <p className="flex flex-1 items-center justify-center px-6 text-center text-[12.5px] text-stone-500">
                  选择左侧一个知识库,即可在这里添加或拖入文件;选中某份来源可查看其内容。
                </p>
              )
            ) : (
              <>
                <div className="flex shrink-0 items-center justify-between gap-2 border-b border-stone-200/70 px-5 py-2.5 dark:border-white/5">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 truncate text-[13.5px] font-medium text-stone-800 dark:text-stone-100">
                      {selected.source.ocr ? <ScanText size={14} className="shrink-0 text-stone-400" /> : <FileText size={14} className="shrink-0 text-stone-400" />}
                      <span className="truncate">{selected.source.name}</span>
                    </div>
                    <div className="mt-0.5 text-[11px] text-stone-400">
                      {selected.source.pageCount} 页 · {selected.source.chars} 字 · {selected.notebook}
                    </div>
                  </div>
                  {/* 原文 / 解析 切换 */}
                  <div className="flex shrink-0 rounded-lg bg-stone-100 p-0.5 text-[11.5px] dark:bg-ink-800">
                    {(["original", "parsed"] as const).map((v) => (
                      <button
                        key={v}
                        onClick={() => setView(v)}
                        className={
                          "rounded-md px-2.5 py-1 font-medium transition " +
                          (view === v
                            ? "bg-white text-stone-800 shadow-sm dark:bg-ink-700 dark:text-stone-100"
                            : "text-stone-500 hover:text-stone-700 dark:hover:text-stone-300")
                        }
                      >
                        {v === "original" ? "原文" : "解析"}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="min-h-0 flex-1">
                  {view === "original" ? (
                    <webview
                      key={selected.source.id}
                      src={toFileUrl(selected.source.path)}
                      plugins
                      className="h-full w-full"
                      style={{ width: "100%", height: "100%" }}
                    />
                  ) : loading ? (
                    <div className="flex items-center justify-center gap-2 py-10 text-[12.5px] text-stone-500">
                      <Loader2 size={14} className="animate-spin" /> 读取中…
                    </div>
                  ) : content ? (
                    <div className="h-full overflow-auto p-5">
                      <SourceReader pages={content.pages} />
                    </div>
                  ) : (
                    <p className="py-10 text-center text-[12.5px] text-stone-500">读不到这份来源(可能已被移除)。</p>
                  )}
                </div>
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
  onPick,
  onAddFiles,
  onDropFiles,
  onRemove
}: {
  nb: NotebookView;
  open: boolean;
  selectedSourceId: string;
  onToggle: () => void;
  onPick: (s: SourceView) => void;
  onAddFiles: () => void;
  onDropFiles: (e: React.DragEvent) => void;
  onRemove: (s: SourceView) => void;
}): JSX.Element {
  const [dragOver, setDragOver] = useState(false);
  return (
    <div
      className={"mb-0.5 rounded-lg " + (dragOver ? "bg-ember-50 ring-1 ring-ember-300 dark:bg-ember-500/10" : "")}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        setDragOver(false);
        onDropFiles(e);
      }}
    >
      <div className="group flex items-center rounded-lg pr-1 hover:bg-stone-100 dark:hover:bg-ink-800">
        <button className="flex min-w-0 flex-1 items-center gap-1 px-2 py-1.5 text-left text-[13px] text-stone-700 dark:text-stone-200" onClick={onToggle}>
          <ChevronRight size={13} className={"shrink-0 text-stone-400 transition " + (open ? "rotate-90" : "")} />
          <span className="min-w-0 flex-1 truncate font-medium">{nb.name}</span>
          <span className="shrink-0 text-[11px] text-stone-400">{nb.sourceCount}</span>
        </button>
        <button
          className="shrink-0 rounded-md p-1.5 text-stone-400 transition hover:bg-ember-50 hover:text-ember-600 dark:hover:bg-ember-500/10"
          onClick={onAddFiles}
          title="加文件到这个知识库"
          aria-label="加文件"
        >
          <FilePlus2 size={17} strokeWidth={2} />
        </button>
      </div>
      {open && (
        <div className="ml-3 mt-0.5 space-y-0.5 border-l border-stone-200/70 pl-2 dark:border-white/5">
          {nb.sources.length === 0 ? (
            <p className="px-2 py-1 text-[11.5px] text-stone-400">空 —— 点右侧 + 或把文件拖到这里</p>
          ) : (
            nb.sources.map((s) => (
              <div
                key={s.id}
                className={
                  "group flex items-center rounded-md pr-1 transition " +
                  (s.id === selectedSourceId ? "bg-ember-100/70 dark:bg-ember-500/15" : "hover:bg-stone-100 dark:hover:bg-ink-800")
                }
              >
                <button
                  className={
                    "flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1 text-left text-[12px] " +
                    (s.id === selectedSourceId ? "text-ember-700 dark:text-ember-100" : "text-stone-600 dark:text-stone-300")
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
                <button
                  className="shrink-0 rounded p-0.5 text-stone-400 opacity-0 transition hover:text-rose-500 group-hover:opacity-100"
                  onClick={() => onRemove(s)}
                  title="移出知识库(软删,可恢复)"
                  aria-label="移除"
                >
                  <Trash2 size={12} />
                </button>
              </div>
            ))
          )}
        </div>
      )}
    </div>
  );
}
