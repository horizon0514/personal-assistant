/**
 * @pa/ctx-reversibility — Reversibility(核心域)
 *
 * 操作日志(journal)+ 撤销。本上下文与具体能力无关:
 * 每个变更类工具执行后产出一个「回滚计划(ReversalPlan)」,记入 journal;
 * 各能力注册自己的 reverser,undo 时按 capability 派发执行。
 *
 * 软删除/回收区由能力侧实现(把删除变成"移动到回收区"),本上下文只负责
 * 记录与触发回滚。diff 预览整批审批留待后续。
 */

/** 能力专属的回滚计划(不透明数据,按 kind 区分,由对应能力的 reverser 解读)*/
export interface ReversalPlan {
  readonly kind: string;
  readonly [key: string]: unknown;
}

export interface JournalEntry {
  readonly actionId: string;
  readonly capability: string;
  readonly tool: string;
  readonly summary: string;
  readonly reversal: ReversalPlan;
  readonly at: number;
  reverted: boolean;
}

export interface RecordInput {
  readonly actionId: string;
  readonly capability: string;
  readonly tool: string;
  readonly summary: string;
  readonly reversal: ReversalPlan;
}

export type Reverser = (plan: ReversalPlan) => Promise<void>;

/** 公开给 UI 的精简视图 */
export interface JournalView {
  readonly actionId: string;
  readonly tool: string;
  readonly capability: string;
  readonly summary: string;
  readonly reverted: boolean;
}

export class OperationJournal {
  private readonly entries: JournalEntry[] = [];
  private readonly reversers = new Map<string, Reverser>();

  registerReverser(capability: string, reverser: Reverser): void {
    this.reversers.set(capability, reverser);
  }

  record(input: RecordInput): JournalEntry {
    const entry: JournalEntry = { ...input, at: Date.now(), reverted: false };
    this.entries.push(entry);
    return entry;
  }

  list(): JournalView[] {
    return this.entries.map((e) => ({
      actionId: e.actionId,
      tool: e.tool,
      capability: e.capability,
      summary: e.summary,
      reverted: e.reverted
    }));
  }

  hasUndoable(): boolean {
    return this.entries.some((e) => !e.reverted);
  }

  /** 撤销最近一个未撤销的操作。返回被撤销的条目;无则 undefined。 */
  async undoLast(): Promise<JournalEntry | undefined> {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      const entry = this.entries[i];
      if (entry && !entry.reverted) {
        const reverser = this.reversers.get(entry.capability);
        if (!reverser) throw new Error(`没有为能力「${entry.capability}」注册回滚器`);
        await reverser(entry.reversal);
        entry.reverted = true;
        return entry;
      }
    }
    return undefined;
  }
}
