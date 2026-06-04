import { describe, it, expect, vi } from "vitest";
import { createGatekeeper, type RememberKey, type RememberStore } from "./index";
import type { RiskLevel, ToolCallIntent } from "@pa/domain-core";

const call = (tool = "exec_shell", args: Record<string, unknown> = {}): ToolCallIntent => ({
  actionId: "a1" as ToolCallIntent["actionId"],
  capability: "shell",
  tool,
  args
});

const approve = (approved: boolean, remember = false) => vi.fn(async () => ({ approved, remember }));

describe("createGatekeeper", () => {
  it("只读自动放行,不弹审批", async () => {
    const requestApproval = approve(true);
    const gk = createGatekeeper({ riskOf: () => "ReadOnly" as RiskLevel, requestApproval });
    expect(await gk.evaluate(call())).toEqual({ allow: true });
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("Destructive 默认走审批;同意 → 放行,拒绝 → 拦截", async () => {
    const yes = createGatekeeper({ riskOf: () => "Destructive" as RiskLevel, requestApproval: approve(true) });
    expect((await yes.evaluate(call())).allow).toBe(true);
    const no = createGatekeeper({ riskOf: () => "Destructive" as RiskLevel, requestApproval: approve(false) });
    expect((await no.evaluate(call())).allow).toBe(false);
  });

  it("已记住的同类操作直接放行,不再弹审批", async () => {
    const store: RememberStore = { has: (id) => id === "shell:git commit", add: vi.fn() };
    const requestApproval = approve(true);
    const gk = createGatekeeper({
      riskOf: () => "Destructive" as RiskLevel,
      requestApproval,
      rememberKeyOf: (): RememberKey => ({ id: "shell:git commit", label: "git commit 命令" }),
      rememberStore: store
    });
    expect((await gk.evaluate(call())).allow).toBe(true);
    expect(requestApproval).not.toHaveBeenCalled(); // 命中记忆 → 不打扰用户
  });

  it("点「总是同意」(approved+remember)→ 写入记忆;仅同意不写", async () => {
    const add = vi.fn();
    const store: RememberStore = { has: () => false, add };
    const key: RememberKey = { id: "shell:git commit", label: "git commit 命令" };

    const gkRemember = createGatekeeper({
      riskOf: () => "Destructive" as RiskLevel,
      requestApproval: approve(true, true),
      rememberKeyOf: () => key,
      rememberStore: store
    });
    await gkRemember.evaluate(call());
    expect(add).toHaveBeenCalledWith("shell:git commit", "git commit 命令");

    add.mockClear();
    const gkOnce = createGatekeeper({
      riskOf: () => "Destructive" as RiskLevel,
      requestApproval: approve(true, false),
      rememberKeyOf: () => key,
      rememberStore: store
    });
    await gkOnce.evaluate(call());
    expect(add).not.toHaveBeenCalled(); // 只「同意」不记忆
  });

  it("不可记忆的调用(rememberKeyOf→null)绝不写记忆,即便勾了 remember", async () => {
    const add = vi.fn();
    const gk = createGatekeeper({
      riskOf: () => "Destructive" as RiskLevel,
      requestApproval: approve(true, true),
      rememberKeyOf: () => null,
      rememberStore: { has: () => false, add }
    });
    expect((await gk.evaluate(call())).allow).toBe(true);
    expect(add).not.toHaveBeenCalled();
  });

  it("deny 策略直接拒绝,不弹审批", async () => {
    const requestApproval = approve(true);
    const gk = createGatekeeper({
      riskOf: () => "Destructive" as RiskLevel,
      policy: () => "deny",
      requestApproval
    });
    expect((await gk.evaluate(call())).allow).toBe(false);
    expect(requestApproval).not.toHaveBeenCalled();
  });
});
