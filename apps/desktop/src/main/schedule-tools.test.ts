import { describe, expect, it, beforeEach } from "vitest";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ScheduleRecord, ScheduleDraft } from "@pa/infra";
import { createScheduleTools } from "./schedule-tools";

/** 内存假 store + 变更计数,验证工具逻辑(不碰真实落盘/调度)。 */
function fakeDeps() {
  let seq = 0;
  const recs: ScheduleRecord[] = [];
  let changes = 0;
  return {
    recs,
    changes: () => changes,
    list: () => [...recs],
    create: (d: ScheduleDraft) => {
      recs.push({ id: `s${++seq}`, createdAt: seq, ...d });
      return [...recs];
    },
    update: (id: string, patch: Partial<ScheduleDraft>) => {
      const r = recs.find((x) => x.id === id);
      if (r) Object.assign(r, patch);
      return [...recs];
    },
    remove: (id: string) => {
      const i = recs.findIndex((x) => x.id === id);
      if (i >= 0) recs.splice(i, 1);
      return [...recs];
    },
    onChange: () => {
      changes++;
    }
  };
}

const tool = (tools: ReturnType<typeof createScheduleTools>, name: string) => tools.find((t) => t.name === name)!;
const run = (t: ReturnType<typeof createScheduleTools>[number], args: unknown): Promise<AgentToolResult<unknown>> =>
  t.execute("id", args as never, undefined as never) as Promise<AgentToolResult<unknown>>;
const textOf = (r: AgentToolResult<unknown>): string => {
  const c = r.content[0];
  return c && c.type === "text" ? c.text : "";
};

let deps: ReturnType<typeof fakeDeps>;
let tools: ReturnType<typeof createScheduleTools>;
beforeEach(() => {
  deps = fakeDeps();
  tools = createScheduleTools(deps);
});

describe("create_schedule", () => {
  it("建任务:规范化时间(补零)、空 days=每天,落盘并广播变更", async () => {
    const out = textOf(await run(tool(tools, "create_schedule"), { title: "新闻", prompt: "搜10条AI新闻", time: "9:00" }));
    expect(deps.recs).toHaveLength(1);
    expect(deps.recs[0]).toMatchObject({ title: "新闻", time: "09:00", days: [], enabled: true });
    expect(out).toContain("每天 09:00");
    expect(deps.changes()).toBe(1);
  });

  it("非法时间被拒,不落盘不广播", async () => {
    const out = textOf(await run(tool(tools, "create_schedule"), { title: "x", prompt: "y", time: "25:99" }));
    expect(out).toContain("时间格式不对");
    expect(deps.recs).toHaveLength(0);
    expect(deps.changes()).toBe(0);
  });

  it("days 去重排序、过滤越界值", async () => {
    await run(tool(tools, "create_schedule"), { title: "工作日", prompt: "p", time: "08:30", days: [5, 1, 1, 9, 3] });
    expect(deps.recs[0]!.days).toEqual([1, 3, 5]);
  });
});

describe("update / cancel", () => {
  it("update 改时间 + 暂停", async () => {
    deps.create({ title: "n", prompt: "p", time: "09:00", days: [], enabled: true });
    await run(tool(tools, "update_schedule"), { id: "s1", time: "8:15", enabled: false });
    expect(deps.recs[0]).toMatchObject({ time: "08:15", enabled: false });
    expect(deps.changes()).toBe(1);
  });

  it("update 不存在的 id → 报错、不广播", async () => {
    const out = textOf(await run(tool(tools, "update_schedule"), { id: "nope", time: "10:00" }));
    expect(out).toContain("没找到");
    expect(deps.changes()).toBe(0);
  });

  it("cancel 删除任务并广播", async () => {
    deps.create({ title: "n", prompt: "p", time: "09:00", days: [], enabled: true });
    const out = textOf(await run(tool(tools, "cancel_schedule"), { id: "s1" }));
    expect(deps.recs).toHaveLength(0);
    expect(out).toContain("已删除");
    expect(deps.changes()).toBe(1);
  });
});

describe("list_schedules", () => {
  it("空时明确提示;非空带 id 供后续改/删", async () => {
    expect(textOf(await run(tool(tools, "list_schedules"), {}))).toContain("没有任何定时任务");
    deps.create({ title: "晨报", prompt: "p", time: "09:00", days: [1, 2, 3, 4, 5], enabled: true });
    const out = textOf(await run(tool(tools, "list_schedules"), {}));
    expect(out).toContain("[s1]");
    expect(out).toContain("晨报");
  });
});
