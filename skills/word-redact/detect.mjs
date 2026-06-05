/**
 * 本地中文敏感实体检测(脱敏「纯本地模式」用)。
 *
 * 用法(由 word-redact 手册经 exec_shell 调用):
 *   node detect.mjs "要检测的中文文本"
 * 输出 JSON 数组:[{ "type":"人名|机构|地点/地址", "text":"表面串", "score":0-1 }]
 * 这些表面串直接喂回 office_cli `set --find/--replace` 做化名/打码。
 *
 * 纯本地:transformers.js + ONNX,onnxruntime 在本机 CPU 跑,文本不出本机。
 * 依赖(@huggingface/transformers)来自 app 提供的「Skill 共享运行时」——
 *   skills 根的 node_modules 符号链接,ESM 沿目录树向上即可解析,无需本 skill 自带依赖。
 * 模型权重缓存到本脚本同级的 .models/(首次联网下一次,之后离线)。
 *
 * 选型:BERT 多语种 NER(PER/ORG/LOC),中文实测高分;GLiNER 多语种版按空格切词、对中文不堪用(已淘汰)。
 * 详见 research/redact-local-ner。
 */
import { pipeline, env } from "@huggingface/transformers";

env.allowLocalModels = false;
env.cacheDir = new URL("./.models", import.meta.url).pathname; // 权重缓存留在 skill 目录下,可控、可离线复用

const MODEL = "Xenova/bert-base-multilingual-cased-ner-hrl";
const LABEL_ZH = { PER: "人名", ORG: "机构", LOC: "地点/地址" };
// 模型权重默认从 HuggingFace 下;连不上(如国内网络)则切国内镜像。仅换权重来源,待检测文本始终不出本机。
// 也可用环境变量 HF_ENDPOINT 显式指定镜像。
const HF_MIRROR = process.env.HF_ENDPOINT || "https://hf-mirror.com";

/** 加载 NER 流水线:先走默认 HF,失败(网络/超时)切镜像重试一次。 */
async function loadNer() {
  try {
    return await pipeline("token-classification", MODEL);
  } catch (e) {
    console.error(`[detect] HuggingFace 拉取失败(${e instanceof Error ? e.message : e}),改用镜像 ${HF_MIRROR} 重试…`);
    env.remoteHost = HF_MIRROR;
    return await pipeline("token-classification", MODEL);
  }
}

/** 检测人名/机构/地点,返回去重后的实体表面串(脱敏宁可多召回,阈值默认放低)。 */
export async function detectEntities(text, threshold = 0.5) {
  const ner = await loadNer();
  const raw = await ner(text, { aggregation_strategy: "simple" });
  const seen = new Map();
  for (const e of raw) {
    if (e.score < threshold) continue;
    const surface = String(e.word).replace(/\s+/g, ""); // 中文子词带空格,去掉还原表面串
    if (surface.length < 2) continue; // 单字噪声易误伤,丢弃
    const key = `${e.entity_group}:${surface}`;
    if (!seen.has(key) || seen.get(key).score < e.score) {
      seen.set(key, { type: LABEL_ZH[e.entity_group] ?? e.entity_group, text: surface, score: +e.score });
    }
  }
  return [...seen.values()].sort((a, b) => b.score - a.score);
}

const text = process.argv[2];
if (!text) {
  console.error('用法: node detect.mjs "要检测的中文文本"');
  process.exit(2);
}
const ents = await detectEntities(text, 0.5);
console.log(JSON.stringify(ents, null, 2));
