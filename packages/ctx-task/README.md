# @pa/ctx-task

Task Orchestration —— Task→Plan→Step 显式建模,含 pi-agent-core 的防腐层(ACL)

已实现:`PiAgentAdapter`(pi-agent-core 的 ACL)+ `AgentEvent`→领域事件翻译(惰性建 Step)+ 会话恢复(initialMessages 播种 / snapshotTranscript)+ `lastError()`。职责与模型见 [`research/domain-model.md`](../../research/domain-model.md)。
