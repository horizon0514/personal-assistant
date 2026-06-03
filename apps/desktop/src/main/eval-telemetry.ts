/**
 * 验收可观测落盘:把每轮验收(评/不评 + 结论 + 耗时)追加成 JSONL。
 *
 * 目的——验收器到底有没有用、误拦多少、值不值这个成本,现在全靠假设。先把数据攒下来,
 * 让后续调参(门的松紧、要不要给 propose_plan 上硬触发、retry 轮数)从"拍脑袋"变成"看 trace"。
 * 见 research/agent-design-insights.md §1/§5。
 *
 * 落盘位置:userData/eval-telemetry.jsonl(全局单份,追加写,永不阻塞主流程——失败只告警)。
 */
import { appendFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import type { EvalTelemetryRecord } from "@pa/ctx-task";

/** 一行落盘记录:适配器的 {@link EvalTelemetryRecord} 加上写入时补的时间戳 + 会话/来源。 */
export interface PersistedEvalRecord extends EvalTelemetryRecord {
  readonly ts: number;
  readonly sessionId: string;
  readonly source: "interactive" | "scheduled";
}

/** 读取 telemetry 后算出的聚合视图:供设置窗「验收质量」面板展示。 */
export interface EvalTelemetrySummary {
  /** 有动作的轮次总数(纯聊天无动作不落盘,故不计入) */
  readonly total: number;
  /** 真的起了验收器的轮次 */
  readonly evaluated: number;
  /** 有动作但被跳过验收的轮次 */
  readonly skipped: number;
  readonly passed: number;
  readonly failed: number;
  /** passed / evaluated;无验收时为 null */
  readonly passRate: number | null;
  /** 触发返工的轮次(verdict 不过且未耗尽 retry) */
  readonly retried: number;
  /** 已验收轮次的平均耗时(ms);无验收为 null */
  readonly avgDurationMs: number | null;
  /** 验收触发原因分布(plan / mutation / plan+mutation) */
  readonly byTrigger: Record<string, number>;
  /** 跳过原因分布(no-deliverable / aborted / error / no-evaluator) */
  readonly bySkipReason: Record<string, number>;
  readonly bySource: { interactive: number; scheduled: number };
  /** 最近若干条原始记录,新→旧,供逐条排查 */
  readonly recent: PersistedEvalRecord[];
}

function filePath(): string {
  return join(app.getPath("userData"), "eval-telemetry.jsonl");
}

/** 给适配器的一笔记录补上时间戳 + 会话/来源元信息,追加成一行 JSON。 */
export function recordEval(
  meta: { sessionId: string; source: "interactive" | "scheduled" },
  rec: EvalTelemetryRecord
): void {
  const line = JSON.stringify({ ts: Date.now(), ...meta, ...rec }) + "\n";
  void appendFile(filePath(), line, "utf8").catch((err) =>
    console.warn(`[eval-telemetry] 写入失败(忽略): ${String(err)}`)
  );
}

function emptySummary(): EvalTelemetrySummary {
  return {
    total: 0,
    evaluated: 0,
    skipped: 0,
    passed: 0,
    failed: 0,
    passRate: null,
    retried: 0,
    avgDurationMs: null,
    byTrigger: {},
    bySkipReason: {},
    bySource: { interactive: 0, scheduled: 0 },
    recent: []
  };
}

function bump(map: Record<string, number>, key: string | undefined): void {
  if (!key) return;
  map[key] = (map[key] ?? 0) + 1;
}

/** 把一行行 JSONL 文本容错解析成记录数组:空行/坏行(写入中途崩溃等)跳过。 */
export function parseEvalTelemetry(raw: string): PersistedEvalRecord[] {
  const records: PersistedEvalRecord[] = [];
  for (const line of raw.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    try {
      records.push(JSON.parse(s) as PersistedEvalRecord);
    } catch {
      // 坏行直接跳过
    }
  }
  return records;
}

/** 纯聚合:把记录数组算成面板摘要(无 IO,可单测)。recentLimit 控制回传的逐条数量。 */
export function summarize(records: PersistedEvalRecord[], recentLimit = 200): EvalTelemetrySummary {
  if (records.length === 0) return emptySummary();

  const sum = emptySummary() as {
    -readonly [K in keyof EvalTelemetrySummary]: EvalTelemetrySummary[K];
  };
  sum.total = records.length;
  let durationTotal = 0;
  for (const r of records) {
    if (r.source === "scheduled") sum.bySource.scheduled++;
    else sum.bySource.interactive++;
    if (r.evaluated) {
      sum.evaluated++;
      if (r.pass) sum.passed++;
      else sum.failed++;
      if (r.retrying) sum.retried++;
      if (typeof r.durationMs === "number") durationTotal += r.durationMs;
      bump(sum.byTrigger, r.trigger);
    } else {
      sum.skipped++;
      bump(sum.bySkipReason, r.skipReason);
    }
  }
  sum.passRate = sum.evaluated > 0 ? sum.passed / sum.evaluated : null;
  sum.avgDurationMs = sum.evaluated > 0 ? Math.round(durationTotal / sum.evaluated) : null;
  // 新→旧;只回最近 recentLimit 条(面板逐条排查用,不必全量)
  sum.recent = records.slice(-recentLimit).reverse();
  return sum;
}

/**
 * 读取并聚合 eval-telemetry.jsonl。文件不存在/读失败 → 空摘要(不抛)。
 */
export async function readEvalTelemetry(recentLimit = 200): Promise<EvalTelemetrySummary> {
  let raw: string;
  try {
    raw = await readFile(filePath(), "utf8");
  } catch {
    return emptySummary();
  }
  return summarize(parseEvalTelemetry(raw), recentLimit);
}
