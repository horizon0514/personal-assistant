import { describe, expect, it } from "vitest";
import type { Capability, TaskId } from "@pa/domain-core";
import { DomainTranslator } from "./index";

const taskId = "task-1" as TaskId;
const capabilityOf = (): Capability => "filesystem";

function newTr() {
  return new DomainTranslator(taskId, capabilityOf);
}

describe("DomainTranslator", () => {
  it("turn 内首个工具 → StepStarted + ActionProposed(带真实 stepId)", () => {
    const tr = newTr();
    tr.translate({ type: "turn_start" });
    const out = tr.translate({
      type: "tool_execution_start",
      toolCallId: "a1",
      toolName: "read_file",
      args: { path: "/x" }
    });
    expect(out[0]).toMatchObject({ type: "StepStarted", taskId });
    expect(out[1]).toMatchObject({
      type: "ActionProposed",
      action: { id: "a1", tool: "read_file", capability: "filesystem", status: "Executing" }
    });
    // Action 的 stepId 与 StepStarted 的一致,且不是 taskId 占位
    const stepId = (out[0] as { stepId: string }).stepId;
    expect((out[1] as { action: { stepId: string } }).action.stepId).toBe(stepId);
    expect(stepId).not.toBe(taskId);
  });

  it("同一 turn 内第二个工具复用同一 Step(不再发 StepStarted)", () => {
    const tr = newTr();
    tr.translate({ type: "turn_start" });
    tr.translate({ type: "tool_execution_start", toolCallId: "a1", toolName: "list_dir", args: {} });
    const out = tr.translate({ type: "tool_execution_start", toolCallId: "a2", toolName: "read_file", args: {} });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "ActionProposed", action: { id: "a2" } });
  });

  it("turn_end 关闭已开的 Step", () => {
    const tr = newTr();
    tr.translate({ type: "turn_start" });
    tr.translate({ type: "tool_execution_start", toolCallId: "a1", toolName: "read_file", args: {} });
    const out = tr.translate({ type: "turn_end", message: {} as never, toolResults: [] });
    expect(out[0]).toMatchObject({ type: "StepCompleted", taskId });
  });

  it("纯聊天 turn(无工具)不产生 Step", () => {
    const tr = newTr();
    tr.translate({ type: "turn_start" });
    const out = tr.translate({ type: "turn_end", message: {} as never, toolResults: [] });
    expect(out).toEqual([]);
  });

  it("tool_execution_end 成功/失败映射", () => {
    const tr = newTr();
    expect(
      tr.translate({ type: "tool_execution_end", toolCallId: "a1", toolName: "x", result: "ok", isError: false })[0]
    ).toMatchObject({ type: "ActionExecuted", actionId: "a1" });
    expect(
      tr.translate({ type: "tool_execution_end", toolCallId: "a1", toolName: "rm", result: "boom", isError: true })[0]
    ).toMatchObject({ type: "ActionFailed", actionId: "a1", error: "boom" });
  });

  it("agent_end → TaskCompleted", () => {
    expect(newTr().translate({ type: "agent_end", messages: [] })[0]).toMatchObject({
      type: "TaskCompleted",
      taskId
    });
  });
});
