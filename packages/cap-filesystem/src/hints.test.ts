/**
 * 零结果/路径错时,工具返回是否"会说话"——附近邻、附下一步、把模型从同样的查询里推出去。
 * 触发的设计动机见 research/agent-design-insights.md(ACI 工具错误引导)。
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { filesystemTools } from "./index";

function tool(name: string) {
  const t = filesystemTools.find((x) => x.name === name);
  if (!t) throw new Error(`未找到工具 ${name}`);
  return t;
}

function textOf(result: { content: readonly unknown[] }): string {
  return result.content
    .filter((c): c is { type: "text"; text: string } => (c as { type?: string })?.type === "text")
    .map((c) => c.text)
    .join("\n");
}

describe("filesystem 工具:零结果/路径错时的换路提示", () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "fs-hints-"));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  describe("list_dir", () => {
    it("健康路径:正常列出条目", async () => {
      writeFileSync(join(root, "a.txt"), "x");
      const result = await tool("list_dir").execute("t1", { path: root });
      expect(textOf(result)).toContain("a.txt");
    });

    it("不存在 → 抛错且附父目录里的近邻", async () => {
      writeFileSync(join(root, "reports-final.md"), "x");
      writeFileSync(join(root, "reports-draft.md"), "x");
      await expect(tool("list_dir").execute("t1", { path: join(root, "reports") })).rejects.toThrow(
        /reports-final\.md|reports-draft\.md/
      );
    });

    it("父目录也没近邻 → 至少告诉模型别凭路径名臆测", async () => {
      await expect(tool("list_dir").execute("t1", { path: join(root, "nope/deeper") })).rejects.toThrow(
        /确认绝对路径|别凭路径名/
      );
    });
  });

  describe("read_file", () => {
    it("不存在 → 抛错且附同目录近邻", async () => {
      writeFileSync(join(root, "data.json"), "{}");
      writeFileSync(join(root, "data.yaml"), "x");
      await expect(tool("read_file").execute("t1", { path: join(root, "data") })).rejects.toThrow(
        /data\.json|data\.yaml/
      );
    });

    it("路径是目录 → 抛错且建议 list_dir", async () => {
      const sub = join(root, "sub");
      mkdirSync(sub);
      await expect(tool("read_file").execute("t1", { path: sub })).rejects.toThrow(/list_dir/);
    });
  });

  describe("find_files", () => {
    it("dir 不存在 → 提示路径不存在", async () => {
      const result = await tool("find_files").execute("t1", {
        dir: join(root, "nope"),
        namePattern: "*.pdf"
      });
      expect(textOf(result)).toContain("不存在");
    });

    it("零命中但 stem 在目录有相似文件 → 列出近邻", async () => {
      writeFileSync(join(root, "reports-2025.pdf"), "x");
      writeFileSync(join(root, "reports-draft.docx"), "x");
      writeFileSync(join(root, "other.txt"), "x");
      const text = textOf(
        await tool("find_files").execute("t1", { dir: root, namePattern: "reports-final*" })
      );
      expect(text).toMatch(/可能相关/);
      expect(text).toMatch(/reports-2025\.pdf/);
      expect(text).toMatch(/reports-draft\.docx/);
      expect(text).not.toMatch(/other\.txt/); // 不带 stem 命中的不该混进来
    });

    it("零命中且无相似 → 至少列出目录里实际有的扩展名 + 下一步", async () => {
      writeFileSync(join(root, "a.txt"), "x");
      writeFileSync(join(root, "b.json"), "x");
      const text = textOf(await tool("find_files").execute("t1", { dir: root, namePattern: "*.pdf" }));
      expect(text).toMatch(/\.txt/);
      expect(text).toMatch(/\.json/);
      expect(text).toMatch(/下一步/);
      expect(text).toMatch(/别用同一参数再搜一次/);
    });
  });

  describe("grep_files", () => {
    it("dir 不存在 → 提示路径不存在", async () => {
      const result = await tool("grep_files").execute("t1", {
        dir: join(root, "nope"),
        query: "foo"
      });
      expect(textOf(result)).toContain("不存在");
    });

    it("扫了但零命中 → 提示换关键词、别重复同样的查询", async () => {
      writeFileSync(join(root, "a.txt"), "hello world");
      writeFileSync(join(root, "b.txt"), "lorem ipsum");
      const text = textOf(await tool("grep_files").execute("t1", { dir: root, query: "zzz" }));
      expect(text).toMatch(/已扫描 2 个文件/);
      expect(text).toMatch(/下一步/);
      expect(text).toMatch(/别用同一参数再搜一次/);
    });

    it("namePattern 把文件过滤光 → 提示先 find_files 确认模式", async () => {
      writeFileSync(join(root, "a.txt"), "hello");
      const text = textOf(
        await tool("grep_files").execute("t1", { dir: root, query: "hello", namePattern: "*.pdf" })
      );
      expect(text).toMatch(/namePattern/);
      expect(text).toMatch(/find_files/);
    });

    it("健康路径:有命中时不走提示分支", async () => {
      writeFileSync(join(root, "a.txt"), "hello world");
      const text = textOf(await tool("grep_files").execute("t1", { dir: root, query: "hello" }));
      expect(text).toMatch(/a\.txt:1/);
      expect(text).not.toMatch(/下一步/);
    });
  });
});
