import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionStore } from "@pa/infra";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { createSearchHistoryTool } from "./history-search";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pa-hist-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const run = (sessions: SessionStore, currentSessionId: string, query: string): Promise<AgentToolResult<unknown>> =>
  createSearchHistoryTool({ sessions, currentSessionId }).execute("id", { query }, undefined as never) as Promise<
    AgentToolResult<unknown>
  >;
const textOf = (r: AgentToolResult<unknown>): string => {
  const c = r.content[0];
  return c && c.type === "text" ? c.text : "";
};

describe("search_history", () => {
  it("命中历史会话的用户/助理文本,排除当前会话,跳过工具结果", async () => {
    const s = new SessionStore(join(root, "ws"));
    const past = s.create("飞书那次");
    s.saveTranscript(past.id, [
      { role: "user", content: "为啥发飞书消息会打开浏览器" },
      { role: "assistant", content: [{ type: "text", text: "浏览器是 read_current_page 触发的" }] },
      { role: "tool", content: [{ type: "text", text: "浏览器 stdout 噪声不该被搜到" }] }
    ]);
    const current = s.create("当前会话");
    s.saveTranscript(current.id, [{ role: "user", content: "浏览器相关的当前对话,不该被搜到" }]);

    const out = textOf(await run(s, current.id, "浏览器"));
    expect(out).toContain("《飞书那次》");
    expect(out).toContain("read_current_page"); // 助理文本命中
    expect(out).not.toContain("stdout 噪声"); // 工具结果被跳过
    expect(out).not.toContain("当前对话"); // 当前会话被排除
  });

  it("多词 AND:全部词都命中才算", async () => {
    const s = new SessionStore(join(root, "ws2"));
    const a = s.create("A");
    s.saveTranscript(a.id, [{ role: "user", content: "聊了浏览器和验收器" }]);
    const b = s.create("B");
    s.saveTranscript(b.id, [{ role: "user", content: "只聊了浏览器" }]);
    const cur = s.create("cur");

    const out = textOf(await run(s, cur.id, "浏览器 验收器"));
    expect(out).toContain("《A》");
    expect(out).not.toContain("《B》");
  });

  it("无命中返回明确提示", async () => {
    const s = new SessionStore(join(root, "ws3"));
    const a = s.create("A");
    s.saveTranscript(a.id, [{ role: "user", content: "随便聊聊" }]);
    const cur = s.create("cur");
    expect(textOf(await run(s, cur.id, "量子计算"))).toContain("没有在历史对话里找到");
  });
});
