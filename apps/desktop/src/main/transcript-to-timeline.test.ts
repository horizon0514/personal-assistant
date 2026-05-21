import { describe, expect, it } from "vitest";
import type { Capability } from "@pa/domain-core";
import { transcriptToTimeline } from "./transcript-to-timeline";

const capabilityOf = (tool: string): Capability => (tool === "remember" ? "memory" : "filesystem");

describe("transcriptToTimeline", () => {
  it("user / assistant 文本 → 气泡", () => {
    const out = transcriptToTimeline(
      [
        { role: "user", content: "你好" },
        { role: "assistant", content: [{ type: "text", text: "在的" }] }
      ],
      capabilityOf
    );
    expect(out).toEqual([
      { kind: "msg", id: "m0", role: "user", content: "你好" },
      { kind: "msg", id: "m1", role: "assistant", content: "在的" }
    ]);
  });

  it("assistant 的 toolCall → step 块,toolResult 回填失败状态", () => {
    const out = transcriptToTimeline(
      [
        { role: "user", content: "读文件" },
        {
          role: "assistant",
          content: [
            { type: "text", text: "好的" },
            { type: "toolCall", id: "t1", name: "read_file" },
            { type: "toolCall", id: "t2", name: "list_dir" }
          ]
        },
        { role: "toolResult", toolCallId: "t1", toolName: "read_file", isError: false, content: [] },
        { role: "toolResult", toolCallId: "t2", toolName: "list_dir", isError: true, content: [{ type: "text", text: "失败了" }] }
      ],
      capabilityOf
    );
    const step = out.find((i) => i.kind === "step");
    expect(step).toBeDefined();
    expect(step).toMatchObject({
      kind: "step",
      index: 1,
      actions: [
        { id: "t1", tool: "read_file", status: "done", capability: "filesystem" },
        { id: "t2", tool: "list_dir", status: "failed", error: "失败了" }
      ]
    });
  });

  it("非数组(新会话无 transcript)→ 空", () => {
    expect(transcriptToTimeline(undefined, capabilityOf)).toEqual([]);
  });
});
