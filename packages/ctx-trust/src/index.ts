/**
 * @pa/ctx-trust — Trust & Governance(核心域)
 *
 * 守门人:对每个待执行工具做风险分级 → 查权限策略 → 只读自动放行 /
 * 需审批则先查「已记住允许」命中即放行 / 否则发起 UI 审批并等待 / 拒绝则拦截。
 * 挂在 pi 的 beforeToolCall 上。
 */
import type { GateDecision, Gatekeeper, RiskLevel, ToolCallIntent } from "@pa/domain-core";

/** 策略裁决:自动放行 / 需审批 / 直接拒绝 */
export type Verdict = "auto" | "ask" | "deny";

/** 风险等级 → 裁决。默认:只读自动,其余一律审批,无默认拒绝。 */
export type Policy = (risk: RiskLevel) => Verdict;

export const defaultPolicy: Policy = (risk) => (risk === "ReadOnly" ? "auto" : "ask");

/**
 * 记忆键:把一次调用归约成「同类操作」的稳定标识 + 给用户看的说明。
 * 同类(命令头+子命令)相同则视为已授权,改参数也放行。null = 该调用不可记忆(始终逐次审批)。
 */
export interface RememberKey {
  /** 匹配用稳定 id,如 "shell:git commit"、"office:set" */
  readonly id: string;
  /** 展示用说明,如 "git commit 命令" */
  readonly label: string;
}

/** 已记住的「允许」规则存储(全局持久化,主进程实现注入)。 */
export interface RememberStore {
  has(id: string): boolean;
  add(id: string, label: string): void;
}

/** 用户对一次审批的决定。 */
export interface ApprovalDecision {
  readonly approved: boolean;
  /** 是否勾选「以后此类不再问」(仅当 ask 带 rememberKey 时有意义)。 */
  readonly remember: boolean;
}

/** 审批请求(交给 UI 桥处理)*/
export interface ApprovalAsk extends ToolCallIntent {
  readonly riskLevel: RiskLevel;
  /** 可记忆则带键(UI 据此显示「以后 {label} 不再问」按钮);不可记忆为 null。 */
  readonly rememberKey: RememberKey | null;
}

export interface GatekeeperDeps {
  /** 工具调用 → 风险等级(由各 Capability 的风险元数据组合而成)*/
  readonly riskOf: (call: ToolCallIntent) => RiskLevel;
  /** 权限策略,默认 defaultPolicy */
  readonly policy?: Policy;
  /** UI 审批桥:发起审批并等待用户决定 */
  readonly requestApproval: (ask: ApprovalAsk) => Promise<ApprovalDecision>;
  /** 从调用提取记忆键;返回 null = 不可记忆。不提供则全部不可记忆(退化为旧的逐次审批)。 */
  readonly rememberKeyOf?: (call: ToolCallIntent) => RememberKey | null;
  /** 已记住允许的存储;不提供则不记忆。 */
  readonly rememberStore?: RememberStore;
}

export function createGatekeeper(deps: GatekeeperDeps): Gatekeeper {
  const policy = deps.policy ?? defaultPolicy;
  return {
    async evaluate(call: ToolCallIntent): Promise<GateDecision> {
      const riskLevel = deps.riskOf(call);
      const verdict = policy(riskLevel);

      if (verdict === "auto") return { allow: true };
      if (verdict === "deny") return { allow: false, reason: `策略禁止执行(风险:${riskLevel})` };

      // verdict === "ask":先查「已记住允许」——同类操作此前已授权 → 直接放行,不打扰用户。
      const key = deps.rememberKeyOf?.(call) ?? null;
      if (key && deps.rememberStore?.has(key.id)) return { allow: true };

      // 否则发起审批并等待;若用户选了「总是同意」,记下该类以后免问。
      const decision = await deps.requestApproval({ ...call, riskLevel, rememberKey: key });
      if (decision.approved && decision.remember && key) deps.rememberStore?.add(key.id, key.label);
      return decision.approved ? { allow: true } : { allow: false, reason: "用户拒绝了该操作" };
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
