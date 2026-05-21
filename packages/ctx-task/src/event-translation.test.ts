import { describe, expect, it } from "vitest";
import type { Capability, TaskId } from "@pa/domain-core";
import { translateEvent } from "./index";

const taskId = "task-1" as TaskId;
const capabilityOf = (): Capability => "filesystem";

describe("translateEvent", () => {
  it("tool_execution_start → ActionProposed,带 Action", () => {
    const out = translateEvent(
      { type: "tool_execution_start", toolCallId: "a1", toolName: "read_file", args: { path: "/x" } },
      taskId,
      capabilityOf
    );
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      type: "ActionProposed",
      taskId,
      action: { id: "a1", tool: "read_file", capability: "filesystem", status: "Executing" }
    });
  });

  it("tool_execution_end(成功)→ ActionExecuted", () => {
    const out = translateEvent(
      { type: "tool_execution_end", toolCallId: "a1", toolName: "read_file", result: "ok", isError: false },
      taskId,
      capabilityOf
    );
    expect(out[0]).toMatchObject({ type: "ActionExecuted", taskId, actionId: "a1" });
  });

  it("tool_execution_end(失败)→ ActionFailed", () => {
    const out = translateEvent(
      { type: "tool_execution_end", toolCallId: "a1", toolName: "rm", result: "boom", isError: true },
      taskId,
      capabilityOf
    );
    expect(out[0]).toMatchObject({ type: "ActionFailed", taskId, actionId: "a1", error: "boom" });
  });

  it("agent_end → TaskCompleted", () => {
    const out = translateEvent({ type: "agent_end", messages: [] }, taskId, capabilityOf);
    expect(out[0]).toMatchObject({ type: "TaskCompleted", taskId });
  });

  it("无关事件 → 空", () => {
    expect(translateEvent({ type: "turn_start" }, taskId, capabilityOf)).toEqual([]);
  });
});
