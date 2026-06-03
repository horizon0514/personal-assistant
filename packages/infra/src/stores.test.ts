import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WorkspaceStore } from "./workspace-store";
import { SessionStore } from "./session-store";
import { ScheduleStore } from "./schedule-store";

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

  it("setDigest 持久化但不重排会话;recentWithDigest 倒序、排除当前、只取有摘要的", () => {
    const wsDir = join(root, "ws-digest");
    const s = new SessionStore(wsDir);
    const a = s.create("旧");
    const b = s.create("新"); // b 更晚,updatedAt 更大
    const bUpdatedAt = s.list().find((x) => x.id === b.id)!.updatedAt;
    s.setDigest(a.id, "意图:整理下载\n决策:删 .pco");
    s.setDigest(b.id, "意图:发飞书");

    // 不碰 updatedAt:写 digest 后 b 仍排在 a 前(顺序未因 digest 改变)
    expect(s.list().find((x) => x.id === b.id)!.updatedAt).toBe(bUpdatedAt);

    // 排除当前会话 b → 只剩 a;且带回 digest
    const recent = s.recentWithDigest(4, b.id);
    expect(recent.map((r) => r.id)).toEqual([a.id]);
    expect(recent[0]!.digest).toContain("整理下载");

    // 不排除时倒序(b 在前),且重启后 digest 保留
    expect(new SessionStore(wsDir).recentWithDigest(4).map((r) => r.id)).toEqual([b.id, a.id]);
  });

  it("setBoundNotebook 持久化、可解绑、不重排会话;重启保留", () => {
    const wsDir = join(root, "ws-bind");
    const s = new SessionStore(wsDir);
    const a = s.create("旧");
    const b = s.create("新");
    const bUpdatedAt = s.list().find((x) => x.id === b.id)!.updatedAt;

    s.setBoundNotebook(a.id, "  项目X调研  "); // 前后空白会被 trim
    expect(s.get(a.id)!.boundNotebook).toBe("项目X调研");

    // 不碰 updatedAt:绑定是配置而非活动,b 仍排在 a 前
    expect(s.list().find((x) => x.id === b.id)!.updatedAt).toBe(bUpdatedAt);

    // 重启后保留
    expect(new SessionStore(wsDir).get(a.id)!.boundNotebook).toBe("项目X调研");

    // 空字符串=解绑(字段删除)
    s.setBoundNotebook(a.id, "");
    expect(s.get(a.id)!.boundNotebook).toBeUndefined();
    expect(new SessionStore(wsDir).get(a.id)!.boundNotebook).toBeUndefined();
  });

  it("needingDigest:未处理/处理后又更新的会补跑;markDigested 后不再补;重启保留", () => {
    const wsDir = join(root, "ws-catchup");
    const s = new SessionStore(wsDir);
    const a = s.create("A");
    s.saveTranscript(a.id, [{ role: "user", content: "x" }]);

    // 从未处理 → 待补跑
    expect(s.needingDigest(8).map((r) => r.id)).toEqual([a.id]);

    // 标记已处理 → 不再待补
    s.markDigested(a.id);
    expect(s.needingDigest(8)).toHaveLength(0);
    expect(new SessionStore(wsDir).needingDigest(8)).toHaveLength(0); // 重启保留 digestedAt

    // 处理后又有新活动(updatedAt 抬高)→ 重新待补
    s.saveTranscript(a.id, [{ role: "user", content: "x2" }]);
    expect(s.needingDigest(8).map((r) => r.id)).toEqual([a.id]);

    // 排除当前会话
    expect(s.needingDigest(8, a.id)).toHaveLength(0);
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

  it("saveAttachment 把外部文件拷进会话附件目录,删会话连带清掉", () => {
    const wsDir = join(root, "ws-att");
    const s = new SessionStore(wsDir);
    const rec = s.create("带附件");

    // 准备一个外部源文件
    const src = join(root, "report.pdf");
    writeFileSync(src, "PDFDATA");

    const dest = s.saveAttachment(rec.id, src);
    expect(dest).toContain(join(wsDir, "sessions", `${rec.id}.attachments`));
    expect(dest.endsWith("-report.pdf")).toBe(true); // 原名保留 + 短随机前缀
    expect(existsSync(dest)).toBe(true);
    expect(readFileSync(dest, "utf8")).toBe("PDFDATA"); // 是拷贝,内容一致
    expect(existsSync(src)).toBe(true); // 原件不动

    // 删会话 → 附件目录连带清掉
    s.remove(rec.id);
    expect(existsSync(dest)).toBe(false);
    expect(existsSync(join(wsDir, "sessions", `${rec.id}.attachments`))).toBe(false);
  });
});

describe("ScheduleStore", () => {
  const draft = { title: "每日新闻", prompt: "搜 10 条新闻", time: "09:00", days: [], enabled: true };

  it("create/update/remove 落盘,重启后读回;list 按时间排序", () => {
    const a = new ScheduleStore(root);
    const morning = a.create(draft);
    a.create({ ...draft, title: "午间", time: "12:30" });

    // 按 time 升序
    expect(a.list().map((r) => r.time)).toEqual(["09:00", "12:30"]);

    // 重启读回
    const b = new ScheduleStore(root);
    expect(b.get(morning.id)?.title).toBe("每日新闻");

    // update 局部改
    b.update(morning.id, { enabled: false, time: "08:00" });
    expect(new ScheduleStore(root).get(morning.id)).toMatchObject({ enabled: false, time: "08:00" });

    // remove
    b.remove(morning.id);
    expect(new ScheduleStore(root).get(morning.id)).toBeUndefined();
  });

  it("markRun 记录 lastRunAt + 会话 id", () => {
    const s = new ScheduleStore(root);
    const rec = s.create(draft);
    s.markRun(rec.id, 1717200000000, "sess-1");
    const after = new ScheduleStore(root).get(rec.id);
    expect(after?.lastRunAt).toBe(1717200000000);
    expect(after?.lastSessionId).toBe("sess-1");
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
