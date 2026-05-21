/**
 * @pa/ctx-trust — Trust & Governance(核心域)
 *
 * 守门人:对每个待执行工具做风险分级 → 查权限策略 → 只读自动放行 /
 * 需审批则发起 UI 审批并等待 / 拒绝则拦截。挂在 pi 的 beforeToolCall 上。
 */
import type { GateDecision, Gatekeeper, RiskLevel, ToolCallIntent } from "@pa/domain-core";

/** 策略裁决:自动放行 / 需审批 / 直接拒绝 */
export type Verdict = "auto" | "ask" | "deny";

/** 风险等级 → 裁决。默认:只读自动,其余一律审批,无默认拒绝。 */
export type Policy = (risk: RiskLevel) => Verdict;

export const defaultPolicy: Policy = (risk) => (risk === "ReadOnly" ? "auto" : "ask");

/** 审批请求(交给 UI 桥处理)*/
export interface ApprovalAsk extends ToolCallIntent {
  readonly riskLevel: RiskLevel;
}

export interface GatekeeperDeps {
  /** 工具调用 → 风险等级(由各 Capability 的风险元数据组合而成)*/
  readonly riskOf: (call: ToolCallIntent) => RiskLevel;
  /** 权限策略,默认 defaultPolicy */
  readonly policy?: Policy;
  /** UI 审批桥:发起审批并等待用户决定(true=同意)*/
  readonly requestApproval: (ask: ApprovalAsk) => Promise<boolean>;
}

export function createGatekeeper(deps: GatekeeperDeps): Gatekeeper {
  const policy = deps.policy ?? defaultPolicy;
  return {
    async evaluate(call: ToolCallIntent): Promise<GateDecision> {
      const riskLevel = deps.riskOf(call);
      const verdict = policy(riskLevel);

      if (verdict === "auto") return { allow: true };
      if (verdict === "deny") return { allow: false, reason: `策略禁止执行(风险:${riskLevel})` };

      // verdict === "ask":发起审批并等待
      const approved = await deps.requestApproval({ ...call, riskLevel });
      return approved ? { allow: true } : { allow: false, reason: "用户拒绝了该操作" };
    }
  };
}

/**
 * 由「工具名 → 风险等级」映射表构造 riskOf。
 * 未知工具默认 Destructive(保守:强制走审批),避免新工具默认裸跑。
 */
export function riskClassifierFromMap(
  map: Readonly<Record<string, RiskLevel>>,
  fallback: RiskLevel = "Destructive"
): (call: ToolCallIntent) => RiskLevel {
  return (call) => map[call.tool] ?? fallback;
}
