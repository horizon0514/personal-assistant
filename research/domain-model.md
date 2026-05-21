# Personal Assistant — 领域模型(DDD)

> 用领域驱动设计明确本产品的领域:子域分类、限界上下文、统一语言、聚合/实体/值对象、领域事件与上下文映射。
> 日期:2026-05-21 · 配套阅读:[`design-discussion.md`](design-discussion.md)

---

## 0. 第一性原则

DDD 的首要动作是**区分核心域 / 支撑域 / 通用域**:把自研精力压在核心域,通用域买/复用。
我们已决定 agent loop、上下文压缩、多 provider 用 pi —— 等于把它们划入**通用/可买域**。

| 类别 | 子域 | 说明 |
|------|------|------|
| **核心域** | 信任与治理(Trust & Governance) | 风险分级、审批、权限、注入隔离。面向非开发者的命门。 |
| **核心域** | 可逆性(Reversibility) | 操作日志、软删除、回滚、diff 预览。"敢用"的前提。 |
| **核心域** | 个人记忆(Personal Memory) | 偏好/事实,可见可编辑。"个人助理"的分水岭。 |
| **支撑域** | 能力(Capabilities) | 文件 / 调研 / 浏览器。价值载体,是"手"不是"脑"。 |
| **通用域** | Agent 运行时 | pi-agent-core(loop/compaction/session) |
| **通用域** | 模型网关 | pi-ai(多 provider) |
| **通用域** | 凭证存储 | OS Keychain(浏览器登录态) |

---

## 1. 统一语言(Ubiquitous Language)

| 术语 | 定义 |
|------|------|
| **Assistant** | 代表用户行动的助理/agent 人格 |
| **User** | 用户(知识工作者/白领) |
| **Intent** | 用户用自然语言表达的目标 |
| **Task** | 由 Intent 派生的一项要完成的工作(顶层工作单元) |
| **Plan** | Assistant 为完成 Task 提出的、有序且可修订的 Step 集合 |
| **Step** | Plan 中的一个连贯子目标,可产出一个或多个 Action |
| **Action** | 单个具体操作(映射一次 tool call)。**治理与可逆性的最小单位** |
| **Capability** | 一类操作领域(FileSystem / WebResearch / BrowserSession),对外暴露 Tool |
| **Tool** | Capability 内可被 Action 调用的接口 |
| **Approval** | 用户对某个 Action 或某类 Action 的授权/拒绝决定 |
| **Permission Policy** | 关于"自动执行 vs 需审批"的常驻规则 |
| **Risk Level** | Action 潜在危害的分级 |
| **Journal** | 已执行的破坏性 Action 的追加式记录,支撑 Undo |
| **Reversal / Undo** | 还原某 Action/批次执行前的状态 |
| **Memory** | 持久化的个人偏好/事实 |
| **Session** | 持久化的一段对话及其 Task(对应 pi 的 session) |

> **核心主线(贯穿所有上下文的脊柱):**
> `Intent → Task → Plan(Steps) → Step 提出 Action → 风险分级 → 权限校验 →（按需）审批 → Capability 执行 Tool →（若有副作用）写 Journal → 结果回流 → 继续循环`

---

## 2. 限界上下文地图

```
┌─────────────────┐    Intent       ┌──────────────────────┐
│  Conversation   │ ───────────────▶│  Task Orchestration   │
│  会话/消息/流式   │◀─── 执行事件 ────│  Task→Plan→Step       │
└─────────────────┘                 └──────┬───────────────┘
        ▲                                  │ ACL 包裹
        │ 注入偏好                          ▼  pi-agent-core
        │                          ┌──────────────────┐
┌───────┴────────┐                 │  Agent Runtime    │(通用)
│ Personal Memory │◀───recall──────│  + Model Gateway  │
│ 偏好/事实(核心)  │                 └──────────────────┘
└────────────────┘                        │ ActionProposed
                                            ▼
                                   ┌──────────────────────┐
                                   │  Trust & Governance   │ 核心 · 网关
                                   │  风险分级/审批/权限/注入 │
                                   └──────┬───────────────┘
                                  approved │（挂 pi beforeToolCall）
        ┌──────────────┬──────────────────┼──────────────────┐
        ▼              ▼                   ▼                  ▼
 ┌────────────┐ ┌────────────┐    ┌───────────────┐  ┌──────────────┐
 │ FileSystem │ │ WebResearch │    │ BrowserSession │  │ (future:      │
 │ Capability │ │ Capability  │    │  Capability    │  │  App Control) │
 └─────┬──────┘ └────────────┘    └───────┬────────┘  └──────────────┘
       │ 变更操作                          │ 登录态
       ▼                                   ▼
 ┌──────────────┐                  ┌──────────────────┐
 │ Reversibility │                  │ Credential Store  │(通用/Keychain)
 │ journal/trash │ 核心             └──────────────────┘
 └──────────────┘
```

---

## 3. 各限界上下文模型

### 3.1 Conversation(对话上下文)
**职责**:管理对话、会话、消息,把执行事件流式推给 UI。
- **聚合根 `Conversation`**:`id`、`messages[]`、`state`(对应 pi session)
  - 实体 `Message`:user / assistant / toolResult / UI-only(对应 pi 的 `AgentMessage`)
- **值对象**:`MessageContent`、`StreamEvent`(text_delta / tool_execution_* 等)
- **领域事件**:`ConversationStarted`、`MessageAppended`、`TurnStarted/Ended`
- **关系**:上游供给 Intent 给 Task Orchestration;下游消费执行事件做展示

### 3.2 Task Orchestration(任务编排上下文)— 含自研建模
**职责**:把 Task→Plan→Step **显式建模**,驱动 pi loop,跟踪生命周期。
- **聚合根 `Task`**:`id`、`intent`、`status`、`plan`、`conversationId`
  - 实体 `Plan`:有序 `Step[]`、`revision`(计划可中途修订)
  - 实体 `Step`:`id`、`description`、`status`、`order`、所产出 `Action` 的引用
- **`Action`(跨上下文概念)**:在本上下文中是"挂在 Step 上的待执行工作";其**风险分级/审批**归 Trust、**回滚记录**归 Reversibility,以 `ActionId` 作为集成键
- **值对象**:`TaskStatus`(Pending/Planning/AwaitingApproval/Executing/Paused/Completed/Failed/Reverted)、`StepStatus`、`PlanRevision`、`Intent`
- **领域事件**:`TaskCreated`、`PlanProposed`、`PlanRevised`、`StepStarted`、`StepCompleted`、`ActionProposed`、`ActionExecuted`、`ActionFailed`、`TaskCompleted/Failed/Paused`
- **不变量**:
  - Plan 的 Step 必须有序;Task 存在未完成 Step 时不可置为 Completed
  - 进入 Executing 的 Action 必须已通过 Trust 的放行
- **关系**:对 pi-agent-core 用 **防腐层(ACL)**——pi 发底层 tool_execution 事件,ACL 翻译成领域 Action/Step,保护领域模型不被 pi 概念污染

### 3.3 Trust & Governance(信任与治理上下文)— 核心
**职责**:风险分级、权限策略、审批管理、注入隔离。**是 Action 执行前的网关**。
- **聚合根 `ApprovalRequest`**:`id`、`actionRef`、`riskLevel`、`requestedScope`(once / session-class / always)、`status`(Pending/Granted/Denied/Expired)、`decidedBy`、`decidedAt`
- **聚合根 `PermissionPolicy`**:常驻规则 `(Capability/Tool/RiskLevel) → AutoAllow | RequireApproval | Deny`,含会话级临时授权
- **值对象 `RiskLevel`**:`ReadOnly` / `ReversibleMutating` / `Destructive` / `ExternalStateChanging`
- **值对象**:`ActionDescriptor`(capability、tool、args 摘要)、`ApprovalScope`
- **领域服务**:
  - `RiskClassifier`:`ActionDescriptor → RiskLevel`
  - `InjectionGuard`:标注/隔离不可信内容(网页/页面数据)与可信指令
- **领域事件**:`RiskClassified`、`ApprovalRequested`、`ApprovalGranted`、`ApprovalDenied`、`PolicyUpdated`、`InjectionSuspected`
- **不变量**:
  - 任何高于其策略阈值的 Action,无匹配的 granted Approval 不得执行
  - **`ExternalStateChanging`(发送/购买/删除/发帖)永远需要逐次显式审批**,不可被整批/常驻自动放行
- **集成**:挂在 pi `beforeToolCall` hook 上,作为 Capability 执行的守门人

### 3.4 Reversibility(可逆性上下文)— 核心
**职责**:记录变更、支持撤销、软删除回收、diff 预览。
- **聚合根 `OperationJournal`**(按 Task/Session):追加式 `JournalEntry[]`
  - 实体 `JournalEntry`:`actionRef`、`capability`、`before/after` 描述、`reversalPlan`、`reverted`
- **聚合根 `TrashBin`**:软删除项、可恢复、保留期
- **值对象**:`ChangeSet`(执行前的 diff 预览:对文件的计划操作集)、`ReversalPlan`
- **领域服务**:`PreviewBuilder`(执行前构建 ChangeSet 供整批审批)、`Reverser`(应用 ReversalPlan)
- **领域事件**:`ChangeSetPreviewed`、`OperationJournaled`、`OperationReverted`、`ItemTrashed`、`ItemRestored`
- **不变量**:
  - 每个 `ReversibleMutating`/`Destructive` Action 提交前**必须**先生成 JournalEntry
  - 删除 = 移入 TrashBin,保留期内**永不硬删**
- **关系**:与 FileSystem Capability 是 Customer/Supplier(能力供给变更数据,本上下文记录并能回滚)

### 3.5 Personal Memory(个人记忆上下文)— 核心
**职责**:持久化偏好/事实,可见可编辑,纯本地。
- **聚合根 `MemoryStore`**:`MemoryItem[]`
  - 实体 `MemoryItem`:`id`、`kind`(Preference / Fact)、`content`、`source`(如何习得)、`createdAt`、`enabled`
- **值对象**:`MemoryKind`、`MemoryScope`(global / per-capability)
- **领域服务**:`MemoryWriter`(决定何时持久化,**受控非静默**)、`MemoryRecaller`(把相关记忆注入上下文)
- **领域事件**:`MemoryRecorded`、`MemoryEdited`、`MemoryDeleted`、`MemoryRecalled`
- **不变量**:记忆写入必须可被用户检视(不存在黑箱静默写入);仅本地存储
- **关系**:被 Task Orchestration / Conversation 读取(规划时注入偏好);经受控 `MemoryWriter` 写入。"Preference"作为发布语言共享

### 3.6 Capability 上下文(支撑域)— 三个独立上下文

#### 3.6a FileSystem Capability
- **聚合根 `FileOperation`**:`kind`(Read/Rename/Move/Delete/Write/Create)、`targets`、`params`
- **概念**:`FileNode`(path、type)、`DocumentExtraction`(PDF/图片 → 结构化数据)
- **Tool**:`read_file`、`list_dir`、`extract_document`、`rename`、`move`、`delete`、`write_document`、`build_spreadsheet`
- **领域事件**:`FileRead`、`DocumentExtracted`、`FileMutationProposed`、`FileMutated`
- **关系**:变更操作 → Reversibility(supplier);所有操作 → Trust(被网关)

#### 3.6b WebResearch Capability
- **聚合根 `ResearchQuery`**:`query`、`results[]`、`sources[]`
- **概念**:`Source`(url、title、snippet、retrievedAt)、`ResearchFinding`
- **Tool**:`web_search`(搜索 API)、`fetch_extract`
- **领域事件**:`SearchPerformed`、`SourceFetched`、`FindingCompiled`
- **不变量**:所有抓取内容标记为不可信(交 InjectionGuard)

#### 3.6c BrowserSession Capability
- **聚合根 `BrowserSession`**:`profileId`、`loggedInServices[]`、当前页面状态
  - 实体 `BrowserProfile`:Playwright persistent context;凭证经 Credential Store
- **概念**:`PageAction`(navigate/click/fill/read)、`PageSnapshot`
- **Tool**:`open_url`、`read_page`、`click`、`fill`、`screenshot`
- **领域事件**:`SessionOpened`、`LoggedInDetected`、`PageActionProposed`、`PageActionExecuted`
- **不变量**:改状态的 PageAction 永远需审批(Trust);页面内容不可信

### 3.7 通用底座
- **Model Gateway**(pi-ai):provider/模型选择、BYO key。用 ACL 隔离,领域不依赖具体 provider
- **Agent Runtime**(pi-agent-core):loop/compaction/session,被 Task Orchestration 的 ACL 包裹
- **Credential Store**:OS Keychain 存浏览器登录态。Conformist(直接遵从系统 API)

---

## 4. 上下文映射(关系与模式)

| 上游 → 下游 | 模式 | 说明 |
|-------------|------|------|
| Conversation → Task Orchestration | Customer/Supplier | 对话供给 Intent |
| Task Orchestration → Agent Runtime (pi) | **ACL(防腐层)** | 翻译 pi 事件为领域 Action/Step |
| Task Orchestration → Model Gateway | ACL(经 pi) | 不依赖具体 provider |
| Task Orchestration → Trust & Governance | Gatekeeper(守门人) | ActionProposed 必须经 Trust 放行 |
| Trust & Governance → Capabilities | 网关(pi hook) | 执行前拦截 |
| Capabilities(变更) → Reversibility | Customer/Supplier | 能力供变更数据,可逆性记录/回滚 |
| Memory ↔ Task Orchestration / Conversation | Published Language | 共享 "Preference" 概念 |
| BrowserSession → Credential Store | Conformist | 遵从 OS Keychain |

---

## 5. 待细化(下一步)

1. **Action 聚合归属**:目前 Action 作为跨上下文概念以 `ActionId` 集成。若执行编排复杂度上升,可考虑将其提升为独立聚合(执行记录 / 审批 / 日志各自引用)。
2. **Plan 修订语义**:Plan 可中途 `PlanRevised`——需定义修订时已执行 Step/Action 的处理(保留 vs 失效)。
3. **RiskClassifier 规则来源**:静态规则表 vs LLM 辅助分级 vs 两者结合(静态兜底)。
4. **Memory 写入触发**:何时由 `MemoryWriter` 提议持久化(任务结束?用户显式?LLM 判断?),以及"受控非静默"的具体 UX。
5. **事件总线**:领域事件是进程内同步分发,还是经一条总线供 UI/持久化订阅(影响 Electron 主进程↔渲染层的 IPC 设计)。
