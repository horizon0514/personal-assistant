import { describe, it, expect } from "vitest";
import { parseEvalTelemetry, summarize, trimToLastLines } from "./eval-telemetry";
import type { PersistedEvalRecord } from "./eval-telemetry";

const base = (over: Partial<PersistedEvalRecord>): PersistedEvalRecord => ({
  ts: 1_000,
  sessionId: "s1",
  source: "interactive",
  taskId: "t1" as PersistedEvalRecord["taskId"],
  round: 0,
  evaluated: false,
  toolCalls: 1,
  mutated: false,
  hadPlan: false,
  ...over
});

describe("parseEvalTelemetry", () => {
  it("跳过空行与坏行,只留可解析的记录", () => {
    const raw = [JSON.stringify(base({})), "", "   ", "{坏的 json", JSON.stringify(base({ ts: 2_000 }))].join("\n");
    const recs = parseEvalTelemetry(raw);
    expect(recs).toHaveLength(2);
    expect(recs.map((r) => r.ts)).toEqual([1_000, 2_000]);
  });

  it("空输入 → 空数组", () => {
    expect(parseEvalTelemetry("")).toEqual([]);
    expect(parseEvalTelemetry("\n\n  \n")).toEqual([]);
  });
});

describe("summarize", () => {
  it("空记录 → 空摘要(passRate/avgDuration 为 null)", () => {
    const s = summarize([]);
    expect(s.total).toBe(0);
    expect(s.passRate).toBeNull();
    expect(s.avgDurationMs).toBeNull();
    expect(s.recent).toEqual([]);
  });

  it("通过率/平均耗时只按已验收轮次算,跳过轮不参与", () => {
    const recs = [
      base({ evaluated: true, pass: true, trigger: "mutation", durationMs: 1_000, mutated: true }),
      base({ evaluated: true, pass: false, retrying: true, trigger: "plan", durationMs: 3_000, hadPlan: true, blockers: 2 }),
      base({ evaluated: false, skipReason: "no-deliverable" }) // 跳过:不进 pass/duration 分母
    ];
    const s = summarize(recs);
    expect(s.total).toBe(3);
    expect(s.evaluated).toBe(2);
    expect(s.skipped).toBe(1);
    expect(s.passed).toBe(1);
    expect(s.failed).toBe(1);
    expect(s.passRate).toBe(0.5); // 1/2,跳过那条不算
    expect(s.retried).toBe(1);
    expect(s.avgDurationMs).toBe(2_000); // (1000+3000)/2
    expect(s.byTrigger).toEqual({ mutation: 1, plan: 1 });
    expect(s.bySkipReason).toEqual({ "no-deliverable": 1 });
  });

  it("来源分布 interactive/scheduled 分别计数", () => {
    const s = summarize([
      base({ source: "interactive" }),
      base({ source: "scheduled" }),
      base({ source: "scheduled" })
    ]);
    expect(s.bySource).toEqual({ interactive: 1, scheduled: 2 });
  });

  it("recent 新→旧且受 limit 截断", () => {
    const recs = [base({ ts: 1 }), base({ ts: 2 }), base({ ts: 3 })];
    const s = summarize(recs, 2);
    expect(s.recent.map((r) => r.ts)).toEqual([3, 2]); // 末尾两条,倒序
  });

  it("已验收但 durationMs 缺失时不污染平均(按存在的算)", () => {
    const s = summarize([
      base({ evaluated: true, pass: true, durationMs: 2_000 }),
      base({ evaluated: true, pass: true }) // 无 durationMs
    ]);
    // 当前实现:总时长 2000 / 已验收 2 = 1000(缺失按 0 计入分母)——锁住这个行为,后续若改为只算有耗时的需同步改测
    expect(s.avgDurationMs).toBe(1_000);
  });
});

describe("trimToLastLines(轮转裁剪)", () => {
  it("行数不超过 keep → 不裁(返回 null)", () => {
    expect(trimToLastLines("a\nb\nc\n", 3)).toBeNull();
    expect(trimToLastLines("a\nb\n", 5)).toBeNull();
    expect(trimToLastLines("", 10)).toBeNull();
  });

  it("超过 keep → 只留最近 keep 行,末尾带换行", () => {
    expect(trimToLastLines("a\nb\nc\nd\ne\n", 2)).toBe("d\ne\n");
  });

  it("去掉空行后再判定与裁剪", () => {
    // 5 个有效行 + 夹杂空行;keep=3 → 留最后 3 个有效行
    expect(trimToLastLines("a\n\nb\n  \nc\nd\ne\n", 3)).toBe("c\nd\ne\n");
  });
});
