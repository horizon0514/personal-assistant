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
  type Evaluator,
  type Gatekeeper,
  type Intent,
  type StepId,
  type TaskId
} from "@pa/domain-core";

export { createPiEvaluator, type PiEvaluatorDeps } from "./evaluator";
export { createContractTool, type ContractToolDeps } from "./contract";
export { createAskUserTool, type AskUserToolDeps } from "./ask-user";
export type { Evaluator, EvaluationRequest, Verdict, SprintContract } from "@pa/domain-core";

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
  /** 执行后独立验收器(可选)。调过工具的任务跑完后,由它对照目标核查产出。 */
  readonly evaluator?: Evaluator;
  /** 验收不通过时自动返工的最大轮数(evaluator-optimizer 闭环)。默认 1。 */
  readonly maxEvalRetries?: number;
  /** 取本次任务已确认的交付契约(若执行器签了 propose_contract),作为评估的验收清单。 */
  readonly contractProvider?: () => import("@pa/domain-core").SprintContract | undefined;
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

const DEFAULT_MAX_EVAL_RETRIES = 1;

export class PiAgentAdapter {
  private readonly agent: Agent;
  /** 用户主动中断标记:中断后跳过验收与返工。 */
  private aborted = false;

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
    this.aborted = false;
    this.deps.onEvent({ type: "TaskCreated", taskId, intent });
    const translator = new DomainTranslator(taskId, this.deps.capabilityOf);

    // 验收所需的过程信息:是否调过工具、动作日志(累计)、本轮最终汇报文本。
    let sawTool = false;
    const actionLog: { tool: string; ok: boolean }[] = [];
    let roundSummary = "";

    const unsubscribe = this.agent.subscribe((event) => {
      // 助理文本增量 → Conversation 通道 + 累计本轮汇报
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        roundSummary += event.assistantMessageEvent.delta;
        this.deps.onAssistantDelta?.(event.assistantMessageEvent.delta);
      }
      if (event.type === "tool_execution_start") sawTool = true;
      if (event.type === "tool_execution_end") {
        actionLog.push({ tool: event.toolName, ok: !event.isError });
      }
      // 每个 turn 的 assistant 消息收尾:非正常停因(error/aborted)打日志,便于定位被吞的模型错误
      if (event.type === "message_end") {
        const m = event.message as { role?: string; stopReason?: string; errorMessage?: string };
        if (m.role === "assistant" && m.stopReason && m.stopReason !== "stop" && m.stopReason !== "tool_use") {
          console.error(`[agent] assistant turn 结束于 stopReason=${m.stopReason}`, m.errorMessage ?? "");
        }
      }
      // 任务/动作生命周期 → 领域事件通道。
      // 注意:translator 在每次 agent_end(每轮 prompt 收尾)都会产出 TaskCompleted;
      // 但"任务完成"应在验收/返工闭环结束后只发一次,故在此抑制,末尾统一补发。
      for (const domainEvent of translator.translate(event)) {
        if (domainEvent.type === "TaskCompleted") continue;
        this.deps.onEvent(domainEvent);
      }
    });

    const maxRetries = this.deps.maxEvalRetries ?? DEFAULT_MAX_EVAL_RETRIES;
    try {
      let prompt = intent.text;
      for (let round = 0; ; round++) {
        roundSummary = "";
        await this.agent.prompt(prompt);

        // 无评估器 / 没调过工具(纯聊天)/ 被用户中断 / 本轮带错误收尾 → 不验收,直接结束
        if (!this.deps.evaluator || !sawTool || this.aborted || this.agent.state.errorMessage) break;

        this.deps.onEvent({ type: "EvaluationStarted", taskId, round });
        const verdict = await this.deps.evaluator.evaluate({
          taskId,
          intent,
          actionLog: [...actionLog],
          finalSummary: roundSummary.trim(),
          contract: this.deps.contractProvider?.()
        });
        const willRetry = !verdict.pass && round < maxRetries && !this.aborted;
        this.deps.onEvent({
          type: "EvaluationCompleted",
          taskId,
          round,
          verdict: verdict.pass ? "pass" : "fail",
          issues: [...verdict.issues],
          summary: verdict.summary,
          retrying: willRetry
        });
        if (!willRetry) break;

        // 返工:把问题清单回灌给执行器(同一 agent,带上下文)再跑一轮
        prompt = `「独立验收」未通过,发现以下问题,请逐条核实并修正后继续把任务做完(完成后简洁汇报即可):\n- ${verdict.issues.join("\n- ")}`;
      }
    } finally {
      unsubscribe();
    }

    this.deps.onEvent({ type: "TaskCompleted", taskId });
    if (this.agent.state.errorMessage) {
      console.error(`[agent] 运行结束但带错误: ${this.agent.state.errorMessage}`);
    }
    return taskId;
  }

  /** 最近一次运行的错误信息(模型 API 报错等);pi 在出错时不抛异常,错误落在 state 里。 */
  lastError(): string | undefined {
    return this.agent.state.errorMessage;
  }

  /** 中断当前运行(用户点停止)。pi 会以 aborted 收尾,prompt() 正常 resolve。 */
  abort(): void {
    this.aborted = true;
    this.agent.abort();
  }

  /** 当前 transcript 快照(持久化以便日后恢复会话)。 */
  snapshotTranscript(): AgentMessage[] {
    return this.agent.state.messages;
  }

  /**
   * 替换本会话的工具集(渐进披露用)。pi 的 createContextSnapshot 在每次 prompt() 开头
   * 从 state.tools 重新切片,所以**在 startTask 之前**调用本方法即可在下一轮生效。
   * 运行中调用对当前 run 无效——当前 run 用的是已快照的工具集。
   */
  setTools(tools: AgentTool[]): void {
    this.agent.state.tools = tools;
  }
}
