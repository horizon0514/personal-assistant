/**
 * SessionStore — 单个 workspace 下的会话:索引(元数据)+ 每会话 transcript。
 * transcript 对 infra 不透明(其类型 AgentMessage 属 pi,不外泄到 infra);
 * 这里只负责把它当 JSON 存取。它既喂 agent 恢复,又供渲染层重建 timeline。
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson, writeText } from "./persistence";

export interface SessionRecord {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  /** 已归档:不在会话列表展示,但 transcript 保留(不删)。 */
  archived?: boolean;
  /**
   * 滚动会话摘要:本会话的「意图 + 决策」(≤3 行,不含结果)。离开会话时蒸馏生成,
   * 注入新会话的「近期线索」给跨对话连续性(人感)。时间用 updatedAt 现算相对值。
   */
  digest?: string;
  /**
   * 上次跑完「离开后处理」(蒸馏摘要 + 沉淀记忆)的时间。`updatedAt > digestedAt` 即说明
   * 会话在处理后又有新内容(或从未处理过)——客户端重启时据此补跑漏掉的(如退出前没"离开")。
   */
  digestedAt?: number;
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

  /** 本会话执行轨迹文件的绝对路径(供验收器/执行器用只读工具读取)。 */
  tracePath(id: string): string {
    return join(this.workspaceDir, "sessions", `${id}.trace.txt`);
  }

  /** 覆写本会话当前任务的执行轨迹(可读文本,已带不可信围栏)。返回落盘路径。 */
  writeTrace(id: string, content: string): string {
    const p = this.tracePath(id);
    writeText(p, content);
    return p;
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

  /** 写入会话摘要。**不**碰 updatedAt——蒸馏发生在"离开后",不算一次活动,不该重排会话。 */
  setDigest(id: string, digest: string): void {
    const rec = this.records.find((r) => r.id === id);
    if (rec) {
      rec.digest = digest;
      this.persist();
    }
  }

  /** 标记「离开后处理」已跑完(不碰 updatedAt)。供重启补跑判断哪些会话还没处理。 */
  markDigested(id: string): void {
    const rec = this.records.find((r) => r.id === id);
    if (rec) {
      rec.digestedAt = this.tick();
      this.persist();
    }
  }

  /** 需补跑「离开后处理」的未归档会话(更新晚于上次处理 / 从未处理),最近优先。 */
  needingDigest(limit: number, excludeId?: string): SessionRecord[] {
    return this.records
      .filter((r) => !r.archived && r.id !== excludeId && r.updatedAt > (r.digestedAt ?? 0))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(0, limit));
  }

  /** 最近有摘要的未归档会话(倒序),供「近期线索」注入;排除当前会话。 */
  recentWithDigest(limit: number, excludeId?: string): SessionRecord[] {
    return this.records
      .filter((r) => !r.archived && r.digest && r.id !== excludeId)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, Math.max(0, limit));
  }

  remove(id: string): void {
    this.records = this.records.filter((r) => r.id !== id);
    this.persist();
    rmSync(this.transcriptPath(id), { force: true });
    rmSync(this.tracePath(id), { force: true });
  }
}
