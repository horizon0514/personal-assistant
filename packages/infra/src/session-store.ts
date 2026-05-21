/**
 * SessionStore — 单个 workspace 下的会话:索引(元数据)+ 每会话 transcript。
 * transcript 对 infra 不透明(其类型 AgentMessage 属 pi,不外泄到 infra);
 * 这里只负责把它当 JSON 存取。它既喂 agent 恢复,又供渲染层重建 timeline。
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "./persistence";

export interface SessionRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 已归档:不在会话列表展示,但 transcript 保留(不删)。 */
  archived?: boolean;
}

export class SessionStore {
  private readonly indexPath: string;
  private records: SessionRecord[];
  private lastTs = 0;

  /** @param workspaceDir 形如 <root>/<wsId> */
  constructor(private readonly workspaceDir: string) {
    this.indexPath = join(workspaceDir, "sessions", "index.json");
    this.records = readJson<SessionRecord[]>(this.indexPath, []);
    this.lastTs = Math.max(0, ...this.records.map((r) => r.updatedAt));
  }

  /** 单调递增时间戳:同毫秒内多次操作也能保证排序确定。 */
  private tick(): number {
    this.lastTs = Math.max(Date.now(), this.lastTs + 1);
    return this.lastTs;
  }

  private persist(): void {
    writeJson(this.indexPath, this.records);
  }

  private transcriptPath(id: string): string {
    return join(this.workspaceDir, "sessions", `${id}.json`);
  }

  /** 未归档会话,按最近活跃倒序。 */
  list(): SessionRecord[] {
    return this.records.filter((r) => !r.archived).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 已归档会话,按最近活跃倒序。 */
  listArchived(): SessionRecord[] {
    return this.records.filter((r) => r.archived).sort((a, b) => b.updatedAt - a.updatedAt);
  }

  /** 归档(可逆):保留 transcript,仅从主列表隐藏。 */
  setArchived(id: string, archived: boolean): void {
    const rec = this.records.find((r) => r.id === id);
    if (rec) {
      rec.archived = archived;
      this.persist();
    }
  }

  create(title = "新会话"): SessionRecord {
    const now = this.tick();
    const rec: SessionRecord = { id: crypto.randomUUID(), title, createdAt: now, updatedAt: now };
    this.records.push(rec);
    this.persist();
    return rec;
  }

  rename(id: string, title: string): void {
    const rec = this.records.find((r) => r.id === id);
    if (rec) {
      rec.title = title;
      rec.updatedAt = this.tick();
      this.persist();
    }
  }

  saveTranscript(id: string, transcript: unknown): void {
    writeJson(this.transcriptPath(id), { transcript });
    const rec = this.records.find((r) => r.id === id);
    if (rec) {
      rec.updatedAt = this.tick();
      this.persist();
    }
  }

  /** 加载 transcript;无则返回 undefined(新会话或文件缺失)。 */
  loadTranscript(id: string): unknown {
    return readJson<{ transcript?: unknown }>(this.transcriptPath(id), {}).transcript;
  }

  remove(id: string): void {
    this.records = this.records.filter((r) => r.id !== id);
    this.persist();
    rmSync(this.transcriptPath(id), { force: true });
  }
}
