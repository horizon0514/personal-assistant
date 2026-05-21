/**
 * @pa/ctx-task — Task Orchestration
 *
 * pi-agent-core 的防腐层(ACL):把 pi 的 AgentEvent 翻译成领域 DomainEvent,
 * 把 Trust 守门人挂到 beforeToolCall,把 Capability 工具注入 Agent。
 * pi 的概念不允许外泄到 domain-core / 渲染层。
 *
 * 注:本版先打通"Intent → Agent 循环 → 领域事件"主线。Plan/Step 的显式建模、
 * Reversibility 记账(afterToolCall)、Memory 召回(transformContext)留待后续。
 */
import {
  Agent,
  type AgentEvent,
  type AgentTool,
  type BeforeToolCallContext,
  type BeforeToolCallResult
} from "@earendil-works/pi-agent-core";
import type { ApiKeyResolver, ModelHandle } from "@pa/infra";
import {
  newTaskId,
  type Action,
  type ActionId,
  type Capability,
  type DomainEvent,
  type Intent,
  type StepId,
  type TaskId
} from "@pa/domain-core";

// ── Trust 边界(由 ctx-trust 实现;此处只定接口 + stub)──────────
export interface ToolCallIntent {
  readonly capability: Capability;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
}
export interface GateDecision {
  readonly allow: boolean;
  readonly reason?: string;
}
export interface Gatekeeper {
  evaluate(call: ToolCallIntent): Promise<GateDecision>;
}
/** 占位守门人:全部放行。真实风险分级在 ctx-trust。 */
export const allowAllGatekeeper: Gatekeeper = {
  async evaluate() {
    return { allow: true };
  }
};

// ── 事件翻译(纯函数,单独可测)────────────────────────────────
/** 把 pi 的 AgentEvent 翻译为领域事件。pi 无 Step 概念,stepId 暂用占位。 */
export function translateEvent(
  event: AgentEvent,
  taskId: TaskId,
  capabilityOf: (tool: string) => Capability
): DomainEvent[] {
  switch (event.type) {
    case "tool_execution_start": {
      const action: Action = {
        id: event.toolCallId as ActionId,
        stepId: taskId as unknown as StepId, // TODO: Plan/Step 显式建模后替换
        capability: capabilityOf(event.toolName),
        tool: event.toolName,
        args: (event.args ?? {}) as Record<string, unknown>,
        status: "Executing"
      };
      return [{ type: "ActionProposed", taskId, action }];
    }
    case "tool_execution_end":
      return event.isError
        ? [
            {
              type: "ActionFailed",
              taskId,
              actionId: event.toolCallId as ActionId,
              error: typeof event.result === "string" ? event.result : JSON.stringify(event.result)
            }
          ]
        : [{ type: "ActionExecuted", taskId, actionId: event.toolCallId as ActionId }];
    case "agent_end":
      return [{ type: "TaskCompleted", taskId }];
    default:
      return [];
  }
}

// ── 适配器 ───────────────────────────────────────────────────
export interface PiAgentAdapterDeps {
  readonly model: ModelHandle;
  readonly apiKeyResolver: ApiKeyResolver;
  /** Capability 暴露的工具集 */
  readonly tools?: AgentTool[];
  /** Trust 守门人(默认全放行 stub)*/
  readonly gatekeeper?: Gatekeeper;
  /** tool 名 → 所属 Capability 的解析 */
  readonly capabilityOf: (tool: string) => Capability;
  readonly systemPrompt?: string;
  /** 领域事件出口(供 Conversation/UI 订阅)*/
  readonly onEvent: (event: DomainEvent) => void;
}

export class PiAgentAdapter {
  private readonly agent: Agent;

  constructor(private readonly deps: PiAgentAdapterDeps) {
    const gate = deps.gatekeeper ?? allowAllGatekeeper;
    this.agent = new Agent({
      initialState: {
        systemPrompt: deps.systemPrompt ?? "",
        model: deps.model,
        tools: deps.tools ?? []
      },
      getApiKey: (provider) => deps.apiKeyResolver(provider),
      beforeToolCall: async (
        ctx: BeforeToolCallContext
      ): Promise<BeforeToolCallResult | undefined> => {
        const toolName = ctx.toolCall.name;
        const decision = await gate.evaluate({
          capability: deps.capabilityOf(toolName),
          tool: toolName,
          args: (ctx.args ?? {}) as Record<string, unknown>
        });
        // 放行 → 返回 undefined;拦截 → {block:true}
        return decision.allow ? undefined : { block: true, reason: decision.reason };
      }
    });
  }

  /** 接收一个 Intent,跑通 agent 循环,期间把领域事件推给 onEvent。 */
  async startTask(intent: Intent): Promise<TaskId> {
    const taskId = newTaskId();
    this.deps.onEvent({ type: "TaskCreated", taskId, intent });
    const unsubscribe = this.agent.subscribe((event) => {
      for (const domainEvent of translateEvent(event, taskId, this.deps.capabilityOf)) {
        this.deps.onEvent(domainEvent);
      }
    });
    try {
      await this.agent.prompt(intent.text);
    } finally {
      unsubscribe();
    }
    return taskId;
  }
}
