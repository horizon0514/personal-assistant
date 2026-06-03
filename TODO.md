# TODO

## 设置界面重做:独立窗口 + 全局/workspace 二分(决策见 design-discussion.md「设置界面重做」节)

- [x] **第二渲染入口 + 窗口生命周期**:`settings.html` + `settings.tsx`;electron.vite 加 entry;`openSettings`(单实例/非模态/原生标题栏/720×520)+ `settings:open` IPC;`menu.ts` 装应用菜单含「设置… ⌘,」并保留 编辑/视图/窗口 角色。
- [x] **全局设置 store + 主题**:`app-settings.ts`(`userData/settings.json`);`nativeTheme.themeSource` 启动 apply + 切换(Tailwind media 策略,无需切 class);IPC `settings:getTheme/setTheme`;底色同步改单一全局监听。
- [x] **记忆 IPC 按 wsId 参数化**:四通道加 wsId;`memory:changed` 带 wsId;MemoryList 接 `workspaceId` prop,onChanged 按所选过滤。
- [x] **设置窗 IA**:左分组 sidebar(应用:模型/通用/关于 · 工作空间[选择器]:记忆/偏好)+ 右详情;`ThemePanel`(浅/深/系统)、`About`(版本,`app:version` IPC);复用 `ApiKeySection`、`MemoryList(wsId)`;偏好占位。
- [x] **退役旧模态**:删 `SettingsPanel` + store `settingsOpen/setSettingsOpen`;`WorkspaceSwitcher` 设置项改调 `window.pa.settings.open()`。

## 拟人记忆:情景 + 修订 + 受控遗忘(决策见 design-discussion.md「拟人记忆」节)

- [x] **schema 升级 + 迁移**:`MemoryItem` 加 `episode/revisions/status/forgottenReason/updatedAt`;`normalize()` 兼容旧记录(enabled→status)。6 测试。
- [x] **agent 工具 ×4**:remember(situation 必填,quote 可选)/update_memory/forget_memory/search_memory;`memoryToolNames` 供能力表+风险表。
- [x] **sourceSessionId 自动填**:`buildAdapter(sessionId)` → `getSourceSessionId` 绑定该会话。
- [x] **混合召回**:`render()` 注入 `- [id] content`;情景/历史靠 search_memory。
- [x] **reconsolidation guidelines**:"先巩固再新增"(矛盾/细化→update、过时→forget)。
- [x] **写入可见+可逆**:记忆工具全 ReadOnly 自动放行(不审批),onChange 刷新列表。
- [x] **UI(中等档)**:content+kind+situation+遗忘(软删)/恢复;原话/修改历史可展开;底部弱化"已遗忘"折叠区做误忘兜底。不做跳转源会话、行内编辑。
- [x] **IPC/preload**:`memory:list`(active,含新字段)、`memory:listForgotten`、`memory:remove`(软删)、`memory:restore`;MemoryView 加 revisions 供 UI 展开。
- 暂不做(已决策):自动衰退/TTL、相关性筛选注入、显式权重。

## 交互改版:Workspace + 三栏布局 + Step 内联(决策见 research/design-discussion.md)

### 阶段 1 · 前端交互骨架(已完成,对账于 2026-05-22)

> 实际实现进度领先于本清单,核对代码后统一勾选;两条按更优方案落地,见备注。

- [x] **四栏外壳**:`App.tsx` 三栏 `[SessionList] [ChatPane] [ArtifactPanel?]`,旧 50/50 已移除。
- [x] **SessionList**:`features/session/SessionList.tsx`,当前 workspace 会话列表,可折叠。
- [x] **WorkspaceSwitcher**:`features/session/WorkspaceSwitcher.tsx`,左下角弹出式切换器 + 设置入口。
- [x] **红绿灯留白**:折叠态 `pl-[78px]` 让出 macOS 红绿灯(`App.tsx`)。
- [x] **step 内联**:`StepTrace` 按 stepId 归组内联进 `ChatPane`(`upsertAction`/`patchAction`),审批/撤销内联到对应 action 行。
- [x] **审批 UI(改为内联,取代 ApprovalBanner)**:未做"输入框下常驻横幅";`approval.onRequest` → 把对应 action 切 `awaiting` 态,同意/拒绝按钮内联在该 action 行。更贴合 step 内联,横幅方案作废。
- [x] **退役 WorkspacePanel**:`features/workspace/` 已不存在。
- [x] **ArtifactPanel**:`features/artifact/ArtifactPanel.tsx`,默认折叠(无内容返回 null)、一次一个。
- [x] **来源块重开**(2026-05-22):可查看工具(read_file/extract_document/list_dir/find_files/grep_files)的结果文本经新 `step:result` 通道(live)/ `transcriptToTimeline` 回填(重开会话)挂到 step 行;`StepTrace` 完成行显示「查看」→ `openArtifact({kind:"text"})` 在右侧面板展示。打通了此前无调用方的 `openArtifact`。
- [x] **批量 diff 自动弹出**:`shell/store.tsx` 订阅 `batch.onRequest` → 自动开 ArtifactPanel 显示 `BatchView`(全部同意/拒绝)。
- [x] **Workspace(改为真实 IPC,取代 mock)**:阶段 2 已落地 `WorkspaceStore` + IPC,无需 mock。
- [x] **设置面板**:`features/settings/SettingsApp.tsx` 独立设置窗,`MemoryList` 移入 workspace 设置。

### 阶段 2 · 数据层与迁移

- [x] **会话持久化**:`infra` 新增 WorkspaceStore + SessionStore。**transcript JSON 单一事实源**(JSONL 方案作废)—— 既喂 agent 恢复,又由主进程 `transcriptToTimeline` 映射重建 timeline。
- [x] **完整恢复**:`PiAgentAdapter` 加 `initialMessages` 播种 + `snapshotTranscript()`;主进程按 session 管理 adapter 注册表,切回会话 agent 带记忆接着聊。
- [x] **记忆 workspace 化**:每 workspace 一份 `MemoryStore`(`<wsId>/memory.json`),记忆 IPC 走当前 workspace。
- [x] **workspace 实体落地**:`WorkspaceStore` + IPC(list/active/create/switch),渲染层 store 改真实 IPC,移除 mock。
- [x] **迁移**:`workspaces.ensureDefault()` + 旧 `userData/memory.json` 并入默认 workspace。
- [x] **全包 typecheck + build** 通过。

#### 阶段 2 收尾
- [x] **会话删除 UI**:SessionList 每行 hover 出 🗑,调 `session:remove`,删当前会话则清空对话。
- [x] **transcript 文件清理**:`SessionStore.remove` 同时 `rmSync` transcript `.json`。
- [x] **workspace 创建/重命名 UI**:切换器弹层加「新建工作空间」「重命名当前」内联输入;补 `workspace:rename` IPC/preload/facade。
- [x] **sidebar 宽度/折叠持久化**:存 localStorage(`pa.sidebarWidth` / `pa.sidebarCollapsed`)。
- [x] **BYO key → safeStorage**(原阶段 C):主进程 `key-store.ts` 用 Electron `safeStorage` 加密落盘 `userData/secrets.json`(全局单份,按 provider 索引);resolver 优先取存储 key,dev 仍 `.env`/env 兜底;`SettingsPanel` 加全局 API Key 区(密文输入、显示末 4 位、更换/清除);IPC/preload `secret:*` 通道。
- [x] **会话归档(非删除)**:`SessionStore` 加 `archived` 标记 + `setArchived`/`listArchived`;`list` 过滤归档;UI 🗑→📦 归档(从列表隐藏,transcript 保留)。`session:archive` 通道。
- [x] **workspace 删除 + 二次确认**:`WorkspaceStore.remove`(级联清子树、拒删最后一个);切换器内联"删除「X」?确认/取消";删当前自动切到剩余。
- [x] **updatedAt 单调递增**:`SessionStore.tick()` 修同毫秒排序不确定。
- [ ] **未配置 key 引导**:暂不做 —— 默认内置 LLM 后端,未来做登录(决策 2026-05-21)。
- [x] **已归档会话查看/恢复 UI**(2026-05-22):补全 facade `listArchivedSessions`/`unarchiveSession` + IPC `session:listArchived`/`session:unarchive` + preload;`ArchivedSessions.tsx` 挂在 SessionList 底部(可展开「已归档 (N)」,空则不显示,每行恢复按钮);恢复广播 `session:changed` 刷新活跃列表。
- [ ] ~~**BYO key 多 provider**~~:**不做**(2026-05-22)——专注 deepseek,未来走"内置 + 注册登录开箱即用",非多 provider。KeyStore 仍按 provider 索引备用。

## 领域模型待细化(来自 research/domain-model.md 第 5 节)

- [ ] **Action 聚合归属** —— 是否将 Action 从"跨上下文概念"提升为独立聚合(执行记录/审批/日志各自引用)。
- [ ] **Plan 修订语义** —— `PlanRevised` 时,已执行 Step/Action 如何处理(保留 vs 失效)。⭐ 影响执行编排正确性
- [ ] **RiskClassifier 规则来源** —— 静态规则表 vs LLM 辅助分级 vs 两者结合(静态兜底)。⭐ 影响安全正确性
- [x] **Memory 写入触发** —— 已定:增/改/忘由 agent 工具(remember/update_memory/forget_memory)触发,自动执行 + 可见(对话内动作 + 列表刷新)+ 可逆(软删),不审批。详见 design-discussion.md「拟人记忆」。
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
- [x] **extract_document**:新建 `@pa/cap-document`(PDF via pdf-parse + 纯文本类),ReadOnly 自动放行;`Capability` union 加 `document`;`capabilityOf` 改为工具名→能力注册表(为多能力铺路);system-prompt 注入 documentGuidelines。**图片 OCR / docx 留后续。**
- [x] **破坏性 fs 工具**:delete(软删到回收区)/ move_file(移动/重命名),均可回滚。
- [x] **执行前 diff 预览整批审批**:plan_file_changes 工具一次性提交全部 move/delete,UI 整批预览+同意/拒绝,批准后原子执行+批量回滚日志。**阶段 A 完成。**

## 浏览器运行时验证(代码 typecheck 绿,但选择器/登录态/自动化的真实页面假设未验证)

> 拿真实网站跑一遍,把"靠假设、没被线上验证"的脆点揪出来修。能编译 ≠ 选择器能匹配真实 DOM。

- [ ] **搜索 SERP 选择器**(最脆):`web_search` 硬编码扒 Bing(`#b_results > li.b_algo` / `h2 a` / `.b_caption p`)。验证不同关键词/地区/语言下能否稳定抓到结果;改版或返回异构结构时的退化行为。
- [ ] **正文提取**:`web_fetch` 的 `article`/`main`/`body` 兜底在 SPA、瀑布流、重 JS 站点上的效果(噪音/空白)。
- [ ] **自动化选择器 + 坐标点击**:`browser_click`/`browser_type` 在 iframe 内元素、shadow DOM、被遮挡/动画中元素上的命中率(坐标点击会点偏)。目前只在百度试过。
- [ ] **登录态留存**:`partition:"persist:research"` 声称 cookie 跨重启留存——重启 app 后是否仍登录(拿需登录的站实测)。
- [ ] **可见窗 + 中断**:停止运行(abort)能否干净打断导航;虚拟光标在各类页面渲染是否正常。
- [ ] 顺带:删除被浏览器方案取代的空壳包 `cap-webresearch`。

## 记忆与检索演进(按需再做,勿过早)

- [ ] **记忆 TTL / 衰减**:给记忆加有效期字段。"中期记忆"=会过期的记忆(如"最近在做项目 X");"长期"=不过期。不单独搞短/中/长三层架构(短期已由 pi 的对话上下文+compaction 覆盖)。决策:分层是存储分类法,不解决"写什么/何时召回/何时遗忘",过早引入是负担。
- [ ] **相关性召回**:记忆/文件变多时,按相关性挑选注入,而非全量塞 prompt。
- [ ] **采用 agentic search(grep)而非向量 RAG**:让 agent 用搜索工具(grep/glob)按需查找,而不是预建向量索引。理由:本地文件常变(索引易失效)、需要精确匹配(符号/字符串)、模型可多步推理"去哪找"、零索引基建。先加 filesystem 搜索能力(content grep + 文件名 glob);记忆召回同理用 search_memory(关键词)。真正需要语义相似度时再考虑 embedding,但不预先上 RAG。

## Notebook(来源集 / NotebookLM 式问答)— 设计见 [`research/notebook-design.md`](research/notebook-design.md)

> 定位:把"读完即弃"升级成"对一组资料持续问答、带引用"。**复用 agentic 检索,不上向量**(是上条决策的延伸,非例外);落在 status §5 #5「调研→产出」的输入侧。Notebook 对标 Personal Memory(本地、可见可恢复、每 workspace 一份),非无状态 Capability。

- [x] **M0 接地抽取**:`cap-document` 加结构化抽取,导出可复用 `extractDocument()`(保逐页 `PageText[]`,数字版用 `pages[].text`、扫描件逐页 OCR);`extract_document` 扁平输出对多页 PDF 加「第 N 页」锚 → 引用接地的地基。(2026-06-03)
- [ ] **M1 Notebook 领域+持久化**:新 `packages/ctx-notebook`,manifest + 逐页文本缓存(抽过即存,免重跑 OCR),每 workspace 一份;`notebook_add_source`/`list`/`remove`(增删=本地 manifest,可见可逆,软删留痕)。
- [ ] **M2 范围问答+引用**:`notebook_search`(缓存文本关键词检索,回 `来源:页:片段`)+ `notebook_read_source`;接地约束进 `notebookGuidelines`(只基于来源、每论断标 `[来源, p.X]`、找不到就说找不到);独立 evaluator 加"每论断须有来源支撑"验收。**现有聊天框即可端到端**。
- [ ] **M3 UI**:Notebook 视图(来源列表 + 问答区 + 引用跳回原文),复用三栏 + ArtifactPanel。
- [ ] **M4(以后/可选)**:关键词搜不动、需语义相似时再上 embedding —— 严守"按需再做"。

## 跨对话记忆 / 人感(本轮 2026-06-01;详见 memory `cross-conversation-memory`)

> 已落地:第1层 滚动会话摘要(意图+决策,离开蒸馏,注入「近期线索」带相对时间戳)、第3层 search_history(历史 transcript 关键词检索)、第2层 主动记忆形成(扩 remember + 会话收尾保守沉淀)、客户端重启补跑(digestedAt/needingDigest 懒触发)、skill 热加载认知纠正(告诉模型可自建 skill)。

- [x] **撤掉 `[browser-activity]` 诊断日志**(2026-06-02):已全撤(`logAct`/`callerStack` 及各工具入口调用),保留 `read_current_page` 没页面不拉空面板的功能修复。
- [ ] **同步 memory `cross-conversation-memory`**:把本轮进展补进那条记忆——第1/3/2 层均已落地、客户端重启懒触发补跑已实现、skill 热加载认知已纠正;capstone 第4层 dream 仍待攒料。

> 第4层 dream(离线消化/反思,自我进化引擎)的设计已记在 memory `cross-conversation-memory`,攒够真实会话/反馈后再启动,此处不重列。

## Agent harness 行为(自建 harness 时打磨)

> 启示与优先级见 [`research/agent-design-insights.md`](research/agent-design-insights.md)(对照 Anthropic 两篇工程文章)。建议落地顺序:trace → 子 Agent → 独立 evaluator + Sprint Contract → context reset → ACI 错误引导。

- [ ] **P1 · 可观测(读 trace)**:轻量 trace 日志(每轮 token 数、压缩触发、工具调用序列、记忆写次数),解锁一批"靠假设"的 deferred 决策(记忆头部注入、history 常态长度、记忆写频率)。见 insights §5。
  - 首步已落地(2026-06-02):**验收 telemetry** —— 每轮验收(评/不评 + 触发原因 + pass/blockers + 耗时 + verdict 原文)追加落盘 `userData/eval-telemetry.jsonl`(`apps/desktop/src/main/eval-telemetry.ts`;适配器经 `onEvalTelemetry` 出口)。先攒数据评估验收门松紧/成本,再扩到 token/压缩等全量 trace。
- [ ] **P1 · 子 Agent(orchestrator-workers)**:浏览器/文档多步调研在隔离 worker 里跑,只把结论交回主线 —— 一次解决主 history 污染 + 工具 schema 膨胀 + context anxiety 三件事。`cap-browser`/「调研→产出」是首个用例。见 insights §2、prompt-cache §4.4/§5 P2(从 P2 提到 P1)。
- [x] **独立 evaluator(非同体自评)+ 自动返工**(已落地):执行器跑完一个**调过工具**的任务后,由**独立、干净上下文**的 evaluator(只读工具子集 + `submit_verdict`)对照目标核查产出;不通过则把问题清单回灌执行器自动返工(evaluator-optimizer 闭环,默认最多 1 轮)。端口 `Evaluator`/`Verdict` 在 domain-core;实现 `createPiEvaluator` 在 ctx-task(起第二个 pi Agent);组合根 `agent.ts` 注入;ChatPane 显示验收结论(不持久化)。⚠️ `harness-design` 警告"自评必然过度自信",故刻意换独立 agent。见 insights §1。
  - 改进(2026-06-02):**①验收门重挂载** —— 触发从"调过任何工具"(`sawTool`,既误报纯只读/聊天、又对纯聊错答漏报)改为「**本轮改了真实状态 ∥ 有确认过的契约**」(`hadPlan || sawMutation`),只在有可独立复核的客观靶子时才验,直接掐掉"答得没问题却被挑刺返工"的噪声源(`isMutatingTool` 在 `agent.ts`,按静态风险非 ReadOnly + exec_shell 按命令分级)。**②verdict 结构化** —— `submit_verdict` 由 `{pass,issues}` 拆成 `blockers[](须附证据)`/`suggestions[](永不返工)`,pass 由 `blockers.length===0` 算出,把"可优化≠硬伤"从 prompt 软约束变成数据结构硬约束。**③telemetry 落盘**(见上 P1 可观测)。
  - 暂未做:把 Verdict 持久化到 transcript;评估器跨返工轮只看到本轮 actionLog(非全程累积);返工耗尽 retry 后仍不过会静默发车(无终态"仍未通过"提示)。
- [x] **Sprint Contract(动手前签约)+ 可评分标准**(已落地):执行器对**多步/有交付物**的开放任务,动手前调 `propose_contract` 起草「交付物 + 可核查验收标准」→ 用户内联确认/微调(可编辑卡)→ 锁定;确认后的契约既约束执行器,又作为 evaluator 的**逐条验收清单**。`SprintContract` 在 domain-core;`createContractTool` 在 ctx-task;`agent.ts` 经 `contract:request`/`resolve` 桥接确认卡 + 每会话存契约喂评估器;ChatPane `ContractCard`。触发=执行器自行判断(system prompt 软约束)。见 insights §4。
  - 触发强化(2026-06-02):system prompt 的「开工对齐」段从"适用于…"改成「命中即先 propose_plan」清单(产出报告/清单/表格/对比/文案,或多步且交付形态不明),让"调研→产出"类任务更可靠地先签约——这条契约现在也是验收门的触发条件之一,漏签会导致该验的不验。**刻意不上会阻塞执行、强弹确认卡的硬分类器**(反向骚扰风险 + 没数据定阈值),等 eval-telemetry 显示 plan 漏触发严重再说。
  - 暂未做:契约持久化(刷新会话后卡片不留,仅 tool 调用在 transcript)、grading criteria 的加权打分(现为 criteria 逐条 pass/fail)。
- [ ] **context reset(配合阶段 D durable-harness)**:长/后台任务用"做完→把结论写进 memory/journal→开干净 agent 接下一段"的结构化重置,绕开压缩消不掉的 context anxiety。见 insights §3、status-and-roadmap 阶段 D #10。
- [ ] **工具能力兜底 + ACI 错误引导**:能力缺口会让 agent 兜圈(如曾经的"无法建目录")。受限 shell(高风险强制审批)是一条路;更便宜的一招是**让现有工具失败时返回引导性错误**(如 write_file 到不存在目录 → 提示"父目录不存在,可用 X")。见 insights §6。
- [ ] **空闲压缩(暂缓,先做交互+功能)**:pi 现在只在快撑满时被动压缩(`shouldCompact` = `contextTokens > contextWindow - 16384`),且压缩走独立 summarization call(命中 0%)。文章决策 5 的优化是「用户停手/失焦时趁 cache 还热主动压」,避免长会话 TTL 过期后整段 history 全量 cold。**决策(2026-05-22):暂不做,先把交互和功能做扎实。** 启动前先确认 `pi-agent-core` 是否暴露手动 `compact()` 入口。背景见 [`research/prompt-cache-and-compaction.md`](research/prompt-cache-and-compaction.md) §2/§5。

## 范围/产品

- [ ] 团队规模与排期确定后,复审 V1 范围,大概率砍"破坏性文件操作"。
- [ ] 公开网页调研是否并入搜索 API(Tavily/Exa),与登录态浏览器两条路并存。
- [x] ~~Prompt injection 纵深防御的系统化设计~~ ✅ 已落地(domain-core markUntrusted/detectInjection + 信任边界条款 + InjectionSuspected;见 status-and-roadmap §1)。
- [ ] **开箱即用 = 干掉 BYO Key**(最大采用拐点):内置 deepseek + 注册登录,与商业化(后端/登录/计费)合流。**已认领,与分发后续统一做。**
- [ ] Mac 代码签名 + 公证;Electron 自动更新通道。**已认领,与开箱即用统一做。**
- [ ] 商业化(BYO 先免费验证 → 网关层切订阅制)。
- [ ] **沙箱(执行隔离)**:给 agent 操作划硬边界(scoped 目录/禁系统文件/受限 shell 在隔离环境跑),信任从软约束推进到硬隔离。见 status-and-roadmap 阶段 D #12。
- [ ] **IM 集成(优先飞书/Lark)**:(a) 读/总结/起草/发消息;(b) IM 作触发通道,从手机/IM 派活拿到移动性 + 主动推送。见 status-and-roadmap 阶段 D #13。

> 产品视角的成败关键与排序见 [`research/status-and-roadmap.md`](research/status-and-roadmap.md) §5。
