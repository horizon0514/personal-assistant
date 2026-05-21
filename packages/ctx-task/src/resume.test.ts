import { describe, expect, it } from "vitest";
import { createModel, envApiKeyResolver } from "@pa/infra";
import type { Capability } from "@pa/domain-core";
import { PiAgentAdapter, type AgentMessage } from "./index";

/**
 * 恢复路径(无网络):用持久化 transcript 播种 adapter,snapshotTranscript 应读回。
 * 这正是"重启 app → 打开旧会话"时 getAdapter 走的那条路。
 */
describe("PiAgentAdapter 会话恢复", () => {
  it("initialMessages 播种后,snapshotTranscript 含历史消息", () => {
    const seed: AgentMessage[] = [
      { role: "user", content: "我叫小明", timestamp: 1 } as AgentMessage,
      { role: "assistant", content: [{ type: "text", text: "你好小明" }], timestamp: 2 } as unknown as AgentMessage
    ];
    const adapter = new PiAgentAdapter({
      model: createModel({ provider: "deepseek", modelId: "deepseek-v4-flash" }),
      apiKeyResolver: envApiKeyResolver,
      capabilityOf: (): Capability => "filesystem",
      onEvent: () => {},
      initialMessages: seed
    });

    const snap = adapter.snapshotTranscript();
    expect(snap).toHaveLength(2);
    expect(snap[0]).toMatchObject({ role: "user", content: "我叫小明" });
  });

  it("不播种时 transcript 为空", () => {
    const adapter = new PiAgentAdapter({
      model: createModel({ provider: "deepseek", modelId: "deepseek-v4-flash" }),
      apiKeyResolver: envApiKeyResolver,
      capabilityOf: (): Capability => "filesystem",
      onEvent: () => {}
    });
    expect(adapter.snapshotTranscript()).toHaveLength(0);
  });
});
