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
import { PiAgentAdapter, createPiEvaluator, type AgentMessage } from "@pa/ctx-task";
import { MemoryStore, createMemoryTools, memoryGuidelines, memoryToolNames } from "@pa/ctx-memory";
import { createGatekeeper, riskClassifierFromMap, type ApprovalAsk } from "@pa/ctx-trust";
import { OperationJournal } from "@pa/ctx-reversibility";
import {
  createModel,
  envApiKeyResolver,
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
import { newConversationId, type Capability, type DomainEvent, type RiskLevel } from "@pa/domain-core";
import { buildSystemPrompt, buildSessionContext, buildEvaluatorPrompt } from "./system-prompt";
import { transcriptToTimeline, VIEWABLE_TOOLS } from "./transcript-to-timeline";
import { keyStore } from "./key-store";

const PROVIDER = import.meta.env.MAIN_VITE_PROVIDER ?? "deepseek";
const MODEL = import.meta.env.MAIN_VITE_MODEL ?? "deepseek-v4-flash";
const API_KEY = import.meta.env.MAIN_VITE_API_KEY;
// vision 覆盖:强行把模型标注为支持图片输入。默认关——已实测 deepseek-v4-flash 的 API
// 拒收 image_url(只认 text)。将来换到支持图片的模型时设 MAIN_VITE_VISION=1 开启。
const FORCE_VISION = import.meta.env.MAIN_VITE_VISION === "1";

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
    // 新记忆的情景里记下它从哪个会话学来的
    ...createMemoryTools(memory, () => broadcastMemory(wsId), () => sessionId)
  ];
  // 优先用户在设置里存的 key(safeStorage),其次构建期 .env(dev 兜底),最后环境变量
  const apiKeyResolver = async (provider: string): Promise<string | undefined> =>
    keyStore.get(provider) ?? API_KEY ?? (await envApiKeyResolver(provider));

  // 独立验收器:同模型 + 只读工具子集 + 挑剔的评估器提示,与执行器上下文隔离。
  const evaluator = createPiEvaluator({
    model,
    apiKeyResolver,
    systemPrompt: buildEvaluatorPrompt(),
    readonlyTools: tools.filter((t) => EVALUATOR_TOOLS.has(t.name))
  });

  return new PiAgentAdapter({
    model,
    apiKeyResolver,
    evaluator,
    systemPrompt: buildSystemPrompt({
      tools: tools.map((t) => ({ name: t.name, description: t.description })),
      guidelines: [filesystemGuidelines, documentGuidelines, browserGuidelines, memoryGuidelines]
    }),
    thinkingLevel: "high",
    tools,
    initialMessages,
    // 注入 [session context](环境信息,决策 2:不进字节冻结的 system prompt)+ 记忆召回。
    // 经 transformContext 作为前置消息每轮注入,不写入持久 transcript。
    contextProvider: () =>
      [buildSessionContext({ modelLabel: `${PROVIDER} · ${MODEL}` }), memory.render()]
        .filter((s): s is string => Boolean(s && s.trim()))
        .join("\n\n"),
    gatekeeper: createGatekeeper({
      riskOf: (call): RiskLevel =>
        // plan_file_changes 内部自做批量审批;记忆工具按决策自动执行+可见+可逆(不审批)
        call.tool === "plan_file_changes" || memoryToolNames.has(call.tool)
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
      // 落盘:transcript 快照 + 首条用户消息自动命名
      sessions.saveTranscript(sessionId, instance.snapshotTranscript());
      autoTitle(sessions, sessionId, text);
      broadcast("session:changed", sessions.list());
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

/** 会话仍叫「新会话」时,用首条用户消息生成标题。 */
function autoTitle(sessions: SessionStore, sessionId: string, firstText: string): void {
  const rec = sessions.list().find((s) => s.id === sessionId);
  if (rec && rec.title === "新会话") {
    const title = firstText.trim().replace(/\s+/g, " ").slice(0, 24);
    if (title) sessions.rename(sessionId, title);
  }
}
