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

  it("可查看工具的成功结果 → 回填 resultBody(供重开会话的「查看」)", () => {
    const out = transcriptToTimeline(
      [
        { role: "user", content: "读文件" },
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "read_file" }] },
        { role: "toolResult", toolCallId: "t1", toolName: "read_file", isError: false, content: [{ type: "text", text: "文件正文" }] }
      ],
      capabilityOf
    );
    const step = out.find((i) => i.kind === "step");
    expect(step).toMatchObject({ actions: [{ id: "t1", tool: "read_file", status: "done", resultBody: "文件正文" }] });
  });

  it("非可查看工具(如 remember)不回填 resultBody", () => {
    const out = transcriptToTimeline(
      [
        { role: "assistant", content: [{ type: "toolCall", id: "t1", name: "remember" }] },
        { role: "toolResult", toolCallId: "t1", toolName: "remember", isError: false, content: [{ type: "text", text: "已记住" }] }
      ],
      capabilityOf
    );
    const step = out.find((i) => i.kind === "step");
    const action = step?.kind === "step" ? step.actions[0] : undefined;
    expect(action?.resultBody).toBeUndefined();
  });

  it("非数组(新会话无 transcript)→ 空", () => {
    expect(transcriptToTimeline(undefined, capabilityOf)).toEqual([]);
  });
});
