# 现状盘点与路线规划

> 更新:2026-05-21 · 配套:[`design-discussion.md`](design-discussion.md) · [`domain-model.md`](domain-model.md) · [`tech-stack.md`](tech-stack.md)

## 一、已建成(可运行)

**骨架与工程**
- pnpm monorepo,9 个包对齐限界上下文;Electron + React + Tailwind;electron-vite 构建
- 全程 TypeScript;typecheck 全绿;ctx-task 有事件翻译单测

**对话与模型**
- 流式 chat:Markdown + GFM + 语法高亮;多轮上下文
- pi 接入:`pi-ai`→`infra`(Model Gateway);`pi-agent-core`→`ctx-task`(PiAgentAdapter ACL)
- BYO key 经 `.env`(当前 deepseek-v4-flash);模型调用在主进程

**领域与架构**
- domain-core:Task/Plan/Step/Action/RiskLevel + 领域事件 + Gatekeeper 端口(共享内核)
- ctx-task ACL:AgentEvent → 领域事件;助理文本与领域事件双通道分离
- 右侧工作区:实时动作卡片(执行中/完成/失败)

**能力(支撑域)**
- cap-filesystem:`list_dir`、`read_file`(只读)、`write_file`(可变更)

**信任(核心域)**
- ctx-trust:`createGatekeeper` —— 风险分级 → 策略 → 只读自动放行 / 需审批异步等待 / 拒绝拦截
- 审批 IPC 往返 + 卡片上的"待审批 + 同意/拒绝"UX;风险元数据归属各能力

**界面**
- macOS 隐藏标题栏 + 可拖拽顶栏 + 原生滚动条;实色不透底,跟随系统浅/深色

## 二、已知缺口 / 技术债

| 项 | 现状 | 影响 |
|----|------|------|
| **Reversibility** | ctx-reversibility 空壳 | write/删除无回滚,破坏性操作不敢开 |
| **Plan/Step 建模** | stepId 用 taskId 占位 | 动作平铺,无法按计划步骤分组 |
| **Personal Memory** | ctx-memory 空壳 | "个人"助理还没记忆 |
| **WebResearch / Browser** | cap-* 空壳 | 联网调研、登录态闭网未做 |
| **Keychain** | key 明文存 .env | 仅开发期可接受,正式版必须换 |
| **持久化** | session/记录在内存 | 重启即丢;SQLite 未启用 |
| **afterToolCall / transformContext** | 未接 | Reversibility 记账、Memory 召回、注入隔离的挂载点空着 |
| **打包分发** | 未做 | 无签名/公证/自动更新,装不出去 |
| **测试覆盖** | 仅事件翻译 | 守门人/能力/回滚均无测试 |

## 三、路线规划

### 阶段 A —— 把"安全文件整理"这条线打透(当前推进中)
1. **Reversibility(第 3 步)**:操作日志 journal + 软删除回收 + 撤销;接 `afterToolCall` 记账
2. **破坏性 fs 工具**:`delete`(软删)、`move`/`rename`(可变更);执行前 diff 预览整批审批
3. **Plan/Step 显式建模**:工作区按计划步骤分组,而非平铺动作

### 阶段 B —— 补齐"个人助理"的差异化
4. **Personal Memory**:本地、可见可编辑的偏好/事实;接 `transformContext` 召回
5. **WebResearch 能力**:搜索 API(Tavily/Exa)+ 抓取,调研→产出流水线的"输入"
6. **多 provider / 模型选择 UI**:网关已抽象,补前端切换

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
