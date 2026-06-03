import { useCallback, useEffect, useState, type ReactNode } from "react";
import { RefreshCw } from "lucide-react";
import type { EvalTelemetrySummary, PersistedEvalRecord } from "../../../../preload";

/**
 * 验收质量面板:读取 + 展示 eval-telemetry.jsonl 的聚合统计与最近逐条记录。
 * 纯只读观测——用来回答「验收门松紧合不合适、误拦多少、值不值这成本」。
 */
export function EvalTelemetryPanel(): JSX.Element {
  const [data, setData] = useState<EvalTelemetrySummary | null>(null);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setData(await window.pa.evalTelemetry.get());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (loading && !data) {
    return <p className="text-[12.5px] text-stone-500 dark:text-stone-500">读取中…</p>;
  }
  if (!data || data.total === 0) {
    return (
      <div className="space-y-3">
        <p className="text-[12.5px] leading-relaxed text-stone-500 dark:text-stone-400">
          还没有验收数据。跑几轮会触发验收(改了真实状态 ∥ 有确认过的开工契约)的任务后,这里就会有统计。
        </p>
        <RefreshButton onClick={load} loading={loading} />
      </div>
    );
  }

  const { passRate, avgDurationMs } = data;
  return (
    <div className="space-y-5">
      <div className="flex items-center justify-between">
        <p className="text-[11.5px] text-stone-500 dark:text-stone-500">
          共 {data.total} 轮有动作 · 数据来自 <code className="text-[11px]">eval-telemetry.jsonl</code>
        </p>
        <RefreshButton onClick={load} loading={loading} />
      </div>

      {/* 核心指标 */}
      <div className="grid grid-cols-3 gap-2">
        <Stat label="通过率" value={passRate == null ? "—" : `${Math.round(passRate * 100)}%`} hint={`${data.passed}/${data.evaluated} 通过`} accent />
        <Stat label="触发验收" value={String(data.evaluated)} hint={`${data.skipped} 轮跳过`} />
        <Stat label="返工" value={String(data.retried)} hint="不过且未耗尽 retry" />
        <Stat label="平均耗时" value={avgDurationMs == null ? "—" : `${(avgDurationMs / 1000).toFixed(1)}s`} hint="每轮验收" />
        <Stat label="交互/定时" value={`${data.bySource.interactive}/${data.bySource.scheduled}`} hint="来源分布" />
        <Stat label="跳过" value={String(data.skipped)} hint="有动作但没验收" />
      </div>

      {/* 触发 / 跳过原因分布 */}
      <div className="grid grid-cols-2 gap-3">
        <Breakdown title="验收触发原因" map={data.byTrigger} labeler={triggerLabel} empty="暂无" />
        <Breakdown title="跳过原因" map={data.bySkipReason} labeler={skipReasonLabel} empty="暂无" />
      </div>

      {/* 最近逐条 */}
      <div>
        <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-500">
          最近记录(新→旧)
        </div>
        <div className="overflow-hidden rounded-lg border border-stone-200/70 dark:border-white/5">
          {data.recent.map((r, i) => (
            <RecordRow key={`${r.ts}-${i}`} r={r} alt={i % 2 === 1} />
          ))}
        </div>
      </div>
    </div>
  );
}

function RefreshButton({ onClick, loading }: { onClick: () => void; loading: boolean }): JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={loading}
      className="flex items-center gap-1.5 rounded-lg border border-stone-200 bg-white px-2.5 py-1 text-[12px] text-stone-600 transition hover:bg-stone-50 disabled:opacity-50 dark:border-white/10 dark:bg-ink-800 dark:text-stone-300 dark:hover:bg-ink-700"
    >
      <RefreshCw size={12} className={loading ? "animate-spin" : ""} />
      刷新
    </button>
  );
}

function Stat({ label, value, hint, accent }: { label: string; value: string; hint?: string; accent?: boolean }): JSX.Element {
  return (
    <div className="rounded-xl border border-stone-200/70 bg-white px-3 py-2.5 dark:border-white/5 dark:bg-ink-800/50">
      <div className="text-[10.5px] text-stone-500 dark:text-stone-500">{label}</div>
      <div className={"mt-0.5 text-[18px] font-semibold tabular-nums " + (accent ? "text-ember-600 dark:text-ember-400" : "text-stone-700 dark:text-stone-200")}>
        {value}
      </div>
      {hint && <div className="text-[10px] text-stone-400 dark:text-stone-500">{hint}</div>}
    </div>
  );
}

function Breakdown({
  title,
  map,
  labeler,
  empty
}: {
  title: string;
  map: Record<string, number>;
  labeler: (k: string) => string;
  empty: string;
}): JSX.Element {
  const entries = Object.entries(map).sort((a, b) => b[1] - a[1]);
  return (
    <div className="rounded-xl border border-stone-200/70 bg-white px-3 py-2.5 dark:border-white/5 dark:bg-ink-800/50">
      <div className="text-[10.5px] font-medium text-stone-500 dark:text-stone-500">{title}</div>
      {entries.length === 0 ? (
        <div className="mt-1 text-[11px] text-stone-400 dark:text-stone-600">{empty}</div>
      ) : (
        <div className="mt-1.5 space-y-1">
          {entries.map(([k, n]) => (
            <div key={k} className="flex items-center justify-between text-[11.5px]">
              <span className="text-stone-600 dark:text-stone-300">{labeler(k)}</span>
              <span className="tabular-nums text-stone-400 dark:text-stone-500">{n}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function RecordRow({ r, alt }: { r: PersistedEvalRecord; alt: boolean }): JSX.Element {
  return (
    <div className={"flex items-center gap-2 px-2.5 py-1.5 text-[11.5px] " + (alt ? "bg-stone-50/60 dark:bg-white/[0.015]" : "")}>
      <span className="w-[64px] shrink-0 tabular-nums text-stone-400 dark:text-stone-500">{formatTime(r.ts)}</span>
      <span className="w-[34px] shrink-0 text-[10px] text-stone-400 dark:text-stone-600">{r.source === "scheduled" ? "定时" : "交互"}</span>
      <span className="min-w-0 flex-1 truncate text-stone-600 dark:text-stone-300" title={r.intentText}>
        {r.intentText || "(无意图文本)"}
      </span>
      {r.evaluated ? <Verdict pass={!!r.pass} blockers={r.blockers} retrying={r.retrying} /> : <Skip reason={r.skipReason} />}
    </div>
  );
}

function Verdict({ pass, blockers, retrying }: { pass: boolean; blockers?: number; retrying?: boolean }): ReactNode {
  if (pass) {
    return <Tag className="bg-emerald-50 text-emerald-600 dark:bg-emerald-500/10 dark:text-emerald-400">通过</Tag>;
  }
  return (
    <Tag className="bg-rose-50 text-rose-600 dark:bg-rose-500/10 dark:text-rose-400">
      {retrying ? "返工" : "未过"}
      {blockers ? ` ·${blockers}` : ""}
    </Tag>
  );
}

function Skip({ reason }: { reason?: string }): ReactNode {
  return (
    <Tag className="bg-stone-100 text-stone-400 dark:bg-white/5 dark:text-stone-500">
      跳过{reason && reason !== "no-deliverable" ? `·${skipReasonLabel(reason)}` : ""}
    </Tag>
  );
}

function Tag({ children, className }: { children: ReactNode; className: string }): JSX.Element {
  return <span className={"shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium tabular-nums " + className}>{children}</span>;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number): string => String(n).padStart(2, "0");
  return `${p(d.getMonth() + 1)}/${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function triggerLabel(k: string): string {
  return { plan: "有契约", mutation: "改了状态", "plan+mutation": "契约+改状态" }[k] ?? k;
}

function skipReasonLabel(k: string): string {
  return (
    { "no-deliverable": "无交付物(纯只读/聊天)", aborted: "被中断", error: "带错误收尾", "no-evaluator": "无验收器" }[k] ?? k
  );
}
