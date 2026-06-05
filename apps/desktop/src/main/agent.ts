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
import { basename, join } from "node:path";
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
import {
  createGatekeeper,
  riskClassifierFromMap,
  type ApprovalAsk,
  type ApprovalDecision,
  type RememberKey
} from "@pa/ctx-trust";
import { rememberStore } from "./approval-allowlist";
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
import { createDocumentTools, documentToolNames, documentToolRisk, documentGuidelines, extractDocument } from "@pa/cap-document";
import { NotebookStore, createNotebookTools, notebookToolNames, notebookGuidelines, addSourceToNotebook } from "@pa/ctx-notebook";
import { createBrowserTools, browserToolNames, browserToolRisk, browserGuidelines } from "@pa/cap-browser";
import { createShellTools, shellToolNames, classifyShellRisk, shellGuidelines, type ShellSpec } from "@pa/cap-shell";
import { createOfficeTools, officeToolNames, classifyOfficeRisk, officeGuidelines } from "@pa/cap-office";
import { scanSkills, renderSkillsForContext, createUseSkillTool } from "@pa/ctx-skill";
import { BrowserManager } from "./browser-manager";
import { createSearchHistoryTool, searchHistoryToolName } from "./history-search";
import { createScheduleTools, scheduleToolNames, scheduleGuidelines } from "./schedule-tools";
import { schedules } from "./scheduler";
import { ensureSkillRuntime } from "./skill-runtime";
import {
  newConversationId,
  type Capability,
  type DomainEvent,
  type RiskLevel,
  type WorkPlan
} from "@pa/domain-core";
import { buildSystemPrompt, buildSessionContext, buildEvaluatorPrompt } from "./system-prompt";
import { transcriptToTimeline, VIEWABLE_TOOLS } from "./transcript-to-timeline";
import { recordEval } from "./eval-telemetry";
import { keyStore } from "./key-store";

const PROVIDER = import.meta.env.MAIN_VITE_PROVIDER ?? "deepseek";
const MODEL = import.meta.env.MAIN_VITE_MODEL ?? "deepseek-v4-flash";
const API_KEY = import.meta.env.MAIN_VITE_API_KEY;

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
for (const t of notebookToolNames) capabilityByTool.set(t, "notebook");
for (const t of browserToolNames) capabilityByTool.set(t, "browser");
for (const t of shellToolNames) capabilityByTool.set(t, "shell");
for (const t of officeToolNames) capabilityByTool.set(t, "office");
capabilityByTool.set(searchHistoryToolName, "memory"); // 跨对话回忆,归入记忆能力
for (const t of scheduleToolNames) capabilityByTool.set(t, "schedule");
const capabilityOf = (tool: string): Capability => capabilityByTool.get(tool) ?? "filesystem";

// 评估器可用的只读工具(独立核查产出用;不含记忆写入/破坏性工具)。
// 验收器的只读核查工具子集。含 read_current_page:网页类任务里验收器要靠它核查页面真实状态。
// (它现在是安全的——current() 没有已打开页面时只如实回报、绝不拉起空浏览器面板,见 browser-manager。)
const EVALUATOR_TOOLS = new Set([
  "list_dir",
  "read_file",
  "find_files",
  "grep_files",
  "extract_document",
  "notebook_list",
  "notebook_search",
  "notebook_read_source",
  "read_current_page"
]);

// 验收门用:某次工具调用是否「改动了真实状态」。只读/纯聊天任务没动状态、又没契约时不验收
// (避免无谓返工)。静态风险非 ReadOnly 即视为改动;exec_shell 按命令内容分级(纯只读命令不算)。
const MUTATING_RISK = new Set<RiskLevel>(["ReversibleMutating", "Destructive", "ExternalStateChanging"]);
const STATIC_TOOL_RISK: Readonly<Record<string, RiskLevel>> = {
  ...filesystemToolRisk,
  ...documentToolRisk,
  ...browserToolRisk
};
/** 从 office_cli 的 argsText({args:[...]} 的 JSON)里解出参数数组;解析失败 → 空数组(classifyOfficeRisk 会保守判 Destructive)。 */
function officeArgsFromText(argsText: string): string[] {
  try {
    const parsed = JSON.parse(argsText) as { args?: unknown };
    return Array.isArray(parsed.args) ? parsed.args.filter((a): a is string => typeof a === "string") : [];
  } catch {
    return [];
  }
}
function isMutatingTool(tool: string, argsText: string): boolean {
  // exec_shell:风险取决于命令;同 gatekeeper 用 skill 自声明的"已知安全"模式判定,非只读才算改动。
  if (tool === "exec_shell")
    return classifyShellRisk(argsText, scanSkills(SKILLS_DIR).flatMap((s) => s.safeShell)) !== "ReadOnly";
  // office_cli:风险取决于子命令;argsText 是 {args:[...]} 的 JSON,解出数组按子命令分级,非只读才算改动。
  if (tool === "office_cli") return classifyOfficeRisk(officeArgsFromText(argsText)) !== "ReadOnly";
  if (tool === "plan_file_changes") return true; // 批量 move/delete,风险表外的特例(它内部自做审批)
  const risk = STATIC_TOOL_RISK[tool];
  return risk ? MUTATING_RISK.has(risk) : false; // 记忆/定时/propose_plan/ask 等不在表内 → 非"交付物式"改动,不触发验收
}

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
  /**
   * 该能力的使用指南。**gated 能力**(browser/shell/schedule)把 guideline 挂这里——本轮被选中才随工具一起
   * 经 contextProvider 注入,与 selectTools 同一道门,避免给无关任务背编排说明。
   * **always-on 能力**(fs/doc/memory)不挂这里,其 guideline 留在字节冻结的 system prompt(反正每轮都在,零缓存损失)。
   */
  guideline?: string;
}

/**
 * 启用 shell 工具组的关键词。命中即把 exec_shell 暴露给本轮。
 * 只在该用户明确要执行命令时才暴露,避免模型随意调起 shell。
 */
const SHELL_KEYWORDS =
  /shell|终端|命令行|命令|执行|运行|跑一下|git |npm |pnpm |yarn |node |python |bash |zsh |chmod|chown|mkdir|rm |cp |mv |ls |cat |grep |find |du |df |ps |kill|brew |curl |wget |tar |zip |unzip|docker |kubectl|ssh |scp/i;

/**
 * 启用 office 工具组的关键词。命中(提到 Office 文档/格式/编辑动作)即把 office_cli 暴露给本轮。
 * 与 shell 同为 gated:不提 Office 的任务不背它(省工具 schema + 避免误用)。
 */
const OFFICE_KEYWORDS =
  /office|word|excel|powerpoint|\bppt\b|docx|xlsx|pptx|幻灯片|演示文稿|电子表格|工作簿|单元格|做个?(表格|幻灯|ppt|演示文稿)|word\s?文档/i;

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
    name: "notebook",
    summary: "知识库(来源集):把若干本地文档攒进一个库并缓存逐页文本,便于基于这批资料反复问答;可新建/加入/查看/移出来源。详见下方「知识库」指南。"
  },
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
  },
  {
    name: "schedule",
    summary: "定时任务:用自然语言设定「到点(每天/指定星期某时刻)自动跑一条指令并通知」,以及查看/修改/暂停/取消已有定时。别让用户去面板填表单。详见下方「定时任务」指南。"
  },
  {
    name: "office",
    summary: "读/改/新建 Word(.docx)、Excel(.xlsx)、PowerPoint(.pptx),无需安装 Office。读类自动执行,改文件需审批。详见下方「Office 文档」指南。"
  }
];

// 每会话「上一轮真正用过的 capability」累积器(渐进披露的 continuation 兜底,见 send / afterTool)。
const recentBySession = new Map<string, Set<Capability>>();
/** 本轮选择结果:暴露的工具子集 + 选中 gated 能力的 guideline 串(随 selectTools 同一道门算出)。 */
interface TurnSelection {
  tools: AgentTool[];
  guideline: string;
}
// 每会话工具选择器(buildAdapter 时绑定 sessionId 闭包,send 里读取)。
const selectorsBySession = new Map<string, (userText: string, recent: Set<Capability>) => TurnSelection>();
// 每会话「本轮 gated guideline 串」(send 里随 selectTools 写入,contextProvider 按轮注入)。
const turnGuidelineBySession = new Map<string, string>();
// 每会话「本轮用户拖入附件的本地路径」(send 里拷贝后写入,contextProvider 按轮注入给 agent;
// 用户消息气泡只显示文件名,完整路径走这里,避免长路径污染对话)。
const turnAttachmentsBySession = new Map<string, string[]>();

/** 把本轮附件的绝对路径渲染成给 agent 的上下文块(无附件 → undefined,不注入)。 */
function renderTurnAttachments(paths: string[] | undefined): string | undefined {
  if (!paths || paths.length === 0) return undefined;
  return [
    "## 本轮附件(用户随这条消息拖入,已存到本地)",
    "需要其内容时用 extract_document(PDF/文本)按下列绝对路径读取,别让用户再贴一遍:",
    ...paths.map((p) => `- ${p}`)
  ].join("\n");
}

/**
 * 把「本对话绑定的知识库」渲染成给 agent 的上下文块。
 * 库不存在(被删/改名)→ undefined,不注入,避免误导模型去搜一个空库。
 */
function renderBoundNotebook(name: string | undefined, wsId: string): string | undefined {
  if (!name) return undefined;
  const nb = getNotebook(wsId).getNotebook(name);
  if (!nb) return undefined;
  const list = nb.sources.length
    ? nb.sources.map((s) => `- ${s.name}(${s.pageCount} 页${s.error ? "、⚠ 未识别" : ""})`).join("\n")
    : "(暂无来源)";
  return [
    `## 当前对话已绑定知识库「${nb.name}」`,
    "用户在此对话里的提问,默认就是问这个知识库——除非用户明确转向别处:",
    "- 优先用 notebook_search / notebook_read_source 在本库内检索、读原文,据此作答并标页码引用(如 [xx.pdf, p.3])。",
    "- 只依据本库来源,别用先验知识硬补;库里确实没有就直说,并说明搜了哪些词。",
    "- 用户说「加这份 / 收进来」时,notebook_add_source 默认加到本库。",
    `本库现有来源(${nb.sourceCount} 份):`,
    list
  ].join("\n");
}

// ── 持久化根 ─────────────────────────────────────────────────
const workspaces = new WorkspaceStore(join(app.getPath("userData"), "workspaces"));
let activeWorkspaceId = workspaces.ensureDefault();
let activeSessionId = "";

// Skill 热插拔根目录(用户可往里丢文件夹,无需重启即生效)。每轮 send 经 contextProvider 重扫。
const SKILLS_DIR = join(app.getPath("userData"), "skills");
mkdirSync(SKILLS_DIR, { recursive: true });

// 「本 app 版本自己的 Release」附件下载基址。OCR 运行时 / 脚本 Skill 运行时都从这里按平台取,
// 故 app 与各运行时版本天然一致。
const RELEASE_DL_BASE = "https://github.com/horizon0514/personal-assistant/releases/download";

// OCR 原生运行时(PaddleOCR 栈 ≈ 90–100MB)不随 app 包:打包后按需从 Release 下载到 userData。
// dev/未打包:返回 null → cap-document 走 node_modules 里的 OCR 栈,不下载。
// release workflow 按平台产出 ocr-runtime-<plat>-<arch>.tar.gz;Intel Mac(darwin-x64)无对应附件 → 优雅降级。
function ocrRuntime(): { dir: string; url: string } | null {
  if (!app.isPackaged) return null;
  const version = app.getVersion();
  const platform = `${process.platform}-${process.arch}`;
  return {
    dir: join(app.getPath("userData"), "ocr-runtime", version),
    url: `${RELEASE_DL_BASE}/v${version}/ocr-runtime-${platform}.tar.gz`
  };
}
/** 组合根:统一构造 cap-document 的 OCR 选项(模型缓存目录 + 外置运行时 + 可选进度回调)。 */
function ocrDocOptions(onProgress?: (actionId: string, note: string) => void): {
  ocrModelDir: string;
  ocrRuntime: { dir: string; url: string } | null;
  onProgress?: (actionId: string, note: string) => void;
} {
  return { ocrModelDir: join(app.getPath("userData"), "paddleocr"), ocrRuntime: ocrRuntime(), onProgress };
}

// 脚本 Skill 共享运行时:打包后从本版本 Release 下预构建 tar(含对应平台原生 onnxruntime),用户机器免 npm;
// dev 返回 undefined → ensureSkillRuntime 走本机 npm install。启动时预热(幂等+去重;无脚本 Skill 直接跳过)。
function skillRuntimeTarballUrl(): string | undefined {
  if (!app.isPackaged) return undefined;
  const version = app.getVersion();
  return `${RELEASE_DL_BASE}/v${version}/skill-runtime-${process.platform}-${process.arch}.tar.gz`;
}
void ensureSkillRuntime({
  runtimeRoot: join(app.getPath("userData"), "skill-runtime"),
  skillsDir: SKILLS_DIR,
  tarballUrl: skillRuntimeTarballUrl(),
  onProgress: (note) => console.log(`[skill-runtime] ${note}`)
}).then((r) => {
  if (!r.ok) console.warn(`[skill-runtime] 准备失败(脚本 Skill 将不可用): ${r.error}`);
});

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

const notebookStores = new Map<string, NotebookStore>();
function getNotebook(wsId: string): NotebookStore {
  let s = notebookStores.get(wsId);
  if (!s) {
    s = new NotebookStore(workspaces.notebooksDir(wsId));
    notebookStores.set(wsId, s);
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
const pendingApprovals = new Map<string, (decision: ApprovalDecision) => void>();
const pendingBatches = new Map<string, (approved: boolean) => void>();
// Work Plan:待确认的计划请求 + 每会话已确认的计划(供评估器取用)。
const pendingPlans = new Map<string, (result: PlanConfirmation) => void>();
const plansBySession = new Map<string, WorkPlan>();
// ask_user:待用户回答的提问请求(requestId → resolve)。
const pendingAsks = new Map<string, (answer: string) => void>();
// 运行代际:每条 send 自增一次;用户在验收期发来新消息会打断旧 run——旧 run 收尾时
// 若代际已被新 send 顶替,就别再往流里发 done/error(否则会误关掉新 run 的流)。
const runGenBySession = new Map<string, number>();

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
function broadcastNotebooks(wsId: string): void {
  broadcast("notebook:changed", { wsId, notebooks: getNotebook(wsId).listNotebooks() });
}
/** 定时任务 NL 工具:模型从一句话建/查/改/删,变更后广播 schedule:changed 让面板实时刷新。 */
const scheduleTools = createScheduleTools({
  list: () => schedules.list(),
  create: (draft) => schedules.create(draft),
  update: (id, patch) => schedules.update(id, patch),
  remove: (id) => schedules.remove(id),
  onChange: () => broadcast("schedule:changed", schedules.list())
});

function broadcastJournal(): void {
  broadcast("reversibility:changed", journal.list());
}

function requestApproval(ask: ApprovalAsk): Promise<ApprovalDecision> {
  return new Promise((resolve) => {
    pendingApprovals.set(ask.actionId, resolve);
    sendTo("approval:request", {
      actionId: ask.actionId,
      tool: ask.tool,
      capability: ask.capability,
      riskLevel: ask.riskLevel,
      args: ask.args,
      // 可记忆则带说明:UI 据此显示「总是同意」按钮(点了 → 同类操作以后免审批)。
      rememberLabel: ask.rememberKey?.label ?? null
    });
  });
}

/**
 * 从一次调用提取「记忆键」(同类操作的稳定标识),null = 不可记忆(始终逐次审批)。
 * 粒度 = 命令头 + 子命令(改参数仍算同类);仅 shell / office 支持,其余工具暂逐次审批。
 */
function rememberKeyOf(call: { tool: string; args: Readonly<Record<string, unknown>> }): RememberKey | null {
  if (call.tool === "exec_shell") {
    const cmd = String(call.args.command ?? "").trim();
    // 含管道/重定向/命令替换/链接的复合命令成分太杂,不归类记忆 —— 逐条问更安全。
    if (!cmd || /[|&;<>`$]/.test(cmd)) return null;
    const toks = cmd.split(/\s+/);
    const head = toks[0];
    const sub = toks[1] && !toks[1].startsWith("-") ? toks[1] : undefined;
    const sig = sub ? `${head} ${sub}` : head;
    return { id: `shell:${sig}`, label: `${sig} 命令` };
  }
  if (call.tool === "office_cli") {
    const args = Array.isArray(call.args.args) ? (call.args.args as string[]) : [];
    const sub = args.find((a) => !a.startsWith("-"))?.toLowerCase();
    if (!sub) return null;
    return { id: `office:${sub}`, label: `Office ${sub} 操作` };
  }
  return null;
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

function buildAdapter(
  wsId: string,
  sessionId: string,
  initialMessages?: AgentMessage[],
  opts: { background?: boolean } = {}
): PiAgentAdapter {
  // background:定时任务的无人值守运行。不把流式增量/领域事件/可查看结果推给渲染层
  //（否则后台任务的 token 会串进用户当前打开的会话视图);transcript 仍照常落盘。
  const background = opts.background ?? false;
  const memory = getMemory(wsId);
  const model = createModel({ provider: PROVIDER, modelId: MODEL });
  // 文档工具:OCR 是基础能力;模型缓存 + 外置运行时经 ocrDocOptions 注入;onProgress 把"正在识别/下载"亮到 step 行。
  const onDocProgress = (actionId: string, note: string): void => {
    if (!background) sendTo("step:progress", { actionId, note });
  };
  const documentTools = createDocumentTools(ocrDocOptions(onDocProgress));
  // Office 工具:OfficeCLI 二进制按需下载到缓存目录(组合根注入);onProgress 把"正在下载运行时"亮到 step 行。
  const officeBinDir = join(app.getPath("userData"), "officecli");
  const officeTools = createOfficeTools({ officeBinDir, onProgress: onDocProgress });
  // 知识库(来源集):入库复用 cap-document 的抽取器(注入,保持 ctx-notebook 与 cap 解耦);每 workspace 一份。
  // onChange → 广播 notebook:changed,agent 在对话里增删来源时左侧面板实时刷新。
  const notebookTools = createNotebookTools(
    getNotebook(wsId),
    (path, actionId) => extractDocument(path, ocrDocOptions(onDocProgress), actionId),
    () => broadcastNotebooks(wsId)
  );

  // 工具目录:按 capability 分组 + 披露规则。新增 capability(如以后接 MCP)就加一项。
  const catalog: CapabilityGroup[] = [
    {
      capability: "filesystem",
      alwaysOn: true,
      tools: [...filesystemTools, createPlanFileChangesTool(requestBatchApproval)]
    },
    {
      // 工具集在上面装配:extract_document(含 PaddleOCR 扫描件 OCR + onProgress 进度上报)。
      capability: "document",
      alwaysOn: true,
      tools: documentTools
    },
    {
      // 知识库:add/list/remove(增删=本地 manifest,可见可逆)。alwaysOn 保证模型知道有此能力,
      // 不致退化成每次重新 extract_document。基于库内容的检索/带引用问答在后续版本(M2)。
      capability: "notebook",
      alwaysOn: true,
      tools: notebookTools
    },
    {
      capability: "memory",
      alwaysOn: true,
      tools: createMemoryTools(memory, () => broadcastMemory(wsId), () => sessionId)
    },
    {
      // 网页调研是核心能力,且关键词门控对续接指令(「再手动跑一次」)太脆 —— 漏挂 browser 会让模型
      // 误以为有 web 工具、找不到就退化成 curl 抓网页(SPA 抓空壳 + curl 走审批)。故 alwaysOn,其 guideline 进冻结 prompt。
      capability: "browser",
      alwaysOn: true,
      tools: browserTools
    },
    {
      capability: "shell",
      alwaysOn: false,
      // shell 关键词命中,**或**已装任何 Skill 时暴露 exec_shell:
      // Skill 跑在 exec_shell 上,装了 Skill 的任务(如「发飞书消息」)多半不含 shell 关键词,
      // 不一并暴露会让模型读了手册却发现无工具可执行。每次重扫=随 Skill 热加载。
      matches: (text) => SHELL_KEYWORDS.test(text) || scanSkills(SKILLS_DIR).length > 0,
      tools: [...shellTools],
      guideline: shellGuidelines
    },
    {
      // Office 编辑(Word/Excel/PPT):gated——只在提到 Office 文档/格式/编辑动作时暴露,
      // 不提的任务不背它(底层是个大二进制,且模型无谓时不该惦记它)。其 guideline 随选中按轮注入。
      capability: "office",
      alwaysOn: false,
      matches: (text) => OFFICE_KEYWORDS.test(text),
      tools: officeTools,
      guideline: officeGuidelines
    },
    {
      // 管定时任务是私人助理的核心职责,且关键词门控对续接指令太脆 —— 用户先「每天10点提醒喝水」(命中),
      // 之后「改一下之前的任务」(不含时间词)就漏挂 schedule,模型手上没工具便去手搓系统 crontab(脱离面板、
      // 用户改/删不了,还会卡死)。故 alwaysOn,其 guideline 进冻结 prompt,与 browser 同理。
      capability: "schedule",
      alwaysOn: true,
      tools: scheduleTools
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
    createUseSkillTool({ list: () => scanSkills(SKILLS_DIR) }),

    // 跨对话深度回忆:在本 workspace 历史会话里检索(只读)。「近期线索」给被动连续性,这个给主动深挖。
    createSearchHistoryTool({ sessions: getSessions(wsId), currentSessionId: sessionId })
  ];
  /** 全集:评估器筛选只读子集用 + 适配器初始 tools(send 里会被本轮选择结果覆盖)。 */
  const allTools: AgentTool[] = [...catalog.flatMap((g) => g.tools), ...alwaysOnExtras];

  /**
   * 本轮工具选择器:alwaysOn ∪ matches 命中 ∪ recent(上一轮真正用过的 capability)∪ alwaysOnExtras。
   * recent 是 continuation 兜底——比如上一轮用了 browser,本轮用户只回"好了",关键词不会命中,
   * 但 recent 里还有 browser,这一轮仍把 browser 工具组挂上,模型才能接着干。
   */
  const selectTools = (userText: string, recent: Set<Capability>): TurnSelection => {
    const tools: AgentTool[] = [...alwaysOnExtras];
    const guidelines: string[] = [];
    for (const g of catalog) {
      if (g.alwaysOn || recent.has(g.capability) || (g.matches?.(userText) ?? false)) {
        tools.push(...g.tools);
        if (g.guideline) guidelines.push(g.guideline); // gated 能力本轮被选中 → 其 guideline 随之注入
      }
    }
    return { tools, guideline: guidelines.join("\n\n") };
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
    // 验收门:本轮改了真实状态 ∥ 有确认过的契约,才有可独立复核的客观靶子;纯只读/聊天跳过。
    isMutatingTool,
    // 可观测:每轮验收(评/不评)落盘成 JSONL,供离线评估门的松紧与成本。
    onEvalTelemetry: (rec) => recordEval({ sessionId, source: background ? "scheduled" : "interactive" }, rec),
    // 执行轨迹落盘到会话目录(<sessionId>.trace.txt),返回绝对路径供验收器只读读取。
    writeTrace: (text) => getSessions(wsId).writeTrace(sessionId, text),
    systemPrompt: buildSystemPrompt({
      capabilities: CAPABILITY_DESCRIPTIONS,
      // 只放 always-on 能力的 guideline(每轮都在,留冻结=零缓存损失)。browser/schedule 均为 always-on,故其指南也在此。
      // 仍 gated 的能力(仅 shell)的 guideline 挂在 catalog 上,随 selectTools 经 contextProvider 按轮注入。
      guidelines: [
        filesystemGuidelines,
        documentGuidelines,
        notebookGuidelines,
        memoryGuidelines,
        browserGuidelines,
        scheduleGuidelines
      ]
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
      // 「近期线索」(滚动会话摘要)同样在此注入,给跨对话连续性;会话内稳定,不破缓存。
      [
        buildSessionContext(),
        // 本轮选中的 gated 能力(browser/shell/schedule)guideline——随 selectTools 同门注入,无关任务不背。
        turnGuidelineBySession.get(sessionId),
        // 本轮用户拖入的附件(已拷到本地)的绝对路径——用户消息只显示文件名,完整路径在此给 agent。
        renderTurnAttachments(turnAttachmentsBySession.get(sessionId)),
        renderBoundNotebook(getSessions(wsId).get(sessionId)?.boundNotebook, wsId),
        memory.render(),
        renderRecentThreads(getSessions(wsId), sessionId),
        renderSkillsForContext(scanSkills(SKILLS_DIR), SKILLS_DIR)
      ]
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
          call.tool === searchHistoryToolName || // 跨对话回忆,只读
          scheduleToolNames.has(call.tool) || // 定时任务增删改:可见(面板+聊天回报)、可逆,自动跑不弹审批
          memoryToolNames.has(call.tool) ||
          notebookToolNames.has(call.tool) // 知识库增删:本地 manifest、可见、软删可恢复,自动执行不弹审批
        )
          return "ReadOnly";
        // exec_shell 风险取决于命令内容:纯只读自动跑,写/改/拿不准的走审批。
        // 各 skill 在 frontmatter 里声明自己 CLI 的"已知安全"命令模式(热扫描),命中即视同只读——
        // 内核不认识 lark-cli 之类的 skill CLI,由 skill 自己负责声明,加 CLI 不改这里。
        if (call.tool === "exec_shell")
          return classifyShellRisk(
            String(call.args.command ?? ""),
            scanSkills(SKILLS_DIR).flatMap((s) => s.safeShell)
          );
        // office_cli 风险取决于子命令:读类自动跑,改文件类走审批。
        if (call.tool === "office_cli")
          return classifyOfficeRisk(Array.isArray(call.args.args) ? (call.args.args as string[]) : []);
        return riskClassifierFromMap({ ...filesystemToolRisk, ...documentToolRisk, ...browserToolRisk })(call);
      },
      requestApproval,
      rememberKeyOf, // 同类操作此前点过「总是同意」→ 直接放行,不再弹审批
      rememberStore
    }),
    capabilityOf,
    onAssistantDelta: (text) => {
      if (!background) sendTo("chat:stream", { type: "delta", text } satisfies ChatStreamEvent);
    },
    // 增量落盘:每个 assistant turn 收尾即持久化快照,运行中(含卡在审批/规划)也不丢对话。
    onTurnEnd: (transcript) => getSessions(wsId).saveTranscript(sessionId, transcript),
    onEvent: (event: DomainEvent) => {
      if (!background) sendTo("domain:event", event);
    },
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
        if (!background)
          sendTo("domain:event", {
            type: "InjectionSuspected",
            actionId,
            source: inj.url ?? tool,
            reasons: inj.injectionReasons ?? []
          } satisfies DomainEvent);
      }
      // 可查看工具:把结果文本推给渲染层,供 step 行"查看"按钮重开到 artifact 面板
      if (!background && VIEWABLE_TOOLS.has(tool) && resultText.trim()) {
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
    notebookStores.delete(wsId);
    sessionStores.delete(wsId);
    adapters.clear(); // 简单起见全清,下次按需从磁盘 transcript 重建
    selectorsBySession.clear();
    recentBySession.clear();
    turnGuidelineBySession.clear();
    turnAttachmentsBySession.clear();
    const list = workspaces.list();
    if (!list.some((w) => w.id === activeWorkspaceId)) {
      activeWorkspaceId = list[0]?.id ?? activeWorkspaceId;
      activeSessionId = "";
    }
    return { workspaces: list, activeWorkspaceId };
  },
  switchWorkspace(wsId: string): void {
    onSessionLeave(activeWorkspaceId, activeSessionId); // 离开旧 workspace 的当前会话 → 蒸馏摘要 + 沉淀记忆
    activeWorkspaceId = wsId;
    activeSessionId = "";
    broadcastMemory(wsId);
    void catchUpSessionMemory(wsId); // 进入新 workspace:补跑它漏掉的离开后处理
  },

  /** 客户端启动后补跑漏掉的「离开后处理」(退出前没离开的会话等)。由 index.ts 在 app ready 后调。 */
  catchUpMemory(): void {
    void catchUpSessionMemory(activeWorkspaceId);
  },

  // Session
  listSessions: (): SessionRecord[] => getSessions(activeWorkspaceId).list(),
  createSession(): SessionRecord {
    onSessionLeave(activeWorkspaceId, activeSessionId); // 离开当前会话 → 蒸馏摘要 + 沉淀记忆
    const rec = getSessions(activeWorkspaceId).create();
    activeSessionId = rec.id;
    return rec;
  },
  /** 打开会话:确保 adapter 已用 transcript 播种,返回重建好的 timeline。 */
  openSession(sessionId: string): unknown[] {
    if (activeSessionId && activeSessionId !== sessionId) onSessionLeave(activeWorkspaceId, activeSessionId);
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
  /** 绑定/解绑会话的知识库(持久化到会话记录;广播 session:changed 让渲染层刷新展示)。 */
  setBoundNotebook(sessionId: string, notebook?: string): void {
    const sessions = getSessions(activeWorkspaceId);
    sessions.setBoundNotebook(sessionId, notebook);
    broadcast("session:changed", sessions.list());
  },
  /** 当前 workspace 的已归档会话(供"已归档"列表查看/恢复)。 */
  listArchivedSessions: (): SessionRecord[] => getSessions(activeWorkspaceId).listArchived(),
  /** 恢复归档会话:重回活跃列表(广播 session:changed 让渲染层刷新)。 */
  unarchiveSession(sessionId: string): void {
    const sessions = getSessions(activeWorkspaceId);
    sessions.setArchived(sessionId, false);
    broadcast("session:changed", sessions.list());
  },

  async send(sender: WebContents, sessionId: string, text: string, attachments?: string[]): Promise<void> {
    activeSender = sender;
    activeSessionId = sessionId;
    plansBySession.delete(sessionId); // 新任务从无计划开始;本轮若对齐由 propose_plan 重新写入
    const gen = (runGenBySession.get(sessionId) ?? 0) + 1;
    runGenBySession.set(sessionId, gen);
    const sessions = getSessions(activeWorkspaceId);

    // 拖入的附件:拷进会话附件目录(可复现,原件被挪/删不影响重放),完整绝对路径经
    // contextProvider 注入给 agent;用户消息只追加文件名,避免长路径污染气泡。
    const savedPaths: string[] = [];
    const names: string[] = [];
    for (const src of attachments ?? []) {
      try {
        savedPaths.push(sessions.saveAttachment(sessionId, src));
        names.push(basename(src));
      } catch (err) {
        console.warn(`[chat] 附件拷贝失败(忽略): ${src} — ${String(err)}`);
      }
    }
    turnAttachmentsBySession.set(sessionId, savedPaths); // 空数组 → contextProvider 不注入
    const userText = names.length > 0 ? `${text}${text ? "\n\n" : ""}📎 附件:${names.join("、")}` : text;

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
        const selection = selector(userText, prevRecent);
        instance.setTools(selection.tools);
        // 本轮 gated guideline 存入槽,contextProvider(startTask 内被调)按轮读取注入,时序与 setTools 一致。
        turnGuidelineBySession.set(sessionId, selection.guideline);
      }
      await instance.startTask({ text: userText, conversationId: newConversationId() });
      // 被后来的 send 顶替(用户在验收期发了新消息)→ 本轮已被打断,流由新 run 接管,
      // 这里不再发 done/error,也不抢着落盘(新 run 会落自己的)。
      if (runGenBySession.get(sessionId) !== gen) return;
      // 落盘:transcript 快照 + 首条用户消息自动命名(先截断占位)
      sessions.saveTranscript(sessionId, instance.snapshotTranscript());
      const placeholder = autoTitle(sessions, sessionId, userText);
      broadcast("session:changed", sessions.list());
      // 首轮:异步用 AI 升级标题,不阻塞本次回复完成
      if (placeholder) void generateSessionTitle(sessions, sessionId, userText, placeholder);
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

  /**
   * 定时任务触发:把 prompt 当作一条用户消息,在当前 workspace 新开一个会话里无人值守地跑一遍,
   * 产出落盘成会话。返回会话 id + 末条助理回复(供系统通知摘要)。
   *
   * 用后台 adapter(不串流到渲染层),且不缓存进 adapters——用户日后打开该会话时,
   * 会从落盘 transcript 重建一个正常的交互 adapter。
   * 注意:适合只读/调研类(如取新闻);若任务触发了需审批的写操作,审批卡会发往当前活动窗口。
   */
  async runScheduledTask(
    title: string,
    prompt: string
  ): Promise<{ wsId: string; sessionId: string; summary: string }> {
    const wsId = activeWorkspaceId;
    const sessions = getSessions(wsId);
    const rec = sessions.create((title || "定时任务").trim().slice(0, 24) || "定时任务");
    const sessionId = rec.id;
    broadcast("session:changed", sessions.list());
    const instance = buildAdapter(wsId, sessionId, undefined, { background: true });
    try {
      const selector = selectorsBySession.get(sessionId);
      if (selector) {
        const selection = selector(prompt, new Set<Capability>());
        instance.setTools(selection.tools);
        turnGuidelineBySession.set(sessionId, selection.guideline); // 定时任务也按选中能力注入 gated guideline
      }
      await instance.startTask({ text: prompt, conversationId: newConversationId() });
      const transcript = instance.snapshotTranscript();
      sessions.saveTranscript(sessionId, transcript);
      broadcast("session:changed", sessions.list());
      const err = instance.lastError();
      return { wsId, sessionId, summary: err ? `运行出错:${err}` : lastAssistantText(transcript) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      try {
        sessions.saveTranscript(sessionId, instance.snapshotTranscript());
      } catch {
        /* 落盘失败不致命 */
      }
      return { wsId, sessionId, summary: `运行出错:${message}` };
    } finally {
      // 一次性后台运行:清掉它在选择器/最近能力累加器里的痕迹,别让它影响别的会话。
      selectorsBySession.delete(sessionId);
      recentBySession.delete(sessionId);
      turnGuidelineBySession.delete(sessionId);
      turnAttachmentsBySession.delete(sessionId);
    }
  },

  resolveApproval(actionId: string, approved: boolean, remember = false): void {
    const resolve = pendingApprovals.get(actionId);
    if (resolve) {
      pendingApprovals.delete(actionId);
      resolve({ approved, remember });
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

  // Notebook(知识库,按 wsId 参数化)——左侧面板只读浏览。
  listNotebooks: (wsId: string) => getNotebook(wsId).listNotebooks(),
  notebookDetail: (wsId: string, name: string) => getNotebook(wsId).getNotebook(name) ?? null,
  /** 读某来源的逐页全文(供右栏查看 / 引用跳转)。 */
  readNotebookSource(wsId: string, name: string, ref: string) {
    const s = getNotebook(wsId).getSource(name, ref);
    return s ? { id: s.id, name: s.name, pageCount: s.pageCount, ocr: s.ocr, pages: s.pages } : null;
  },
  /** UI 新建空知识库(之后往里加来源)。 */
  createNotebook(wsId: string, name: string) {
    const nb = getNotebook(wsId).ensureNotebook(name);
    broadcastNotebooks(wsId);
    return { id: nb.id, name: nb.name };
  },
  /** UI 加来源(选文件/拖入触发):复用与对话工具同一条入库逻辑(抽取+去重+留痕)。 */
  async addNotebookSource(wsId: string, notebook: string, path: string) {
    const r = await addSourceToNotebook(
      getNotebook(wsId),
      (p, actionId) => extractDocument(p, ocrDocOptions(), actionId),
      notebook,
      path
    );
    if (r.status !== "unsupported") broadcastNotebooks(wsId);
    if (r.status === "reused") return { status: "reused" as const, name: r.source.name };
    if (r.status === "unsupported") return { status: "unsupported" as const, note: r.note };
    return { status: "added" as const, name: r.source.name, error: !!r.source.error, note: r.source.note };
  },
  /** UI 移出来源(软删,可恢复)。 */
  removeNotebookSource(wsId: string, notebook: string, ref: string) {
    const removed = getNotebook(wsId).removeSource(notebook, ref);
    if (removed) broadcastNotebooks(wsId);
    return { removed: !!removed };
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

// ── 滚动会话摘要(第 1 层:跨对话连续性 / 人感)─────────────────────
// recap = 意图 + 决策(不含结果;结果让用户需要时另查)。离开会话时后台蒸馏,注入新会话的「近期线索」。

const RECENT_THREADS_LIMIT = 4;

/** 从一条消息的 content 抽纯文本(string 或 text 块数组)。 */
function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((b): b is { type: "text"; text: string } => (b as { type?: string })?.type === "text")
    .map((b) => b.text)
    .join("");
}

/** 取 transcript 里最后一条非空助理文本(定时任务通知摘要用)。 */
function lastAssistantText(transcript: unknown): string {
  if (!Array.isArray(transcript)) return "";
  for (let i = transcript.length - 1; i >= 0; i--) {
    const m = transcript[i] as { role?: string; content?: unknown };
    if (m?.role === "assistant") {
      const t = textFromContent(m.content).trim();
      if (t) return t;
    }
  }
  return "";
}

/** 把 transcript 压成「以用户为中心」的文本喂给摘要器:用户原话全留,助理只留短文本做消歧,工具噪声丢弃。 */
function renderTranscriptForDigest(transcript: unknown): string {
  if (!Array.isArray(transcript)) return "";
  const lines: string[] = [];
  for (const raw of transcript as { role?: string; content?: unknown }[]) {
    const text = textFromContent(raw.content).trim();
    if (!text) continue;
    if (raw.role === "user") lines.push(`用户: ${text}`);
    else if (raw.role === "assistant") lines.push(`助理: ${text.length > 160 ? text.slice(0, 160) + "…" : text}`);
    else if (text.startsWith("用户回答")) lines.push(`决策: ${text}`); // ask_user 的回答 = 用户决策信号
  }
  return lines.join("\n");
}

/** 蒸馏某会话的「意图+决策」摘要。LLM 出错会抛(由 processSessionOnLeave 决定是否标记已处理)。 */
async function generateSessionDigest(sessions: SessionStore, sessionId: string): Promise<void> {
  const body = renderTranscriptForDigest(sessions.loadTranscript(sessionId));
  if (!body.split("\n").some((l) => l.startsWith("用户:"))) return; // 没有用户实质输入 → 不值得摘要
  const model = createModel({ provider: PROVIDER, modelId: MODEL });
  const apiKey = await resolveApiKey(PROVIDER);
  const raw = await generateText(model, {
    apiKey,
    maxTokens: 160,
    system:
      "你是会话摘要器,为「跨对话记忆」服务。只关心两件事:用户的**意图**(想达成什么)和**决策**(定了什么)。" +
      "助理的长篇输出只用来理解用户的话,不要复述它。忽略寒暄与过程细节,**不要写结果/成败**(用户需要时会另查)。" +
      "最多输出 3 行,每行一句中文,形如「意图:…」「决策:…」;若没有明确的意图或决策,只输出一个字:无。",
    prompt: body.slice(0, 6000)
  });
  const digest = raw.trim();
  if (!digest || digest === "无") return;
  sessions.setDigest(sessionId, digest);
  broadcast("session:changed", sessions.list());
}

/**
 * 主动记忆形成(第 2 层):会话收尾时**保守地**把值得长期记住的(稳定偏好/在推进的项目/影响以后做法的决策)
 * 沉淀进 Personal Memory,作为模型 inline `remember` 的兜底。去重 + 默认不记,避免常驻注入的记忆臃肿
 * (彻底的合并剪枝留给第 4 层 dream)。
 */
async function promoteSessionMemories(wsId: string, sessionId: string): Promise<void> {
  const memory = getMemory(wsId);
  const body = renderTranscriptForDigest(getSessions(wsId).loadTranscript(sessionId));
  if (!body.split("\n").some((l) => l.startsWith("用户:"))) return; // 没有用户实质输入 → 不沉淀
  const existing = memory.list();
  const existingList = existing.map((m) => `- ${m.content}`).join("\n") || "(暂无)";
  const model = createModel({ provider: PROVIDER, modelId: MODEL });
  const apiKey = await resolveApiKey(PROVIDER);
  const raw = await generateText(model, {
    apiKey,
    maxTokens: 200,
    system:
      "你在一段对话收尾时,判断有没有**值得长期记住**的、关于这位用户的信息——稳定的偏好/习惯、在推进的项目或目标、" +
      "影响以后做法的决策。**只记跨会话还有用的;一次性的任务细节不要记**(那些能另查)。已经记过的不要重复或换汤不换药地再记。" +
      "最多 3 条,拿不准就少记或不记。每条输出一行,格式 `偏好|内容` 或 `事实|内容`(内容简洁具体一句话);" +
      "没有任何值得记的就只输出一个字:无。",
    prompt: `已经记过的(别重复):\n${existingList}\n\n本次对话:\n${body.slice(0, 6000)}`
  });
  const out = raw.trim();
  if (!out || out === "无") return;
  const seen = new Set(existing.map((m) => m.content.trim().toLowerCase()));
  let added = 0;
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*(偏好|事实)\s*[|｜:：]\s*(.+)$/);
    const content = m?.[2]?.trim();
    if (!m || !content || seen.has(content.toLowerCase())) continue;
    memory.add({
      kind: m[1] === "偏好" ? "preference" : "fact",
      content,
      situation: "会话收尾自动沉淀",
      sourceSessionId: sessionId
    });
    seen.add(content.toLowerCase());
    if (++added >= 3) break;
  }
  if (added) broadcastMemory(wsId);
}

/**
 * 离开某会话后的处理:蒸馏「近期线索」+ 沉淀值得长期记的记忆。两者都成功(或合法地无内容跳过)才
 * markDigested;若 LLM 出错则不标记,留待客户端下次启动补跑(见 catchUpSessionMemory)。幂等:摘要覆盖、沉淀去重。
 */
async function processSessionOnLeave(wsId: string, sessionId: string): Promise<void> {
  if (!sessionId) return;
  const sessions = getSessions(wsId);
  try {
    await Promise.all([generateSessionDigest(sessions, sessionId), promoteSessionMemories(wsId, sessionId)]);
    sessions.markDigested(sessionId);
  } catch (err) {
    console.warn(`[session-leave] 处理失败,留待重启补跑: ${String(err)}`);
  }
}

/** 离开某会话(切走/新建/换 workspace)时触发(后台、不阻塞)。 */
function onSessionLeave(wsId: string, sessionId: string): void {
  void processSessionOnLeave(wsId, sessionId);
}

/**
 * 客户端重启补跑:把"离开没跑成"的会话(尤其退出前从没离开过的当前会话、或 LLM 当时出错的)补上。
 * 顺序跑、限最近若干个(避免首次铺开时一次性轰炸 + 老会话本就不进近期线索)。
 */
async function catchUpSessionMemory(wsId: string): Promise<void> {
  const pending = getSessions(wsId).needingDigest(8, activeSessionId);
  for (const rec of pending) await processSessionOnLeave(wsId, rec.id);
}

/** 时间戳现算成口语相对标签 + 紧凑绝对日期(如「昨天·6/1」)。注入当下计算,永不过期。 */
function relativeDayLabel(ts: number, now: number): string {
  const d = new Date(ts);
  const md = `${d.getMonth() + 1}/${d.getDate()}`;
  const startOfDay = (t: number): number => {
    const x = new Date(t);
    x.setHours(0, 0, 0, 0);
    return x.getTime();
  };
  const days = Math.round((startOfDay(now) - startOfDay(ts)) / 86400000);
  let rel: string;
  if (days <= 0) rel = "今天";
  else if (days === 1) rel = "昨天";
  else if (days === 2) rel = "前天";
  else if (days < 7) rel = `${days}天前`;
  else if (days < 14) rel = "上周";
  else if (days < 30) rel = `${Math.floor(days / 7)}周前`;
  else if (days < 365) rel = `${Math.floor(days / 30)}个月前`;
  else rel = `${Math.floor(days / 365)}年前`;
  return `${rel}·${md}`;
}

/** 「近期线索」注入块:本 workspace 最近 N 条带摘要的会话(排除当前),带相对时间戳。 */
function renderRecentThreads(sessions: SessionStore, currentId: string): string | undefined {
  const recent = sessions.recentWithDigest(RECENT_THREADS_LIMIT, currentId);
  if (!recent.length) return undefined;
  const now = Date.now();
  const lines = recent.map(
    (r) => `- [${relativeDayLabel(r.updatedAt, now)}] ${(r.digest ?? "").replace(/\s*\n\s*/g, " · ")}`
  );
  return `# 近期线索(你和这位用户最近聊过的话题,仅供本轮请求相关时回忆参考;**不要主动推进这里提到的旧任务**,除非用户这轮明确提起)\n${lines.join("\n")}`;
}
