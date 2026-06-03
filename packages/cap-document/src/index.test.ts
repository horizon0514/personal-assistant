import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createDocumentTools, documentToolNames, documentToolRisk } from "./index";

const FIXTURES = join(fileURLToPath(new URL(".", import.meta.url)), "__fixtures__");

// ocrModelDir 仅在扫描件路径用到;这些测试都是数字 PDF / 纯文本,不触发 OCR,给个占位目录即可。
const tool = createDocumentTools({ ocrModelDir: join(tmpdir(), "pa-doc-ocr-models") }).find(
  (t) => t.name === "extract_document"
)!;
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

  it("数字版 PDF 经 liteparse 抽出文本(含中文、版面)", async () => {
    const res = await run(join(FIXTURES, "digital-text.pdf"));
    const text = (res.content[0] as { text: string }).text;
    expect(res.details).toMatchObject({ kind: "pdf" });
    expect((res.details as { pages: number }).pages).toBeGreaterThanOrEqual(1);
    expect(text).toContain("LiteParse"); // 英文
    expect(text).toContain("中文一行测试"); // 中文不乱码
    expect(text).toContain("12345"); // 数字/符号
  });
});
