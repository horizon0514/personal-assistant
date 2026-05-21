import { useEffect, useState } from "react";
import { ActionCard } from "./ActionCard";
import { BatchPreview } from "./BatchPreview";
import type { ActionRow, BatchState, JournalItem } from "./types";

/**
 * 工作区面板:Task(步骤/动作)+ Trust(审批)+ Reversibility(批量预览/撤销)的可视化。
 * 自持这部分领域状态,通过 window.pa 订阅领域事件 / 审批 / 批量 / journal。
 */
export function WorkspacePanel(): JSX.Element {
  const [actions, setActions] = useState<ActionRow[]>([]);
  const [journal, setJournal] = useState<JournalItem[]>([]);
  const [batch, setBatch] = useState<BatchState | null>(null);

  // 领域事件 → 步骤/动作
  useEffect(() => {
    const off = window.pa.domain.onEvent((ev) => {
      if (ev.type === "ActionProposed") {
        setActions((prev) => [
          ...prev,
          {
            id: ev.action.id,
            stepId: ev.action.stepId,
            tool: ev.action.tool,
            capability: ev.action.capability,
            status: "running"
          }
        ]);
      } else if (ev.type === "ActionExecuted") {
        setActions((prev) => prev.map((a) => (a.id === ev.actionId ? { ...a, status: "done" } : a)));
      } else if (ev.type === "ActionFailed") {
        setActions((prev) =>
          prev.map((a) => (a.id === ev.actionId ? { ...a, status: "failed", error: ev.error } : a))
        );
      }
    });
    return off;
  }, []);

  // 审批请求 → 把对应卡片切到"待审批"
  useEffect(() => {
    const off = window.pa.approval.onRequest((req) => {
      setActions((prev) => {
        const exists = prev.some((a) => a.id === req.actionId);
        const patched = prev.map((a) =>
          a.id === req.actionId ? { ...a, status: "awaiting" as const, riskLevel: req.riskLevel } : a
        );
        return exists
          ? patched
          : [
              ...patched,
              {
                id: req.actionId,
                stepId: "pending",
                tool: req.tool,
                capability: req.capability,
                status: "awaiting" as const,
                riskLevel: req.riskLevel
              }
            ];
      });
    });
    return off;
  }, []);

  // 批量改动预览
  useEffect(() => {
    const off = window.pa.batch.onRequest((req) => setBatch(req as BatchState));
    return off;
  }, []);

  // journal(撤销可用性)
  useEffect(() => {
    void window.pa.reversibility.list().then(setJournal);
    const off = window.pa.reversibility.onChanged(setJournal);
    return off;
  }, []);

  const undoable = journal.some((j) => !j.reverted);

  const respond = (id: string, approved: boolean): void => {
    window.pa.approval.resolve(id, approved);
    setActions((prev) =>
      prev.map((a) =>
        a.id === id ? { ...a, status: approved ? "running" : "failed", error: approved ? undefined : "已拒绝" } : a
      )
    );
  };

  const respondBatch = (approved: boolean): void => {
    if (!batch) return;
    window.pa.batch.resolve(batch.actionId, approved);
    setBatch(null);
  };

  return (
    <section className="flex w-1/2 flex-col">
      <div className="flex items-center justify-between px-5 py-3">
        <span className="text-[13px] font-medium text-slate-500 dark:text-slate-400">计划 / 工作区</span>
        {journal.length > 0 && (
          <button
            className="rounded-lg border border-slate-200 px-2.5 py-1 text-[12px] text-slate-600 transition hover:bg-slate-100 disabled:opacity-40 dark:border-slate-700 dark:text-slate-300 dark:hover:bg-slate-800"
            onClick={() => void window.pa.reversibility.undoLast()}
            disabled={!undoable}
            title="撤销最近一次可逆操作"
          >
            ↩ 撤销上一步
          </button>
        )}
      </div>

      {batch && <BatchPreview batch={batch} onRespond={respondBatch} />}

      {actions.length === 0 ? (
        <div className="flex flex-1 items-center justify-center px-6 text-center text-[13px] text-slate-400 dark:text-slate-500">
          助理执行的动作会在这里实时显示。
        </div>
      ) : (
        <div className="flex-1 space-y-4 overflow-auto px-4 pb-5">
          {groupByStep(actions).map((group, i) => (
            <div key={group.stepId}>
              <div className="mb-1.5 flex items-center gap-2 px-1">
                <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 dark:text-slate-500">
                  步骤 {i + 1}
                </span>
                <span className="h-px flex-1 bg-slate-200/70 dark:bg-slate-700/70" />
              </div>
              <div className="space-y-2">
                {group.actions.map((a) => (
                  <ActionCard key={a.id} action={a} onRespond={respond} />
                ))}
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}

function groupByStep(actions: ActionRow[]): { stepId: string; actions: ActionRow[] }[] {
  const groups: { stepId: string; actions: ActionRow[] }[] = [];
  for (const a of actions) {
    let g = groups.find((x) => x.stepId === a.stepId);
    if (!g) {
      g = { stepId: a.stepId, actions: [] };
      groups.push(g);
    }
    g.actions.push(a);
  }
  return groups;
}
