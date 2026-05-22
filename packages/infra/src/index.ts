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
  /**
   * 实验性 vision 覆盖:强行把模型标注为支持图片输入。
   * pi-ai 仅凭 `model.input.includes("image")` 决定是否把工具返回的截图序列化为 image_url
   * 发给模型;部分新模型(如 deepseek-v4-flash)实际收图但 pi-ai 内置元数据滞后标成纯文本。
   * 置 true 时给模型 input 补上 "image",让截图真正送达。模型若不支持,API 会报错(可关掉)。
   */
  readonly forceVision?: boolean;
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
  const model = looseGetModel(spec.provider, spec.modelId);
  if (spec.forceVision && !model.input.includes("image")) {
    // 浅拷贝后改 input,避免污染 pi-ai 的全局模型表。
    return { ...model, input: [...model.input, "image"] };
  }
  return model;
}

/** 默认 key 解析:环境变量。占位,后续替换为 Keychain 实现。 */
export const envApiKeyResolver: ApiKeyResolver = async (provider) => getEnvApiKey(provider);

// ── 本地持久化(workspace / session)──────────────────────────
export { readJson, writeJson } from "./persistence";
export { WorkspaceStore, type WorkspaceRecord } from "./workspace-store";
export { SessionStore, type SessionRecord } from "./session-store";
