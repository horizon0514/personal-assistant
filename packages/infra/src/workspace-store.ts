/**
 * WorkspaceStore — workspace 的逻辑命名空间(记忆/偏好/会话隔离)。
 * 不强绑文件目录;每个 workspace 在 <root>/<wsId>/ 下有自己的子树。
 */
import { rmSync } from "node:fs";
import { join } from "node:path";
import { readJson, writeJson } from "./persistence";

export interface WorkspaceRecord {
  id: string;
  name: string;
  createdAt: number;
}

const DEFAULT_WORKSPACE: WorkspaceRecord = {
  id: "default",
  name: "个人",
  createdAt: 0
};

export class WorkspaceStore {
  private readonly indexPath: string;
  private records: WorkspaceRecord[];

  /** @param root 形如 <userData>/workspaces */
  constructor(private readonly root: string) {
    this.indexPath = join(root, "index.json");
    this.records = readJson<WorkspaceRecord[]>(this.indexPath, []);
  }

  private persist(): void {
    writeJson(this.indexPath, this.records);
  }

  /** 升级兜底:无 workspace 时建默认 workspace,返回其 id。 */
  ensureDefault(): string {
    if (this.records.length === 0) {
      this.records = [{ ...DEFAULT_WORKSPACE, createdAt: Date.now() }];
      this.persist();
    }
    return this.records[0]!.id;
  }

  list(): WorkspaceRecord[] {
    return this.records.map((r) => ({ ...r }));
  }

  create(name: string): WorkspaceRecord {
    const rec: WorkspaceRecord = { id: crypto.randomUUID(), name, createdAt: Date.now() };
    this.records.push(rec);
    this.persist();
    return rec;
  }

  rename(id: string, name: string): void {
    const rec = this.records.find((r) => r.id === id);
    if (rec) {
      rec.name = name;
      this.persist();
    }
  }

  /**
   * 删除 workspace,级联清掉其子树(记忆 + 全部会话/transcript)。
   * 拒绝删除最后一个 workspace(应用至少保留一个)。
   */
  remove(id: string): void {
    if (this.records.length <= 1) return;
    this.records = this.records.filter((r) => r.id !== id);
    this.persist();
    rmSync(this.dir(id), { recursive: true, force: true });
  }

  /** 该 workspace 的子目录(记忆/会话都在其下)。 */
  dir(id: string): string {
    return join(this.root, id);
  }

  /** 该 workspace 的记忆文件路径。 */
  memoryPath(id: string): string {
    return join(this.dir(id), "memory.json");
  }

  /** 该 workspace 的 Notebook(来源集)目录:每个 notebook 一份 <id>.json,含逐页文本缓存。 */
  notebooksDir(id: string): string {
    return join(this.dir(id), "notebooks");
  }
}
