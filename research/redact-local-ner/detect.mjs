/**
 * 纯本地中文敏感实体检测(脱敏用)——POC
 *
 * 路线:transformers.js(token-classification)+ ONNX 权重,经 onnxruntime 在 Node 内跑,
 * 全程不联网(首次下权重后)、文档不出本机。和项目 cap-office「按需下二进制、之后本地跑」一脉相承。
 *
 * 分工:结构化 PII(手机/身份证/邮箱/银行卡…)交给正则(确定性、零依赖);
 *       本脚本只负责正则抓不到的**非结构化实体**:人名 / 机构 / 地点地址。
 * 输出的是实体「表面串」,直接喂回 word-redact skill 的 office_cli `set --find/--replace` 做替换。
 *
 * 选型结论(实测):
 * - GLiNER 多语种 PII 版(gliner_multi_pii-v1, onnx)对**中文不堪用**——它按空格切词,中文无空格,
 *   字级/词级预切分后仍漏抓、错标、置信度低。GLiNER 适合英文/欧洲语言,不适合中文。
 * - 改用 BERT 多语种 NER(bert-base-multilingual-cased-ner-hrl, onnx)效果拔群:
 *   王建国→PER 1.00、北京晨曦科技有限公司→ORG 1.00、李秘书→PER 0.96,CPU 推理 ~40ms。
 *
 * 跑法:cd research/redact-local-ner && npm i && node detect.mjs
 */
import { pipeline, env } from "@huggingface/transformers";

// 允许联网下权重(首次);要完全离线可预置权重到本地并设 env.allowLocalModels=true + env.localModelPath
env.allowLocalModels = false;

const MODEL = "Xenova/bert-base-multilingual-cased-ner-hrl"; // 多语种 NER(含中文),onnx,transformers.js 兼容
const LABEL_ZH = { PER: "人名", ORG: "机构", LOC: "地点/地址" };

let _ner; // 单例:模型只加载一次
async function getNer() {
  if (!_ner) _ner = await pipeline("token-classification", MODEL);
  return _ner;
}

/**
 * 检测一段中文里的人名/机构/地点。返回去重后的实体表面串列表(可直接做字面替换)。
 * @param {string} text
 * @param {number} threshold 置信度下限。脱敏宁可多召回,默认放低到 0.5。
 * @returns {Promise<Array<{type:string,label:string,text:string,score:number}>>}
 */
export async function detectEntities(text, threshold = 0.5) {
  const ner = await getNer();
  const raw = await ner(text, { aggregation_strategy: "simple" });
  const seen = new Map(); // 表面串去重,保留最高分
  for (const e of raw) {
    if (e.score < threshold) continue;
    const surface = String(e.word).replace(/\s+/g, ""); // 中文子词带空格,去掉还原表面串
    if (surface.length < 2) continue; // 单字噪声(易误伤)丢弃
    const key = `${e.entity_group}:${surface}`;
    if (!seen.has(key) || seen.get(key).score < e.score) {
      seen.set(key, { type: e.entity_group, label: LABEL_ZH[e.entity_group] ?? e.entity_group, text: surface, score: +e.score });
    }
  }
  return [...seen.values()].sort((a, b) => b.score - a.score);
}

// 直接运行:对样例文本演示
if (import.meta.url === `file://${process.argv[1]}`) {
  const text =
    process.argv[2] ??
    "客户王建国就职于北京晨曦科技有限公司,联系人李秘书,住址北京市朝阳区建国路88号,项目代号烛龙。";
  console.log("加载模型(首次会下 onnx 权重)…");
  const t0 = Date.now();
  const ents = await detectEntities(text, 0.5);
  console.log(`完成,用时 ${Date.now() - t0}ms\n原文:${text}\n检测到的非结构化敏感实体:`);
  for (const e of ents) console.log(`  [${e.label}] ${e.text}  (${e.score.toFixed(2)})`);
  console.log("\n→ 这些表面串交给 office_cli set --find/--replace 做化名/打码;结构化 PII 另走正则。");
}
