/**
 * 验收可观测落盘:把每轮验收(评/不评 + 结论 + 耗时)追加成 JSONL。
 *
 * 目的——验收器到底有没有用、误拦多少、值不值这个成本,现在全靠假设。先把数据攒下来,
 * 让后续调参(门的松紧、要不要给 propose_plan 上硬触发、retry 轮数)从"拍脑袋"变成"看 trace"。
 * 见 research/agent-design-insights.md §1/§5。
 *
 * 落盘位置:userData/eval-telemetry.jsonl(全局单份,追加写,永不阻塞主流程——失败只告警)。
 */
import { appendFile } from "node:fs/promises";
import { join } from "node:path";
import { app } from "electron";
import type { EvalTelemetryRecord } from "@pa/ctx-task";

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
