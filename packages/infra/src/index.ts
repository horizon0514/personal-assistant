/**
 * @pa/infra — Model Gateway(pi-ai 的防腐封装)
 *
 * 对外只暴露"取一个模型句柄 + 解析 API key"。pi-ai 的具体类型不外泄到
 * domain-core / 渲染层。BYO key 经 ApiKeyResolver 注入(后续换 Keychain)。
 */
import {
  getEnvApiKey,
  getModel,
  registerBuiltInApiProviders,
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

// ── 本地持久化(workspace / session)──────────────────────────
export { readJson, writeJson } from "./persistence";
export { WorkspaceStore, type WorkspaceRecord } from "./workspace-store";
export { SessionStore, type SessionRecord } from "./session-store";
