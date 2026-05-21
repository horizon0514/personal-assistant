import { describe, expect, it, vi } from "vitest";
import { OperationJournal } from "./index";

function makeJournal() {
  const journal = new OperationJournal();
  const reverser = vi.fn(async () => {});
  journal.registerReverser("filesystem", reverser);
  return { journal, reverser };
}

describe("OperationJournal", () => {
  it("record 后可列出且初始未撤销", () => {
    const { journal } = makeJournal();
    journal.record({
      actionId: "a1",
      capability: "filesystem",
      tool: "write_file",
      summary: "/tmp/x",
      reversal: { kind: "fs.delete-created", path: "/tmp/x" }
    });
    expect(journal.list()).toHaveLength(1);
    expect(journal.hasUndoable()).toBe(true);
  });

  it("undoLast 调用对应能力的回滚器并标记 reverted", async () => {
    const { journal, reverser } = makeJournal();
    journal.record({
      actionId: "a1",
      capability: "filesystem",
      tool: "write_file",
      summary: "/tmp/x",
      reversal: { kind: "fs.restore", path: "/tmp/x", prevContent: "old" }
    });
    const entry = await journal.undoLast();
    expect(entry?.actionId).toBe("a1");
    expect(reverser).toHaveBeenCalledWith({ kind: "fs.restore", path: "/tmp/x", prevContent: "old" });
    expect(journal.hasUndoable()).toBe(false);
  });

  it("undoLast 按后进先出顺序撤销", async () => {
    const { journal } = makeJournal();
    journal.record({ actionId: "a1", capability: "filesystem", tool: "t", summary: "1", reversal: { kind: "k" } });
    journal.record({ actionId: "a2", capability: "filesystem", tool: "t", summary: "2", reversal: { kind: "k" } });
    expect((await journal.undoLast())?.actionId).toBe("a2");
    expect((await journal.undoLast())?.actionId).toBe("a1");
    expect(await journal.undoLast()).toBeUndefined();
  });

  it("未注册回滚器的能力抛错", async () => {
    const journal = new OperationJournal();
    journal.record({ actionId: "a1", capability: "browser", tool: "t", summary: "1", reversal: { kind: "k" } });
    await expect(journal.undoLast()).rejects.toThrow(/browser/);
  });
});
