# TODO

## 领域模型待细化(来自 research/domain-model.md 第 5 节)

- [ ] **Action 聚合归属** —— 是否将 Action 从"跨上下文概念"提升为独立聚合(执行记录/审批/日志各自引用)。
- [ ] **Plan 修订语义** —— `PlanRevised` 时,已执行 Step/Action 如何处理(保留 vs 失效)。⭐ 影响执行编排正确性
- [ ] **RiskClassifier 规则来源** —— 静态规则表 vs LLM 辅助分级 vs 两者结合(静态兜底)。⭐ 影响安全正确性
- [ ] **Memory 写入触发** —— 何时由 MemoryWriter 提议持久化;"受控非静默"的具体 UX。
- [ ] **领域事件分发机制** —— 进程内同步 vs 事件总线(影响 Electron 主进程↔渲染层 IPC 设计)。

## pi 集成后续(已接 pi-ai → infra,pi-agent-core → ctx-task)

- [ ] **Capability 工具**:实现 `AgentTool` 并注入 adapter(filesystem 先行:read_file/list_dir/extract_document)。当前 tools=[],循环空转。
- [ ] **Trust 守门人落地**:用 ctx-trust 的 RiskClassifier 替换 `allowAllGatekeeper`;`capabilityOf` 改为真实 tool→capability 注册表。
- [ ] **Reversibility 记账**:接 `afterToolCall`,变更类 Action 写 journal。
- [ ] **Memory 召回**:接 `transformContext`,把偏好/事实注入上下文 + 标注网页不可信内容(InjectionGuard)。
- [ ] **Plan/Step 显式建模**:当前 translateEvent 用 taskId 占位 stepId;pi 无 step 概念,需在 ACL 层自建 Plan/Step 并与 pi 的 turn/tool 事件对齐。
- [ ] **BYO key → Keychain**:`envApiKeyResolver` 仅占位,换成 OS Keychain 实现。
- [ ] **真实对话验证**:填入 Anthropic key 跑通端到端(目前仅 typecheck + 事件翻译单测,未跑真实 LLM)。
- [ ] **desktop 接线**:主进程实例化 gateway + adapter,经 IPC 把领域事件流推给渲染层。

## 范围/产品

- [ ] 团队规模与排期确定后,复审 V1 范围,大概率砍"破坏性文件操作"。
- [ ] 公开网页调研是否并入搜索 API(Tavily/Exa),与登录态浏览器两条路并存。
- [ ] Prompt injection 纵深防御的系统化设计。
- [ ] Mac 代码签名 + 公证;Electron 自动更新通道。
- [ ] 商业化(BYO 先免费验证 → 网关层切订阅制)。
