import { describe, it, expect } from "vitest";
import { classifyOfficeRisk, createOfficeTools, officeToolNames } from "./index";

describe("classifyOfficeRisk", () => {
  it.each([
    ["view", "/abs/a.docx", "--mode", "text"],
    ["get", "/abs/a.xlsx", "/Sheet1/A1"],
    ["query", "/abs/a.pptx", "slide"],
    ["dump", "/abs/a.docx"],
    ["validate", "/abs/a.docx"],
    ["stats", "/abs/a.xlsx"]
  ])("纯读子命令自动执行: %s", (...args) => {
    expect(classifyOfficeRisk(args)).toBe("ReadOnly");
  });

  it.each([
    ["create", "/abs/new.docx"],
    ["new", "/abs/new.xlsx"],
    ["set", "/abs/a.xlsx", "/Sheet1/A1", "--prop", "value=42"],
    ["add", "/abs/a.pptx", "/slide", "--type", "slide"],
    ["remove", "/abs/a.docx", "/body/p[1]"],
    ["move", "/abs/a.docx", "/body/p[1]", "--to", "/body/p[3]"],
    ["merge", "/abs/tpl.docx", "--data", "data.json"],
    ["batch", "/abs/a.xlsx", "--script", "ops.json"],
    ["raw", "/abs/a.docx", "--set", "x"],
    ["open", "/abs/a.docx"],
    ["close", "/abs/a.docx"]
  ])("会改文件/拿不准的子命令走审批: %s", (...args) => {
    expect(classifyOfficeRisk(args)).toBe("Destructive");
  });

  it("空 args 保守判为 Destructive", () => {
    expect(classifyOfficeRisk([])).toBe("Destructive");
  });

  it("仅有选项、无子命令 → Destructive", () => {
    expect(classifyOfficeRisk(["--help-ish", "-x"])).toBe("Destructive");
  });

  it("子命令大小写不敏感", () => {
    expect(classifyOfficeRisk(["VIEW", "/abs/a.docx"])).toBe("ReadOnly");
  });
});

describe("createOfficeTools", () => {
  const tools = createOfficeTools({ officeBinDir: "/tmp/officecli-test" });

  it("暴露单个 office_cli 工具,工具名登记一致", () => {
    expect(tools).toHaveLength(1);
    expect(tools[0]!.name).toBe("office_cli");
    expect(officeToolNames.has("office_cli")).toBe(true);
  });

  it("空 args 直接返回错误,不触碰二进制/网络", async () => {
    const r = (await tools[0]!.execute("id", { args: [] }, undefined as never)) as {
      details: { error?: string };
    };
    expect(r.details.error).toBe("empty args");
  });
});
