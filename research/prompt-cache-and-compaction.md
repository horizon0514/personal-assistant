# Prompt Cache 与压缩:pi 实测行为 + 工程取舍

> 更新:2026-05-22 · 配套:[`design-discussion.md`](design-discussion.md) · [`status-and-roadmap.md`](status-and-roadmap.md)
>
> 缘起:一篇关于本地 Agent(OpenClacky)的工程复盘,核心论点是「把工程预算花在 harness 上,把智能预算留给模型」,并给出 7 个围绕 **cache 局部性 + 工具集稳定性** 的决策。本项目与之同类(去终端化本地 Agent),所以逐条对照,记录**哪些 pi 已经替我们做了、哪些是我们自己的责任、哪些是坑**。

## 0. 一句话结论

缓存与压缩**几乎全部由 `pi-ai` / `pi-agent-core` 内核掌控,App 没有直接控制权**。因此我们的工程预算不该花在重造缓存策略上,而该花在**内核没覆盖的缝隙**:① system prompt 字节稳定性(我们正在违反);② 空闲压缩;③ 工具 schema 稳定性;④ 子 Agent 状态隔离。

---

## 1. pi 的真实缓存行为(`pi-ai@0.75.4`,Anthropic provider)

源码:`pi-ai/dist/providers/anthropic.js`。

**断点位置(3 个)**——`cache_control: { type: "ephemeral" }`:

| # | 位置 | 源码 |
|---|------|------|
| 1 | system prompt 末块 | `buildParams` 约 :683/:700 |
| 2 | tools 数组最后一个 tool | `convertTools` 约 :710/:938(需 `supportsCacheControlOnTools`) |
| 3 | **最后一条 user message 的末块** | `convertMessages` 约 :898 |

**TTL / retention**:`getCacheControl`(:25)默认 `short`(≈5 分钟)。环境变量 `PI_CACHE_RETENTION=long` → `1h`(仅当模型 `supportsLongCacheRetention`)。

**关键判断:这是「单尾标记」,不是文章决策 1 的「双标记滚动双缓冲」。**

- 文章的双标记是为了解决两件事:**(a) 单步 tool 回退后仍命中**;**(b) Claude 与 OpenAI 兼容两条线缓存语义不同**。
- pi 只在「当前请求的最后一条 user message」打一个尾标记。靠 Anthropic 的**自动增量前缀缓存**,单调追加场景下基本够用(上一轮写入的前缀,这一轮作为读命中)。
- 但 pi **没有**回退容错那一层。工具报错重试 / 用户中断重发导致「昨天的最后一条」被丢弃时,会比双标记方案多 miss 一次。这是内核的设计,**我们短期内不改**(改 = fork `pi-ai`,维护成本高,收益是低频回退场景省一次 miss)。

> 备注:provider 里还有 OAuth/stealth 模式会把 system 拆成「Claude Code 身份块 + 真实 system」两段并各打断点(:678–:692),仅在用 OAuth token 时触发,BYO key 路径不走这里。

---

## 2. pi 的真实压缩行为(`pi-agent-core@0.75.4`)

源码:`pi-agent-core/dist/harness/compaction/compaction.js`。

**触发阈值**(`shouldCompact`,:123):
```js
contextTokens > contextWindow - reserveTokens   // reserveTokens 默认 16384
```
即「**快撑满才压**」。`keepRecentTokens` 默认 20000,压完保留约 20K 近期上下文。

**压缩方式**(`generateSummary`,`SUMMARIZATION_SYSTEM_PROMPT`):
开**独立 LLM 调用**,system prompt 换成 `"You are a context summarization assistant..."`。`model` 由调用方传入(可同可换)。

⚠️ **这正是文章决策 5 点名的反模式**:独立 call 的 system prompt 与主 session 无共享前缀 → 压缩那次调用 **0% cache hit**;压缩后主 session history 被摘要替换 → 主 session 接下来若干轮也 cold。文章的 Insert-then-Compress(把压缩指令作为一条消息插进当前对话末尾、复用现有前缀)pi **没有**采用。

**没有空闲压缩定时器**:pi 是在某一轮 `shouldCompact` 为真时**被动**压缩,不存在「用户停手 N 秒、趁 cache 还热主动压」的逻辑。

---

## 3. 逐条对照文章 7 决策

| 决策 | 文章主张 | pi/本项目现状 | 结论 |
|------|----------|---------------|------|
| **1 双标记 cache** | 滚动双标记 + 回退容错 | pi 单尾标记,无回退容错 | 内核管,不重造;知其边界即可 |
| **2 system prompt 字节冻结** | 动态信息禁入 system prompt | ❌ `system-prompt.ts` 把 `date/OS/cwd` 烤进 system prompt;断点 #1 每天/每次重建即失效 | **我们的责任,待修(P0)** |
| **3 invoke_skill 子 Agent** | 统一入口 + 状态隔离,主 history 不被污染 | 无子 Agent 机制 | 成长期补(见 §4) |
| **4 工具集 16 个稳定** | 粗粒度、schema 稳定 | 现 ~11 个;`cap-browser`/`cap-webresearch` 待接入 | 扩张时守 schema 稳定(见 §4) |
| **5 压缩:同模型 + 空闲 + 压到底** | Insert-then-Compress + 空闲定时 + 压到 ~1万 | pi 独立 call 压缩、被动触发、保留 20K | 部分偏离;空闲压缩是 App 机会 |
| **6 文档处理脚本自进化** | Python 脚本 copy 到用户目录,Agent 自维护 | `cap-document` 是内置工具 | TS/Electron 栈下优先级低,记录备查 |
| **7 浏览器:接管用户 Chrome,非 headless** | 用已登录的 Chrome/Edge,看得见 | roadmap 阶段 C 写的是 Playwright 内置 profile | ⚠️ 与「登录态闭网访问」定位有张力,见 §5 |

**我们已经做对的**(对照文章开篇反 RAG):`ctx-memory` 用 `render()` 注入 `- [id] content` + `search_memory` 工具做混合召回,**无向量库**。文章判断 90% 召回率有害、需 97%+,继续保持,抵抗未来加 embedding 的诱惑。

---

## 4. 我们的责任边界(内核没管的部分)

1. **system prompt 字节稳定性(决策 2)** —— 内核把 system prompt 当顶层断点,但 system prompt 内容是**我们**构造的。`buildSystemPrompt` 注入 `new Date()` 等动态值 = 主动破坏断点 #1。
2. **空闲压缩(决策 5)** —— pi 只被动压。App 知道「用户停手 / 窗口失焦」这些信号,可在 cache 还热时主动触发压缩。这是 App 层独有的优化位。
3. **工具 schema 稳定性(决策 4)** —— 接入 browser/webresearch 时,**1 个高层语义 `browser` 工具**(snapshot/click/navigate),而非 8 个细粒度 CDP 动作;每加/改一个工具都抖动断点 #2 之后的全部前缀。
4. **子 Agent 状态隔离(决策 3)** —— browser/document/webresearch 的中间步骤(读几十文件、抓网页)若都进主 history,会更早触发压缩、更贵。一个统一入口 + 隔离子会话能同时压住「工具列表膨胀」和「主 history 污染」。

---

## 5. 待办(按优先级)

- [x] **P0 · system prompt 冻结**(决策 2)✅ 2026-05-22:`system-prompt.ts` 的 `buildSystemPrompt` 移除 `date/OS/homedir/tmpdir` 插值,改为「不接受环境参数」的字节冻结版;新增 `buildSessionContext()` 产出 `[session context]` 块(日期/OS/主目录/临时目录/模型)。`agent.ts` 的 `contextProvider` 改为 `[buildSessionContext(), memory.render()].join`,经 pi 的 `transformContext` 作为前置消息每轮注入、不写入 transcript。全包 typecheck + test 通过。
  - **遗留小账(已评估,见下「记忆召回的头部注入损耗」)**:`transformContext` 把注入块放在 messages **最前面**(`[injected, ...messages]`,见 `ctx-task/src/index.ts:179`)。env 部分 session 内稳定,不添乱;但 `memory.render()` 变化时会让其后整段 history cache-miss。结论是**现在不修,带触发条件登记**。
- [ ] **P1 · 空闲压缩**(决策 5):利用窗口失焦 / 输入停顿信号,在接近阈值且 cache 仍热(< TTL)时主动调用 pi 压缩。需先确认 pi 是否暴露手动 `compact()` 入口。
- [ ] **P1 · browser 工具粗粒度**(决策 4):`cap-browser` 对外只暴露 1 个语义工具,schema 冻结。
- [ ] **P2 · 子 Agent 入口**(决策 3):评估在 browser/webresearch 落地前引入统一隔离入口。
- [ ] **P2 · 浏览器方向再确认**(决策 7):roadmap 阶段 C 的「Playwright 内置 profile」对照「接管用户已登录 Chrome」,与「登录态闭网访问」定位做一次决策(见 design-discussion 开放问题)。
- [ ] **可选 · `PI_CACHE_RETENTION=long`**:长会话桌面场景(用户常走开),若模型支持 1h TTL,评估默认开启以减少 TTL 过期导致的全量 cold。

---

## 6. 评估:记忆召回的头部注入损耗(2026-05-22,结论=暂不修)

P0 的副产物。结论先行:**现在不修,带触发条件登记;真要修首选「并进最后一条 user 消息」而非简单尾部 append。**

### 已核实的机制

- `transformContext` **每次 LLM 调用都跑**(`pi-agent-core/dist/agent-loop.js:176`,在 `streamAssistantResponse` 内,每个 loop step 一次)。
- 注入块落在 **`messages[0]`**(绝对最前,紧跟 system prompt)。缓存断点 #1/#2(system/tools)在它**之前**,永远命中;但整段对话历史的前缀**从它开始**。
- `[injected, ...messages]` 是**我方** `ctx-task/src/index.ts:179` 的代码,**非 pi 强制** —— prepend / append 由我们决定,改它不碰 pi。
- `memory.render()` 是纯函数式、稳定输出(无时间戳、顺序确定,`ctx-memory/src/index.ts:208`),只在记忆增/改/忘时变。

### 损耗多大

- **记忆不变的轮次**:注入块逐字节相同 → 历史全命中,**零损耗**。
- **一次 `remember/update/forget` 之后**:注入块变 → 其后整段 history 按 cache-**write** 费率重算一次(Anthropic ≈1.25× vs 命中 0.1×),之后重新 warm。
- 即代价是「**每次记忆写一次性重算整段 history**」,非每轮。记忆工具自动放行、**任务执行中**就会 fire,故多步任务中途写记忆会让该任务剩余步骤重新 warm(本质仍是一次重算事件,除非一个任务里写多次)。
- 绝对成本 = `history_tokens × (write率 − hit率) × 单价`。

### 什么时候才真的疼(三个放大因子,当前一个都没踩满)

| 因子 | 现状 | 疼的阈值 |
|------|------|----------|
| 模型单价 | deepseek-v4-flash(便宜) | 默认切到 Opus 级贵模型 |
| history 长度 | 早期、短 | 常态 > 30–50K token |
| 记忆写频率 | 未知,大概率低 | 单会话频繁写 |

→ 当前阶段属 **premature optimization**;P0 已把 system/tools 两个最大断点稳住,这条是次级损耗且自带规避前提(便宜模型 + 短历史)。

### 真要修:修法 + 风险

唯一有效是**位置性**修法:注入块从 `messages[0]` 挪到尾部,让稳定 history 前缀在断点 #3 前先缓存,记忆变化只失效尾部几百 token。三个真实代价(正是不该现在做的原因):

1. **连续两条 user 消息**:用户真实消息已在尾部,再 append user 角色注入块 → 连续同角色。Anthropic 容忍,但 **OpenAI 兼容线(当前 deepseek)可能报错/被迫合并**(`anthropic.js` 的 `convertMessages` 逐条 push、不合并)。需按 provider 验证。
2. **`[session context]` 也被带到尾部**:环境信息放在用户问题之后,不如做前言自然。要么 env 仍前置 + memory 后置,逻辑更碎。
3. **失去「先验证再优化」**:无 telemetry 证明记忆写高频前,是在为假设热点付工程 + 测试成本。

### 触发条件(任一满足即重启此项)

- [ ] 默认模型换成 Opus 级贵模型,**或**
- [ ] 实测单会话 history 常态 > 30–50K token,**或**
- [ ] telemetry 显示记忆写在会话内高频。

届时**首选修法**:把注入块**并进最后一条 user 消息的 content 块**(规避连续同角色),而非简单 append;并按 provider(Anthropic / OpenAI 兼容)分别验证。

---

## 附:本结论的源码出处(便于回查 / 版本升级时复核)

- 缓存断点:`node_modules/.../pi-ai/dist/providers/anthropic.js` —— `getCacheControl`、`buildParams`、`convertMessages`、`convertTools`
- 压缩:`node_modules/.../pi-agent-core/dist/harness/compaction/compaction.js` —— `DEFAULT_COMPACTION_SETTINGS`、`shouldCompact`、`SUMMARIZATION_SYSTEM_PROMPT`、`generateSummary`
- 我方 system prompt:`apps/desktop/src/main/system-prompt.ts`
- 我方 agent 组装:`apps/desktop/src/main/agent.ts`

> 版本钉死在 `pi-agent-core@0.75.4` / `pi-ai@0.75.4`。升级 pi 后需复核以上行为是否变化(尤其断点数量、压缩是否转向 Insert-then-Compress)。
