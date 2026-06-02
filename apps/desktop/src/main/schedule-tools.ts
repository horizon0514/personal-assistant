/**
 * 定时任务的自然语言工具(取代鼠标填表单)。让模型从一句话直接建/查/改/取消定时任务:
 * 「每天早上 9 点给我搜 10 条 AI 新闻」→ 模型把意图映射成 {title, prompt, time, days} 调 create_schedule。
 * 面板(ScheduleManager)退化成"可见可管"的展示层,不再是设置入口。贴合 akari-goal:别让用户碰表单。
 *
 * 注意:定时任务到点是在**全新会话**里无人值守地跑 `prompt`,所以 prompt 必须**自包含**(把完整意图写进去,
 * 别依赖当前对话上下文)。time 用 24 小时 `HH:MM`(本地);days 为星期数组(0=周日…6=周六),空=每天。
 */
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ScheduleRecord, ScheduleDraft } from "@pa/infra";

export const scheduleToolNames: ReadonlySet<string> = new Set([
  "create_schedule",
  "list_schedules",
  "update_schedule",
  "cancel_schedule"
]);

export interface ScheduleToolsDeps {
  list: () => ScheduleRecord[];
  create: (draft: ScheduleDraft) => ScheduleRecord[];
  update: (id: string, patch: Partial<ScheduleDraft>) => ScheduleRecord[];
  remove: (id: string) => ScheduleRecord[];
  /** 变更后通知渲染层刷新面板。 */
  onChange: () => void;
}

const WEEK = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const TIME_RE = /^([01]?\d|2[0-3]):([0-5]\d)$/;

/** 校验并规范化 HH:MM(补零)。非法返回 undefined。 */
function normTime(t: string): string | undefined {
  const m = TIME_RE.exec(t.trim());
  if (!m) return undefined;
  return `${m[1]!.padStart(2, "0")}:${m[2]}`;
}

/** 过滤成合法星期数组(0-6 去重排序);非数组/空 → [](每天)。 */
function normDays(days: unknown): number[] {
  if (!Array.isArray(days)) return [];
  return [...new Set(days.filter((d): d is number => Number.isInteger(d) && d >= 0 && d <= 6))].sort();
}

function whenLabel(time: string, days: number[]): string {
  if (days.length === 0) return `每天 ${time}`;
  if (days.length === 7) return `每天 ${time}`;
  return `每${days.map((d) => WEEK[d]!.slice(1)).join("、")} ${time}`; // 周一→一
}

function line(r: ScheduleRecord): string {
  const last = r.lastRunAt ? `,上次 ${new Date(r.lastRunAt).toLocaleString("zh-CN")}` : "";
  return `- [${r.id}] ${r.title} · ${whenLabel(r.time, r.days)} · ${r.enabled ? "启用" : "已停用"}${last}\n    指令:${r.prompt}`;
}

function result(text: string, details: unknown): AgentToolResult<unknown> {
  return { content: [{ type: "text", text }], details };
}

const createParams = Type.Object({
  title: Type.String({ description: "简短任务名,如「每日 AI 新闻」" }),
  prompt: Type.String({
    description: "到点要无人值守执行的**完整自包含指令**(在全新会话里跑,别依赖当前上下文)。例:搜索今天最新的 10 条 AI 行业新闻,列出标题、一句话摘要和链接。"
  }),
  time: Type.String({ description: "本地触发时刻,24 小时制 HH:MM,如 09:00 / 21:30" }),
  days: Type.Optional(
    Type.Array(Type.Number(), {
      description: "星期数组,0=周日…6=周六;省略或空数组=每天。如工作日填 [1,2,3,4,5]"
    })
  )
});

const updateParams = Type.Object({
  id: Type.String({ description: "要改的任务 id(先 list_schedules 拿)" }),
  title: Type.Optional(Type.String()),
  prompt: Type.Optional(Type.String()),
  time: Type.Optional(Type.String({ description: "新的 HH:MM" })),
  days: Type.Optional(Type.Array(Type.Number(), { description: "新的星期数组;空=每天" })),
  enabled: Type.Optional(Type.Boolean({ description: "false=暂停(保留任务),true=恢复" }))
});

const idParams = Type.Object({ id: Type.String({ description: "要取消的任务 id(先 list_schedules 拿)" }) });
const emptyParams = Type.Object({});

/** 创建定时任务的 NL 工具集。在组合根用 scheduler 的 `schedules` facade + 面板刷新广播注入。 */
export function createScheduleTools(deps: ScheduleToolsDeps): AgentTool<any>[] {
  const createSchedule: AgentTool<typeof createParams> = {
    name: "create_schedule",
    label: "建定时任务",
    description:
      "设一个定时任务:在指定本地时刻(每天/指定星期)无人值守地跑一条指令,跑完弹系统通知。用户说「每天/每周某时做某事」「定时/定期/到点提醒我…」时用。建完用一句话回报你设了什么。",
    parameters: createParams,
    execute: async (_id, a): Promise<AgentToolResult<unknown>> => {
      const time = normTime(a.time);
      if (!time) return result(`时间格式不对:「${a.time}」。请用 24 小时制 HH:MM,如 09:00。`, { ok: false });
      const days = normDays(a.days);
      const list = deps.create({ title: a.title.trim() || "定时任务", prompt: a.prompt.trim(), time, days, enabled: true });
      deps.onChange();
      const created = list.find((r) => r.title === a.title.trim() && r.time === time);
      return result(`已设定时任务:${whenLabel(time, days)} · ${a.title.trim()}\n指令:${a.prompt.trim()}`, {
        ok: true,
        id: created?.id
      });
    }
  };

  const listSchedules: AgentTool<typeof emptyParams> = {
    name: "list_schedules",
    label: "查定时任务",
    description: "列出当前所有定时任务(含 id、时间、启停、上次运行)。改/取消某个任务前先用它拿 id。",
    parameters: emptyParams,
    execute: async (): Promise<AgentToolResult<unknown>> => {
      const list = deps.list();
      if (!list.length) return result("当前没有任何定时任务。", { count: 0 });
      return result(`当前 ${list.length} 个定时任务:\n${list.map(line).join("\n")}`, { count: list.length });
    }
  };

  const updateSchedule: AgentTool<typeof updateParams> = {
    name: "update_schedule",
    label: "改定时任务",
    description: "按 id 修改一个定时任务的时间/星期/指令/名称,或启停(enabled)。先 list_schedules 拿 id。",
    parameters: updateParams,
    execute: async (_id, a): Promise<AgentToolResult<unknown>> => {
      const patch: Partial<ScheduleDraft> = {};
      if (a.title !== undefined) patch.title = a.title.trim();
      if (a.prompt !== undefined) patch.prompt = a.prompt.trim();
      if (a.days !== undefined) patch.days = normDays(a.days);
      if (a.enabled !== undefined) patch.enabled = a.enabled;
      if (a.time !== undefined) {
        const t = normTime(a.time);
        if (!t) return result(`时间格式不对:「${a.time}」。请用 HH:MM。`, { ok: false });
        patch.time = t;
      }
      const list = deps.update(a.id, patch);
      const rec = list.find((r) => r.id === a.id);
      if (!rec) return result(`没找到 id 为 ${a.id} 的定时任务(可能已删)。先 list_schedules 确认。`, { ok: false });
      deps.onChange();
      return result(`已更新:${rec.title} · ${whenLabel(rec.time, rec.days)} · ${rec.enabled ? "启用" : "已停用"}`, {
        ok: true
      });
    }
  };

  const cancelSchedule: AgentTool<typeof idParams> = {
    name: "cancel_schedule",
    label: "取消定时任务",
    description: "按 id 彻底删除一个定时任务(不可恢复)。只想暂停就用 update_schedule 设 enabled=false。先 list_schedules 拿 id。",
    parameters: idParams,
    execute: async (_id, { id }): Promise<AgentToolResult<unknown>> => {
      const before = deps.list().find((r) => r.id === id);
      if (!before) return result(`没找到 id 为 ${id} 的定时任务。`, { ok: false });
      deps.remove(id);
      deps.onChange();
      return result(`已删除定时任务:${before.title}(${whenLabel(before.time, before.days)})。`, { ok: true });
    }
  };

  return [createSchedule, listSchedules, updateSchedule, cancelSchedule];
}

/** 注入 system prompt 的定时任务指南。 */
export const scheduleGuidelines = `## 定时任务
- 用户要"每天/每周某时做某事""定时/定期/到点提醒我…"时,用 create_schedule 设定,别让他去面板填表单。
- **prompt 必须自包含**:任务到点是在全新会话里无人值守地跑,把完整意图写进 prompt(别依赖当前对话)。
- 时间用 24 小时 HH:MM;时间含糊(如"早上""晚点")先问清几点再设。设好后用一句话回报设了什么。
- 改/停/删已有任务:先 list_schedules 拿 id,再 update_schedule(enabled=false 为暂停)/ cancel_schedule(删除)。`;
