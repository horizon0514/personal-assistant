/**
 * @pa/infra — Model Gateway(pi-ai 的防腐封装)
 *
 * 对外只暴露"取一个模型句柄 + 解析 API key"。pi-ai 的具体类型不外泄到
 * domain-core / 渲染层。BYO key 经 ApiKeyResolver 注入(后续换 Keychain)。
 */
import {
  completeSimple,
  getEnvApiKey,
  getModel,
  registerBuiltInApiProviders,
  type Message,
  type Model
} from "@earendil-works/pi-ai";

/** 不透明模型句柄。上层只负责传递,不解读其内部。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type ModelHandle = Model<any>;

export interface ModelSpec {
  readonly provider: string;
  readonly modelId: string;
}

/** BYO key 解析器。默认实现读环境变量;生产用 Keychain 实现替换。 */
export type ApiKeyResolver = (provider: string) => Promise<string | undefined>;

let registered = false;
function ensureProvidersRegistered(): void {
  if (!registered) {
    registerBuiltInApiProviders();
    registered = true;
  }
}

// getModel 在类型层强约束到已知 provider/model;我们以字符串 spec 驱动,放宽签名。
const looseGetModel = getModel as unknown as (provider: string, modelId: string) => ModelHandle;

export function createModel(spec: ModelSpec): ModelHandle {
  ensureProvidersRegistered();
  return looseGetModel(spec.provider, spec.modelId);
}

/** 默认 key 解析:环境变量。占位,后续替换为 Keychain 实现。 */
export const envApiKeyResolver: ApiKeyResolver = async (provider) => getEnvApiKey(provider);

export interface GenerateTextOptions {
  readonly system?: string;
  readonly prompt: string;
  readonly apiKey?: string;
  readonly maxTokens?: number;
  readonly signal?: AbortSignal;
}

/**
 * 一次性文本补全(防腐封装 pi-ai 的 completeSimple)。
 * 用于「会话标题生成」这类轻量、与主对话无关的调用——独立 Context,不碰任何
 * session transcript / 提示缓存。reasoning 固定 minimal 以求快。
 */
export async function generateText(model: ModelHandle, opts: GenerateTextOptions): Promise<string> {
  const messages: Message[] = [{ role: "user", content: opts.prompt, timestamp: Date.now() }];
  const result = await completeSimple(
    model,
    { systemPrompt: opts.system, messages },
    { apiKey: opts.apiKey, signal: opts.signal, maxTokens: opts.maxTokens ?? 64, reasoning: "minimal" }
  );
  return result.content
    .filter((c): c is { type: "text"; text: string } => c.type === "text")
    .map((c) => c.text)
    .join("")
    .trim();
}

// ── 本地持久化(workspace / session)──────────────────────────
export { readJson, writeJson } from "./persistence";
export { WorkspaceStore, type WorkspaceRecord } from "./workspace-store";
export { SessionStore, type SessionRecord } from "./session-store";
export { ScheduleStore, type ScheduleRecord, type ScheduleDraft } from "./schedule-store";
