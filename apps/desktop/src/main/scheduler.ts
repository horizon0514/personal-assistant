/**
 * 定时任务调度器。每 30s 一跳,把「到点」(本地 HH:MM 命中、当天还没跑过)的任务交给
 * runner 执行。设计极简——无外部依赖,跟项目「数据小、能看能删」的取向一致。
 *
 * 局限(v1):只在 App 运行时触发;错过的(如 9 点 App 没开)当天不补跑。
 */
import { app } from "electron";
import { ScheduleStore, type ScheduleRecord, type ScheduleDraft } from "@pa/infra";

const TICK_MS = 30_000;

const store = new ScheduleStore(app.getPath("userData"));

/** 本地 "HH:MM"(补零)。 */
function hhmm(d: Date): string {
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** 同一本地日(忽略时分秒),用于「今天是否已跑过」去重。 */
function sameLocalDay(a: number, b: number): boolean {
  const x = new Date(a);
  const y = new Date(b);
  return x.getFullYear() === y.getFullYear() && x.getMonth() === y.getMonth() && x.getDate() === y.getDate();
}

/** 该任务此刻是否应触发。 */
function isDue(rec: ScheduleRecord, now: Date): boolean {
  if (!rec.enabled) return false;
  if (rec.time !== hhmm(now)) return false;
  if (rec.days.length > 0 && !rec.days.includes(now.getDay())) return false;
  if (rec.lastRunAt && sameLocalDay(rec.lastRunAt, now.getTime())) return false; // 当天已跑
  return true;
}

type Runner = (rec: ScheduleRecord) => Promise<void>;

let runner: Runner | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
const firing = new Set<string>(); // 防重入:上一次还没跑完别再起同一任务

/** 立即触发某任务(调度命中 / 手动「立即运行」共用)。 */
function fire(rec: ScheduleRecord): void {
  if (!runner || firing.has(rec.id)) return;
  firing.add(rec.id);
  void runner(rec).finally(() => firing.delete(rec.id));
}

function tick(): void {
  if (!runner) return;
  const now = new Date();
  for (const rec of store.list()) {
    if (firing.has(rec.id) || !isDue(rec, now)) continue;
    fire(rec);
  }
}

/** 启动调度循环,绑定真正执行任务的 runner(由 index.ts 注入:跑 agent + 通知)。 */
export function startScheduler(run: Runner): void {
  runner = run;
  if (!timer) timer = setInterval(tick, TICK_MS);
}

/** 定时任务 facade(供 IPC 委派)。CRUD 返回最新列表,渲染层直接替换。 */
export const schedules = {
  list: (): ScheduleRecord[] => store.list(),
  create: (draft: ScheduleDraft): ScheduleRecord[] => {
    store.create(draft);
    return store.list();
  },
  update: (id: string, patch: Partial<ScheduleDraft>): ScheduleRecord[] => {
    store.update(id, patch);
    return store.list();
  },
  remove: (id: string): ScheduleRecord[] => {
    store.remove(id);
    return store.list();
  },
  /** 记一次触发(runner 跑完回写 lastRunAt + 会话 id)。 */
  markRun: (id: string, at: number, sessionId: string): void => store.markRun(id, at, sessionId),
  /** 立即运行一次(测试 / 手动触发),不影响其按时调度。 */
  runNow: (id: string): ScheduleRecord[] => {
    const rec = store.get(id);
    if (rec) fire(rec);
    return store.list();
  }
};
