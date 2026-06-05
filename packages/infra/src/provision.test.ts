import { describe, it, expect } from "vitest";
import { provisionOnce } from "./provision";

describe("provisionOnce", () => {
  it("已就绪则立即返回 ok,不跑 populate", async () => {
    let runs = 0;
    const r = await provisionOnce("ready-key", {
      isReady: () => true,
      populate: async () => {
        runs++;
      }
    });
    expect(r).toEqual({ ok: true });
    expect(runs).toBe(0);
  });

  it("并发同 key 只 populate 一次,firstRunNote 只报一次", async () => {
    let runs = 0;
    let ready = false;
    const notes: string[] = [];
    const opts = {
      isReady: () => ready,
      firstRunNote: "first",
      onProgress: (n: string) => notes.push(n),
      populate: async () => {
        runs++;
        await new Promise((res) => setTimeout(res, 10));
        ready = true;
      }
    };
    const results = await Promise.all([provisionOnce("k", opts), provisionOnce("k", opts), provisionOnce("k", opts)]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect(runs).toBe(1);
    expect(notes).toEqual(["first"]);

    // 就绪后再调 → 短路,不再 populate
    const again = await provisionOnce("k", opts);
    expect(again.ok).toBe(true);
    expect(runs).toBe(1);
  });

  it("populate 抛错被捕获成 { ok:false, error },且失败后可重试", async () => {
    const fail = await provisionOnce("k2", {
      isReady: () => false,
      populate: async () => {
        throw new Error("boom");
      }
    });
    expect(fail).toEqual({ ok: false, error: "boom" });

    // inflight 已清:再来一次走新 populate(本次成功)
    let ready = false;
    const retry = await provisionOnce("k2", {
      isReady: () => ready,
      populate: async () => {
        ready = true;
      }
    });
    expect(retry.ok).toBe(true);
  });
});
