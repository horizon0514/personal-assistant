/**
 * ScheduleStore — 定时任务(cron-like)。全局一份(不分 workspace),落到
 * userData/schedules.json。与 session / memory 同风格:同步 JSON、目录惰性建、数据可见可删。
 *
 * 每条任务:在指定本地时间(HH:MM)、指定星期(空=每天)触发一次,由调度器把 `prompt`
 * 当作一条用户消息丢给 agent 跑,产出落成一条新会话。
 */
import { join } from "node:path";
import { readJson, writeJson } from "./persistence";

export interface ScheduleRecord {
  id: string;
  /** 任务名(展示 + 通知标题),如「每日新闻」。 */
  title: string;
  /** 到点丢给 agent 的指令原文,如「搜今天 10 条最重要的科技新闻,逐条给我标题+摘要+链接」。 */
  prompt: string;
  /** 触发时刻,本地 24h 制 "HH:MM"。 */
  time: string;
  /** 触发星期 0(周日)..6(周六);空数组 = 每天。 */
  days: number[];
  enabled: boolean;
  createdAt: number;
  /** 上次触发时间(毫秒);「同一天同一任务只跑一次」的去重判据。 */
  lastRunAt?: number;
  /** 上次触发产出的会话 id(供通知点开 / UI 跳转)。 */
  lastSessionId?: string;
}

/** 新建 / 编辑表单可写字段。 */
export type ScheduleDraft = Pick<ScheduleRecord, "title" | "prompt" | "time" | "days" | "enabled">;

export class ScheduleStore {
  private readonly path: string;
  private records: ScheduleRecord[];

  /** @param dir 形如 userData 根目录;文件落在 <dir>/schedules.json */
  constructor(dir: string) {
    this.path = join(dir, "schedules.json");
    this.records = readJson<ScheduleRecord[]>(this.path, []);
  }

  private persist(): void {
    writeJson(this.path, this.records);
  }

  /** 按触发时刻、再按创建顺序排序。 */
  list(): ScheduleRecord[] {
    return [...this.records].sort((a, b) => a.time.localeCompare(b.time) || a.createdAt - b.createdAt);
  }

  get(id: string): ScheduleRecord | undefined {
    return this.records.find((r) => r.id === id);
  }

  create(draft: ScheduleDraft): ScheduleRecord {
    const rec: ScheduleRecord = { id: crypto.randomUUID(), createdAt: Date.now(), ...draft };
    this.records.push(rec);
    this.persist();
    return rec;
  }

  update(id: string, patch: Partial<ScheduleDraft>): ScheduleRecord | undefined {
    const rec = this.records.find((r) => r.id === id);
    if (!rec) return undefined;
    Object.assign(rec, patch);
    this.persist();
    return rec;
  }

  remove(id: string): void {
    this.records = this.records.filter((r) => r.id !== id);
    this.persist();
  }

  /** 记一次触发:落 lastRunAt(去重判据)+ 产出会话 id。 */
  markRun(id: string, at: number, sessionId: string): void {
    const rec = this.records.find((r) => r.id === id);
    if (rec) {
      rec.lastRunAt = at;
      rec.lastSessionId = sessionId;
      this.persist();
    }
  }
}
