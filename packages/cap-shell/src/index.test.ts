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
    "git worktree list"
  ])("写/改/拿不准的命令走审批: %s", (cmd) => {
    expect(classifyShellRisk(cmd)).toBe("Destructive");
  });

  it("空命令保守判为 Destructive", () => {
    expect(classifyShellRisk("   ")).toBe("Destructive");
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
