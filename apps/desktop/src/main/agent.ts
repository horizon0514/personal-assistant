/**
 * 组合根(composition root):把各限界上下文装配成 agent,并对外暴露 IPC facade。
 *
 * 阶段 2:workspace → session → step 落地为真实持久化。
 * - WorkspaceStore:workspace 列表 + 每 workspace 子树。
 * - 每 workspace 一份记忆(MemoryStore);每 workspace 一个 SessionStore。
 * - 每 session 一个 PiAgentAdapter(用持久化 transcript 播种,带记忆接着聊)。
 */
import { app, BrowserWindow, type WebContents } from "electron";
import { copyFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  PiAgentAdapter,
  createPiEvaluator,
  createContractTool,
  createAskUserTool,
  type AgentMessage
} from "@pa/ctx-task";
import { MemoryStore, createMemoryTools, memoryGuidelines, memoryToolNames } from "@pa/ctx-memory";
import { createGatekeeper, riskClassifierFromMap, type ApprovalAsk } from "@pa/ctx-trust";
import { OperationJournal } from "@pa/ctx-reversibility";
import {
  createModel,
  envApiKeyResolver,
  generateText,
  WorkspaceStore,
  SessionStore,
  type WorkspaceRecord,
  type SessionRecord
} from "@pa/infra";
import {
  createPlanFileChangesTool,
  filesystemGuidelines,
  filesystemReverser,
  filesystemTools,
  filesystemToolNames,
  filesystemToolRisk,
  type FileChangeOp
} from "@pa/cap-filesystem";
import { documentTools, documentToolNames, documentToolRisk, documentGuidelines } from "@pa/cap-document";
import { createBrowserTools, browserToolNames, browserToolRisk, browserGuidelines } from "@pa/cap-browser";
import { BrowserManager } from "./browser-manager";
import {
  newConversationId,
  type Capability,
  type DomainEvent,
  type RiskLevel,
  type SprintContract
} from "@pa/domain-core";
import { buildSystemPrompt, buildSessionContext, buildEvaluatorPrompt } from "./system-prompt";
import { transcriptToTimeline, VIEWABLE_TOOLS } from "./transcript-to-timeline";
import { keyStore } from "./key-store";

const PROVIDER = import.meta.env.MAIN_VITE_PROVIDER ?? "deepseek";
const MODEL = import.meta.env.MAIN_VITE_MODEL ?? "deepseek-v4-flash";
const API_KEY = import.meta.env.MAIN_VITE_API_KEY;
// vision 覆盖:强行把模型标注为支持图片输入。默认关——已实测 deepseek-v4-flash 的 API
// 拒收 image_url(只认 text)。将来换到支持图片的模型时设 MAIN_VITE_VISION=1 开启。
const FORCE_VISION = import.meta.env.MAIN_VITE_VISION === "1";

/** API key 解析:用户设置里存的(safeStorage)优先 → 构建期 .env(dev 兜底)→ 环境变量。 */
async function resolveApiKey(provider: string): Promise<string | undefined> {
  return keyStore.get(provider) ?? API_KEY ?? (await envApiKeyResolver(provider));
}

type ChatStreamEvent = { type: "delta"; text: string } | { type: "done" } | { type: "error"; message: string };

// 工具名 → Capability 注册表(各 capability 自报工具名;新增能力在此登记一行)。
const capabilityByTool = new Map<string, Capability>();
for (const t of memoryToolNames) capabilityByTool.set(t, "memory");
for (const t of filesystemToolNames) capabilityByTool.set(t, "filesystem");
for (const t of documentToolNames) capabilityByTool.set(t, "document");
for (const t of browserToolNames) capabilityByTool.set(t, "browser");
const capabilityOf = (tool: string): Capability => capabilityByTool.get(tool) ?? "filesystem";

// 评估器可用的只读工具(独立核查产出用;不含记忆写入/破坏性工具)。
const EVALUATOR_TOOLS = new Set([
  "list_dir",
  "read_file",
  "find_files",
  "grep_files",
  "extract_document",
  "read_current_page"
]);

// ── 持久化根 ─────────────────────────────────────────────────
const workspaces = new WorkspaceStore(join(app.getPath("userData"), "workspaces"));
let activeWorkspaceId = workspaces.ensureDefault();
let activeSessionId = "";

migrateLegacyMemory();

/** 旧版全局 memory.json → 并入默认 workspace(只做一次)。 */
function migrateLegacyMemory(): void {
  const legacy = join(app.getPath("userData"), "memory.json");
  const target = workspaces.memoryPath(activeWorkspaceId);
  if (existsSync(legacy) && !existsSync(target)) {
    try {
      copyFileSync(legacy, target);
    } catch {
      /* 迁移失败不致命:大不了从空记忆开始 */
    }
  }
}

// ── 每 workspace 的记忆 / 会话索引(惰性)────────────────────
const memoryStores = new Map<string, MemoryStore>();
function getMemory(wsId: string): MemoryStore {
  let s = memoryStores.get(wsId);
  if (!s) {
    s = new MemoryStore(workspaces.memoryPath(wsId));
    memoryStores.set(wsId, s);
  }
  return s;
}

const sessionStores = new Map<string, SessionStore>();
function getSessions(wsId: string): SessionStore {
  let s = sessionStores.get(wsId);
  if (!s) {
    s = new SessionStore(workspaces.dir(wsId));
    sessionStores.set(wsId, s);
  }
  return s;
}

// ── Reversibility(全局 journal)────────────────────────────
const journal = new OperationJournal();
journal.registerReverser("filesystem", filesystemReverser);

// ── 内置浏览器(全局保活,跨会话共享 persist 登录态)──────────
const browser = new BrowserManager();
const browserTools = createBrowserTools(browser);

// ── 审批 / 批量 桥 ──────────────────────────────────────────
let activeSender: WebContents | undefined;
const pendingApprovals = new Map<string, (approved: boolean) => void>();
const pendingBatches = new Map<string, (approved: boolean) => void>();
// Sprint Contract:待确认的契约请求 + 每会话已确认的契约(供评估器取用)。
const pendingContracts = new Map<string, (contract: SprintContract | null) => void>();
const contractsBySession = new Map<string, SprintContract>();
// ask_user:待用户回答的提问请求(requestId → resolve)。
const pendingAsks = new Map<string, (answer: string) => void>();

function sendTo(channel: string, payload: unknown): void {
  if (activeSender && !activeSender.isDestroyed()) activeSender.send(channel, payload);
}
function broadcast(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send(channel, payload);
  }
}
function broadcastMemory(wsId: string): void {
  broadcast("memory:changed", { wsId, items: getMemory(wsId).list() });
}
function broadcastJournal(): void {
  broadcast("reversibility:changed", journal.list());
}

function requestApproval(ask: ApprovalAsk): Promise<boolean> {
  return new Promise((resolve) => {
    pendingApprovals.set(ask.actionId, resolve);
    sendTo("approval:request", {
      actionId: ask.actionId,
      tool: ask.tool,
      capability: ask.capability,
      riskLevel: ask.riskLevel,
      args: ask.args
    });
  });
}
function requestBatchApproval(req: { actionId: string; operations: FileChangeOp[] }): Promise<boolean> {
  return new Promise((resolve) => {
    pendingBatches.set(req.actionId, resolve);
    sendTo("batch:request", req);
  });
}
/** 弹出契约确认卡,等用户确认(可改)/取消。返回确认后的契约或 null。 */
function requestContractConfirmation(proposed: SprintContract): Promise<SprintContract | null> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    pendingContracts.set(requestId, resolve);
    sendTo("contract:request", {
      requestId,
      deliverables: [...proposed.deliverables],
      criteria: [...proposed.criteria]
    });
  });
}
/** 弹出提问卡,等用户作答(自由输入或选项)。返回用户回答文本。 */
function requestUserAnswer(question: string, options: string[]): Promise<string> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    pendingAsks.set(requestId, resolve);
    sendTo("ask:request", { requestId, question, options: [...options] });
  });
}

// ── 每 session 一个 adapter(用 transcript 播种)─────────────
const adapters = new Map<string, PiAgentAdapter>();

function buildAdapter(wsId: string, sessionId: string, initialMessages?: AgentMessage[]): PiAgentAdapter {
  const memory = getMemory(wsId);
  const model = createModel({ provider: PROVIDER, modelId: MODEL, forceVision: FORCE_VISION });
  const modelHasVision = model.input.includes("image");
  // 模型不收图时不暴露 browser_screenshot——否则截图只会被降级成占位文字,纯误导模型。
  const activeBrowserTools = modelHasVision
    ? browserTools
    : browserTools.filter((t) => t.name !== "browser_screenshot");
  const tools = [
    ...filesystemTools,
    ...documentTools,
    ...activeBrowserTools,
    createPlanFileChangesTool(requestBatchApproval),
    // Sprint Contract:动手前与用户确认交付物 + 验收标准;确认后存到本会话供评估器取用
    createContractTool({
      confirm: requestContractConfirmation,
      onConfirmed: (contract) => contractsBySession.set(sessionId, contract)
    }),
    // 执行中遇到需用户拍板的岔路:提问并暂停等回答(避免擅自决定 / 误判任务已完成)
    createAskUserTool({ ask: requestUserAnswer }),
    // 新记忆的情景里记下它从哪个会话学来的
    ...createMemoryTools(memory, () => broadcastMemory(wsId), () => sessionId)
  ];

  // 独立验收器:同模型 + 只读工具子集 + 挑剔的评估器提示,与执行器上下文隔离。
  const evaluator = createPiEvaluator({
    model,
    apiKeyResolver: resolveApiKey,
    systemPrompt: buildEvaluatorPrompt(),
    readonlyTools: tools.filter((t) => EVALUATOR_TOOLS.has(t.name))
  });

  return new PiAgentAdapter({
    model,
    apiKeyResolver: resolveApiKey,
    evaluator,
    contractProvider: () => contractsBySession.get(sessionId),
    systemPrompt: buildSystemPrompt({
      tools: tools.map((t) => ({ name: t.name, description: t.description })),
      guidelines: [filesystemGuidelines, documentGuidelines, browserGuidelines, memoryGuidelines]
    }),
    thinkingLevel: "high",
    tools,
    initialMessages,
    // 注入 [session context](环境信息,决策 2:不进字节冻结的 system prompt)+ 记忆召回。
    // 经 transformContext 作为前置消息每轮注入,不写入持久 transcript。
    // 注意:不再注入 modelLabel —— 它把"当前模型:deepseek"喂进上下文,会诱导模型把自己
    // 当成底层 LLM 报家门,与 Akari 的助理身份冲突;且无任何代码依赖模型自知模型名。
    contextProvider: () =>
      [buildSessionContext(), memory.render()]
        .filter((s): s is string => Boolean(s && s.trim()))
        .join("\n\n"),
    gatekeeper: createGatekeeper({
      riskOf: (call): RiskLevel =>
        // plan_file_changes 内部自做批量审批;propose_contract/ask_user 自带交互卡;记忆工具自动执行+可见+可逆(均不走审批)
        call.tool === "plan_file_changes" ||
        call.tool === "propose_contract" ||
        call.tool === "ask_user" ||
        memoryToolNames.has(call.tool)
          ? "ReadOnly"
          : riskClassifierFromMap({ ...filesystemToolRisk, ...documentToolRisk, ...browserToolRisk })(call),
      requestApproval
    }),
    capabilityOf,
    onAssistantDelta: (text) => sendTo("chat:stream", { type: "delta", text } satisfies ChatStreamEvent),
    onEvent: (event: DomainEvent) => sendTo("domain:event", event),
    afterTool: ({ actionId, capability, tool, details, resultText, isError }) => {
      if (isError) return;
      // 注入检测:web_fetch 抓到疑似注入内容时,报领域事件 + 日志(纵深防御的"提示"层)
      const inj = details as { injectionSuspected?: boolean; injectionReasons?: string[]; url?: string } | undefined;
      if (inj?.injectionSuspected) {
        console.warn(`[security] 疑似 prompt injection @ ${inj.url ?? tool}:`, inj.injectionReasons?.join("、"));
        sendTo("domain:event", {
          type: "InjectionSuspected",
          actionId,
          source: inj.url ?? tool,
          reasons: inj.injectionReasons ?? []
        } satisfies DomainEvent);
      }
      // 可查看工具:把结果文本推给渲染层,供 step 行"查看"按钮重开到 artifact 面板
      if (VIEWABLE_TOOLS.has(tool) && resultText.trim()) {
        sendTo("step:result", { actionId, body: resultText });
      }
      const reversal = (details as { reversal?: { kind: string } & Record<string, unknown> } | undefined)?.reversal;
      if (!reversal) return;
      const summary =
        (details as { path?: string; to?: string } | undefined)?.path ??
        (details as { to?: string } | undefined)?.to ??
        tool;
      journal.record({ actionId, capability, tool, summary, reversal });
      broadcastJournal();
    }
  });
}

function getAdapter(sessionId: string): PiAgentAdapter {
  let a = adapters.get(sessionId);
  if (!a) {
    const seed = getSessions(activeWorkspaceId).loadTranscript(sessionId) as AgentMessage[] | undefined;
    a = buildAdapter(activeWorkspaceId, sessionId, seed);
    adapters.set(sessionId, a);
  }
  return a;
}

// ── facade ──────────────────────────────────────────────────
export const agent = {
  modelLabel: (): string => `${PROVIDER} · ${MODEL}`,

  // BYO key(全局单份,按当前 provider 存)
  apiKeyStatus: (): { provider: string; set: boolean; last4?: string } => ({
    provider: PROVIDER,
    ...keyStore.status(PROVIDER)
  }),
  setApiKey: (key: string): void => keyStore.set(PROVIDER, key.trim()),
  clearApiKey: (): void => keyStore.clear(PROVIDER),

  // Workspace
  listWorkspaces: (): WorkspaceRecord[] => workspaces.list(),
  activeWorkspace: (): string => activeWorkspaceId,
  createWorkspace: (name: string): WorkspaceRecord => workspaces.create(name),
  renameWorkspace: (wsId: string, name: string): WorkspaceRecord[] => {
    workspaces.rename(wsId, name);
    return workspaces.list();
  },
  /** 删除 workspace(级联清子树)。若删的是当前,切到剩余第一个。 */
  deleteWorkspace(wsId: string): { workspaces: WorkspaceRecord[]; activeWorkspaceId: string } {
    workspaces.remove(wsId);
    memoryStores.delete(wsId);
    sessionStores.delete(wsId);
    adapters.clear(); // 简单起见全清,下次按需从磁盘 transcript 重建
    const list = workspaces.list();
    if (!list.some((w) => w.id === activeWorkspaceId)) {
      activeWorkspaceId = list[0]?.id ?? activeWorkspaceId;
      activeSessionId = "";
    }
    return { workspaces: list, activeWorkspaceId };
  },
  switchWorkspace(wsId: string): void {
    activeWorkspaceId = wsId;
    activeSessionId = "";
    broadcastMemory(wsId);
  },

  // Session
  listSessions: (): SessionRecord[] => getSessions(activeWorkspaceId).list(),
  createSession(): SessionRecord {
    const rec = getSessions(activeWorkspaceId).create();
    activeSessionId = rec.id;
    return rec;
  },
  /** 打开会话:确保 adapter 已用 transcript 播种,返回重建好的 timeline。 */
  openSession(sessionId: string): unknown[] {
    activeSessionId = sessionId;
    getAdapter(sessionId); // 触发播种
    const transcript = getSessions(activeWorkspaceId).loadTranscript(sessionId);
    return transcriptToTimeline(transcript, capabilityOf);
  },
  /** 归档会话(可逆,保留 transcript):从列表隐藏。 */
  archiveSession(sessionId: string): void {
    getSessions(activeWorkspaceId).setArchived(sessionId, true);
    if (activeSessionId === sessionId) activeSessionId = "";
  },
  /** 当前 workspace 的已归档会话(供"已归档"列表查看/恢复)。 */
  listArchivedSessions: (): SessionRecord[] => getSessions(activeWorkspaceId).listArchived(),
  /** 恢复归档会话:重回活跃列表(广播 session:changed 让渲染层刷新)。 */
  unarchiveSession(sessionId: string): void {
    const sessions = getSessions(activeWorkspaceId);
    sessions.setArchived(sessionId, false);
    broadcast("session:changed", sessions.list());
  },

  async send(sender: WebContents, sessionId: string, text: string): Promise<void> {
    activeSender = sender;
    activeSessionId = sessionId;
    contractsBySession.delete(sessionId); // 新任务从无契约开始;本轮若签约由 propose_contract 重新写入
    const sessions = getSessions(activeWorkspaceId);

    let instance: PiAgentAdapter;
    try {
      instance = getAdapter(sessionId);
    } catch (err) {
      sendTo("chat:stream", { type: "error", message: `模型初始化失败:${String(err)}` } satisfies ChatStreamEvent);
      return;
    }
    try {
      await instance.startTask({ text, conversationId: newConversationId() });
      // 落盘:transcript 快照 + 首条用户消息自动命名(先截断占位)
      sessions.saveTranscript(sessionId, instance.snapshotTranscript());
      const placeholder = autoTitle(sessions, sessionId, text);
      broadcast("session:changed", sessions.list());
      // 首轮:异步用 AI 升级标题,不阻塞本次回复完成
      if (placeholder) void generateSessionTitle(sessions, sessionId, text, placeholder);
      // pi 出错时不抛异常,错误落在 state 里——主动捞出来让 UI 看到,而非静默结束。
      const runError = instance.lastError();
      if (runError) {
        console.error(`[chat] 运行带错误结束: ${runError}`);
        sendTo("chat:stream", { type: "error", message: runError } satisfies ChatStreamEvent);
      } else {
        sendTo("chat:stream", { type: "done" } satisfies ChatStreamEvent);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendTo("chat:stream", { type: "error", message } satisfies ChatStreamEvent);
    }
  },

  /** 停止某会话正在进行的运行(中断 agent loop)。 */
  stop(sessionId: string): void {
    adapters.get(sessionId)?.abort();
  },

  resolveApproval(actionId: string, approved: boolean): void {
    const resolve = pendingApprovals.get(actionId);
    if (resolve) {
      pendingApprovals.delete(actionId);
      resolve(approved);
    }
  },
  resolveBatch(actionId: string, approved: boolean): void {
    const resolve = pendingBatches.get(actionId);
    if (resolve) {
      pendingBatches.delete(actionId);
      resolve(approved);
    }
  },
  /** 用户对契约确认卡的回应:确认(可能改过)→ 传契约;取消 → 传 null。 */
  resolveContract(requestId: string, contract: SprintContract | null): void {
    const resolve = pendingContracts.get(requestId);
    if (resolve) {
      pendingContracts.delete(requestId);
      resolve(contract);
    }
  },
  /** 用户对提问卡的回答 → 喂回执行器,继续本轮。 */
  resolveAsk(requestId: string, answer: string): void {
    const resolve = pendingAsks.get(requestId);
    if (resolve) {
      pendingAsks.delete(requestId);
      resolve(answer);
    }
  },

  // Memory(按 wsId 参数化,设置窗自选 workspace,不漂移)
  listMemory: (wsId: string) => getMemory(wsId).list(),
  listForgottenMemory: (wsId: string) => getMemory(wsId).listForgotten(),
  removeMemory(wsId: string, id: string): void {
    getMemory(wsId).remove(id); // 软删(遗忘)
    broadcastMemory(wsId);
  },
  restoreMemory(wsId: string, id: string): void {
    getMemory(wsId).restore(id);
    broadcastMemory(wsId);
  },

  listJournal: () => journal.list(),
  async undoLast(): Promise<{ actionId: string; tool: string; summary: string } | null> {
    const entry = await journal.undoLast();
    broadcastJournal();
    return entry ? { actionId: entry.actionId, tool: entry.tool, summary: entry.summary } : null;
  }
};

const DEFAULT_TITLE = "新会话";

/**
 * 会话仍叫「新会话」时,先用首条用户消息截断占位(立即生效,避免侧栏空窗/闪烁)。
 * 返回所设的占位标题——非空表示这是首轮、随后可异步用 AI 升级标题;否则返回 undefined。
 */
function autoTitle(sessions: SessionStore, sessionId: string, firstText: string): string | undefined {
  const rec = sessions.list().find((s) => s.id === sessionId);
  if (rec && rec.title === DEFAULT_TITLE) {
    const title = firstText.trim().replace(/\s+/g, " ").slice(0, 24);
    if (title) {
      sessions.rename(sessionId, title);
      return title;
    }
  }
  return undefined;
}

/** AI 标题清洗:去引号/首尾标点/空白,压成一行,限长。 */
function sanitizeTitle(raw: string): string {
  return raw
    .replace(/\s+/g, " ")
    .replace(/^["'“”‘’「」『』\s]+|["'“”‘’「」『』。.!?！？\s]+$/g, "")
    .trim()
    .slice(0, 20);
}

/**
 * 首轮对话后,异步发一个独立的轻量调用让模型概括出简洁标题,原位替换占位标题。
 * 失败/为空则保留占位;且仅当标题仍是我们刚设的占位时才替换(不覆盖期间用户的手动改名)。
 */
async function generateSessionTitle(
  sessions: SessionStore,
  sessionId: string,
  firstText: string,
  placeholder: string
): Promise<void> {
  try {
    const model = createModel({ provider: PROVIDER, modelId: MODEL });
    const apiKey = await resolveApiKey(PROVIDER);
    const raw = await generateText(model, {
      apiKey,
      maxTokens: 32,
      system:
        "你是会话标题生成器。根据用户的首条消息,用中文概括其意图,生成一个简洁标题。" +
        "要求:不超过 12 个字;不带引号、标点和前后缀;只输出标题本身,不要任何解释。",
      prompt: firstText.slice(0, 2000)
    });
    const title = sanitizeTitle(raw);
    if (!title) return;
    const rec = sessions.list().find((s) => s.id === sessionId);
    if (rec && rec.title === placeholder) {
      sessions.rename(sessionId, title);
      broadcast("session:changed", sessions.list());
    }
  } catch (err) {
    console.warn(`[title] 自动生成标题失败,保留占位: ${String(err)}`);
  }
}
