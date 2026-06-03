import { useEffect, useState, type ReactNode } from "react";
import { Download, RefreshCw, X } from "lucide-react";
import type { UpdateStatus } from "../../../../preload";

/**
 * 应用内更新提示条:订阅主进程的更新状态,在顶栏下方显示。
 * - downloading → "正在下载 vX… NN%"
 * - downloaded  → "vX 已就绪" + [重启更新]
 * - error(带版本) → mac 未签名兜底:"发现 vX,自动更新需签名版" + [前往下载]
 * 可单条关闭(×);新状态(版本变化)会重新出现。
 */
export function UpdateBanner(): JSX.Element | null {
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const [dismissed, setDismissed] = useState(false);

  useEffect(() => {
    void window.pa.updater.get().then(setStatus);
    return window.pa.updater.onStatus((s) => {
      setStatus(s);
      setDismissed(false); // 新事件来了重新显示
    });
  }, []);

  if (dismissed) return null;
  const dismiss = (): void => setDismissed(true);

  if (status.state === "downloaded") {
    return (
      <Bar tone="ready">
        <span>新版本 {status.version} 已下载完成</span>
        <button
          className="rounded-md bg-ember-500 px-2.5 py-0.5 text-[11.5px] font-medium text-ink-900 transition hover:bg-ember-400"
          onClick={() => window.pa.updater.install()}
        >
          重启更新
        </button>
        <Dismiss onClick={dismiss} />
      </Bar>
    );
  }
  if (status.state === "downloading") {
    return (
      <Bar tone="info">
        <RefreshCw size={12} className="shrink-0 animate-spin" />
        <span>正在下载新版本 {status.version}… {status.percent}%</span>
        <Dismiss onClick={dismiss} />
      </Bar>
    );
  }
  if (status.state === "available") {
    return (
      <Bar tone="info">
        <span>发现新版本 {status.version},正在准备下载…</span>
        <Dismiss onClick={dismiss} />
      </Bar>
    );
  }
  // 出错且已知版本 = 能检测到却装不上(典型:mac 未签名)→ 引导手动下载
  if (status.state === "error" && status.version) {
    return (
      <Bar tone="warn">
        <Download size={12} className="shrink-0" />
        <span>发现新版本 {status.version},自动更新需签名版,可手动下载</span>
        <button
          className="rounded-md px-2.5 py-0.5 text-[11.5px] font-medium text-amber-800 ring-1 ring-amber-300 transition hover:bg-amber-100 dark:text-amber-200 dark:ring-amber-500/40 dark:hover:bg-amber-500/15"
          onClick={() => window.pa.updater.openReleases()}
        >
          前往下载
        </button>
        <Dismiss onClick={dismiss} />
      </Bar>
    );
  }
  return null;
}

function Bar({ tone, children }: { tone: "info" | "ready" | "warn"; children: ReactNode }): JSX.Element {
  const toneCls = {
    info: "bg-stone-100/80 text-stone-600 dark:bg-ink-800/80 dark:text-stone-300",
    ready: "bg-ember-50 text-ember-800 dark:bg-ember-500/10 dark:text-ember-200",
    warn: "bg-amber-50 text-amber-800 dark:bg-amber-500/10 dark:text-amber-200"
  }[tone];
  return (
    <div className={"flex shrink-0 items-center gap-2 px-4 py-1.5 text-[12px] " + toneCls}>{children}</div>
  );
}

function Dismiss({ onClick }: { onClick: () => void }): JSX.Element {
  return (
    <button
      className="ml-auto flex h-5 w-5 shrink-0 items-center justify-center rounded opacity-50 transition hover:bg-black/5 hover:opacity-100 dark:hover:bg-white/10"
      onClick={onClick}
      aria-label="关闭"
    >
      <X size={12} strokeWidth={2.5} />
    </button>
  );
}
