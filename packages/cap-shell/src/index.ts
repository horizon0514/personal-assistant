/**
 * @pa/cap-shell — Shell Execution Capability(支撑域)
 *
 * exec_shell:在用户本机执行 shell 命令并返回输出。
 *
 * 安全设计:
 * - 风险等级 Destructive,每次执行前必经用户审批
 * - 自管理超时(默认 30s,可调)+ **杀整个进程组**防挂起:
 *   子进程以独立进程组(detached)启动,超时/中断时按进程组 kill,
 *   连同 `sh -c "a | b"` 里的孙进程一起收掉。否则被卡住的孙进程(如等系统
 *   授权的 crontab)会一直持着 stdout/stderr 的 pipe fd,使 Node 的 `close`
 *   永不触发、Promise 永不 resolve —— 既超时不了也 abort 不掉(会话卡死)。
 * - abort/超时后即便进程组顽固不死,也在宽限期后强制 resolve,绝不让 agent loop 永久挂起。
 * - 基于 Node.js child_process.spawn(shell:true / 指定 bin)
 * - 结果截断防撑爆上下文(前 100KB stdout + 10KB stderr)
 */
import { spawn, type ChildProcess } from "node:child_process";
import { homedir } from "node:os";
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Capability, RiskLevel } from "@pa/domain-core";

const CAPABILITY: Capability = "shell";

const MAX_STDOUT_CHARS = 100_000;
const MAX_STDERR_CHARS = 10_000;
const DEFAULT_TIMEOUT_MS = 30_000;
/** 进程内累积输出的硬上限(防失控命令吃爆内存;超出即停止追加,clip 仍会标截断)。 */
const MAX_BUFFER_CHARS = 2 * MAX_STDOUT_CHARS;
/** SIGTERM 后等多久再补 SIGKILL。 */
const KILL_GRACE_MS = 2_000;
/** 触发 kill 后,即便进程组没死透也最迟在此时限强制 resolve(避免卡死 agent loop)。 */
const FORCE_RESOLVE_MS = KILL_GRACE_MS + 1_000;

function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

/** 截断文本并加标记 */
function clip(text: string, max: number): { text: string; truncated: boolean } {
  if (text.length <= max) return { text, truncated: false };
  return { text: text.slice(0, max) + `\n…(已截断,共 ${text.length} 字符)`, truncated: true };
}

const execShellParams = Type.Object({
  command: Type.String({ description: "要执行的 shell 命令,如 ls -la /tmp" }),
  cwd: Type.Optional(
    Type.String({ description: "工作目录(绝对路径)。默认:用户主目录" })
  ),
  timeout: Type.Optional(
    Type.Number({ description: "超时毫秒数(默认 30 秒,最大 120 秒)" })
  )
});

/**
 * shell 执行底座规格。**缺省(undefined)= 用宿主系统默认 shell**(/bin/sh 或 cmd.exe,即 `spawn(cmd, {shell:true})` 行为)。
 * 指定 bin 时改走 `spawn(bin, [...args, command])` —— 用于随包打包的**跨平台 shell**,
 * 让三平台命令行为一致([[akari-goal]] 的「exec_shell 跨平台底座」)。busybox 用 `{ bin, args: ["sh", "-c"] }`。
 */
export interface ShellSpec {
  readonly bin: string;
  /** 命令前置参数,真正的 command 追加在最后。busybox: ["sh","-c"];多数 sh 兼容 shell: ["-c"]。 */
  readonly args: readonly string[];
}

const IS_WINDOWS = process.platform === "win32";

/**
 * 起一个子进程跑 command:有 ShellSpec 走指定 shell,否则回落系统默认 shell。
 * posix 下用 `detached: true` 让子进程自成进程组(组长 pid = child.pid),
 * 这样 {@link killTree} 能用负 pid 一次性收掉 `sh -c "a | b"` 派生的所有孙进程。
 */
function spawnShell(command: string, dir: string, shell?: ShellSpec): ChildProcess {
  const common = {
    cwd: dir,
    detached: !IS_WINDOWS, // 自成进程组,便于整组 kill;Windows 无对应语义,靠 killTree 的 taskkill /T 兜
    env: { ...process.env, PATH: process.env.PATH }
  };
  return shell
    ? spawn(shell.bin, [...shell.args, command], common)
    : spawn(command, { ...common, shell: true });
}

/**
 * 杀掉子进程**及其整个进程树/组**。
 * posix:`process.kill(-pid, sig)` —— 负 pid 作用于以 child 为组长的整个进程组(含孙进程)。
 * Windows:`taskkill /T /F` 递归杀进程树。pid 已不存在则静默忽略。
 */
function killTree(child: ChildProcess, sig: NodeJS.Signals): void {
  const pid = child.pid;
  if (pid == null) return;
  try {
    if (IS_WINDOWS) {
      spawn("taskkill", ["/pid", String(pid), "/T", "/F"]);
    } else {
      process.kill(-pid, sig);
    }
  } catch {
    // 进程(组)已退出 / 已被回收 —— 无事可做
  }
}

function createExecShellTool(shell?: ShellSpec): AgentTool<typeof execShellParams> {
  return {
  name: "exec_shell",
  label: "执行 Shell 命令",
  description:
    "在用户本机执行 shell 命令,返回 stdout/stderr/退出码。纯只读命令自动执行;写/改状态或拿不准的命令会向用户弹审批,经其确认后才执行。" +
    "适合:查系统状态、git 操作、压缩解压、运行脚本等本地终端操作。不要用来启动交互式程序(如 vim、top)。",
  parameters: execShellParams,
  execute: async (_id, { command, cwd, timeout }, signal): Promise<AgentToolResult<any>> => {
    const t = Math.min(timeout ?? DEFAULT_TIMEOUT_MS, 120_000);
    const dir = cwd ?? homedir();

    return new Promise((resolve) => {
      const child = spawnShell(command, dir, shell);

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

      // 触发整组终止:先 SIGTERM,宽限后 SIGKILL,并设硬兜底强制 resolve。
      // 即便孙进程卡在内核态(如等系统授权)收不掉,也绝不让本 Promise 永久挂起 —— 否则 agent loop 卡死。
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

      const finish = (exitCode: number | null, note?: string): void => {
        if (settled) return;
        settled = true;
        for (const id of timers) clearTimeout(id);
        timers.clear();
        signal?.removeEventListener("abort", onAbort);

        const clippedStdout = clip(stdout, MAX_STDOUT_CHARS);
        const clippedStderr = clip(stderr, MAX_STDERR_CHARS);

        const parts: string[] = [];
        if (clippedStdout.text) parts.push(`stdout:\n${clippedStdout.text}`);
        if (clippedStderr.text) parts.push(`stderr:\n${clippedStderr.text}`);
        parts.push(`退出码: ${exitCode ?? (note ?? "(超时/被杀)")}`);

        resolve(
          textResult(parts.join("\n\n"), {
            exitCode,
            stdout: clippedStdout.text,
            stderr: clippedStderr.text,
            stdoutTruncated: clippedStdout.truncated,
            stderrTruncated: clippedStderr.truncated,
            cwd: dir,
            command,
            ...(note ? { note } : {})
          })
        );
      };

      // 自管理超时:杀整个进程组(连孙进程),而非只杀直接子进程。
      later(t, () => terminate("(超时,已终止进程组)"));

      // AbortSignal 支持:用户点"停止"时终止整组
      const onAbort = () => terminate("(已中断)");
      signal?.addEventListener("abort", onAbort, { once: true });

      child.on("close", (exitCode) => finish(exitCode));

      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        for (const id of timers) clearTimeout(id);
        timers.clear();
        signal?.removeEventListener("abort", onAbort);
        resolve(
          textResult(`执行失败: ${err.message}`, {
            error: err.message,
            command,
            cwd: dir
          })
        );
      });
    });
  }
  };
}

/**
 * 创建 shell 工具集。不传 shell → 用系统默认 shell(当前行为,零回归);
 * 传 shell(如随包 busybox)→ 三平台命令一致。组合根决定传不传。
 */
export function createShellTools(opts?: { shell?: ShellSpec }): AgentTool<any>[] {
  return [createExecShellTool(opts?.shell)];
}

export const shellToolNames: ReadonlySet<string> = new Set(["exec_shell"]);

/**
 * 纯只读命令头白名单:不改任何文件/状态,命中即可自动执行(ReadOnly)。
 * 凡不在表内的命令头,一律落到 Destructive 走审批(保守兜底)。
 */
const READONLY_HEADS: ReadonlySet<string> = new Set([
  "cd", "pwd", "ls", "ll", "la", "dir", "tree",
  "cat", "head", "tail", "less", "more", "bat",
  "echo", "printf", "stat", "file", "wc", "du", "df",
  "realpath", "readlink", "dirname", "basename",
  "which", "whereis", "type", "whoami", "id", "groups",
  "hostname", "uname", "arch", "sw_vers", "date", "uptime",
  "env", "printenv", "locale",
  "grep", "egrep", "fgrep", "rg", "ag", "ack",
  "sort", "uniq", "cut", "tr", "diff", "comm", "column", "paste", "fold", "nl",
  "ps", "free", "vm_stat", "lsof", "ifconfig", "ip"
]);

/** git 永远只读的子命令(不接受任何会改仓库状态的写法)。 */
const GIT_READONLY_SUB: ReadonlySet<string> = new Set([
  "status", "log", "diff", "show", "blame", "reflog", "rev-parse", "describe",
  "ls-files", "ls-tree", "cat-file", "shortlog", "rev-list", "name-rev",
  "symbolic-ref", "whatchanged", "var", "count-objects", "check-ignore"
]);

/**
 * git 仅在「无写标志、无新增位置参数」时才算只读的子命令(裸 list 形态)。
 * 只收纳「裸命令即列出」的三个;stash/config/worktree 语义更杂,统一走审批。
 */
const GIT_LIST_SUB: ReadonlySet<string> = new Set(["branch", "tag", "remote"]);
// 注:-a 是 branch 的「列全部」(只读),创建类一定带位置参数,已被位置参数判定兜住,故不列为写标志。
const GIT_MUTATING_FLAG = /^-(d|D|m|M|f|u|-delete|-move|-force|-create|-edit|-set-upstream|-unset)$/;

/** 版本/帮助探测可放行的解释器/工具头(只接受 -v/--version/--help 这类参数)。 */
const VERSION_PROBE_HEADS: ReadonlySet<string> = new Set([
  "node", "python", "python3", "ruby", "go", "java", "rustc", "cargo",
  "deno", "bun", "npm", "pnpm", "yarn", "tsc", "git", "brew", "docker"
]);
const VERSION_FLAG = /^(-v|-V|--version|-h|--help|version)$/;

function gitIsReadOnly(args: string[]): boolean {
  const sub = args.find((a) => !a.startsWith("-"));
  if (!sub) return true; // 裸 `git`(打印用法)
  if (GIT_READONLY_SUB.has(sub)) return true;
  if (GIT_LIST_SUB.has(sub)) {
    const rest = args.slice(args.indexOf(sub) + 1);
    if (rest.some((a) => a.startsWith("-") && GIT_MUTATING_FLAG.test(a))) return false; // 带写标志 → 改动
    // 显式列出标志(-l/--list/--contains 等):后面的位置参数是过滤模式,仍只读
    if (rest.some((a) => /^(-l|--list|--contains|--no-contains|--merged|--no-merged|--points-at)$/.test(a)))
      return true;
    // 否则:有新增位置参数即视为创建/改名 → 不放行
    return !rest.some((a) => !a.startsWith("-"));
  }
  return false;
}

function segmentIsReadOnly(seg: string): boolean {
  let tokens = seg.trim().split(/\s+/).filter(Boolean);
  // 剥掉前置环境变量赋值(FOO=bar cmd ...)
  while (tokens[0] && /^\w+=/.test(tokens[0])) tokens = tokens.slice(1);
  const head = tokens[0];
  if (!head) return true;
  const rest = tokens.slice(1);
  if (head === "git") return gitIsReadOnly(rest);
  if (head === "find" || head === "fd") {
    return !rest.some((a) => /^-(delete|exec|execdir|ok|okdir|fprint|fprintf|fls)$/.test(a));
  }
  if (VERSION_PROBE_HEADS.has(head)) return rest.length > 0 && rest.every((a) => VERSION_FLAG.test(a));
  return READONLY_HEADS.has(head);
}

/** 写重定向(> / >>),排除 >& 合流与丢弃到 /dev/null。 */
function hasWriteRedirect(cmd: string): boolean {
  const redirects = cmd.match(/\d?>>?\s*[^\s|&;]*/g) ?? [];
  return redirects.some((r) => {
    if (r.includes(">&")) return false;
    const target = r.replace(/^\d?>>?\s*/, "");
    return target !== "" && target !== "/dev/null";
  });
}

/**
 * 把 skill 声明的安全命令模式(glob,`*` 通配)编译成前缀匹配正则。
 * 语义:从命令开头匹配(尾部可带额外 flag/参数),`*` 匹配任意字符。escape 其余正则元字符。
 * 例:`lark-cli * +*search*` 命中 `lark-cli contact +search-user --query x`。
 */
function compileSafePattern(glob: string): RegExp {
  const escaped = glob
    .trim()
    .replace(/[.+?^${}()|[\]\\]/g, "\\$&") // 转义正则元字符(保留 *)
    .replace(/\*/g, ".*");
  return new RegExp("^" + escaped);
}

/**
 * 按命令内容判定 exec_shell 的风险:纯只读且无写入副作用 → ReadOnly(自动执行);
 * 其余(写文件、改状态、命令替换、不在白名单)→ Destructive(走审批)。保守:拿不准一律审批。
 *
 * @param safePatterns skill 在 frontmatter 里声明的"本 skill 已知安全"的命令模式(glob)。
 *   内核不认识各 skill 带的 CLI(如 lark-cli),由 skill 自己声明哪些子命令只读;
 *   命中的命令段视同只读自动跑。**硬危险项(命令替换/sudo/写重定向)不被 safePatterns 豁免**。
 */
export function classifyShellRisk(command: string, safePatterns: readonly string[] = []): RiskLevel {
  const cmd = command.trim();
  if (!cmd) return "Destructive";
  // 命令替换可能藏写操作,sudo 永远要确认;写重定向落盘——这些是硬地板,skill 也豁免不了。
  if (/\$\(|`/.test(cmd) || /(^|\s)sudo(\s|$)/.test(cmd)) return "Destructive";
  if (hasWriteRedirect(cmd)) return "Destructive";
  const safe = safePatterns.map(compileSafePattern);
  const segOk = (seg: string): boolean => {
    const s = seg.trim();
    return segmentIsReadOnly(s) || safe.some((re) => re.test(s));
  };
  const segments = cmd.split(/&&|\|\||[;|]|\n/);
  return segments.every(segOk) ? "ReadOnly" : "Destructive";
}

export const shellGuidelines = `## Shell 执行
- exec_shell 用于需要命令行的场景:查系统状态、git 操作、压缩解压、运行脚本等。
- 纯只读命令(如 ls / cat / pwd / git status / git diff)自动执行,不打断用户;
  任何写文件、改状态或拿不准的命令都会先向用户弹审批,经其看过同意后才执行。
- 不要用它启动交互式程序(vim、top、htop、node 交互等),它们会挂住直到超时。
- 命令默认在用户主目录执行,可通过 cwd 指定其他目录。
- 超时默认 30 秒,最长 120 秒;长时间命令可手动调 timeout。
- 输出超出 100KB 会截断,stderr 超 10KB 截断。`;

export { CAPABILITY as shellCapability };
