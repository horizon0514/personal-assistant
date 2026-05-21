/** 工作区(Task / Trust / Reversibility 的可视化)共享类型 */

export interface ActionRow {
  id: string;
  stepId: string;
  tool: string;
  capability: string;
  status: "running" | "awaiting" | "done" | "failed";
  riskLevel?: string;
  error?: string;
}

export interface JournalItem {
  actionId: string;
  tool: string;
  capability: string;
  summary: string;
  reverted: boolean;
}

export type BatchOp = { op: "move"; from: string; to: string } | { op: "delete"; path: string };

export interface BatchState {
  actionId: string;
  operations: BatchOp[];
}
