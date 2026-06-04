/**
 * @pa/cap-office — Office Automation Capability(支撑域)
 *
 * office_cli:读 / 改 / 新建 Word(.docx)· Excel(.xlsx)· PowerPoint(.pptx),
 * 底座是 **OfficeCLI**(iOfficeAI/OfficeCLI,Apache-2.0)——一个自包含原生二进制,
 * 直接读写 OpenXML,**不需要装 Microsoft Office,也不需要 LibreOffice**。
 * 这正好补上 cap-document 当初因「docx/xlsx 需另装 LibreOffice」而搁置的 Office 编辑能力。
 *
 * 设计取舍:
 * - 二进制**按需下载、不随 app 包**:首个 office 命令触发时,按平台/架构从 GitHub Releases
 *   下到缓存目录(组合根注入 officeBinDir),之后复用——沿用 cap-document 下 OCR 模型那套
 *   (临时文件 + rename 防半成品、并发去重、变体子目录可整体失效)。
 * - 工具是**单一直通入口**:把 OfficeCLI 自己的子命令(view/get/set/add/merge/batch…)透传给模型,
 *   而不是把它的命令面重新包一层结构化工具——OfficeCLI 本就是为 agent 设计的,重包只会更脆。
 * - 风险**按子命令分级**:纯读子命令(view/get/query/dump/validate/stats)自动跑(ReadOnly,Trust 放行);
 *   其余(create/set/add/remove/move/merge/refresh/batch/raw/open/close…会改文件)走审批(Destructive)。
 * - 自管理超时 + 杀整个进程组防挂起(同 cap-shell:渲染/公式重算等可能卡)。
 */
import { spawn, type ChildProcess } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Capability, RiskLevel } from "@pa/domain-core";

const CAPABILITY: Capability = "office";

const MAX_STDOUT_CHARS = 100_000;
const MAX_STDERR_CHARS = 10_000;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 180_000;
/** 进程内累积输出硬上限(防失控命令吃爆内存)。 */
const MAX_BUFFER_CHARS = 2 * MAX_STDOUT_CHARS;
const KILL_GRACE_MS = 2_000;
const FORCE_RESOLVE_MS = KILL_GRACE_MS + 1_000;

const IS_WINDOWS = process.platform === "win32";

// ── OfficeCLI 二进制(按需下载,不随包)─────────────────────────────
/** 固定到一个已知发布版,保证可复现 + 换版即整体重下(改这个常量即可)。 */
const OFFICECLI_VERSION = "v1.0.103";
const RELEASE_BASE = `https://github.com/iOfficeAI/OfficeCLI/releases/download/${OFFICECLI_VERSION}`;

/**
 * 当前平台/架构对应的发布资产名(取自官方 install.sh / install.ps1)。
 * 资产即裸可执行文件(无压缩),下完 chmod +x 即可用。
 * linux 在 musl(Alpine 等)上用 alpine 变体;glibc 用普通 linux 变体。
 */
function resolveAssetName(): string {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  if (process.platform === "darwin") return `officecli-mac-${arch}`;
  if (IS_WINDOWS) return `officecli-win-${arch}.exe`;
  const libc = isMuslLibc() ? "alpine-" : "";
  return `officecli-linux-${libc}${arch}`;
}

/** 检测是否 musl libc(Alpine 等):glibc 运行时缺失且共享对象里含 musl → musl。探测失败按 glibc。 */
function isMuslLibc(): boolean {
  try {
    const report = process.report?.getReport() as
      | { header?: { glibcVersionRuntime?: string }; sharedObjects?: string[] }
      | undefined;
    if (report?.header?.glibcVersionRuntime) return false;
    return (report?.sharedObjects ?? []).some((p) => p.includes("musl"));
  } catch {
    return false;
  }
}

/** 并发去重(同一文件不重复下),写临时文件再 rename(防半成品被当成可用)。同 cap-document。 */
const inflight = new Map<string, Promise<string | null>>();

/**
 * 退出清理用的进程内状态:
 * - resolvedBin:已就位的二进制绝对路径(disposeOffice 用它去 close 常驻进程)。
 * - openedDocs:本进程操作过、可能起了常驻进程的文档(OfficeCLI 的 create/open 等会留后台常驻加速后续命令)。
 */
let resolvedBin: string | null = null;
const openedDocs = new Set<string>();

/**
 * 确保 OfficeCLI 二进制就位,返回其绝对路径(下载失败 → null)。
 * 缓存到 <binRoot>/<version>/<asset>:带版本子目录,换版自动走新目录重下、旧的不被误用。
 */
function ensureOfficeBinary(binRoot: string, onNote: (note: string) => void): Promise<string | null> {
  const asset = resolveAssetName();
  const dir = join(binRoot, OFFICECLI_VERSION);
  const dest = join(dir, asset);
  if (existsSync(dest)) {
    resolvedBin = dest;
    return Promise.resolve(dest);
  }

  let p = inflight.get(dest);
  if (!p) {
    onNote("首次使用 Office:正在下载 OfficeCLI 运行时(约 30–80MB,仅此一次)…");
    p = (async (): Promise<string | null> => {
      const res = await fetch(`${RELEASE_BASE}/${asset}`);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      mkdirSync(dir, { recursive: true });
      const tmp = `${dest}.tmp`;
      writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
      if (!IS_WINDOWS) chmodSync(tmp, 0o755); // 裸可执行文件:补可执行位
      renameSync(tmp, dest);
      resolvedBin = dest;
      return dest;
    })()
      .catch((err: unknown) => {
        console.warn(`[cap-office] OfficeCLI 下载失败 ${asset}: ${String(err)}`);
        return null;
      })
      .finally(() => inflight.delete(dest));
    inflight.set(dest, p);
  }
  return p;
}

// ── 风险分级 ────────────────────────────────────────────────────
/**
 * 纯读子命令:不改任何文件,命中即自动执行(ReadOnly)。
 * 其余(create/set/add/remove/move/merge/refresh/batch/raw/open/close…)一律 Destructive 走审批(保守兜底)。
 */
const READONLY_SUBCOMMANDS: ReadonlySet<string> = new Set([
  "view",
  "get",
  "query",
  "dump",
  "validate",
  "stats",
  "help",
  "version"
]);

/** 取第一个非选项 token 作为子命令(officecli <sub> <file> …;子命令在最前)。 */
function subcommandOf(args: readonly string[]): string | undefined {
  return args.find((a) => !a.startsWith("-"));
}

/** 参数里所有像 Office 文档的 token(.docx/.xlsx/.pptx)。用于追踪开了哪些常驻进程,退出时收掉。 */
function officeFilesIn(args: readonly string[]): string[] {
  return args.filter((a) => /\.(docx|xlsx|pptx)$/i.test(a));
}

/**
 * 按子命令判定 office_cli 风险:纯读子命令 → ReadOnly(自动执行);其余 → Destructive(走审批)。
 * 拿不准(空 args / 未知子命令)一律 Destructive,保守。
 */
export function classifyOfficeRisk(args: readonly string[]): RiskLevel {
  const sub = subcommandOf(args)?.toLowerCase();
  if (!sub) return "Destructive";
  return READONLY_SUBCOMMANDS.has(sub) ? "ReadOnly" : "Destructive";
}

// ── 执行 ────────────────────────────────────────────────────────
function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + `\n…(已截断,共 ${text.length} 字符)`, truncated: true };
}

/** 杀子进程及其整个进程组/树。posix:负 pid 收整组;Windows:taskkill /T。同 cap-shell。 */
function killTree(child: ChildProcess, sig: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid == null) return;
  try {
    if (IS_WINDOWS) spawn("taskkill", ["/pid", String(pid), "/T", "/F"]);
    else process.kill(-pid, sig);
  } catch {
    // 进程(组)已退出 —— 无事可做
  }
}

interface RunResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
  note?: string;
}

/** 直接 spawn 二进制(shell:false,args 数组,免引号转义);自管理超时 + 整组 kill,绝不无限挂起。 */
function runOffice(
  bin: string,
  args: string[],
  cwd: string,
  timeoutMs: number,
  signal?: AbortSignal
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, args, {
      cwd,
      detached: !IS_WINDOWS, // 自成进程组,便于整组 kill
      env: { ...process.env }
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const timers = new Set<NodeJS.Timeout>();
    const later = (ms: number, fn: () => void): void => {
      const id = setTimeout(() => {
        timers.delete(id);
        fn();
      }, ms);
      timers.add(id);
    };

    const finish = (exitCode: number | null, note?: string): void => {
      if (settled) return;
      settled = true;
      for (const id of timers) clearTimeout(id);
      timers.clear();
      signal?.removeEventListener("abort", onAbort);
      resolve({ exitCode, stdout, stderr, note });
    };

    const terminate = (note: string): void => {
      killTree(child, "SIGTERM");
      later(KILL_GRACE_MS, () => killTree(child, "SIGKILL"));
      later(FORCE_RESOLVE_MS, () => finish(null, note));
    };

    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      if (stdout.length < MAX_BUFFER_CHARS) stdout += chunk;
    });
    child.stderr?.on("data", (chunk: string) => {
      if (stderr.length < MAX_BUFFER_CHARS) stderr += chunk;
    });

    later(timeoutMs, () => terminate("(超时,已终止进程组)"));
    const onAbort = (): void => terminate("(已中断)");
    signal?.addEventListener("abort", onAbort, { once: true });

    child.on("close", (exitCode) => finish(exitCode));
    child.on("error", (err) => finish(null, `执行失败: ${err.message}`));
  });
}

const officeParams = Type.Object({
  args: Type.Array(Type.String(), {
    description:
      "传给 OfficeCLI 的参数数组(不含 officecli 本身),逐项一个 token。" +
      "例:读全文 → [\"view\",\"/abs/报告.docx\",\"text\"](mode 是位置参数,不是 --mode);" +
      "改单元格 → [\"set\",\"/abs/数据.xlsx\",\"/Sheet1/A1\",\"--prop\",\"value=42\"];" +
      "加段落 → [\"add\",\"/abs/报告.docx\",\"/body\",\"--type\",\"p\",\"--prop\",\"text=正文\"];" +
      "新建 → [\"create\",\"/abs/新文档.docx\"]。文件用绝对路径,属性一律走 --prop key=value。"
  }),
  cwd: Type.Optional(Type.String({ description: "工作目录(绝对路径)。默认:用户主目录。" })),
  timeout: Type.Optional(Type.Number({ description: "超时毫秒数(默认 60 秒,最大 180 秒)。" }))
});

export interface OfficeToolsOptions {
  /** OfficeCLI 二进制缓存目录(组合根注入,如 <userData>/officecli)。 */
  readonly officeBinDir: string;
  /** 执行中进度上报(actionId = execute 第一参数 = 渲染层 step 行 id);首次下二进制耗时,亮给用户。 */
  readonly onProgress?: (actionId: string, note: string) => void;
}

function createOfficeCliTool(opts: OfficeToolsOptions): AgentTool<typeof officeParams> {
  return {
    name: "office_cli",
    label: "Office 文档操作",
    description:
      "读 / 改 / 新建 Word(.docx)、Excel(.xlsx)、PowerPoint(.pptx),底层用 OfficeCLI,无需安装 Office。" +
      "读类子命令(view/get/query)自动执行;改文件的子命令(create/set/add/remove/move/merge/batch 等)会向用户弹审批。" +
      "需要看懂或编辑 Office 文档时用它,别用 shell 自己拼。",
    parameters: officeParams,
    execute: async (id, { args, cwd, timeout }, signal): Promise<AgentToolResult<any>> => {
      if (!args || args.length === 0) {
        return textResult("未提供 OfficeCLI 参数(args 为空)。", { error: "empty args" });
      }
      const bin = await ensureOfficeBinary(opts.officeBinDir, (note) => opts.onProgress?.(id, note));
      if (!bin) {
        return textResult(
          "OfficeCLI 运行时下载失败(可能离线或网络受限),无法操作 Office 文档。稍后联网重试。",
          { error: "binary unavailable" }
        );
      }

      const t = Math.min(timeout ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
      const dir = cwd ?? homedir();
      // 记下涉及的文档:OfficeCLI 多数命令会留后台常驻进程,退出时 disposeOffice 逐个 close 收掉。
      for (const f of officeFilesIn(args)) openedDocs.add(f);
      const r = await runOffice(bin, args, dir, t, signal);

      const out = clip(r.stdout, MAX_STDOUT_CHARS);
      const errc = clip(r.stderr, MAX_STDERR_CHARS);
      const parts: string[] = [];
      if (out.text) parts.push(`stdout:\n${out.text}`);
      if (errc.text) parts.push(`stderr:\n${errc.text}`);
      parts.push(`退出码: ${r.exitCode ?? (r.note ?? "(超时/被杀)")}`);

      return textResult(parts.join("\n\n"), {
        exitCode: r.exitCode,
        stdout: out.text,
        stderr: errc.text,
        stdoutTruncated: out.truncated,
        stderrTruncated: errc.truncated,
        cwd: dir,
        subcommand: subcommandOf(args),
        ...(r.note ? { note: r.note } : {})
      });
    }
  };
}

/** 创建 Office 工具集(office_cli)。officeBinDir = OfficeCLI 二进制缓存目录(组合根注入)。 */
export function createOfficeTools(opts: OfficeToolsOptions): AgentTool<any>[] {
  return [createOfficeCliTool(opts)];
}

/**
 * 退出清理:收掉本进程操作文档时 OfficeCLI 留下的后台常驻进程(它们会 re-parent 到 init,
 * 不随本进程退出而消失 → 不收会泄漏)。对每个开过的文档跑一次 `officecli close <file>`,
 * 全程封一个总时限(默认 3s),绝不阻塞 app 退出。从没用过 Office(无二进制/无文档)则立即返回。
 * 调用后清空记录,可安全重复调用。
 */
export async function disposeOffice(deadlineMs = 3_000): Promise<void> {
  const bin = resolvedBin;
  if (!bin || openedDocs.size === 0) return;
  const files = [...openedDocs];
  openedDocs.clear();
  const closeAll = Promise.all(
    files.map((f) => runOffice(bin, ["close", f], homedir(), deadlineMs)) // runOffice 永不 reject
  );
  const deadline = new Promise<void>((resolve) => setTimeout(resolve, deadlineMs));
  await Promise.race([closeAll.then(() => undefined), deadline]);
}

export const officeToolNames: ReadonlySet<string> = new Set(["office_cli"]);

export const officeGuidelines = `## Office 文档(Word / Excel / PowerPoint)
- 读或编辑 .docx / .xlsx / .pptx 用 office_cli(底层 OfficeCLI,无需装 Office);别用 shell 自己拼命令,也别去找 LibreOffice。
- 它是把参数透传给 OfficeCLI 的直通工具,常用子命令:
  - 读:view(模式是**位置参数**:\`view <文件> text\`,还有 outline/stats/annotated)、get(按 DOM 路径取节点,如 \`get <文件> /Sheet1/A1\`)、query(类 CSS 选择器查)。
  - 写:create/new(新建空文档)、set(改属性/单元格值,如 \`set <文件> /Sheet1/A1 --prop value=42\`)、
    add(加元素,如 \`add <文件> /body --type p --prop text=正文\`)、remove/move(删/移元素)、
    merge(模板 {{key}} 套数据)、batch(一次 open/save 里跑多条,改多处时更快)。
- **属性一律走 \`--prop key=value\`**(裸写 text=… 会被忽略)。文件一律用**绝对路径**。
- 读类子命令自动执行;任何会改文件的子命令都会先弹审批,经用户确认才落盘。
- 首次使用会联网下载 OfficeCLI 运行时(约 30–80MB,仅一次),稍慢属正常。
- 改完可用 view 把结果读回来核对(改了什么、值对不对),别凭空断言已改好。
- 大量改动建议先 create/打好骨架,再用 batch 批量写,减少反复 open/save。`;

export { CAPABILITY as officeCapability };
