import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { scanSkills, renderSkillsForContext, createUseSkillTool } from "./index";

/** 取结果首个文本块(测试里 use_skill 只产出 text)。 */
function textOf(r: AgentToolResult<unknown>): string {
  const c = r.content[0];
  return c && c.type === "text" ? c.text : "";
}

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "skills-"));
  // 合法 skill:带 frontmatter
  mkdirSync(join(root, "fei-shu"));
  writeFileSync(
    join(root, "fei-shu", "SKILL.md"),
    `---\nname: fei-shu\ndescription: 飞书操作\n---\n# 飞书\n用 lark-cli 发消息。`
  );
  // 无 frontmatter:name 退回目录名,description 为空,正文=全文
  mkdirSync(join(root, "plain"));
  writeFileSync(join(root, "plain", "SKILL.md"), `just a body`);
  // 带 safeShell 列表 frontmatter 的 skill
  mkdirSync(join(root, "withsafe"));
  writeFileSync(
    join(root, "withsafe", "SKILL.md"),
    `---\nname: withsafe\ndescription: 带安全命令声明\nsafeShell:\n  - 'foo-cli status'\n  - 'foo-cli * +*search*'\n---\n# 正文`
  );
  // 没有 SKILL.md 的目录:跳过
  mkdirSync(join(root, "empty-dir"));
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

describe("scanSkills", () => {
  it("发现带 SKILL.md 的目录,解析 frontmatter,跳过无 md 的目录", () => {
    const skills = scanSkills(root);
    expect(skills.map((s) => s.name)).toEqual(["fei-shu", "plain", "withsafe"]); // 按名排序,empty-dir 被跳过
    const fs = skills.find((s) => s.name === "fei-shu")!;
    expect(fs.description).toBe("飞书操作");
    expect(fs.body).toContain("用 lark-cli 发消息");
  });

  it("无 frontmatter 时 name 退回目录名、正文为全文", () => {
    const plain = scanSkills(root).find((s) => s.name === "plain")!;
    expect(plain.description).toBe("");
    expect(plain.body).toBe("just a body");
  });

  it("解析 safeShell 列表(去引号),其余单行 key 不受影响;无声明则为空数组", () => {
    const skills = scanSkills(root);
    const ws = skills.find((s) => s.name === "withsafe")!;
    expect(ws.description).toBe("带安全命令声明"); // 列表块不吞掉相邻单行 key
    expect(ws.safeShell).toEqual(["foo-cli status", "foo-cli * +*search*"]);
    expect(ws.body).toContain("正文");
    expect(skills.find((s) => s.name === "plain")!.safeShell).toEqual([]);
  });

  it("目录不存在返回空数组", () => {
    expect(scanSkills(join(root, "nope"))).toEqual([]);
  });
});

describe("renderSkillsForContext", () => {
  it("空列表且无 skillsDir → 空串(不污染上下文)", () => {
    expect(renderSkillsForContext([])).toBe("");
  });
  it("非空时含每个 skill 的名与描述", () => {
    const out = renderSkillsForContext(scanSkills(root));
    expect(out).toContain("可用 Skill");
    expect(out).toContain("**fei-shu**:飞书操作");
  });
  it("传 skillsDir 时附「如何自己创建 Skill」说明(含路径+热加载),哪怕没有 skill", () => {
    const out = renderSkillsForContext([], "/data/skills");
    expect(out).toContain("自己创建 Skill");
    expect(out).toContain("/data/skills/<英文短名>/SKILL.md");
    expect(out).toContain("下一条消息"); // 热加载说明
  });
});

describe("createUseSkillTool", () => {
  const tool = () => createUseSkillTool({ list: () => scanSkills(root) });

  it("命中返回手册正文 + found:true", async () => {
    const r = await tool().execute("id", { name: "fei-shu" }, undefined as never);
    expect(textOf(r)).toContain("用 lark-cli 发消息");
    expect((r.details as { found: boolean }).found).toBe(true);
  });

  it("未命中返回可用清单 + found:false(不抛错)", async () => {
    const r = await tool().execute("id", { name: "nope" }, undefined as never);
    expect((r.details as { found: boolean }).found).toBe(false);
    expect(textOf(r)).toContain("fei-shu");
  });

  it("list 每次现调 = 热加载:新增 skill 立即可见", async () => {
    mkdirSync(join(root, "excel"));
    writeFileSync(join(root, "excel", "SKILL.md"), `---\nname: excel\ndescription: 表格\n---\n手册`);
    const r = await tool().execute("id", { name: "excel" }, undefined as never);
    expect((r.details as { found: boolean }).found).toBe(true);
  });
});
