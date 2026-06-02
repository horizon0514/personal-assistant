import { useEffect, useState } from "react";
import { CalendarClock, Plus, Play, Pencil, Trash2, X, Power } from "lucide-react";
import type { ScheduleRecord, ScheduleDraft } from "../../../../preload";

/** 周标签:索引即 getDay() 的 0..6(周日..周六)。 */
const WEEK = ["日", "一", "二", "三", "四", "五", "六"];

/** 「每日新闻」模板:用户一键即得「每天 9 点发 10 条新闻」。 */
const NEWS_TEMPLATE: ScheduleDraft = {
  title: "每日新闻",
  prompt:
    "搜索今天最重要的 10 条新闻,逐条给我:序号、标题、一句话摘要,以及来源链接。优先科技与财经,用简洁中文。",
  time: "09:00",
  days: [],
  enabled: true
};

const EMPTY: ScheduleDraft = { title: "", prompt: "", time: "09:00", days: [], enabled: true };

/** 把 days 渲染成人话:空=每天;1-5=工作日;否则逐个列。 */
function daysLabel(days: number[]): string {
  if (days.length === 0) return "每天";
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 5 && sorted.every((d, i) => d === i + 1)) return "工作日";
  return "周" + sorted.map((d) => WEEK[d]).join("、");
}

/** 定时任务管理面板(模态浮层):列表 + 新建/编辑表单。 */
export function ScheduleManager({ onClose }: { onClose: () => void }): JSX.Element {
  const [list, setList] = useState<ScheduleRecord[]>([]);
  // 表单态:null = 仅看列表;否则在编辑(editingId 为空串表示新建)。
  const [draft, setDraft] = useState<ScheduleDraft | null>(null);
  const [editingId, setEditingId] = useState<string>("");

  useEffect(() => {
    void window.pa.schedule.list().then(setList);
    // 模型在聊天里建/改/删定时任务时,主进程广播最新列表 → 面板实时同步
    return window.pa.schedule.onChanged(setList);
  }, []);

  const startCreate = (preset: ScheduleDraft): void => {
    setEditingId("");
    setDraft({ ...preset, days: [...preset.days] });
  };
  const startEdit = (rec: ScheduleRecord): void => {
    setEditingId(rec.id);
    setDraft({ title: rec.title, prompt: rec.prompt, time: rec.time, days: [...rec.days], enabled: rec.enabled });
  };
  const cancelEdit = (): void => {
    setDraft(null);
    setEditingId("");
  };

  const save = async (): Promise<void> => {
    if (!draft) return;
    const clean: ScheduleDraft = { ...draft, title: draft.title.trim(), prompt: draft.prompt.trim() };
    if (!clean.title || !clean.prompt || !/^\d{2}:\d{2}$/.test(clean.time)) return;
    const next = editingId ? await window.pa.schedule.update(editingId, clean) : await window.pa.schedule.create(clean);
    setList(next);
    cancelEdit();
  };

  const toggle = async (rec: ScheduleRecord): Promise<void> => {
    setList(await window.pa.schedule.update(rec.id, { enabled: !rec.enabled }));
  };
  const remove = async (id: string): Promise<void> => {
    setList(await window.pa.schedule.remove(id));
  };
  const runNow = async (id: string): Promise<void> => {
    setList(await window.pa.schedule.runNow(id));
  };

  return (
    <div
      className="fixed inset-0 z-40 flex items-center justify-center bg-black/30 p-6 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="flex max-h-[80vh] w-[560px] flex-col overflow-hidden rounded-2xl border border-stone-200 bg-white shadow-2xl dark:border-white/10 dark:bg-ink-900"
        onClick={(e) => e.stopPropagation()}
      >
        {/* 头 */}
        <div className="flex items-center justify-between border-b border-stone-200/70 px-5 py-3.5 dark:border-white/5">
          <div className="flex items-center gap-2 text-[14px] font-semibold text-stone-800 dark:text-stone-100">
            <CalendarClock size={17} strokeWidth={2} className="text-ember-500" />
            定时任务
          </div>
          <button
            className="rounded-lg p-1 text-stone-500 transition hover:bg-stone-100 dark:hover:bg-ink-800"
            onClick={onClose}
            aria-label="关闭"
          >
            <X size={17} />
          </button>
        </div>

        <div className="flex-1 overflow-auto px-5 py-4">
          {draft ? (
            <ScheduleForm
              draft={draft}
              isEdit={Boolean(editingId)}
              onChange={setDraft}
              onSave={() => void save()}
              onCancel={cancelEdit}
            />
          ) : (
            <>
              {list.length === 0 ? (
                <p className="px-2 py-8 text-center text-[12.5px] text-stone-500">
                  还没有定时任务。到点会自动在新会话里跑你的指令,并弹系统通知。
                </p>
              ) : (
                <ul className="space-y-2">
                  {list.map((rec) => (
                    <li
                      key={rec.id}
                      className="flex items-center gap-3 rounded-xl border border-stone-200/80 px-3.5 py-2.5 dark:border-white/8"
                    >
                      <button
                        className={
                          "shrink-0 rounded-lg p-1.5 transition " +
                          (rec.enabled
                            ? "text-ember-500 hover:bg-ember-50 dark:hover:bg-ember-500/10"
                            : "text-stone-400 hover:bg-stone-100 dark:hover:bg-ink-800")
                        }
                        onClick={() => void toggle(rec)}
                        title={rec.enabled ? "已启用(点击停用)" : "已停用(点击启用)"}
                        aria-label="启用/停用"
                      >
                        <Power size={15} strokeWidth={2.2} />
                      </button>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-baseline gap-2">
                          <span className="font-mono text-[13px] font-semibold text-stone-800 dark:text-stone-100">
                            {rec.time}
                          </span>
                          <span className="truncate text-[13px] text-stone-700 dark:text-stone-300">{rec.title}</span>
                        </div>
                        <div className="truncate text-[11.5px] text-stone-500">
                          {daysLabel(rec.days)} · {rec.prompt}
                        </div>
                      </div>
                      <div className="flex shrink-0 items-center gap-0.5 text-stone-500">
                        <button
                          className="rounded-lg p-1.5 transition hover:bg-stone-100 hover:text-ember-600 dark:hover:bg-ink-800"
                          onClick={() => void runNow(rec.id)}
                          title="立即运行一次"
                          aria-label="立即运行"
                        >
                          <Play size={14} />
                        </button>
                        <button
                          className="rounded-lg p-1.5 transition hover:bg-stone-100 hover:text-stone-700 dark:hover:bg-ink-800"
                          onClick={() => startEdit(rec)}
                          title="编辑"
                          aria-label="编辑"
                        >
                          <Pencil size={14} />
                        </button>
                        <button
                          className="rounded-lg p-1.5 transition hover:bg-stone-100 hover:text-red-500 dark:hover:bg-ink-800"
                          onClick={() => void remove(rec.id)}
                          title="删除"
                          aria-label="删除"
                        >
                          <Trash2 size={14} />
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}

              <div className="mt-4 flex gap-2">
                <button
                  className="flex flex-1 items-center justify-center gap-1.5 rounded-xl border border-dashed border-stone-300 py-2 text-[12.5px] font-medium text-stone-700 transition hover:border-ember-300 hover:text-ember-600 dark:border-white/10 dark:text-stone-400"
                  onClick={() => startCreate(EMPTY)}
                >
                  <Plus size={15} strokeWidth={2} />
                  新建任务
                </button>
                <button
                  className="flex items-center justify-center gap-1.5 rounded-xl border border-ember-200 bg-ember-50 px-3 py-2 text-[12.5px] font-medium text-ember-700 transition hover:bg-ember-100 dark:border-ember-500/30 dark:bg-ember-500/10 dark:text-ember-300"
                  onClick={() => startCreate(NEWS_TEMPLATE)}
                  title="一键填入「每天 9 点发 10 条新闻」"
                >
                  用每日新闻模板
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/** 新建/编辑表单。 */
function ScheduleForm({
  draft,
  isEdit,
  onChange,
  onSave,
  onCancel
}: {
  draft: ScheduleDraft;
  isEdit: boolean;
  onChange: (d: ScheduleDraft) => void;
  onSave: () => void;
  onCancel: () => void;
}): JSX.Element {
  const toggleDay = (d: number): void => {
    const has = draft.days.includes(d);
    onChange({ ...draft, days: has ? draft.days.filter((x) => x !== d) : [...draft.days, d] });
  };
  const valid = draft.title.trim() && draft.prompt.trim() && /^\d{2}:\d{2}$/.test(draft.time);
  const labelCls = "mb-1 block text-[11.5px] font-medium text-stone-500";
  const inputCls =
    "w-full rounded-lg border border-stone-300 bg-white px-3 py-2 text-[13px] text-stone-800 outline-none transition focus:border-ember-400 dark:border-white/10 dark:bg-ink-800 dark:text-stone-100";

  return (
    <div className="space-y-3.5">
      <div>
        <label className={labelCls}>任务名</label>
        <input
          className={inputCls}
          value={draft.title}
          placeholder="如:每日新闻"
          onChange={(e) => onChange({ ...draft, title: e.target.value })}
        />
      </div>

      <div className="flex gap-3">
        <div className="w-28">
          <label className={labelCls}>时间</label>
          <input
            type="time"
            className={inputCls + " font-mono"}
            value={draft.time}
            onChange={(e) => onChange({ ...draft, time: e.target.value })}
          />
        </div>
        <div className="flex-1">
          <label className={labelCls}>重复(不选=每天)</label>
          <div className="flex gap-1">
            {WEEK.map((w, d) => {
              const on = draft.days.includes(d);
              return (
                <button
                  key={d}
                  className={
                    "h-8 flex-1 rounded-lg text-[12px] transition " +
                    (on
                      ? "bg-ember-500 font-medium text-white"
                      : "bg-stone-100 text-stone-600 hover:bg-stone-200 dark:bg-ink-800 dark:text-stone-400")
                  }
                  onClick={() => toggleDay(d)}
                >
                  {w}
                </button>
              );
            })}
          </div>
        </div>
      </div>

      <div>
        <label className={labelCls}>指令(到点丢给助理执行)</label>
        <textarea
          className={inputCls + " min-h-[88px] resize-y leading-relaxed"}
          value={draft.prompt}
          placeholder="如:搜今天 10 条最重要的科技新闻,逐条给标题+一句话摘要+链接。"
          onChange={(e) => onChange({ ...draft, prompt: e.target.value })}
        />
      </div>

      <label className="flex items-center gap-2 text-[12.5px] text-stone-600 dark:text-stone-400">
        <input
          type="checkbox"
          className="h-3.5 w-3.5 accent-ember-500"
          checked={draft.enabled}
          onChange={(e) => onChange({ ...draft, enabled: e.target.checked })}
        />
        启用
      </label>

      <div className="flex justify-end gap-2 pt-1">
        <button
          className="rounded-lg px-3.5 py-1.5 text-[12.5px] text-stone-600 transition hover:bg-stone-100 dark:text-stone-400 dark:hover:bg-ink-800"
          onClick={onCancel}
        >
          取消
        </button>
        <button
          className="rounded-lg bg-ember-500 px-4 py-1.5 text-[12.5px] font-medium text-white transition hover:bg-ember-600 disabled:cursor-not-allowed disabled:opacity-40"
          onClick={onSave}
          disabled={!valid}
        >
          {isEdit ? "保存" : "创建"}
        </button>
      </div>
    </div>
  );
}
