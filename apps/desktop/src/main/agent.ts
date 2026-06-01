/**
 * 组合根(composition root):把各限界上下文装配成 agent,并对外暴露 IPC facade。
 *
 * 阶段 2:workspace → session → step 落地为真实持久化。
 * - WorkspaceStore:workspace 列表 + 每 workspace 子树。
 * - 每 workspace 一份记忆(MemoryStore);每 workspace 一个 SessionStore。
 * - 每 session 一个 PiAgentAdapter(用持久化 transcript 播种,带记忆接着聊)。
 */
import { app, BrowserWindow, type WebContents } from "electron";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import type { AgentTool } from "@earendil-works/pi-agent-core";
import {
  PiAgentAdapter,
  createPiEvaluator,
  createPlanTool,
  createAskUserTool,
  type AgentMessage,
  type PlanConfirmation
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
import { createShellTools, shellToolNames, classifyShellRisk, shellGuidelines, type ShellSpec } from "@pa/cap-shell";
import { scanSkills, renderSkillsForContext, createUseSkillTool } from "@pa/ctx-skill";
import { BrowserManager } from "./browser-manager";
import {
  newConversationId,
  type Capability,
  type DomainEvent,
  type RiskLevel,
  type WorkPlan
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

/**
 * 跨平台 shell 底座解析(见 akari-goal:exec_shell 跨平台底座)。
 * 指定随包 shell(如 busybox)→ 三平台命令一致;未指定 → 回落系统默认 shell(当前行为,零回归)。
 * 打包 busybox 后,这里改为 app.isPackaged 时指向 resources 里的二进制 + args ["sh","-c"]。
 * 现阶段经 env 注入便于先行验证:MAIN_VITE_SHELL_BIN=可执行路径;MAIN_VITE_SHELL_ARGS=逗号分隔前置参数(busybox 用 "sh,-c",默认 "-c")。
 */
function resolveShellSpec(): ShellSpec | undefined {
  const bin = import.meta.env.MAIN_VITE_SHELL_BIN as string | undefined;
  if (!bin) return undefined;
  const argsRaw = (import.meta.env.MAIN_VITE_SHELL_ARGS as string | undefined) ?? "-c";
  return { bin, args: argsRaw.split(",").map((s) => s.trim()).filter(Boolean) };
}
const shellTools = createShellTools({ shell: resolveShellSpec() });

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
for (const t of shellToolNames) capabilityByTool.set(t, "shell");
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

// ── 渐进披露:工具目录(catalog)与按用户轮次的选择 ─────────────
// 设计:每条用户消息进来前,基于消息内容 + 上一轮真正用过的 capability,
// 从 catalog 里选出本轮要暴露的工具子集,赋给 agent.state.tools。
// system prompt 字节冻结(只按能力分区做散文描述,不枚举工具),
// 实际工具表每轮请求由 API tools 参数承载。catalog 未来加新 capability(如 MCP)只需新加一项。

/**
 * 一组按能力划分的工具及其披露规则。
 * - alwaysOn:每轮都暴露(对应"小而高频"的能力,门控收益低)
 * - matches:基于本轮用户消息文本判断是否启用(对应"大而非每次都用"的能力,如 browser)
 *
 * 选择最终结果 = alwaysOn ∪ matches 命中 ∪ 上一轮真正用过 ∪ alwaysOnExtras
 */
interface CapabilityGroup {
  capability: Capability;
  tools: AgentTool[];
  /** true 则每轮都暴露;false 时由 matches/recent 决定 */
  alwaysOn: boolean;
  /** 用户消息文本里命中即启用本轮(可选,通常给非 alwaysOn 的能力配) */
  matches?: (userText: string) => boolean;
}

/**
 * 启用 browser 工具组的关键词。命中即把整组浏览器工具暴露给本轮。
 * 宁多勿少:漏一个常见词导致本轮拿不到 browser 比多挂一组更糟。
 */
const BROWSER_KEYWORDS =
  /网页|网址|网站|链接|搜索|搜一下|搜个|查一下|查询|调研|google|baidu|百度|bing|url|https?:\/\/|打开.{0,4}页|浏览器|页面|在线|登录/i;

/**
 * 启用 shell 工具组的关键词。命中即把 exec_shell 暴露给本轮。
 * 只在该用户明确要执行命令时才暴露,避免模型随意调起 shell。
 */
const SHELL_KEYWORDS =
  /shell|终端|命令行|命令|执行|运行|跑一下|git |npm |pnpm |yarn |node |python |bash |zsh |chmod|chown|mkdir|rm |cp |mv |ls |cat |grep |find |du |df |ps |kill|brew |curl |wget |tar |zip |unzip|docker |kubectl|ssh |scp/i;

/**
 * 注入 system prompt 的能力分区描述。**字节冻结**:同一份描述跨 session/天/adapter 重建必须逐字节相同。
 * 不逐工具枚举——实际工具集每轮由 API tools 参数承载。
 */
const CAPABILITY_DESCRIPTIONS = [
  {
    name: "filesystem",
    summary: "本地文件系统操作:列目录、读文件、按名/内容查找、写入,以及批量移动/删除(带审批与回滚)。"
  },
  { name: "document", summary: "本地文档抽取(PDF / 纯文本类)成纯文本以便阅读总结。" },
  {
    name: "browser",
    summary: "内置浏览器调研与操作:搜索、抓正文(可后台并发)、可见面板打开/读当前、点击/输入/截图。详见下方「网页调研」「网页操作」指南。"
  },
  { name: "memory", summary: "用户偏好/事实的长期记忆:记下、更新、遗忘、查来龙去脉。详见下方「记忆」指南。" },
  {
    name: "task",
    summary: "(永远可用)重要的开放任务动手前用 propose_plan 对齐交付物与验收标准(见「开工对齐」)。"
  },
  {
    name: "shell",
    summary: "在用户本机执行 shell 命令并返回输出。纯只读命令自动跑,写/改状态的命令需审批。详见下方「Shell 执行」指南。"
  }
];

// 每会话「上一轮真正用过的 capability」累积器(渐进披露的 continuation 兜底,见 send / afterTool)。
const recentBySession = new Map<string, Set<Capability>>();
// 每会话工具选择器(buildAdapter 时绑定 sessionId 闭包,send 里读取)。
const selectorsBySession = new Map<string, (userText: string, recent: Set<Capability>) => AgentTool[]>();

// ── 持久化根 ─────────────────────────────────────────────────
const workspaces = new WorkspaceStore(join(app.getPath("userData"), "workspaces"));
let activeWorkspaceId = workspaces.ensureDefault();
let activeSessionId = "";

// Skill 热插拔根目录(用户可往里丢文件夹,无需重启即生效)。每轮 send 经 contextProvider 重扫。
const SKILLS_DIR = join(app.getPath("userData"), "skills");
mkdirSync(SKILLS_DIR, { recursive: true });

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
// Work Plan:待确认的计划请求 + 每会话已确认的计划(供评估器取用)。
const pendingPlans = new Map<string, (result: PlanConfirmation) => void>();
const plansBySession = new Map<string, WorkPlan>();
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
/** 弹出开工对齐卡,等用户决定(就这么干 / 不对调一下 / 取消)。 */
function requestPlanConfirmation(proposed: WorkPlan): Promise<PlanConfirmation> {
  return new Promise((resolve) => {
    const requestId = crypto.randomUUID();
    pendingPlans.set(requestId, resolve);
    sendTo("plan:request", {
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

  // 工具目录:按 capability 分组 + 披露规则。新增 capability(如以后接 MCP)就加一项。
  const catalog: CapabilityGroup[] = [
    {
      capability: "filesystem",
      alwaysOn: true,
      tools: [...filesystemTools, createPlanFileChangesTool(requestBatchApproval)]
    },
    { capability: "document", alwaysOn: true, tools: [...documentTools] },
    {
      capability: "memory",
      alwaysOn: true,
      tools: createMemoryTools(memory, () => broadcastMemory(wsId), () => sessionId)
    },
    {
      capability: "browser",
      alwaysOn: false,
      matches: (text) => BROWSER_KEYWORDS.test(text),
      tools: activeBrowserTools
    },
    {
      capability: "shell",
      alwaysOn: false,
      matches: (text) => SHELL_KEYWORDS.test(text),
      tools: [...shellTools]
    }
  ];
  // 不属于具体 capability、但总是要暴露的工具(propose_plan 是任务编排级,跟具体能力域无关)。
  const alwaysOnExtras: AgentTool[] = [
    createPlanTool({
      confirm: requestPlanConfirmation,
      onConfirmed: (plan) => plansBySession.set(sessionId, plan)
    }),

    // 执行中遇到需用户拍板的岔路:提问并暂停等回答(避免擅自决定 / 误判任务已完成)
    createAskUserTool({ ask: requestUserAnswer }),

    // Skill 原语:按名加载热插拔能力的操作手册(列表每次热读盘)。唯一的 skill 工具,新增 skill 不加任何工具。
    createUseSkillTool({ list: () => scanSkills(SKILLS_DIR) })
  ];
  /** 全集:评估器筛选只读子集用 + 适配器初始 tools(send 里会被本轮选择结果覆盖)。 */
  const allTools: AgentTool[] = [...catalog.flatMap((g) => g.tools), ...alwaysOnExtras];

  /**
   * 本轮工具选择器:alwaysOn ∪ matches 命中 ∪ recent(上一轮真正用过的 capability)∪ alwaysOnExtras。
   * recent 是 continuation 兜底——比如上一轮用了 browser,本轮用户只回"好了",关键词不会命中,
   * 但 recent 里还有 browser,这一轮仍把 browser 工具组挂上,模型才能接着干。
   */
  const selectTools = (userText: string, recent: Set<Capability>): AgentTool[] => {
    const out: AgentTool[] = [...alwaysOnExtras];
    for (const g of catalog) {
      if (g.alwaysOn || recent.has(g.capability) || (g.matches?.(userText) ?? false)) {
        out.push(...g.tools);
      }
    }
    return out;
  };
  selectorsBySession.set(sessionId, selectTools);

  // 独立验收器:与执行器的"按轮选择"无关——评估器要看得见所有只读工具,从全集筛。
  const evaluator = createPiEvaluator({
    model,
    apiKeyResolver: resolveApiKey,
    systemPrompt: buildEvaluatorPrompt(),
    readonlyTools: allTools.filter((t) => EVALUATOR_TOOLS.has(t.name))
  });

  return new PiAgentAdapter({
    model,
    apiKeyResolver: resolveApiKey,
    evaluator,
    planProvider: () => plansBySession.get(sessionId),
    systemPrompt: buildSystemPrompt({
      capabilities: CAPABILITY_DESCRIPTIONS,
      guidelines: [filesystemGuidelines, documentGuidelines, browserGuidelines, memoryGuidelines, shellGuidelines]
    }),
    thinkingLevel: "high",
    // 初始挂全集;每条用户消息进来前会被 selectTools 重新设置为本轮子集(send 里)。
    tools: allTools,
    initialMessages,
    // 注入 [session context](环境信息,决策 2:不进字节冻结的 system prompt)+ 记忆召回。
    // 经 transformContext 作为前置消息每轮注入,不写入持久 transcript。
    // 注意:不再注入 modelLabel —— 它把"当前模型:deepseek"喂进上下文,会诱导模型把自己
    // 当成底层 LLM 报家门,与 Akari 的助理身份冲突;且无任何代码依赖模型自知模型名。
    contextProvider: () =>
      // 注:Skill 清单走这里(每轮重扫=热加载),不进冻结的 system prompt——既保持缓存纪律,又让新装的 skill 下条消息即生效。
      [buildSessionContext(), memory.render(), renderSkillsForContext(scanSkills(SKILLS_DIR))]
        .filter((s): s is string => Boolean(s && s.trim()))
        .join("\n\n"),
    gatekeeper: createGatekeeper({
      riskOf: (call): RiskLevel => {
        // plan_file_changes 内部自做批量审批;propose_plan/ask_user 自带交互卡;记忆工具自动执行+可见+可逆(均不走审批)
        if (
          call.tool === "plan_file_changes" ||
          call.tool === "propose_plan" ||
          call.tool === "ask_user" ||
          call.tool === "use_skill" ||
          memoryToolNames.has(call.tool)
        )
          return "ReadOnly";
        // exec_shell 风险取决于命令内容:纯只读自动跑,写/改/拿不准的走审批
        if (call.tool === "exec_shell") return classifyShellRisk(String(call.args.command ?? ""));
        return riskClassifierFromMap({ ...filesystemToolRisk, ...documentToolRisk, ...browserToolRisk })(call);
      },
      requestApproval
    }),
    capabilityOf,
    onAssistantDelta: (text) => sendTo("chat:stream", { type: "delta", text } satisfies ChatStreamEvent),
    // 增量落盘:每个 assistant turn 收尾即持久化快照,运行中(含卡在审批/规划)也不丢对话。
    onTurnEnd: (transcript) => getSessions(wsId).saveTranscript(sessionId, transcript),
    onEvent: (event: DomainEvent) => sendTo("domain:event", event),
    afterTool: ({ actionId, capability, tool, details, resultText, isError }) => {
      if (isError) return;
      // 渐进披露:记下本轮真正用了哪些 capability,下条用户消息进来时把它们继续保留(continuation 兜底)
      let recent = recentBySession.get(sessionId);
      if (!recent) {
        recent = new Set();
        recentBySession.set(sessionId, recent);
      }
      recent.add(capability);
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
    selectorsBySession.clear();
    recentBySession.clear();
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
    plansBySession.delete(sessionId); // 新任务从无计划开始;本轮若对齐由 propose_plan 重新写入
    const sessions = getSessions(activeWorkspaceId);

    let instance: PiAgentAdapter;
    try {
      instance = getAdapter(sessionId);
    } catch (err) {
      sendTo("chat:stream", { type: "error", message: `模型初始化失败:${String(err)}` } satisfies ChatStreamEvent);
      return;
    }
    try {
      // 渐进披露:从 catalog 选出本轮要暴露的工具子集,赋给 agent.state.tools。
      // 时序:读取「上一轮真正用过的 capability」用作 continuation 兜底,然后清零本轮的累加器,
      //      再调 selectTools(基于用户文本 + recent),最后 setTools。
      // pi 的 createContextSnapshot 在 startTask 触发的 prompt() 开头快照 state.tools,故必须在 startTask 之前调用。
      const selector = selectorsBySession.get(sessionId);
      if (selector) {
        const prevRecent = recentBySession.get(sessionId) ?? new Set<Capability>();
        recentBySession.set(sessionId, new Set()); // 重置:本轮的累加从空开始
        instance.setTools(selector(text, prevRecent));
      }
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
  /** 用户对开工对齐卡的回应:就这么干 / 不对调一下 / 取消。 */
  resolvePlan(requestId: string, result: PlanConfirmation): void {
    const resolve = pendingPlans.get(requestId);
    if (resolve) {
      pendingPlans.delete(requestId);
      resolve(result);
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
