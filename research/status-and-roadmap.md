# 现状盘点与路线规划

> 更新:2026-05-22 · 配套:[`design-discussion.md`](design-discussion.md) · [`domain-model.md`](domain-model.md) · [`tech-stack.md`](tech-stack.md) · [`prompt-cache-and-compaction.md`](prompt-cache-and-compaction.md)
>
> 对账说明(2026-05-22):上一版的缺口表严重滞后于代码——Reversibility、Plan/Step、Personal Memory、Keychain、持久化、钩子接线均已落地。本版按代码重新盘点;实现明细以根目录 `TODO.md` 为准。

## 一、已建成(可运行)

**骨架与工程**
- pnpm monorepo,包对齐限界上下文;Electron + React + Tailwind;electron-vite 构建
- 全程 TypeScript;typecheck 全绿;多包单测(ctx-task 事件翻译/恢复、ctx-reversibility journal、ctx-memory、infra stores、cap-document、desktop transcript 映射)

**对话与模型**
- 流式 chat:Markdown + GFM + 语法高亮;多轮上下文
- pi 接入:`pi-ai`→`infra`(Model Gateway);`pi-agent-core`→`ctx-task`(PiAgentAdapter ACL);`afterTool` + `contextProvider`(transformContext)钩子均已接
- BYO key 经 Electron `safeStorage` 加密落盘(`key-store.ts`,按 provider 索引);dev 仍 `.env`/env 兜底;模型调用在主进程
- Prompt cache:system prompt 字节冻结,动态环境走 `[session context]` 注入(详见 cache 文档)

**领域与架构**
- domain-core:Task/Plan/Step/Action/RiskLevel + 领域事件 + Gatekeeper 端口(共享内核)
- ctx-task ACL:AgentEvent → 领域事件;助理文本与领域事件双通道分离
- **Plan/Step 显式建模**:每 turn 惰性开 `StepId`,StepStarted/StepCompleted 生命周期,action 按 stepId 归组

**能力(支撑域)**
- cap-filesystem:`list_dir`/`read_file`/`find_files`/`grep_files`(只读)、`write_file`(可变更)、`plan_file_changes`(批量 move/delete,diff 预览 + 整批审批 + 批量回滚)
- cap-document:`extract_document`(文档提取)

**信任 / 可逆(核心域)**
- ctx-trust:`createGatekeeper` —— 风险分级 → 策略 → 只读自动放行 / 需审批异步等待 / 拒绝拦截;审批内联到对应 action 行(同意/拒绝)
- ctx-reversibility:`OperationJournal` + 按 capability 派发的 reverser(filesystem 已注册)+ `undoLast`;step 行内联「撤销」按钮

**记忆(核心域差异化)**
- ctx-memory:remember/update/forget/search 四工具 + 情景/修订/受控遗忘;混合召回(render 注入精简层 + search 拉历史);每 workspace 一份;UI 可见/可恢复

**持久化**
- WorkspaceStore + SessionStore;transcript JSON 单一事实源(喂 agent 恢复 + 重建 timeline);会话归档/恢复;每 workspace 隔离记忆

**界面**
- 三栏外壳(SessionList / ChatPane / ArtifactPanel);step 内联折叠;artifact 面板(批量 diff 自动弹 + 来源块「查看」结果);workspace 切换器;独立设置窗
- macOS 隐藏标题栏 + 可拖拽顶栏 + 原生滚动条;实色不透底,跟随系统浅/深色

## 二、已知缺口 / 技术债

| 项 | 现状 | 影响 |
|----|------|------|
| **WebResearch / Browser** | cap-browser 已落地(web_search/web_fetch,驱动自带 Chromium);cap-webresearch 仍空壳(已被浏览器方案取代,可清理) | 联网调研 v1 已做;待运行时验证选择器/登录态 |
| **多 provider UI** | 已决策**暂不做**:专注 deepseek | 非缺口;未来走"内置 deepseek + 登录开箱即用",非多 provider 切换 |
| **SQLite** | 现用文件 JSON 持久化(够用) | 数据量大或需查询时再考虑;非阻塞 |
| **打包分发** | 进行中(electron-builder/CI/签名雏形,见近期 commit) | 公证/自动更新通道待打通 |
| **空闲压缩** | pi 被动压缩;无空闲主动压(已决策暂缓) | 长会话 TTL 过期成本,优先级低(见 cache 文档 §5) |
| **测试覆盖** | 多包有单测,但守门人/审批 e2e、UI 交互未覆盖 | 回归靠 typecheck + 局部单测 |

## 三、路线规划

### 阶段 A —— 把"安全文件整理"这条线打透 ✅ 已完成
1. ~~**Reversibility**:操作日志 journal + 软删除回收 + 撤销;接 `afterTool` 记账~~ ✅
2. ~~**破坏性 fs 工具**:move/delete 经 `plan_file_changes`,执行前 diff 预览整批审批 + 批量回滚~~ ✅
3. ~~**Plan/Step 显式建模**:工作区/对话按 step 分组,而非平铺动作~~ ✅

### 阶段 B —— 补齐"个人助理"的差异化(当前推进中)
4. ~~**Personal Memory**:本地、可见可编辑的偏好/事实;接 `transformContext` 召回~~ ✅(情景+修订+受控遗忘已超额完成)
5. ~~**WebResearch 能力**~~ ✅ v1 已做(改用内置浏览器,非搜索 API):`cap-browser` 的 `web_search`/`web_fetch` 驱动 Electron 自带 Chromium(可见、persist 登录态);Bing 抓 SERP + 正文提取;结果走"来源块查看"。**待运行时验证**:Bing 选择器、可见窗体验、登录态留存。
6. ~~多 provider / 模型选择 UI~~ **暂不做**(2026-05-22 决策):专注 deepseek。未来方向是"内置 deepseek + 用户注册登录开箱即用"(无需 BYO key),与商业化路线(网关切服务器中转 + 订阅制)合流,而非多 provider 切换。

### 阶段 C —— 闭网与硬化
7. **BrowserSession 能力**:Playwright 内置 profile 登录态;注入隔离纵深防御
8. **Keychain + SQLite**:key 安全存储、session/journal 持久化
9. **打包分发**:Mac 代码签名 + 公证 + 自动更新

### 阶段 D —— V2
10. **主动自主**:后台自发起 / 定时 / 监控(durable-harness)
11. **商业化**:网关切服务器中转 + 订阅制

## 四、悬而未决(需产品决策)
- 团队规模 / 排期(决定是否砍范围)
- 公开调研是否并入搜索 API(与登录态浏览器两条路并存)
- Prompt injection 系统化防御方案
- 商业化时点
