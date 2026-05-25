import { useEffect, useRef, useState } from "react";
import { Loader2, X } from "lucide-react";
import { useShell } from "../shell/store";
import type { BatchState } from "../shell/types";
import type { ElectronWebview } from "../../env";

/**
 * 右侧 artifact 面板:默认折叠,一次一个。
 * - batch:批量 diff 自动弹出
 * - text:来源块「查看」的结果文本
 * - browser:内置调研浏览器(面板内 <webview>,主进程驱动其导航/抓取)
 */
export function ArtifactPanel(): JSX.Element | null {
  const { artifact, closeArtifact } = useShell();
  if (!artifact) return null;

  const resolveBatch = (batch: BatchState, approved: boolean): void => {
    window.pa.batch.resolve(batch.actionId, approved);
    closeArtifact();
  };

  return (
    <aside className="flex w-[480px] shrink-0 flex-col border-l border-stone-200/70 bg-white/40 dark:border-white/5 dark:bg-ink-900/30">
      <div className="flex h-12 shrink-0 items-center justify-between border-b border-stone-200/70 px-4 dark:border-white/5">
        <span className="truncate text-[13px] font-medium text-stone-500 dark:text-stone-300">
          {artifact.title}
        </span>
        <button
          className="no-drag rounded-lg px-2 py-1 text-[13px] text-stone-500 transition hover:bg-stone-100 hover:text-stone-500 dark:hover:bg-ink-800"
          onClick={closeArtifact}
          aria-label="关闭"
        >
          <X size={16} />
        </button>
      </div>

      {artifact.kind === "browser" ? (
        <BrowserArtifact />
      ) : (
        <div className="flex-1 overflow-auto p-4">
          {artifact.kind === "batch" ? (
            <BatchView batch={artifact.batch} onRespond={(ok) => resolveBatch(artifact.batch, ok)} />
          ) : (
            <pre className="whitespace-pre-wrap break-words font-mono text-[12.5px] text-stone-700 dark:text-stone-200">
              {artifact.body}
            </pre>
          )}
        </div>
      )}
    </aside>
  );
}

/**
 * 内置调研浏览器:渲染层里的一个 <webview>(DOM 元素,天然待在面板区域,无 z-order /
 * 绘制 / bounds 同步问题)。主进程通过 webContents 驱动它 loadURL/抓取(见 browser-manager)。
 * 头部 URL / 加载态直接监听 webview 的 DOM 事件。
 */
function BrowserArtifact(): JSX.Element {
  const ref = useRef<ElectronWebview>(null);
  const [nav, setNav] = useState<{ url: string; loading: boolean }>({ url: "", loading: false });

  useEffect(() => {
    const wv = ref.current;
    if (!wv) return;
    const onStart = (): void => setNav((n) => ({ ...n, loading: true }));
    const onStop = (): void => setNav({ url: wv.getURL(), loading: false });
    const onNav = (): void => setNav((n) => ({ ...n, url: wv.getURL() }));
    wv.addEventListener("did-start-loading", onStart);
    wv.addEventListener("did-stop-loading", onStop);
    wv.addEventListener("did-navigate", onNav);
    wv.addEventListener("did-navigate-in-page", onNav);
    return () => {
      wv.removeEventListener("did-start-loading", onStart);
      wv.removeEventListener("did-stop-loading", onStop);
      wv.removeEventListener("did-navigate", onNav);
      wv.removeEventListener("did-navigate-in-page", onNav);
    };
  }, []);

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="relative shrink-0 border-b border-stone-200/70 dark:border-white/5">
        <div className="flex items-center gap-1.5 px-3 py-1.5">
          {nav.loading && <Loader2 size={12} className="shrink-0 animate-spin text-ember-500" />}
          <span className="truncate text-[11.5px] text-stone-500 dark:text-stone-400" title={nav.url}>
            {nav.loading && !nav.url ? "加载中…" : nav.url || "调研浏览器"}
          </span>
        </div>
        {nav.loading && (
          <div className="absolute inset-x-0 bottom-0 h-0.5 animate-pulse bg-ember-300/70 dark:bg-ember-500/60" />
        )}
      </div>
      <webview
        ref={ref}
        src="about:blank"
        partition="persist:research"
        className="min-h-0 flex-1"
        style={{ width: "100%" }}
      />
    </div>
  );
}

function BatchView({
  batch,
  onRespond
}: {
  batch: BatchState;
  onRespond: (approved: boolean) => void;
}): JSX.Element {
  return (
    <div>
      <p className="mb-2 text-[12px] text-stone-500 dark:text-stone-400">
        助理想批量修改 {batch.operations.length} 项,确认后执行(可整批回滚)。
      </p>
      <div className="space-y-1 rounded-xl bg-stone-50 p-3 font-mono text-[12px] dark:bg-ink-800/50">
        {batch.operations.map((op, i) => (
          <div key={i} className="break-words text-stone-700 dark:text-stone-200">
            {op.op === "move" ? (
              <>
                <span className="text-sky-600 dark:text-sky-400">移动</span> {op.from}{" "}
                <span className="text-stone-500">→</span> {op.to}
              </>
            ) : (
              <>
                <span className="text-rose-600 dark:text-rose-400">删除</span> {op.path}{" "}
                <span className="text-stone-500">→ 回收区</span>
              </>
            )}
          </div>
        ))}
      </div>
      <div className="mt-3 flex gap-2">
        <button
          className="flex-1 rounded-lg bg-ember-500 px-3 py-2 text-[13px] font-medium text-ink-900 hover:bg-ember-600"
          onClick={() => onRespond(true)}
        >
          全部同意
        </button>
        <button
          className="flex-1 rounded-lg bg-stone-100 px-3 py-2 text-[13px] font-medium text-stone-500 hover:bg-stone-200 dark:bg-ink-700 dark:text-stone-200 dark:hover:bg-ink-600"
          onClick={() => onRespond(false)}
        >
          全部拒绝
        </button>
      </div>
    </div>
  );
}
