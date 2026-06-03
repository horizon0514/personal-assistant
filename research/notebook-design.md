# Notebook（来源集）— 设计稿

> 日期:2026-06-03 · 配套:[`domain-model.md`](domain-model.md)、[`status-and-roadmap.md`](status-and-roadmap.md)、[`design-discussion.md`](design-discussion.md)
> 缘起:PDF 解析(数字版 liteparse + 扫描件 PaddleOCR)已稳,下一步把"读完即弃"升级成"对一组资料持续问答、带引用" —— NotebookLM 式体验。

---

## 0. 一句话定位

让用户把若干本地文档攒成一个 **Notebook(来源集)**,然后**只基于这些来源**做带引用的问答与产出。
价值锚点 = NotebookLM 让人觉得好用的三件事,**没有一件强依赖向量索引**:

1. **范围锁定** —— 回答只来自"我选的这几份资料",不跑偏、不用全网。
2. **来源接地 + 引用** —— 每个论断能点回原文「第几页/哪段」,不编造。
3. **对一组资料持续对话/产出** —— 摘要、FAQ、时间线、对比表。

向量检索只是 NotebookLM 实现"接地"的**手段之一**;我们已有另一套手段(agentic 多步搜索 + grep + 独立 evaluator 验收),故**复用之,不预先上 RAG**。

---

## 1. 与既有决策的对齐(为什么不上向量)

`TODO.md` 已有明确决策:**采用 agentic search(grep)而非向量 RAG**,理由是本地文件常变(索引易失效)、需精确匹配、模型可多步推理"去哪找"、零索引基建,"真正需要语义相似度时再考虑 embedding,但不预先上 RAG"。
Notebook 是这条决策的**自然延伸**,不是例外:把 agentic 搜索从"任意目录"圈定到"某个来源集",并强制带页码引用。embedding/语义检索留作 **M4 可选项**,等关键词搜不动的真实场景出现再上。

落点:它服务 `status-and-roadmap.md §5 #5`「产出侧补全闭环(调研→产出)」的**输入侧** —— 给"调研→产出"一个被记住的语料底座。

---

## 2. 领域模型(对标 Personal Memory,非 Capability)

Notebook 像 `ctx-memory`:**本地、可见可恢复、每 workspace 一份**的有状态集合,而不是一类无状态操作。故新开 `packages/ctx-notebook`,而非塞进 `cap-document`(后者维持"无状态抽取"职责单一)。

- **聚合根 `Notebook`**:`id` / `name` / `sources[]` / `createdAt` / `updatedAt`
- **实体 `Source`**:`id` / `path` / `kind`(pdf/text)/ `addedAt` / `extractedAt` / `pageCount` / **逐页文本缓存** / `ocr`(是否扫描件)
- **值对象 `PageText`**:`{ page: number; text: string }` —— 接地引用的最小单位
- **不变量**:同一 path 在一个 Notebook 内不重复;抽取失败的 Source 标记 `error` 而非静默丢
- **风险**:全部 `ReadOnly`(查询/读取);增删 Source 是本地 manifest 改动 —— 可见、可恢复(软删,沿用 memory 的"留痕"范式)

### 持久化
- per-workspace:`<userData>/workspaces/<wsId>/notebooks/<id>.json`(manifest)+ 抽取文本缓存(逐页)
- 抽过一次即缓存:**避免每次重跑 OCR**,也让"对资料反复问"零额外成本
- 复用 `infra` 的 store 范式 + `ctx-memory` 的"本地 JSON、可见可恢复"模式

---

## 3. 检索 = 范围锁定的 agentic loop(零索引)

新增只读工具(挂 `capability: "document"` 或新 `"notebook"` 标签,组合根 `agent.ts` 的 catalog 加一组):

| 工具 | 作用 |
|------|------|
| `notebook_add_source` / `notebook_remove_source` / `notebook_list` | 管理语料(增删=本地 manifest,可见可逆) |
| `notebook_search` | 在该 Notebook 缓存文本里关键词检索 → 回 `来源:页:片段`(本质=`grep_files` 圈到语料缓存) |
| `notebook_read_source` | 把指定 Source 的某页/段拉进上下文 |

问答闭环沿用已落地的 agentic 多步:**search → 读命中段 → 带 `[来源, p.X]` 作答**。
**接地约束**进 system prompt / `notebookGuidelines`:"回答只能基于 Notebook 内来源,每个论断须标 `[来源名, p.X]`,找不到就说找不到,别用先验知识补。"
**反编造**复用已落地的**独立 evaluator**:对"有交付物"的 Notebook 问答,加一条"每个论断须有 Notebook 来源支撑"的验收清单 —— 这正是 NotebookLM 的"不编造",且与 `status §5`(可信/护城河)同构。

---

## 4. 落地切片(从薄往厚,每片可单独验证)

| 切片 | 内容 | 价值 | 状态 |
|------|------|------|------|
| **M0 接地抽取** | `cap-document` 加结构化抽取(保逐页 `PageText[]`),导出可复用的 `extractDocument()`;agent 的 `extract_document` 扁平输出对多页 PDF 加「第 N 页」锚 | 地基;小而可测 | ✅ 已落地 |
| **M1 Notebook 领域+持久化** | `ctx-notebook` 包:manifest + 逐页文本缓存 + add/list/remove;每 workspace 一份 | 语料从此"被记住" | ✅ 已落地 |
| **M2 范围问答+引用** | `notebook_search/read` + 接地约束 prompt + evaluator 可独立核查引用 | **核心体验成形**(现有聊天框即可端到端跑) | ✅ 已落地 |
| **M3 UI** | Notebook 视图:来源列表 + 问答区 + 引用跳回原文(复用三栏 + ArtifactPanel) | NotebookLM 的"样子" | ← 下一步 |
| **M4(以后/可选)** | 关键词搜不动、需语义相似时再上 embedding | 严守"按需再做" | |

M0+M1+M2 即可在**现有聊天框**端到端跑通"对一组资料带引用问答";M3 才做成独立界面。

---

## 5. 悬而未决

- **Source 数量上限 / 单 Notebook 体量**:关键词检索在几十份文档内够用;超出再评估 M4。
- **跨 Notebook 检索 / 与 Personal Memory 的边界**:Notebook=可丢弃的"工作集语料",Memory=长期"关于用户的事实",暂不混用。
- **docx/xlsx 来源**:仍受限于 LibreOffice 缺失(见 `cap-document` 注释),暂不在范围。
- **引用渲染**:M2 先用文本锚(`[来源, p.X]`),M3 再做可点击跳转。
