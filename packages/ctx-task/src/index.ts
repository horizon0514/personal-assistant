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
  renderActionTrace,
  type Action,
  type ActionId,
  type ActionTraceEntry,
  type Capability,
  type DomainEvent,
  type Evaluator,
  type Gatekeeper,
  type Intent,
  type StepId,
  type TaskId
} from "@pa/domain-core";

export { createPiEvaluator, type PiEvaluatorDeps } from "./evaluator";
export { createPlanTool, type PlanToolDeps, type PlanConfirmation } from "./plan";
export { createAskUserTool, type AskUserToolDeps } from "./ask-user";
export type { Evaluator, EvaluationRequest, Verdict, WorkPlan } from "@pa/domain-core";

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
  /** 取本次任务已确认的开工计划(若执行器跑过 propose_plan),作为评估的验收清单。 */
  readonly planProvider?: () => import("@pa/domain-core").WorkPlan | undefined;
  /**
   * 落盘本次任务的执行轨迹(已渲染、带不可信围栏的可读文本),返回其绝对路径。
   * 验收器据此用只读工具读取完整轨迹。不提供则验收器只拿到内联截断摘要。
   */
  readonly writeTrace?: (renderedTrace: string) => string | undefined;
  /** 领域事件出口(任务/动作生命周期,供工作区面板订阅)*/
  readonly onEvent: (event: DomainEvent) => void;
  /** 助理文本增量出口(Conversation 关注点,不进领域事件)*/
  readonly onAssistantDelta?: (text: string) => void;
  /**
   * 每个 assistant turn 收尾时出口,参数为当前 transcript 快照(供增量落盘)。
   * 让运行中的会话边跑边持久化,而非等整轮结束——卡住/崩溃/关窗也不丢已发生的对话。
   */
  readonly onTurnEnd?: (transcript: AgentMessage[]) => void;
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

/** 把工具入参压成一句可读的命令原文:单一关键字段(command/query)优先,否则 JSON 化。不截断(完整入轨迹文件)。 */
function pickArgsText(args: unknown): string {
  if (args == null) return "";
  const a = args as Record<string, unknown>;
  // exec_shell 等以单一关键字段承载意图的,优先取该字段(更像"命令原文")。
  const key = typeof a.command === "string" ? a.command : typeof a.query === "string" ? a.query : undefined;
  return (key ?? (typeof args === "string" ? args : JSON.stringify(args))).trim();
}

/** 从 pi 的工具结果里抽完整纯文本(客观输出)。不截断。 */
function extractResultText(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => (b as { type?: string })?.type === "text")
    .map((b) => b.text)
    .join("\n")
    .trim();
}

export class PiAgentAdapter {
  private readonly agent: Agent;
  /** 用户主动中断标记:中断后跳过验收与返工。 */
  private aborted = false;
  /** 当前运行(供新任务进来时先打断并等其收尾,避免两轮并发跑同一 agent)。 */
  private running?: Promise<TaskId>;
  /** 本轮验收的中止句柄:中断时连带掐掉正在干等的 evaluator。 */
  private evalController?: AbortController;

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
            // 背景上下文受限于消息角色只能挂 user,但必须**显式声明它不是用户的请求**——
            // 否则模型会把这坨背景(尤其「近期线索」)当成用户开口,转去推进旧任务、无视真正的提问
            // (实测 bad case:用户问「你可以自我进化不」,模型却答「当前没有新的用户消息」跑去查定时任务)。
            const framed =
              "<上下文背景>\n下面是环境信息、关于用户的记忆、近期聊过的线索与可用技能,**这些都不是用户本轮的请求**," +
              "只是供你参考的背景。用户这一轮真正要你做的,是本条之后的**最后一条 user 消息**;" +
              "仅当背景与那条请求相关时才用它,不要主动去推进背景里提到的旧任务。\n\n" +
              ctx +
              "\n</上下文背景>";
            const injected: AgentMessage = { role: "user", content: framed, timestamp: Date.now() };
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

  /**
   * 接收一个 Intent,跑通 agent 循环,期间把领域事件推给 onEvent。
   * 若上一轮(含其验收/返工闭环)还在跑——比如用户在"自查中"就发来新消息——
   * 先打断它并等其收尾,再开本轮,避免两个 run 并发驱动同一个 agent。
   */
  async startTask(intent: Intent): Promise<TaskId> {
    if (this.running) {
      this.abort();
      try {
        await this.running;
      } catch {
        /* 上一轮的收尾错误与本轮无关,吞掉 */
      }
    }
    const run = this.runTask(intent);
    this.running = run.finally(() => {
      if (this.running === run) this.running = undefined;
    });
    return this.running;
  }

  private async runTask(intent: Intent): Promise<TaskId> {
    const taskId = newTaskId();
    this.aborted = false;
    this.evalController = new AbortController();
    this.deps.onEvent({ type: "TaskCreated", taskId, intent });
    const translator = new DomainTranslator(taskId, this.deps.capabilityOf);

    // 验收所需的过程信息:本轮是否调过工具、本轮客观执行轨迹(带命令+完整结果,供验收器看清"做了什么/返回了什么")。
    // start 事件带 args、end 事件带 result,按 toolCallId 对上。**逐 round 重置**(见 loop 顶部)——
    // 否则返工 round 里执行器只回文字也会触发 evaluator,且 evaluator 会拿到上一轮的动作日志而误判。
    let sawTool = false;
    const actionLog: ActionTraceEntry[] = [];
    const pendingArgs = new Map<string, string>();

    // 验收策略:乐观流式 + 失败回滚。final 汇报照常实时流式呈现(流式优先),
    // evaluator 仅在不通过时,经 EvaluationCompleted{retrying} 通知 UI 撤回这段待核验汇报、
    // 再流式补上修正版本。currentTurnText 仍累积,但只用于把 final 汇报文本喂给 evaluator(判定输入),
    // 不再用于"延迟/扣留 flush"——任何文本都边到边发,不再按 turn 缓冲。
    let currentTurnText = "";
    let pendingFinalText = "";

    const unsubscribe = this.agent.subscribe((event) => {
      // 助理文本增量 → 实时流式给 UI;同时累积本 turn 文本(供 evaluator 判定 final 汇报)
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        const delta = event.assistantMessageEvent.delta;
        currentTurnText += delta;
        this.deps.onAssistantDelta?.(delta);
      }
      if (event.type === "tool_execution_start") {
        sawTool = true;
        pendingArgs.set(event.toolCallId, pickArgsText(event.args));
      }
      if (event.type === "tool_execution_end") {
        actionLog.push({
          tool: event.toolName,
          ok: !event.isError,
          args: pendingArgs.get(event.toolCallId) || undefined,
          result: extractResultText(event.result) || undefined
        });
        pendingArgs.delete(event.toolCallId);
      }
      if (event.type === "message_end") {
        const m = event.message as { role?: string; stopReason?: string; errorMessage?: string };
        if (m.role === "assistant") {
          // stop 收尾的 turn = final 汇报:留存文本供 evaluator 判定(内容已实时流式给用户)
          if (m.stopReason === "stop") {
            pendingFinalText = currentTurnText;
          } else if (m.stopReason && m.stopReason !== "tool_use") {
            console.error(`[agent] assistant turn 结束于 stopReason=${m.stopReason}`, m.errorMessage ?? "");
          }
          currentTurnText = "";
          // 增量落盘:这一 turn(及其之前的工具结果)已进 state.messages,持久化一份快照
          this.deps.onTurnEnd?.(this.snapshotTranscript());
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
        // 本轮累加器清零:evaluator 看到的"调过什么"必须是"本轮调过的"。
        // subscribe 是 startTask 全程注册一次,这些 let/array 通过闭包共享——重置完再 await 就行。
        sawTool = false;
        actionLog.length = 0;
        pendingArgs.clear();
        pendingFinalText = "";
        await this.agent.prompt(prompt);

        // 无评估器 / 没调过工具(纯聊天)/ 被用户中断 / 本轮带错误收尾 → 不验收,直接结束(final 已流式呈现)
        if (!this.deps.evaluator || !sawTool || this.aborted || this.agent.state.errorMessage) {
          break;
        }

        this.deps.onEvent({ type: "EvaluationStarted", taskId, round });
        // 落盘完整执行轨迹(带不可信围栏),把路径给验收器:内联看摘要,要细节自己去读这个文件。
        const tracePath = this.deps.writeTrace?.(renderActionTrace(actionLog));
        const verdict = await this.deps.evaluator.evaluate({
          taskId,
          intent,
          actionLog: [...actionLog],
          finalSummary: pendingFinalText.trim(),
          plan: this.deps.planProvider?.(),
          tracePath,
          signal: this.evalController?.signal
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

        if (willRetry) {
          // 这一轮的 final 已流式呈现但未通过自查:UI 收到 retrying 会撤回它,
          // 此处把问题清单回灌让执行器返工,修正版本随后流式补入。
          pendingFinalText = "";
          prompt = `「独立验收」未通过,发现以下问题,请逐条核实并修正后继续把任务做完(完成后简洁汇报即可):\n- ${verdict.issues.join("\n- ")}`;
          continue;
        }

        // 通过 或 已耗尽 retry → final 已流式呈现,直接结束(耗尽 retry 时也保留已给用户看到的版本)
        pendingFinalText = "";
        break;
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

  /** 中断当前运行(用户点停止 / 发来新消息)。pi 会以 aborted 收尾,prompt() 正常 resolve。 */
  abort(): void {
    this.aborted = true;
    this.agent.abort();
    this.evalController?.abort(); // 连带掐掉正在干等的 evaluator
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
