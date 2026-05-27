# 现状盘点与路线规划

> 更新:2026-05-22 · 配套:[`design-discussion.md`](design-discussion.md) · [`domain-model.md`](domain-model.md) · [`tech-stack.md`](tech-stack.md) · [`prompt-cache-and-compaction.md`](prompt-cache-and-compaction.md) · [`agent-design-insights.md`](agent-design-insights.md)
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
- cap-filesystem:`list_dir`/`read_file`/`find_files`/`grep_files`(只读)、`write_file`/`move_file`/`delete`(可逆变更)、`plan_file_changes`(批量 move/delete,diff 预览 + 整批审批 + 批量回滚)
- cap-document:`extract_document`(PDF + 纯文本类提取)
- cap-browser:`web_search`/`web_fetch`/`read_current_page`(调研/读当前页)+ `browser_click`/`browser_type`(自动化,带可选 `waitFor`)+ `browser_screenshot`(默认隐藏)。驱动内置 `<webview>` Chromium,自动化经 `webContents.debugger`(CDP)+ 虚拟光标;`persist:research` 登录态。截图默认隐藏(deepseek API 不收图,`MAIN_VITE_VISION=1` 可开)。**2026-05-22 瘦身:砍 browser_wait(折进 waitFor)/ browser_scroll(低价值),守「少而粗」**

**信任 / 可逆(核心域)**
- ctx-trust:`createGatekeeper` —— 风险分级 → 策略 → 只读自动放行 / 需审批异步等待 / 拒绝拦截;审批内联到对应 action 行(同意/拒绝)
- **注入隔离(InjectionGuard,已落地)**:domain-core 的 `markUntrusted`(包裹不可信外部内容)+ `detectInjection`(启发式扫注入话术)+ `TRUST_BOUNDARY_PROMPT`(系统提示信任边界条款);cap-browser 的 web_search/web_fetch 应用之,疑似命中发 `InjectionSuspected` 事件
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
| **WebResearch / Browser** | cap-browser 已落地:调研(web_search/web_fetch/read_current_page)+ 自动化(click/type,带 waitFor);driver=自带 Chromium;cap-webresearch 仍空壳(已被取代,待删) | 调研 + 自动化 v1 已做;**待运行时验证**真实站点选择器/登录态(见 TODO) |
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
5. ~~**WebResearch 能力**~~ ✅ v1 已做(改用内置浏览器,非搜索 API):`cap-browser` 的 `web_search`/`web_fetch` 驱动 Electron 自带 Chromium(可见、persist 登录态);Bing 抓 SERP + 正文提取;结果走"来源块查看"。**后续扩展为网页自动化**(阶段 C 第 7 项,已做)。**待运行时验证**:Bing 选择器、可见窗体验、登录态留存。
6. ~~多 provider / 模型选择 UI~~ **暂不做**(2026-05-22 决策):专注 deepseek。未来方向是"内置 deepseek + 用户注册登录开箱即用"(无需 BYO key),与商业化路线(网关切服务器中转 + 订阅制)合流,而非多 provider 切换。

### 阶段 C —— 闭网与硬化
7. ~~**BrowserSession 能力 + 注入隔离**~~ ✅ 已做(2026-05-22):登录态 + 自动化(read_current_page/click/type,带 waitFor)驱动内置 webview Chromium,经 `webContents.debugger`(CDP,**非 Playwright**);注入纵深防御(标注隔离 + 信任边界条款 + 启发式检测)已落地。**待运行时验证**:真实站点选择器/登录态留存(见 TODO「浏览器运行时验证」)。
8. **key 安全存储 + SQLite**:key 已用 Electron `safeStorage`(✅);持久化暂用文件 JSON,SQLite 待数据量/查询需要时再上。
9. **打包分发**:Mac 代码签名 + 公证 + 自动更新(进行中)

### 阶段 D —— V2
10. **主动自主**:后台自发起 / 定时 / 监控(durable-harness)
11. **商业化**:网关切服务器中转 + 订阅制
12. **沙箱(执行隔离)**:给 agent 的操作划硬边界——只能动授权范围(scoped 目录、禁系统文件),高危/受限 shell 等能力在隔离环境内跑。把信任从「软约束 + 审批 + 可逆」推进到「硬隔离:它够不到的就动不了」。见 §5「未来方向」。
13. **IM 集成**:接入 IM(优先飞书/Lark)。两层价值——(a) 把「登录态闭网访问」延伸到 IM:读/总结/起草/发消息;(b) IM 作为**输入/触发通道**:从手机/IM 给 Akari 派活,不必造移动端就拿到移动性 + 主动推送。见 §5。

## 五、产品视角:成败关键与未来方向(2026-05-22)

> 核心赌注:让**不写代码的白领**用一句话指挥本机干活(文件/网页/文档),靠「可见 + 可逆 + 登录态」赢得信任。差异化全压在「非开发者也敢用、用得爽」——所有取舍都回到这条。

**三道「能不能上线」的生死线(已认领,BYOK 与分发后续统一做):**
1. **开箱即用 = 干掉 BYO Key**(最大采用拐点):白领不会有 DeepSeek key,填 key 这步劝退绝大多数目标用户。方向「内置 deepseek + 注册登录」,与商业化(后端/登录/计费)合流。**[已认领,后续统一做]**
2. **装得上、敢装 = 签名/公证/自动更新**:动文件、登账号的桌面 App,无公证会被系统拦、无自动更新没法迭代修复。纯工程,硬阻塞分发。**[已认领,后续统一做,见阶段 C #9]**
3. **第一个「魔法时刻」必须稳**:非开发者只看「第一次用成没成」。挑 2-3 个 hero 场景端到端打磨到不翻车(如整理下载夹、Gmail 汇总发票成表、调研→出文档)。喂这个的是浏览器运行时验证(见 TODO)。

**决定「值不值得留」的差异化:**
4. **信任 UX 是护城河**:审批/diff 预览/可逆撤销/可见记忆/注入警告要让非开发者**真看得懂**,当一等公民打磨,而非附加项。
5. **产出侧补全闭环**:现强在「读」与「动手」,弱在文档/表格**产出**(docx/exceljs 未做)。知识工作者要交付物,不是聊天框答案。「调研→产出」补上,价值密度立变。
6. **沙箱 + IM 集成**(见阶段 D #12/#13):前者深化「敢用」(硬隔离),后者拓展触达与主动性。

**建议排序**:分发 → 开箱即用/登录并行;同时挑 1 个 hero 场景按 #3+#5 打透(「调研→产出」最安全、不依赖破坏性操作,适合首个对外 demo)。破坏性文件操作先压。

## 六、悬而未决(需产品决策)
- 团队规模 / 排期(决定是否砍范围)
- 公开调研是否并入搜索 API(与登录态浏览器两条路并存)
- ~~Prompt injection 系统化防御方案~~ ✅ 已落地(见上文「注入隔离」)
- 商业化时点 / 定价模型
- IM 集成优先级与首批平台(飞书 vs 其它)
