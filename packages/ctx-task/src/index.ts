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
  type AfterToolCallContext,
  type AgentEvent,
  type AgentMessage,
  type AgentTool,
  type BeforeToolCallContext,
  type BeforeToolCallResult,
  type ThinkingLevel
} from "@earendil-works/pi-agent-core";
import type { ApiKeyResolver, ModelHandle } from "@pa/infra";
import {
  newStepId,
  newTaskId,
  type Action,
  type ActionId,
  type Capability,
  type DomainEvent,
  type Gatekeeper,
  type Intent,
  type StepId,
  type TaskId
} from "@pa/domain-core";

// Trust 端口已下沉到 domain-core;此处仅提供一个全放行的占位实现。
export type { Gatekeeper, ToolCallIntent, GateDecision } from "@pa/domain-core";
export type { AgentMessage } from "@earendil-works/pi-agent-core";
/** 占位守门人:全部放行。真实风险分级在 ctx-trust。 */
export const allowAllGatekeeper: Gatekeeper = {
  async evaluate() {
    return { allow: true };
  }
};

// ── 事件翻译(有状态:在 ACL 层自建 Plan/Step)──────────────────
/**
 * 把 pi 的 AgentEvent 翻译为领域事件。pi 无 Step 概念,故在此按 turn 自建:
 * 每个 turn 内**首次**出现工具调用时惰性创建一个 Step(纯聊天 turn 不产生空步骤),
 * 该 turn 内的 Action 都归属此 Step;turn 结束时关闭该 Step。
 */
export class DomainTranslator {
  private currentStepId: StepId | undefined;

  constructor(
    private readonly taskId: TaskId,
    private readonly capabilityOf: (tool: string) => Capability
  ) {}

  translate(event: AgentEvent): DomainEvent[] {
    switch (event.type) {
      case "turn_start":
        this.currentStepId = undefined; // 新 turn,尚未产生步骤
        return [];

      case "tool_execution_start": {
        const out: DomainEvent[] = [];
        if (!this.currentStepId) {
          // 本 turn 首个工具 → 惰性开一个 Step
          this.currentStepId = newStepId();
          out.push({ type: "StepStarted", taskId: this.taskId, stepId: this.currentStepId });
        }
        const action: Action = {
          id: event.toolCallId as ActionId,
          stepId: this.currentStepId,
          capability: this.capabilityOf(event.toolName),
          tool: event.toolName,
          args: (event.args ?? {}) as Record<string, unknown>,
          status: "Executing"
        };
        out.push({ type: "ActionProposed", taskId: this.taskId, action });
        return out;
      }

      case "tool_execution_end":
        return event.isError
          ? [
              {
                type: "ActionFailed",
                taskId: this.taskId,
                actionId: event.toolCallId as ActionId,
                error: typeof event.result === "string" ? event.result : JSON.stringify(event.result)
              }
            ]
          : [{ type: "ActionExecuted", taskId: this.taskId, actionId: event.toolCallId as ActionId }];

      case "turn_end": {
        // 仅在本 turn 真的开过 Step 时才关闭
        if (this.currentStepId) {
          const stepId = this.currentStepId;
          this.currentStepId = undefined;
          return [{ type: "StepCompleted", taskId: this.taskId, stepId }];
        }
        return [];
      }

      case "agent_end":
        return [{ type: "TaskCompleted", taskId: this.taskId }];

      default:
        return [];
    }
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
  /** 推理强度(默认 off)。开启可显著改善规划/工具使用。 */
  readonly thinkingLevel?: ThinkingLevel;
  /** 恢复会话:用持久化的 transcript 播种 agent,使其带记忆接着聊。 */
  readonly initialMessages?: AgentMessage[];
  /** 上下文注入(如 Personal Memory 召回):返回的文本会作为前置消息注入每次 LLM 调用 */
  readonly contextProvider?: () => string | undefined;
  /** 领域事件出口(任务/动作生命周期,供工作区面板订阅)*/
  readonly onEvent: (event: DomainEvent) => void;
  /** 助理文本增量出口(Conversation 关注点,不进领域事件)*/
  readonly onAssistantDelta?: (text: string) => void;
  /** 工具执行完成出口(供 Reversibility 记账等)*/
  readonly afterTool?: (info: {
    actionId: ActionId;
    capability: Capability;
    tool: string;
    details: unknown;
    /** 工具结果的纯文本(模型看到的内容,供"查看"等 UI 用) */
    resultText: string;
    isError: boolean;
  }) => void | Promise<void>;
}

export class PiAgentAdapter {
  private readonly agent: Agent;

  constructor(private readonly deps: PiAgentAdapterDeps) {
    const gate = deps.gatekeeper ?? allowAllGatekeeper;
    this.agent = new Agent({
      initialState: {
        systemPrompt: deps.systemPrompt ?? "",
        model: deps.model,
        tools: deps.tools ?? [],
        thinkingLevel: deps.thinkingLevel ?? "off",
        ...(deps.initialMessages ? { messages: deps.initialMessages } : {})
      },
      getApiKey: (provider) => deps.apiKeyResolver(provider),
      beforeToolCall: async (
        ctx: BeforeToolCallContext
      ): Promise<BeforeToolCallResult | undefined> => {
        const toolName = ctx.toolCall.name;
        const decision = await gate.evaluate({
          actionId: ctx.toolCall.id as ActionId,
          capability: deps.capabilityOf(toolName),
          tool: toolName,
          args: (ctx.args ?? {}) as Record<string, unknown>
        });
        // 放行 → 返回 undefined;拦截 → {block:true}
        return decision.allow ? undefined : { block: true, reason: decision.reason };
      },
      // 召回:把记忆等外部上下文作为前置消息注入(不写入持久 transcript)
      transformContext: deps.contextProvider
        ? async (messages: AgentMessage[]): Promise<AgentMessage[]> => {
            const ctx = deps.contextProvider?.();
            if (!ctx) return messages;
            const injected: AgentMessage = { role: "user", content: ctx, timestamp: Date.now() };
            return [injected, ...messages];
          }
        : undefined,
      afterToolCall: async (ctx: AfterToolCallContext) => {
        const toolName = ctx.toolCall.name;
        const resultText = Array.isArray(ctx.result?.content)
          ? ctx.result.content
              .filter((b): b is { type: "text"; text: string } => (b as { type?: string })?.type === "text")
              .map((b) => b.text)
              .join("\n")
          : "";
        await deps.afterTool?.({
          actionId: ctx.toolCall.id as ActionId,
          capability: deps.capabilityOf(toolName),
          tool: toolName,
          details: ctx.result.details,
          resultText,
          isError: ctx.isError
        });
        return undefined;
      }
    });
  }

  /** 接收一个 Intent,跑通 agent 循环,期间把领域事件推给 onEvent。 */
  async startTask(intent: Intent): Promise<TaskId> {
    const taskId = newTaskId();
    this.deps.onEvent({ type: "TaskCreated", taskId, intent });
    const translator = new DomainTranslator(taskId, this.deps.capabilityOf);
    const unsubscribe = this.agent.subscribe((event) => {
      // 助理文本增量 → Conversation 通道
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        this.deps.onAssistantDelta?.(event.assistantMessageEvent.delta);
      }
      // 任务/动作生命周期 → 领域事件通道
      for (const domainEvent of translator.translate(event)) {
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

  /** 中断当前运行(用户点停止)。pi 会以 aborted 收尾,prompt() 正常 resolve。 */
  abort(): void {
    this.agent.abort();
  }

  /** 当前 transcript 快照(持久化以便日后恢复会话)。 */
  snapshotTranscript(): AgentMessage[] {
    return this.agent.state.messages;
  }
}
