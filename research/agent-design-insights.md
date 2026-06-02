# Agent 设计启示:对照 Anthropic 两篇工程文章

> 更新:2026-05-26 · 配套:[`prompt-cache-and-compaction.md`](prompt-cache-and-compaction.md) · [`status-and-roadmap.md`](status-and-roadmap.md) · [`design-discussion.md`](design-discussion.md)
>
> 来源:
> - [Building Effective Agents](https://www.anthropic.com/engineering/building-effective-agents)(workflows vs agents、5 种模式、简单性/透明性/工具设计 ACI)
> - [Harness Design for Long-Running Agentic Apps](https://www.anthropic.com/engineering/harness-design-long-running-apps)(context reset vs 压缩、Planner/Generator/Evaluator 分解、执行与评估分离、Sprint Contract、可评分标准、progressive simplification、读 trace 调参)
>
> 缘起:逐条对照这两篇,挑出**我们还没落地、且文章明确指路**的启示。已经吃透的部分(缓存局部性、反 RAG、工具少而粗)见 `prompt-cache-and-compaction.md`,本文不重复。

## 0. 一句话结论

缓存/压缩/工具粒度那套你们已经啃透;两篇文章里**真正没落地的启示集中在五处**,按杠杆排序:① 执行与评估分离(独立 evaluator);② 子 Agent / orchestrator-workers;③ context reset(对阶段 D 尤其);④ Sprint Contract + 可评分标准;⑤ 可观测(读 trace)。外加一条 ACI 小账(工具错误引导)。

---

## 1. 执行与评估必须分离 —— 我们现在是同体自评(认知层最该修)

> **状态:已落地(2026-05-26)。** `Evaluator`/`Verdict` 端口在 domain-core;`createPiEvaluator`(起第二个 pi Agent,只读工具 + `submit_verdict`)在 ctx-task;组合根 `agent.ts` 注入;`PiAgentAdapter.startTask` 在调过工具的任务跑完后调用它,不通过则回灌问题清单自动返工(默认最多 1 轮),ChatPane 显示验收结论。Sprint Contract(§4)与成本 telemetry(§5)仍未做。

`harness-design` 核心论点:**让干活的 agent 评估自己,必然过度自信(predictable overconfidence)**;要一个独立的 evaluator persona,可调成"该有的怀疑态度",形成具体反馈回路。

我们 `TODO.md`「完成前强制自验证」方向对(prompt 软约束 → harness 硬关卡),但**"自验证"正踩文章警告的坑**:同一个被 context anxiety 催着收尾的 agent 核查自己,会倾向于说"done"。

> **处方**:派一个**独立、干净上下文**的 evaluator(只读工具 + 验收清单),它不背"想赶紧结束"的包袱。对破坏性文件操作这条线尤其值钱。

## 2. 子 Agent(orchestrator-workers)—— 最高杠杆的未建件,两篇都指向它

- `building-effective-agents`:**orchestrator-workers** —— 主 agent 拆活、派给隔离 worker。
- `harness-design`:**decomposition + 上下文隔离** —— worker 在自己窗口里跑,只把结论交回主线。

命中 `prompt-cache-and-compaction.md §4.4` / 其 §5 P2(子 Agent 入口)。一次解决三件事:

| 痛点 | 子 Agent 如何解 |
|------|------------------|
| 主 history 污染 | 浏览器/文档调研的几十次读/抓全留在 worker,不进主 transcript → 推迟压缩、更便宜 |
| 工具 schema 膨胀 | `cap-browser` 那 7 个工具只在 worker 可见,主 agent 工具表稳定(护缓存断点 #2) |
| context anxiety | worker 任务边界清晰、做完即弃,不背长会话焦虑 |

`cap-browser`(多步调研)和"调研→产出"hero 场景是教科书级 worker 用例。**建议从 P2 提到 P1。**

## 3. Context reset 对 durable-harness(阶段 D #10)比压缩更重要

`prompt-cache-and-compaction.md` 整篇在优化**压缩**(空闲压缩、Insert-then-Compress)。但 `harness-design` 判断:**长任务里,带结构化交接的"上下文重置"赢过原地压缩**——压缩消不掉 context anxiety。

短交互场景靠 pi 被动压缩够用;**阶段 D「主动自主/后台定时监控」一旦上,这条从次要变主要**。届时与其纠结空闲压缩,不如设计"任务做完 → 把结论/状态写进 memory 或 journal → 开干净 agent 接下一段"的 reset 交接。与我们已有的 **transcript 单一事实源 + 可见可编辑 memory** 天然契合(交接载体现成)。

## 4. Sprint Contract + 可评分标准 —— 喂给 hero 场景「调研→产出」

> **状态:已落地(2026-05-26)。** `propose_contract` 工具(ctx-task)让执行器对多步/有交付物的开放任务动手前起草「交付物 + 验收标准」,经用户内联确认/微调(ChatPane `ContractCard`)后锁定;确认的 `SprintContract` 存进会话并作为 §1 evaluator 的逐条验收清单。触发靠 system prompt 软约束(执行器自行判断)。未做:契约持久化、硬触发分类器、加权打分。

`harness-design` 两个具体手法还没用:
- **Sprint Contract**:动手前先就"交付物 + 可测的成功标准"达成一致,再实现。
- **可评分标准(grading criteria)**:把"质量好"翻译成可评分维度(文章前端例子:design quality / originality / craft / functionality 加权),否则模型滑向 generic 默认产出。

对 `status-and-roadmap §5.3/§5.5`(第一个魔法时刻要稳、产出侧要补齐):**开头先让 agent 跟用户确认"产出长什么样 + 怎样算合格",再配合 #1 的独立 evaluator 按这份标准验收**,比纯开放对话稳。把 #1、#2、#4 串成一条闭环。

## 5. 可观测:一堆决策"靠假设",文章说要"读真实 trace"

`harness-design` 反复强调**在真实问题上读 trace、迭代调参**。但 `prompt-cache-and-compaction.md` 里"telemetry 未知""大概率低""premature optimization"出现多次——多个 deferred 决策(记忆头部注入要不要修、history 常态多长、记忆写频率)都卡在**没有数据**。

> **处方**:一个轻量 trace 日志(每轮 token 数、压缩触发、工具调用序列、记忆写次数)成本很低,却能一次性解锁这几个"等触发条件"的待办,把"靠假设"变成"靠 trace"。性价比最高的基础设施。

## 6. ACI 小账:工具能力缺口靠「错误引导」,不只是兜底 shell

> **状态:已落地(2026-05-28,filesystem 部分)。** 起点是发现执行器对"工具返回空结果"几乎不反思——它把 0 命中当真相继续干。`packages/cap-filesystem/src/index.ts` 给 list_dir/read_file 加 ENOENT/ENOTDIR/EISDIR 分支,抛错时附**父目录近邻**(按 basename token 做大小写不敏感子串匹配,最多 12 条);find_files/grep_files 零命中不再返回干瘪的"(未找到)",而是返回 stem 近邻 + 目录里实际有的扩展名 + 显式"下一步"建议(放宽 glob、换上级目录、改用另一工具),并都带一句"别用同一参数再搜一次"反复推。配合 system prompt 在「坚持完成」段加一条「**工具返回空结果≠真相,换一个再试**」(`apps/desktop/src/main/system-prompt.ts`),把反思变成纪律,而不是靠模型自发。回归测试 `packages/cap-filesystem/src/hints.test.ts`(12 用例)。其他能力域(browser/document/web)待同样改造。

`building-effective-agents` 的 ACI 原则:工具不只 schema 稳,**报错要能告诉模型"该改用什么"**(poka-yoke)。`TODO.md`「工具能力兜底」里受限 shell 是一条路,但更便宜的一招:**让现有工具失败时返回引导性错误**(如 write_file 到不存在目录,返回"父目录不存在,可用 X")。兜圈往往不是缺能力,是错误信息没给出口。

---

## 已对齐的(确认,不展开)

反 RAG(render 注入 + search_memory 混合召回)、工具少而粗、progressive simplification(砍 browser_wait/scroll)、透明性(step 内联 + 内联审批 + 可见可编辑记忆 + 注入警告)——这几条恰是两篇反复强调的,我们做得比文章示例还细。透明性那块(信任 UX 当一等公民)本身就是对"非开发者"的护城河,继续压。

> **progressive simplification 的提醒**:文章原话"每个 harness 组件都编码了一个'模型做不到'的假设"。当默认模型从 deepseek-flash 换到更强的内置模型时,要回头压测:强制自验证、细粒度审批等脚手架是否还 load-bearing,该删就删。

---

## 落地顺序(最小可行)

1. **#5 trace** —— 解锁数据,成本最低。
2. **#2 子 Agent** —— 最高杠杆(history 污染 + 工具膨胀 + anxiety 三合一)。
3. **#1 + #4 独立 evaluator + Sprint Contract** —— 串起 hero 场景「调研→产出」闭环。
4. **#3 context reset** —— 与阶段 D durable-harness 一起做。
5. **#6 ACI 错误引导** —— 随手做,跟工具兜底一并。
