# TODO

## 领域模型待细化(来自 research/domain-model.md 第 5 节)

- [ ] **Action 聚合归属** —— 是否将 Action 从"跨上下文概念"提升为独立聚合(执行记录/审批/日志各自引用)。
- [ ] **Plan 修订语义** —— `PlanRevised` 时,已执行 Step/Action 如何处理(保留 vs 失效)。⭐ 影响执行编排正确性
- [ ] **RiskClassifier 规则来源** —— 静态规则表 vs LLM 辅助分级 vs 两者结合(静态兜底)。⭐ 影响安全正确性
- [ ] **Memory 写入触发** —— 何时由 MemoryWriter 提议持久化;"受控非静默"的具体 UX。
- [ ] **领域事件分发机制** —— 进程内同步 vs 事件总线(影响 Electron 主进程↔渲染层 IPC 设计)。

## pi 集成后续(已接 pi-ai → infra,pi-agent-core → ctx-task)

- [x] **Capability 工具**:cap-filesystem 暴露 list_dir/read_file(只读)+ write_file(可变更),已注入 adapter。
- [x] **Trust 守门人落地**:ctx-trust createGatekeeper 替换了 allowAllGatekeeper(风险分级 + 策略 + 审批 IPC)。capabilityOf 待扩成多能力注册表。
- [x] **Reversibility 记账**:OperationJournal + 按能力注册 reverser + undoLast;接 afterToolCall 记账;撤销 UI。
- [x] **Memory 召回**:ctx-memory(本地 JSON,可见可删)+ remember 工具 + transformContext 注入召回 + UI 记忆列表。**阶段 B 首项完成。** (InjectionGuard 标注待 WebResearch/Browser 时做)
- [x] **Plan/Step 显式建模**:DomainTranslator 按 turn 惰性建 Step(纯聊天 turn 不产生空步骤),Action 归属真实 stepId;工作区按"步骤 N"分组渲染。
- [ ] **BYO key → Keychain**:`envApiKeyResolver` 仅占位,换成 OS Keychain 实现。(阶段 C)
- [x] **真实对话验证**:DeepSeek 端到端跑通。
- [x] **desktop 接线**:主进程已实例化 gateway + adapter,领域事件经 IPC 推给渲染层工作区。
- [ ] **extract_document**:PDF/图片信息提取工具(阶段 B,调研→产出需要)。
- [x] **破坏性 fs 工具**:delete(软删到回收区)/ move_file(移动/重命名),均可回滚。
- [x] **执行前 diff 预览整批审批**:plan_file_changes 工具一次性提交全部 move/delete,UI 整批预览+同意/拒绝,批准后原子执行+批量回滚日志。**阶段 A 完成。**

## 记忆与检索演进(按需再做,勿过早)

- [ ] **记忆 TTL / 衰减**:给记忆加有效期字段。"中期记忆"=会过期的记忆(如"最近在做项目 X");"长期"=不过期。不单独搞短/中/长三层架构(短期已由 pi 的对话上下文+compaction 覆盖)。决策:分层是存储分类法,不解决"写什么/何时召回/何时遗忘",过早引入是负担。
- [ ] **相关性召回**:记忆/文件变多时,按相关性挑选注入,而非全量塞 prompt。
- [ ] **采用 agentic search(grep)而非向量 RAG**:让 agent 用搜索工具(grep/glob)按需查找,而不是预建向量索引。理由:本地文件常变(索引易失效)、需要精确匹配(符号/字符串)、模型可多步推理"去哪找"、零索引基建。先加 filesystem 搜索能力(content grep + 文件名 glob);记忆召回同理用 search_memory(关键词)。真正需要语义相似度时再考虑 embedding,但不预先上 RAG。

## Agent harness 行为(自建 harness 时打磨)

- [ ] **完成前强制自验证**:破坏性/变更操作后,harness 层加校验关卡,完成任务前强制跑一次只读核实(list_dir/read_file),而非仅靠系统提示引导。目前是 prompt 层软约束,模型偶尔会偷懒。
- [ ] **工具能力兜底**:能力缺口会让 agent 兜圈(如曾经的"无法建目录")。考虑受限 shell 工具(高风险强制审批)作为兜底。

## 范围/产品

- [ ] 团队规模与排期确定后,复审 V1 范围,大概率砍"破坏性文件操作"。
- [ ] 公开网页调研是否并入搜索 API(Tavily/Exa),与登录态浏览器两条路并存。
- [ ] Prompt injection 纵深防御的系统化设计。
- [ ] Mac 代码签名 + 公证;Electron 自动更新通道。
- [ ] 商业化(BYO 先免费验证 → 网关层切订阅制)。
