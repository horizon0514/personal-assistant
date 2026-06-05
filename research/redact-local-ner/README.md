# 纯本地中文敏感实体检测(脱敏用)— POC

给 `word-redact` skill 补上**完全本地**的「人名 / 机构 / 地点地址」识别能力,
补齐之前的隐私缺口:不再需要把全文发给云端大模型去找敏感项。

## 跑起来

```bash
cd research/redact-local-ner
npm i
node detect.mjs                 # 跑内置样例
node detect.mjs "你的中文文本"    # 跑自定义文本
```

首次运行会从 HuggingFace 下一次 ONNX 权重(几十~百余 MB),**之后完全离线**。

## 它做什么 / 不做什么

脱敏分两层,各司其职:

| 类型 | 谁来抓 | 说明 |
|---|---|---|
| 结构化 PII:手机/身份证/银行卡/邮箱/固话… | **正则**(在 skill 第 3a 步) | 有固定形态,确定性命中,零依赖 |
| 非结构化:**人名 / 机构 / 地点地址** | **本脚本**(本地 NER) | 正则抓不到,靠模型 |

`detectEntities(text)` 返回去重后的实体**表面串**,直接喂回 skill 里的
`office_cli set --find/--replace` 做化名 / 打码。模型只负责「找」,不碰替换。

## 技术栈:纯本地 ONNX

- **transformers.js (`@huggingface/transformers`)** 的 `token-classification` 流水线,
  底层 **onnxruntime**(Node 里自动走 `onnxruntime-node` 原生,CPU 即可)。
- 模型:`Xenova/bert-base-multilingual-cased-ner-hrl`(多语种 BERT-NER,含中文,onnx)。
- 全程在本进程内跑,文档**一个字节不出本机**——与项目 `cap-office`
  「按需下运行时、之后本地跑」的取舍一致。要并入正式能力时,可照搬 cap-office 的
  权重按需下载 + 缓存 + 临时文件 rename 防半成品那套。

## 选型记录(实测,别再走弯路)

- ❌ **GLiNER 多语种 PII 版**(`onnx-community/gliner_multi_pii-v1`):对**中文不堪用**。
  GLiNER 按**空格**切词,中文无空格 → 整句成一个 token,span 抽不准;
  字级 / 词级预切分后仍**漏抓、错标、置信度低**(王建国漏掉、"科技"被标成人名)。
  GLiNER 适合英文 / 欧洲语言,不适合中文。
- ✅ **BERT 多语种 NER**(本 POC):同一套纯本地 ONNX 栈,效果拔群——
  `王建国→PER 1.00`、`北京晨曦科技有限公司→ORG 1.00`、`李秘书→PER 0.96`,CPU 推理 ~40ms。

## 局限 / 调参

- 标签只有 PER / ORG / LOC,没有「项目代号」这类自定义类型(样例里"烛龙"被勉强归到 LOC,
  脱敏场景"宁可多抹"反而无妨)。需要自定义类型且中文又要好,可考虑中文专训 NER
  (HanLP / LTP)或小号 Qwen(onnx),代价是更大或更慢。
- `threshold` 默认 0.5,脱敏可再调低多召回;单字实体已默认丢弃以防误伤。
- 同名一律按表面串全量替换,天然满足「同一实体→同一化名」的一致性要求。
