import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryStore, createMemoryTools, memoryToolNames } from "./index";

let dir: string;
let file: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "pa-mem-"));
  file = join(dir, "memory.json");
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("MemoryStore 迁移", () => {
  it("旧记录(enabled)补齐到新结构", () => {
    writeFileSync(
      file,
      JSON.stringify([
        { id: "a", kind: "fact", content: "旧事实", createdAt: 1, enabled: true },
        { id: "b", kind: "preference", content: "已停用", createdAt: 2, enabled: false }
      ])
    );
    const s = new MemoryStore(file);
    expect(s.list().map((m) => m.id)).toEqual(["a"]); // enabled:true → active
    expect(s.listForgotten().map((m) => m.id)).toEqual(["b"]); // enabled:false → forgotten
    const a = s.list()[0]!;
    expect(a.revisionCount).toBe(0);
    expect(a.situation).toBeUndefined();
  });
});

describe("MemoryStore 拟人能力", () => {
  it("add 带情景,list 视图含 situation/quote", () => {
    const s = new MemoryStore(file);
    s.add({ kind: "fact", content: "归档目录是 ~/归档", situation: "整理下载文件夹时", quote: "都放归档吧" });
    const v = s.list()[0]!;
    expect(v).toMatchObject({ content: "归档目录是 ~/归档", situation: "整理下载文件夹时", quote: "都放归档吧" });
  });

  it("update 追加 revision、保留旧值与原因", () => {
    const s = new MemoryStore(file);
    const item = s.add({ kind: "preference", content: "归档到 C 盘" });
    s.update(item.id, "归档到 D 盘", "用户换了盘");
    const v = s.list()[0]!;
    expect(v.content).toBe("归档到 D 盘");
    expect(v.revisionCount).toBe(1);
    expect(v.lastChange).toMatchObject({ prevContent: "归档到 C 盘", reason: "用户换了盘" });
  });

  it("forget 软删可恢复,持久化后仍在", () => {
    const s = new MemoryStore(file);
    const item = s.add({ kind: "fact", content: "记得我" });
    s.forget(item.id, "过时了");
    expect(s.list()).toHaveLength(0);
    expect(s.listForgotten()[0]).toMatchObject({ id: item.id, forgottenReason: "过时了" });

    // 重启后仍可恢复
    const s2 = new MemoryStore(file);
    s2.restore(item.id);
    expect(s2.list().some((m) => m.id === item.id)).toBe(true);
  });

  it("search 命中 content/situation/quote,排除已遗忘", () => {
    const s = new MemoryStore(file);
    s.add({ kind: "fact", content: "X", situation: "在做报税" });
    const gone = s.add({ kind: "fact", content: "报税相关但已忘" });
    s.forget(gone.id);
    const hits = s.search("报税");
    expect(hits).toHaveLength(1);
    expect(hits[0]!.episode.situation).toBe("在做报税");
  });

  it("4 个记忆工具齐备,remember 透传情景 + getSourceSessionId", async () => {
    const s = new MemoryStore(file);
    const tools = createMemoryTools(s, undefined, () => "sess-9");
    expect(tools.map((t) => t.name).sort()).toEqual([...memoryToolNames].sort());
    const remember = tools.find((t) => t.name === "remember")!;
    await remember.execute("a1", { kind: "fact", content: "C", situation: "做X时" } as never, {} as never);
    const v = s.list()[0]!;
    expect(v).toMatchObject({ content: "C", situation: "做X时", sourceSessionId: "sess-9" });
  });

  it("render 只含活跃记忆", () => {
    const s = new MemoryStore(file);
    s.add({ kind: "preference", content: "深色模式" });
    const gone = s.add({ kind: "fact", content: "不该出现" });
    s.forget(gone.id);
    const pref = s.list()[0]!;
    const text = s.render()!;
    expect(text).toContain("深色模式");
    expect(text).toContain(`[${pref.id}]`); // 带 id 供 agent 引用
    expect(text).not.toContain("不该出现");
  });
});
