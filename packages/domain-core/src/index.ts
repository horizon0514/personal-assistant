/**
 * @pa/domain-core
 *
 * 跨限界上下文共享的领域类型与事件定义。
 * 这里只放「各上下文都要引用的语言」——具体行为/聚合实现留在各 ctx-* 包。
 * 详见 research/domain-model.md。
 */

// ── 标识(以 id 作为跨上下文集成键)──────────────────────────────
export type TaskId = string & { readonly __brand: "TaskId" };
export type PlanId = string & { readonly __brand: "PlanId" };
export type StepId = string & { readonly __brand: "StepId" };
export type ActionId = string & { readonly __brand: "ActionId" };
export type ConversationId = string & { readonly __brand: "ConversationId" };

/** id 生成(集成键的来源)。Node 22 全局 crypto.randomUUID。 */
export const newTaskId = (): TaskId => crypto.randomUUID() as TaskId;
export const newActionId = (): ActionId => crypto.randomUUID() as ActionId;
export const newStepId = (): StepId => crypto.randomUUID() as StepId;
export const newConversationId = (): ConversationId => crypto.randomUUID() as ConversationId;

// ── 核心值对象 ───────────────────────────────────────────────
/** 用户用自然语言表达的目标 */
export interface Intent {
  readonly text: string;
  readonly conversationId: ConversationId;
}

/** Capability 域 —— 三个独立限界上下文 */
export type Capability = "filesystem" | "webresearch" | "browser";

/** Action 风险分级(Trust & Governance 的核心值对象)*/
export type RiskLevel =
  | "ReadOnly"
  | "ReversibleMutating"
  | "Destructive"
  | "ExternalStateChanging";

export type TaskStatus =
  | "Pending"
  | "Planning"
  | "AwaitingApproval"
  | "Executing"
  | "Paused"
  | "Completed"
  | "Failed"
  | "Reverted";

export type StepStatus = "Pending" | "Running" | "Completed" | "Failed" | "Skipped";

export type ActionStatus =
  | "Proposed"
  | "AwaitingApproval"
  | "Approved"
  | "Denied"
  | "Executing"
  | "Executed"
  | "Failed"
  | "Reverted";

// ── 实体骨架 ─────────────────────────────────────────────────
/** 单个具体操作:治理与可逆性的最小单位,映射一次 tool call */
export interface Action {
  readonly id: ActionId;
  readonly stepId: StepId;
  readonly capability: Capability;
  readonly tool: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly status: ActionStatus;
  readonly riskLevel?: RiskLevel;
}

export interface Step {
  readonly id: StepId;
  readonly description: string;
  readonly order: number;
  readonly status: StepStatus;
  readonly actionIds: readonly ActionId[];
}

export interface Plan {
  readonly id: PlanId;
  readonly revision: number;
  readonly steps: readonly Step[];
}

/** 顶层工作单元(Task Orchestration 的聚合根)*/
export interface Task {
  readonly id: TaskId;
  readonly intent: Intent;
  readonly status: TaskStatus;
  readonly plan?: Plan;
  readonly conversationId: ConversationId;
}

// ── 领域事件(贯穿上下文的脊柱)───────────────────────────────
// 后续按上下文细化;此处先立 union 骨架。
export type DomainEvent =
  // Task Orchestration
  | { type: "TaskCreated"; taskId: TaskId; intent: Intent }
  | { type: "PlanProposed"; taskId: TaskId; plan: Plan }
  | { type: "PlanRevised"; taskId: TaskId; plan: Plan }
  | { type: "StepStarted"; taskId: TaskId; stepId: StepId }
  | { type: "StepCompleted"; taskId: TaskId; stepId: StepId }
  | { type: "ActionProposed"; taskId: TaskId; action: Action }
  | { type: "ActionExecuted"; taskId: TaskId; actionId: ActionId }
  | { type: "ActionFailed"; taskId: TaskId; actionId: ActionId; error: string }
  | { type: "TaskCompleted"; taskId: TaskId }
  | { type: "TaskFailed"; taskId: TaskId; error: string }
  // Trust & Governance
  | { type: "RiskClassified"; actionId: ActionId; riskLevel: RiskLevel }
  | { type: "ApprovalRequested"; actionId: ActionId; riskLevel: RiskLevel }
  | { type: "ApprovalGranted"; actionId: ActionId }
  | { type: "ApprovalDenied"; actionId: ActionId }
  // Reversibility
  | { type: "ChangeSetPreviewed"; taskId: TaskId; summary: string }
  | { type: "OperationJournaled"; actionId: ActionId }
  | { type: "OperationReverted"; actionId: ActionId }
  // Memory
  | { type: "MemoryRecorded"; memoryId: string }
  | { type: "MemoryRecalled"; memoryId: string };

export type DomainEventType = DomainEvent["type"];
