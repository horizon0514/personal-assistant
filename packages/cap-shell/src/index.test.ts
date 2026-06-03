import { describe, it, expect } from "vitest";
import { classifyShellRisk, createShellTools } from "./index";

describe("classifyShellRisk", () => {
  it.each([
    "cd /tmp",
    "ls -la && pwd",
    "cat package.json | grep name",
    "find . -name '*.ts'",
    "node --version",
    "FOO=bar echo hi",
    "git status",
    "git diff HEAD~1",
    "git log --oneline -5",
    "git branch",
    "git branch -a",
    "git branch -vv",
    "git tag",
    "git tag -l 'v*'",
    "git remote -v"
  ])("只读命令自动执行: %s", (cmd) => {
    expect(classifyShellRisk(cmd)).toBe("ReadOnly");
  });

  it.each([
    "rm -rf /tmp/x",
    "mv a b",
    "echo hi > out.txt",
    "sudo ls",
    "cat $(which node)",
    "node script.js",
    "find . -delete",
    "ls && rm x",
    "git push",
    "git checkout -b new",
    "git branch -d feature",
    "git branch newbranch",
    "git branch -m newname",
    "git tag v1",
    "git tag -a v1 -m x",
    "git remote add origin url",
    "git stash",
    "git config user.name x",
    "git worktree list",
    // 内核不认识 skill 带的 CLI(如 lark-cli):不传 safePatterns 时一律审批
    'lark-cli im +messages-send --user-id ou_x --text "hi"',
    "lark-cli auth status"
  ])("写/改/拿不准的命令走审批: %s", (cmd) => {
    expect(classifyShellRisk(cmd)).toBe("Destructive");
  });

  it("空命令保守判为 Destructive", () => {
    expect(classifyShellRisk("   ")).toBe("Destructive");
  });
});

describe("classifyShellRisk + skill 声明的 safePatterns", () => {
  // 飞书 skill 声明的只读模式样例(实际写在 SKILL.md frontmatter)
  const larkSafe = ["lark-cli auth status", "lark-cli * +*search*", "lark-cli * +agenda", "lark-cli api GET *"];

  it.each([
    "lark-cli auth status",
    'lark-cli contact +search-user --query "黄思远"',
    'lark-cli im +messages-search --query "关键词"',
    "lark-cli calendar +agenda",
    "lark-cli api GET /open-apis/contact/v3/users/me"
  ])("命中 safePatterns → 自动跑: %s", (cmd) => {
    expect(classifyShellRisk(cmd, larkSafe)).toBe("ReadOnly");
  });

  it.each([
    'lark-cli im +messages-send --user-id ou_x --text "hi"', // 写:未命中只读模式
    "lark-cli auth login", // 拉浏览器:未命中
    "lark-cli api POST /open-apis/im/v1/messages" // 非 GET:未命中
  ])("未命中 safePatterns 的写操作仍审批: %s", (cmd) => {
    expect(classifyShellRisk(cmd, larkSafe)).toBe("Destructive");
  });

  it("硬危险项不被 safePatterns 豁免(命令替换/sudo/写重定向/复合段)", () => {
    expect(classifyShellRisk("lark-cli api GET $(rm -rf x)", larkSafe)).toBe("Destructive");
    expect(classifyShellRisk("lark-cli auth status && rm -rf /tmp/x", larkSafe)).toBe("Destructive");
    expect(classifyShellRisk("lark-cli auth status > steal.txt", larkSafe)).toBe("Destructive");
  });
});

describe("createShellTools 可插拔 shell 底座", () => {
  const run = (tools: ReturnType<typeof createShellTools>, command: string) =>
    tools[0]!.execute("id", { command }, undefined as never) as Promise<{
      content: { type: string; text: string }[];
      details: { exitCode: number | null; stdout: string };
    }>;

  it("默认(不传 shell)用系统 shell 跑通", async () => {
    const r = await run(createShellTools(), "echo hi-default");
    expect(r.details.stdout).toContain("hi-default");
    expect(r.details.exitCode).toBe(0);
  });

  it("显式 ShellSpec 走 execFile(bin,[...args,command]) 路径跑通", async () => {
    const r = await run(createShellTools({ shell: { bin: "/bin/sh", args: ["-c"] } }), "echo hi-spec");
    expect(r.details.stdout).toContain("hi-spec");
    expect(r.details.exitCode).toBe(0);
  });

  it("命令非零退出码如实回传", async () => {
    const r = await run(createShellTools(), "exit 3");
    expect(r.details.exitCode).toBe(3);
  });
});

describe("exec_shell 超时/中断必须能终止且 resolve(防会话卡死回归)", () => {
  const runWith = (
    command: string,
    opts: { timeout?: number; signal?: AbortSignal }
  ) =>
    createShellTools()[0]!.execute(
      "id",
      { command, timeout: opts.timeout },
      opts.signal as never
    ) as Promise<{
      content: { type: string; text: string }[];
      details: { exitCode: number | null; note?: string };
    }>;

  it("超时会杀掉长跑命令并以 exitCode=null resolve(不无限挂起)", async () => {
    const started = Date.now();
    const r = await runWith("sleep 10", { timeout: 300 });
    // 远早于 10s 就返回,说明超时真正生效
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.details.exitCode).toBeNull();
  }, 10_000);

  it("abort 会杀掉长跑命令并 resolve(进程组干净退出 → exitCode=null)", async () => {
    const ctrl = new AbortController();
    const p = runWith("sleep 10", { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 100);
    const started = Date.now();
    const r = await p;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.details.exitCode).toBeNull();
  }, 10_000);

  it("abort 收掉管道里的孙进程(整组终止,而非只杀 sh)", async () => {
    // `sleep 10 | cat`:sleep 是 sh 的孙进程。旧实现只杀 sh,sleep 存活并持着 pipe
    // → close 永不触发 → Promise 永挂。整组 kill 后必须快速 resolve。
    const ctrl = new AbortController();
    const p = runWith("sleep 10 | cat", { signal: ctrl.signal });
    setTimeout(() => ctrl.abort(), 100);
    const started = Date.now();
    const r = await p;
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(r.details.exitCode).toBeNull();
  }, 10_000);

  it("正常快命令不受影响,如实返回 exitCode=0", async () => {
    const ctrl = new AbortController();
    const r = await runWith("echo done", { signal: ctrl.signal });
    expect(r.details.exitCode).toBe(0);
    expect(r.content[0]!.text).toContain("done");
  });
});
