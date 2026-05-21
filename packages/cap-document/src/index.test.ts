import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { documentTools, documentToolNames, documentToolRisk } from "./index";

const tool = documentTools.find((t) => t.name === "extract_document")!;
let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pa-doc-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

async function run(path: string) {
  return tool.execute("a1", { path } as never, {} as never);
}

describe("extract_document", () => {
  it("注册元数据齐全(供 capabilityOf / 风险分级)", () => {
    expect(documentToolNames.has("extract_document")).toBe(true);
    expect(documentToolRisk.extract_document).toBe("ReadOnly");
  });

  it("纯文本类直接读出内容", async () => {
    const p = join(dir, "note.md");
    writeFileSync(p, "# 标题\n正文内容");
    const res = await run(p);
    expect(res.content[0]).toMatchObject({ type: "text", text: "# 标题\n正文内容" });
    expect(res.details).toMatchObject({ kind: "text" });
  });

  it("不支持的格式给出明确说明而非崩溃", async () => {
    const p = join(dir, "a.bin");
    writeFileSync(p, "x");
    const res = await run(p);
    expect(res.details).toMatchObject({ kind: "unsupported" });
    expect((res.content[0] as { text: string }).text).toContain("不支持");
  });
});
