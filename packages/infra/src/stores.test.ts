import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceStore } from "./workspace-store";
import { SessionStore } from "./session-store";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "pa-store-"));
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("WorkspaceStore", () => {
  it("ensureDefault 在空仓建默认 workspace,且幂等", () => {
    const ws = new WorkspaceStore(join(root, "workspaces"));
    const id1 = ws.ensureDefault();
    const id2 = ws.ensureDefault();
    expect(id1).toBe(id2);
    expect(ws.list()).toHaveLength(1);
  });

  it("重启(新实例读同一目录)保留 workspace", () => {
    const root2 = join(root, "workspaces");
    const a = new WorkspaceStore(root2);
    a.ensureDefault();
    const created = a.create("工作");
    const b = new WorkspaceStore(root2); // 模拟重启
    expect(b.list().map((w) => w.name)).toContain("工作");
    expect(b.list().some((w) => w.id === created.id)).toBe(true);
  });
});

describe("SessionStore", () => {
  it("transcript 落盘后,新实例(重启)能读回", () => {
    const wsDir = join(root, "ws-1");
    const a = new SessionStore(wsDir);
    const rec = a.create();
    const transcript = [
      { role: "user", content: "整理下载文件夹", timestamp: 1 },
      { role: "assistant", content: [{ type: "text", text: "好的" }], timestamp: 2 }
    ];
    a.saveTranscript(rec.id, transcript);

    const b = new SessionStore(wsDir); // 模拟重启
    expect(b.list().some((s) => s.id === rec.id)).toBe(true);
    expect(b.loadTranscript(rec.id)).toEqual(transcript);
  });

  it("list 按 updatedAt 倒序", () => {
    const s = new SessionStore(join(root, "ws-2"));
    const first = s.create("旧");
    const second = s.create("新");
    s.saveTranscript(second.id, []); // 抬高 second 的 updatedAt
    expect(s.list()[0]!.id).toBe(second.id);
    expect(s.list()[1]!.id).toBe(first.id);
  });

  it("remove 从索引移除并清掉 transcript", () => {
    const s = new SessionStore(join(root, "ws-3"));
    const rec = s.create();
    s.saveTranscript(rec.id, [{ role: "user", content: "x" }]);
    s.remove(rec.id);
    expect(s.list()).toHaveLength(0);
    expect(s.loadTranscript(rec.id)).toBeUndefined();
  });

  it("归档:从 list 隐藏但保留,listArchived 可见且 transcript 不删", () => {
    const wsDir = join(root, "ws-4");
    const s = new SessionStore(wsDir);
    const rec = s.create("会话A");
    s.saveTranscript(rec.id, [{ role: "user", content: "记得我" }]);
    s.setArchived(rec.id, true);
    expect(s.list().some((x) => x.id === rec.id)).toBe(false);
    expect(s.listArchived().some((x) => x.id === rec.id)).toBe(true);
    expect(s.loadTranscript(rec.id)).toBeDefined(); // 归档不删 transcript

    // 重启后归档状态保留,且可恢复
    const s2 = new SessionStore(wsDir);
    expect(s2.listArchived()).toHaveLength(1);
    s2.setArchived(rec.id, false);
    expect(s2.list().some((x) => x.id === rec.id)).toBe(true);
  });
});

describe("WorkspaceStore.remove", () => {
  it("级联删子树,且拒绝删最后一个", () => {
    const ws = new WorkspaceStore(join(root, "ws"));
    ws.ensureDefault();
    const extra = ws.create("工作");
    // 在 extra 下写一个会话
    const sess = new SessionStore(ws.dir(extra.id));
    const rec = sess.create();
    sess.saveTranscript(rec.id, [{ role: "user", content: "x" }]);

    ws.remove(extra.id);
    expect(ws.list().some((w) => w.id === extra.id)).toBe(false);
    // 子树已清:新建 SessionStore 读不到记录
    expect(new SessionStore(ws.dir(extra.id)).list()).toHaveLength(0);

    const onlyId = ws.list()[0]!.id;
    ws.remove(onlyId); // 最后一个,应被拒绝
    expect(ws.list()).toHaveLength(1);
  });
});
