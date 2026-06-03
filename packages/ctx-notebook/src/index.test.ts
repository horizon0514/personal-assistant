import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  NotebookStore,
  createNotebookTools,
  notebookToolNames,
  type DocumentExtractor,
  type ExtractedDoc
} from "./index";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pa-nb-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** 假抽取器:按路径回不同结果,记录调用次数(验证去重不重抽)。 */
function fakeExtractor(map: Record<string, ExtractedDoc>): DocumentExtractor & { calls: string[] } {
  const calls: string[] = [];
  const fn = (async (path: string) => {
    calls.push(path);
    return map[path] ?? { kind: "unsupported", pages: [], ocr: false, note: "不支持" };
  }) as unknown as DocumentExtractor & { calls: string[] };
  fn.calls = calls;
  return fn;
}

const PDF: ExtractedDoc = {
  kind: "pdf",
  ocr: false,
  pageCount: 2,
  pages: [
    { page: 1, text: "第一页讲预算" },
    { page: 2, text: "第二页讲明细" }
  ]
};

describe("NotebookStore", () => {
  it("ensureNotebook 按名大小写不敏感,取或建、落盘可重载", () => {
    const s = new NotebookStore(dir);
    const a = s.ensureNotebook("项目X");
    const b = s.ensureNotebook("  项目x  ");
    expect(b.id).toBe(a.id); // 同名复用,不新建

    // 重新打开:持久化生效
    const reopened = new NotebookStore(dir);
    expect(reopened.listNotebooks()).toHaveLength(1);
    expect(reopened.getNotebook("项目X")?.name).toBe("项目X");
  });

  it("addSource 缓存逐页文本、算 chars;视图不漏文本但带元数据", () => {
    const s = new NotebookStore(dir);
    const { source } = s.addSource("库", {
      path: "/docs/a.pdf",
      name: "a.pdf",
      kind: "pdf",
      ocr: false,
      pageCount: 2,
      pages: PDF.pages
    });
    expect(source.pages).toHaveLength(2);
    expect(source.chars).toBe("第一页讲预算".length + "第二页讲明细".length);

    const view = s.getNotebook("库")!;
    expect(view.sourceCount).toBe(1);
    expect(view.sources[0]).toMatchObject({ name: "a.pdf", pageCount: 2, kind: "pdf" });
    // 视图里不应携带逐页全文(避免撑爆列表)
    expect(view.sources[0] as unknown as Record<string, unknown>).not.toHaveProperty("pages");
  });

  it("removeSource 软删留痕:活跃数减少,但可重载(不真删)", () => {
    const s = new NotebookStore(dir);
    s.addSource("库", { path: "/d/a.pdf", name: "a.pdf", kind: "pdf", ocr: false, pageCount: 1, pages: [{ page: 1, text: "x" }] });
    const removed = s.removeSource("库", "a.pdf", "过期");
    expect(removed?.removedReason).toBe("过期");
    expect(s.getNotebook("库")!.sourceCount).toBe(0);

    // 软删:文件里仍在(status=removed),重载仍可见 active=0
    const reopened = new NotebookStore(dir);
    expect(reopened.getNotebook("库")!.sourceCount).toBe(0);
  });

  it("findActiveSourceByPath 命中已入库的活跃来源", () => {
    const s = new NotebookStore(dir);
    s.addSource("库", { path: "/d/a.pdf", name: "a.pdf", kind: "pdf", ocr: false, pageCount: 1, pages: [{ page: 1, text: "x" }] });
    expect(s.findActiveSourceByPath("库", "/d/a.pdf")).toBeDefined();
    expect(s.findActiveSourceByPath("库", "/d/other.pdf")).toBeUndefined();
  });
});

async function call(tool: AgentToolLike, args: Record<string, unknown>) {
  return tool.execute("act1", args as never, {} as never);
}
interface AgentToolLike {
  name: string;
  execute: (id: string, args: never, ctx: never) => Promise<{ content: { text: string }[]; details: unknown }>;
}

describe("createNotebookTools", () => {
  it("工具名齐全(供组合根登记)", () => {
    expect([...notebookToolNames].sort()).toEqual(["notebook_add_source", "notebook_list", "notebook_remove_source"]);
  });

  it("add → list → remove 走通,且重复添加不重抽取", async () => {
    const s = new NotebookStore(dir);
    const extract = fakeExtractor({ "/docs/budget.pdf": PDF });
    const tools = createNotebookTools(s, extract) as unknown as AgentToolLike[];
    const add = tools.find((t) => t.name === "notebook_add_source")!;
    const list = tools.find((t) => t.name === "notebook_list")!;
    const remove = tools.find((t) => t.name === "notebook_remove_source")!;

    const r1 = await call(add, { notebook: "预算库", path: "/docs/budget.pdf" });
    expect((r1.content[0] as { text: string }).text).toContain("已加入知识库「预算库」");
    expect(r1.details).toMatchObject({ added: true });

    // 重复添加:不再调用抽取器
    const r2 = await call(add, { notebook: "预算库", path: "/docs/budget.pdf" });
    expect(r2.details).toMatchObject({ reused: true });
    expect(extract.calls).toEqual(["/docs/budget.pdf"]); // 只抽过一次

    // 列出所有库
    const all = await call(list, {});
    expect((all.content[0] as { text: string }).text).toContain("预算库(1 份来源)");

    // 列出库内来源
    const inside = await call(list, { notebook: "预算库" });
    expect((inside.content[0] as { text: string }).text).toContain("budget.pdf");

    // 移除
    const rm = await call(remove, { notebook: "预算库", source: "budget" });
    expect(rm.details).toMatchObject({ removed: true });
    expect((await call(list, { notebook: "预算库" })).details).toMatchObject({ count: 0 });
  });

  it("不支持格式不入库,给明确说明", async () => {
    const s = new NotebookStore(dir);
    const extract = fakeExtractor({ "/docs/x.docx": { kind: "unsupported", pages: [], ocr: false, note: "不支持的文档格式" } });
    const tools = createNotebookTools(s, extract) as unknown as AgentToolLike[];
    const add = tools.find((t) => t.name === "notebook_add_source")!;
    const r = await call(add, { notebook: "库", path: "/docs/x.docx" });
    expect(r.details).toMatchObject({ added: false });
    expect(s.listNotebooks()).toHaveLength(0); // 没建空库、没塞坏来源
  });

  it("扫描件 OCR 空:入库但标 error 留痕(不静默丢)", async () => {
    const s = new NotebookStore(dir);
    const extract = fakeExtractor({ "/docs/scan.pdf": { kind: "pdf", pages: [], ocr: true, pageCount: 3, note: "OCR 未识别" } });
    const tools = createNotebookTools(s, extract) as unknown as AgentToolLike[];
    const add = tools.find((t) => t.name === "notebook_add_source")!;
    const r = await call(add, { notebook: "库", path: "/docs/scan.pdf" });
    expect(r.details).toMatchObject({ added: true, error: true });
    expect(s.getNotebook("库")!.sources[0]).toMatchObject({ error: true });
  });
});
