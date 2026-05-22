# Personal Assistant — 设计讨论纪要

> 一个面向知识工作者/白领的、去终端化的本地电脑助理。
> 本文记录 grill 式访谈得出的设计决策、取舍理由,以及尚未敲定的开放问题。
> 日期:2026-05-21

---

## 1. 定位

- 面向 **知识工作者 / 白领(非开发者)** 的 **去终端化本地电脑助理**。
- **Chat 为入口**,底层是能**自主多步执行**的 agent。
- **差异化**:本地操作 + 登录态闭网访问 + 个人记忆 —— 而非又一个面向开发者的 CLI agent(避开 codex / Claude Code / Cursor 的正面战场)。
- 核心场景:**本地电脑操作型 agent**(读写文件、跑命令、操作应用),而非数字办公套壳或云服务。

## 2. 自主性(分阶段)

| 阶段 | 自主度 | 说明 |
|------|--------|------|
| V1 | **被动自主** | 用户接令后,agent 自己拆解、调工具、多步跑完,遇不确定才回来问(类 codex / Claude Code) |
| V2 | **主动自主** | 后台常驻、自发起任务、定时触发、监控状态 |

理由:一个会自己动用户电脑的程序信任成本极高,先把被动自主打牢、风险可控,再上主动触发。

## 3. 技术栈

- **Electron**
  - 渲染层 = Chat + 结构化计划/工作区面板
  - 主 / Node 进程跑 agent
  - UI 三平台通吃;**操作层先只深做 Mac**
- **pi(`earendil-works/pi`,TypeScript,MIT)**
  - `pi-agent-core`:agent loop / 上下文压缩(compaction)/ 会话持久化(session)/ hooks
  - `pi-ai`:统一多 provider(OpenAI / Anthropic / Google)
  - **结论:自建 harness 降级为「在 pi 上扩展」**,省去 2–3 个月重造轮子;比 Vercel AI SDK 强一个量级(后者没有 compaction / session / 审批 hook)
- **工具层纯 Node**(文件 / 文档 / 浏览器)
- **V1 不引入 Rust**;留到将来做 OS 级原生应用控制(Mac Accessibility/AppleScript 等)时再引入
  - 关键认知:Rust 只统一「用一种语言在干净边界后写三套 OS 实现」,**不消除 OS 差异**

团队背景:**前端为主,Rust 少数** → 全程 TS 最贴合分工。

## 4. 模型 / 后端

- **BYO Key + 客户端直连**,零自建后端(先验证产品价值,不烧 token 成本)
- 模型调用抽象成 **「网关层」**:将来可切「服务器中转 + 订阅制」而不返工
- 不走自建推理后端、不走本地开源模型优先(能力跟不上复杂 agent 任务)

## 5. V1 能力范围

1. **联网调研**(机制见开放问题 #2)
2. 本地文档 **读取** 与 **新建产出**(文档 / 表格)
3. 本地文件 **整理**:改名 / 移动 / 删除现有文件(**破坏性操作**)
4. **登录态浏览器** 访问闭网内容(Gmail / 内部系统 / 付费订阅等)
   - Playwright + **App 内置专用 profile**(本地持久登录,cookie 不出本机)
   - **不劫持**用户真实 Chrome,不走浏览器扩展

> 注:范围已偏大。一旦排期确定,大概率要砍 #3(破坏性文件操作),退回低危的「调研 → 产出」先上线。

## 6. 安全 / 信任(入场券,非加分项)

- **建议-审批 + 分级权限**,挂在 pi 的 `beforeToolCall` hook 上
- 只读操作自动跑;副作用操作弹审批(可「本会话按类放行」)
- **文件整理回滚机制**:执行前整批 **diff 预览 → 审批 → 可逆 journal + 软删除(进回收区,不硬删)**
  - 明确不用 git(对非开发者是天书,大媒体库会爆)
  - 明确不用全量复制备份(磁盘爆炸)
- **浏览器**:任何**改状态动作(发送 / 购买 / 删除 / 发帖)强制审批**;只读也要防 prompt injection

## 7. 记忆 / 个性化(与 codex 的分水岭)

- V1 **轻量持久记忆**:只存「用户偏好 + 关键事实」(归档规则、常调研领域、产出格式偏好),不存全部对话历史
- **纯本地存储**(配合 pi 的 session / skills),**不上云** → 隐私卖点
- 记忆 **可见可编辑**:用户能看到「助理记住了什么」并删除,避免黑箱

## 8. 交互形态

- **Chat 为主入口 + 结构化「计划 / 工作区」面板**
- 面板用于:
  - agent 拆解的计划步骤(可勾选审批)
  - 文件操作的 diff 式预览(改名前后 / 移动去向)
  - 调研结果带来源卡片
  - 浏览器操作的实时画面 / 动作日志
- 目的:让「它要干什么」始终可见可控,而非埋在聊天气泡里(非开发者信任 UX 的成败所在)

---

## 开放问题(尚未敲定,建议尽快定)

1. **团队 / 排期**(用户暂搁置)—— 最大风险。当前 V1 同时含「破坏性文件操作」与「登录态浏览器自动化」两块高危高耗能力,排期定下后大概率要砍其一。
2. **公开网页调研机制** —— 登录态走无头浏览器没问题,但公开信息调研用无头浏览器又慢又脆。建议:**登录态走浏览器 + 公开调研另配搜索 API(Tavily/Exa)**,两条路并存。此点未最终敲定。
3. **Prompt injection 纵深防御** —— 「改状态强制审批」只是底线。登录态浏览器读到的网页内容会进上下文,需系统化隔离 / 标注(区分「可信指令」与「网页数据」)。
4. **分发工程** —— Mac **代码签名 + 公证**、Electron **自动更新** 通道。一个要操作本机的可信应用,这些是装得上、敢装的前提。
5. **商业化** —— 暂搁置(BYO 先免费验证),网关层已为将来订阅制留好口子。

---

## 交互改版:Workspace + 三栏布局 + Step 内联(2026-05-21 追加)

> 第二轮 grill 访谈。起因:原布局「左对话 / 右 step 列表」存在三个问题 —— 缺 workspace 概念、布局未分层、step 与对话叙事重复。

### 数据模型层级

- 确立层级 **`workspace → session → step`**。
- **workspace = 逻辑命名空间**(记忆 + 偏好 + 会话 + 信任策略),**不强绑文件目录**。本产品操作范围是整台机器,强绑单目录反而限制能力;文件根目录最多作为新任务的**可选默认起始目录**。
- **命名冲突已解决**:原 `features/workspace`(步骤/动作可视化面板)让出 "workspace" 一词 —— 该面板概念**并入对话**,不再独立存在。

### 布局(四栏,右栏按需)

```
┌──────────┬──────────────────┬─────────────┐
│ session  │                  │             │
│ 列表      │   对话(占满)      │  artifact   │
│(当前ws)   │                  │ (默认折叠)   │
│          │  ┌────────────┐  │  批量diff   │
│          │  │  输入框     │  │  自动弹出    │
│ ┌──────┐ │  ├────────────┤  │  其余手动    │
│ │设置+ │ │  │审批常驻横幅 │  │  一次一个    │
│ │ws切换│ │  └────────────┘  │  无tab历史   │
│ └──────┘ │                  │             │
└──────────┴──────────────────┴─────────────┘
```

- **session 列表**:可折叠,只显当前 workspace 的会话(切 ws 换一批)。
- **左下角**:弹出式 workspace 切换器 + 设置入口(不另起 Slack 式图标竖栏,避免第五栏)。
- **记忆 + 偏好**:收进 workspace 设置,平时不占主界面(呼应 workspace = 命名空间)。
- macOS 红绿灯位移到 session 栏顶,`pl-20` 留白需重新分配(实现细节)。

### 对话 / step / 审批

- **step 并入对话流**:工具调用、状态(running/awaiting/done/failed)、撤销 → 行内可折叠块。不再有独立 step 列表。消除「对话 + step」两套叙事的重复。
- **审批 → 输入框下方常驻横幅**:决策点离用户操作最近,且不会随对话滚走错过。
- **批量 diff**:审批横幅出现的同时,右侧 artifact **自动弹出**铺开 diff(不看就批准太危险);其余 artifact 手动点开。

### artifact 面板

- 默认折叠,对话占满整宽(居中可读栏 ≈720px),不留空面板。
- 一次一个,从对话内来源块可重新点开,**无常驻 tab 历史**(过早的复杂度)。
- 内容:批量 diff、文件内容、文档产出、调研结果、登录态浏览器画面等。

### 持久化与迁移(隐含硬前提,现状不存在)

- **会话未持久化**:现 `ChatPane` 消息仅在组件 state,刷新即没。session 列表要求会话能存/列/切。
- **恢复语义 = 完整恢复**:切回旧会话时 agent **带记忆接着聊**,不只是只读回放。pi 的 `Agent` 原生支持(`initialState.messages` 播种 + `state.messages` 快照)。代价:主进程按 session 管理多个 agent 实例(session 注册表),不再是单一全局 adapter。
- **存储 = transcript JSON 单一事实源**(修正:原 JSONL 方案作废)。既然能拿到完整 `AgentMessage[]`,它**同时**喂 agent 恢复 + 由渲染层映射重建 timeline(assistant 文本→气泡、一个 turn 内工具调用→step 块),无需再单独维护一份 JSONL UI 轨迹(否则双份事实源)。
  - 方案:`packages/infra` 新增 WorkspaceStore + SessionStore。transcript 对 infra 是不透明 JSON(类型 `AgentMessage` 属 pi,不外泄到 infra)。
- **`ctx-memory` 加 workspace 作用域**(按 workspace 分目录存 `memory.json`),老数据迁移。
- 升级建**默认 workspace** 兜底,把现有全局 `memory.json` 并入。

落地目录:
```
<userData>/workspaces/
  index.json                 # workspace 列表 + 元数据
  <wsId>/
    memory.json              # 该 ws 的记忆
    sessions/
      index.json             # 会话索引(标题/时间/排序)
      <sessionId>.json       # 该会话 transcript(AgentMessage[])
```

### 实施顺序

1. **先搭前端骨架**验证交互:会话存内存、workspace mock 1~2 个,跑通布局 / 内联 step / 审批横幅 / artifact 弹出的手感。
2. **再补数据层**:会话持久化 → 记忆 workspace 化 → 迁移。先 UI 后数据,避免一上来动数据层卡住手感验证。

---

## 拟人记忆:情景 + 修订 + 受控遗忘(2026-05-21 追加)

> 第三轮 grill。起因:现 `ctx-memory` 太简单 —— agent 只能 add 不能 delete/update,且记忆是一句蒸馏 content,丢了"何时/何地/为何记"的原始情景。目标:按人类记忆(情景 episodic + 语义 semantic + 巩固 reconsolidation)重塑。正好补回领域模型 3.5 早已定义、却被实现砍掉的 `source` / `MemoryEdited` / `MemoryDeleted` / `MemoryRecaller`。

### 记录结构

```
MemoryItem {
  id, kind: preference|fact
  content                    // 蒸馏的事实/偏好(语义层)
  episode {                  // 情景层(选「中等」档)
    situation                // agent 写的"当时在做什么"
    quote?                   // 触发的原话
    sourceSessionId?         // 链接源会话(主进程自动填;UI 暂不消费)
  }
  revisions[] { prevContent, reason, at }   // 修改历史
  status: active|forgotten   // 软遗忘(复活原 enabled 字段)
  createdAt, updatedAt
}
```

- **情景档位 = 中等**:situation + quote + sourceSessionId。不做 `where` 等结构化环境字段(本地助理"地点"≈某目录/任务,situation 一句已涵盖,过早结构化是负担)。
- **修改历史 = 完整 append-only「存」+ 精简「用」**:存全程 revisions(JSON 便宜、符合"可检视"不变量);注入 prompt / UI 默认只露 当前值 + 最近一次"从 X 改成 Y 因为 Z"。

### 遗忘(分两步)

- **现在做受控软遗忘**:`forget_memory(id, reason)` + UI 删除,**都软删**(status=forgotten、记原因、可恢复、有"已遗忘"区)。理由:解决"只能加不能删";软删保痕迹符合可检视;像人类——忘≠擦除。
- **自动衰退 / TTL 推迟**:对工具而言"悄悄忘了你的归档目录"是灾难且极难调;等真有记忆爆炸、摸清使用模式再说。

### 召回(混合)

- 平时**只自动注入精简语义层**(每条 content 一行,**带短 id** 供 agent 引用),保证基线意识。
- 情景 / 修改历史 / 原话 **不进 prompt**,经 `search_memory(query)` 懒加载。
- 相关性筛选注入**先不做**(N 小全量精简 content 即可);需要时用**隐式显著性**(kind / recency / revision 次数)而非显式权重。

### agent 工具面(4)

- `remember(kind, content, situation, quote?)` — 新增(sourceSessionId 主进程自动填)
- `update_memory(id, newContent, reason)` — 修订(追加 revision)
- `forget_memory(id, reason)` — 软遗忘
- `search_memory(query)` — 拉全貌
- **guidelines 强约束**:新信息与某条已有记忆矛盾/细化 → `update_memory` 改它(reconsolidation),只有全新事实才 `remember`;过时才 `forget`。避免堆矛盾条目。

### 写入控制 & 权重

- 增/改/忘 **自动执行 + 可见 + 可逆**(对话内显示为动作 + 记忆列表实时更新),不弹审批。可见性+可逆性即安全网。
- **权重不做**:其消费者(相关性召回、衰退)均已推迟,加了就是没人读的字段;且无 decay 配套等于半套机制。

### UI(中等档)

- 每条:content + kind + situation + 遗忘/恢复 + "已遗忘"区。
- **可展开**看完整情景(quote)+ 修改历史。兑现"可检视"不变量。
- **不做**:跳转源会话(跨界面导航,先存 sourceSessionId 不消费)、用户行内编辑(涉及"手改算不算 revision",后补)。

### 迁移

旧 `MemoryItem`(无 episode/revisions/status)→ 加载时补:空 episode、status=active、revisions=[]。

---

## 设置界面重做:独立窗口 + 全局/workspace 二分(2026-05-21 追加)

> 第四轮 grill。起因:设置现为主窗口内嵌模态,想更 native(独立 BrowserWindow);信息架构要区分「全局/应用设置」与「workspace 设置(记忆/偏好)」。

### 架构

- **独立 BrowserWindow + 独立 HTML 入口**(`settings.html` + `settings.tsx`,单独 React root)。共享 preload(`window.pa`),所有 IPC 通用。不与主应用 bundle 耦合。
- 设置窗是独立 React root,**无 ShellProvider**;靠 `window.pa.workspace.active()/list()` 直接拿状态。

### 信息架构(macOS 原生:左分组 sidebar + 右详情)

```
应用
  模型 / API Key      (全局)
  通用 (主题)         (全局)
  关于 (版本)         (全局)
─────────────
工作空间 [个人 ▾]      ← 组头带 workspace 选择器
  记忆                (按 wsId)
  偏好 (占位)         (按 wsId)
```

- **workspace 设置自选 workspace、不跟随主窗口**(跟随易漂移)。→ 记忆 IPC **按 wsId 参数化**。

### 主题(通用面板的真实内容)

- 三选项 **浅色 / 深色 / 跟随系统**(默认跟随)。经 **`nativeTheme.themeSource`** 驱动(自动作用于所有窗口的 `prefers-color-scheme` + 窗口底色,契合现有 CSS 媒体查询)。
- 存**全局** `userData/settings.json`(复用 infra readJson/writeJson);启动时读出应用。

### 窗口行为

单实例(已开则聚焦) · 非模态(不锁主窗) · `⌘,` 打开 · **普通原生标题栏**(不无边框,像系统设置) · 固定 720×520 · 关闭仅关窗。

### 接线 & 退役

- 打开:切换器"设置"项 + `⌘,` → `window.pa.settings.open()` IPC → 主进程建/聚焦设置窗。
- **退役**:主窗口内嵌 `SettingsPanel` 模态 + store `settingsOpen/setSettingsOpen`。
- **复用**:`ApiKeySection`、`MemoryList` 仅依赖 `window.pa`,搬进设置窗;`MemoryList` 改为接受 wsId。
- 记忆 IPC `list/listForgotten/remove/restore` 全部加 wsId 入参;`memory:changed` 广播带 wsId,设置窗仅在 `wsId===所选` 时重拉(agent 后台写入也实时反映)。

---

## 决策树速查(决定 → 选择)

| 决策点 | 选择 |
|--------|------|
| 核心场景 | 本地电脑操作 |
| 自主度 | 被动自主(V1)→ 主动自主(V2) |
| 平台优先级 | UI 三平台;操作层先 Mac |
| 客户端框架 | Electron(UI)+ Node(工具) |
| Agent 内核 | pi(pi-agent-core + pi-ai),在其上扩展 |
| Rust | V1 不用,留给将来 GUI 控制 |
| 模型 / 后端 | BYO Key + 客户端直连 + 网关抽象 |
| 安全模型 | 建议-审批 + 分级权限(beforeToolCall hook) |
| 文件回滚 | 预览整批审批 + 可逆 journal + 软删除 |
| 记忆 | 轻量本地、可见可编辑 |
| 记忆模型 | 拟人:情景(situation+quote+源会话)+语义+修订历史 |
| 记忆情景档 | 中等(situation+quote+sourceSessionId,不做结构化 where) |
| 记忆修订 | 完整 append-only 存 + 精简「当前值+最近变更」用 |
| 记忆遗忘 | 受控软遗忘(可恢复)现在做;自动衰退/TTL 推迟 |
| 记忆召回 | 混合:自动注入精简 content(带 id)+ search_memory 懒加载 |
| 记忆工具 | remember/update_memory/forget_memory/search_memory |
| 记忆写入 | 自动执行+可见+可逆,不审批 |
| 记忆权重 | 不做(留给相关性召回期,优先隐式显著性) |
| 设置形态 | 独立 BrowserWindow + 独立 HTML 入口(settings.html) |
| 设置 IA | 左分组 sidebar:应用(模型/通用/关于)+ 工作空间[选择器](记忆/偏好) |
| 设置·workspace | 自选 wsId,记忆 IPC 按 wsId 参数化(不跟随主窗) |
| 主题 | 浅/深/跟随系统(默认跟随),nativeTheme.themeSource,全局 settings.json |
| 设置窗行为 | 单实例/非模态/⌘,/原生标题栏/固定 720×520 |
| 联网 / 调研 | 驱动 Electron 自带 Chromium(可见,非 headless);**不用搜索 API**、**不接管用户 Chrome**(见下「内置浏览器调研」节) |
| 浏览器 profile | App 内置专用 partition(`persist:research`),本地持久登录 |
| 交互形态 | Chat + 结构化计划 / 工作区面板 |
| 目标用户 | 知识工作者 / 白领(非开发者) |
| 数据层级 | workspace → session → step |
| workspace 定义 | 逻辑命名空间(记忆+偏好+会话+信任),不绑目录 |
| 布局 | 四栏:session列表 / 对话 / artifact(按需);左下角 ws 切换+设置 |
| step 呈现 | 并入对话流(行内可折叠块),取消独立列表 |
| 审批位置 | 内联到对应 action 行(横幅方案作废) |
| artifact | 默认折叠,一次一个,批量 diff 自动弹出 |
| 记忆/偏好 | 收进 workspace 设置 |
| 会话恢复 | 完整恢复(agent 带记忆接着聊,pi 原生支持) |
| 会话持久化 | infra WorkspaceStore+SessionStore;transcript JSON 单一事实源(JSONL 方案作废) |
| 实施顺序 | 先前端骨架(内存态)→ 后补持久化与迁移 |

---

## 内置浏览器调研:驱动自带 Chromium(2026-05-22 追加)

WebResearch 不走搜索 API,改为驱动浏览器。架构岔路对照了 OpenClacky 决策 7(接管用户 Chrome):

- **关键区别**:OpenClacky 是 Ruby CLI,自己没浏览器,所以接管用户 Chrome 几乎是拿到"可见+登录态+真浏览器"的唯一办法。**我们是 Electron,本身就是 Chromium**,接管用户 Chrome 的核心动因不成立。
- **决策:走 B,驱动 Electron 自带 Chromium。** 可见(贴合决策 7 的信任诉求)、非 headless、`partition:"persist:research"` 持久登录态、无 API、无外部 daemon、无 `--remote-debugging-port` 开箱摩擦。代价是用户日常浏览器的现成登录不自动复用——但助理拥有独立、显式授权的浏览器身份反而更干净。
- **形态(2026-05-22 定,踩坑后):嵌入 ArtifactPanel,用渲染层的 `<webview>` DOM 元素,不开独立弹窗。** `web_search`/`web_fetch` 实时在面板里浏览(用户看着 agent 翻页,决策 7 透明性)。
  - 主进程通过 `app.on("web-contents-created")` 拿到 webview 的 webContents 驱动导航/抓取;头部 URL/加载态由渲染层监听 webview DOM 事件。
  - **弃用 WebContentsView 覆盖层**:macOS + BrowserWindow 下它被主页面合成盖住(z-order 无解),改 BaseWindow 又导致应用异常退出,还有首帧不绘制的时序坑。`<webview>` 在 DOM 里显示天然可靠,是 Electron 面板内嵌浏览器的稳妥做法(代价:webviewTag 已 deprecated 但当前可用)。
- **不选 A(接管用户 Chrome)**:需 remote-debugging 配置 + 外部 chrome-devtools-mcp daemon + 劫持用户日常浏览器,与"开箱即用"冲突。

> ⚠️ 这块在 macOS + Electron 上踩了一长串坑(z-order、绘制时序、BaseWindow 崩溃等),完整实录见 [`browser-embedding-pitfalls.md`](browser-embedding-pitfalls.md)。**改浏览器前必读。**

实现要点:
- 分层:`cap-browser` 只定义 `BrowserController` 接口 + 工具 schema(保持 electron-free);Electron 驱动放 `apps/desktop/src/main/browser-manager.ts`,组合根注入。
- 工具粒度(决策 4):起步 `web_search` + `web_fetch` 两个高层语义工具。**2026-05-22 扩展为网页自动化**:新增 `browser_click` / `browser_type` / `browser_wait` / `browser_scroll` / `browser_screenshot`,操作 web_fetch 打开的同一个可见 webview。
  - **驱动用 Electron `webContents.debugger`(进程内 CDP),不用 Playwright。** 用 Playwright 现成库要 `connectOverCDP` + `--remote-debugging-port`,那个本机调试端口让任意本机进程能掏 cookie/DOM,对"托管登录态的可信本机助理"是真实攻击面——正是当初否掉 remote-debugging 的同一理由。`debugger` 进程内、不开端口、且给真实可信输入事件(`isTrusted=true`)。代价:无 auto-wait/locator 现成糖,自包装 ~150 行。读查询走 `executeJavaScript`,真实输入与截图走 debugger(`Input.*` / `Page.captureScreenshot`)。
  - 风险分级:`browser_click`/`browser_type` → `ReversibleMutating` 强制审批(本节"改状态强制审批");`wait`/`scroll`/`screenshot` 只读自动放行。
- 搜索抓 SERP(脆),起步用 DuckDuckGo / Bing,避开 Google 反爬。
- 登录态:遇登录墙时让用户在可见视图登一次,cookie 走 persist partition 留存。
- 实例首次调用时创建、跨多次 tool call 保活。

详见 [`status-and-roadmap.md`](status-and-roadmap.md) 阶段 B / 记忆 `browser-architecture`。
