import { useEffect, useState } from "react";
import { Check, KeyRound } from "lucide-react";
import type { ApiKeyStatus } from "../../../../preload";

/** 全局模型 API Key:safeStorage 加密存储,只读回状态(末 4 位),不回传完整 key。 */
export function ApiKeySection(): JSX.Element {
  const [status, setStatus] = useState<ApiKeyStatus | null>(null);
  const [draft, setDraft] = useState("");
  const [editing, setEditing] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    void window.pa.secret.apiKeyStatus().then(setStatus);
  }, []);

  const save = (): void => {
    const key = draft.trim();
    if (!key) return;
    setSaving(true);
    void window.pa.secret.setApiKey(key).then((s) => {
      setStatus(s);
      setDraft("");
      setEditing(false);
      setSaving(false);
    });
  };

  const clear = (): void => {
    void window.pa.secret.clearApiKey().then(setStatus);
  };

  const provider = status?.provider ?? "";

  return (
    <div className="rounded-xl border border-stone-200/70 p-3 dark:border-ink-700">
      <div className="mb-2 flex items-center gap-2 text-[12.5px] text-stone-500 dark:text-stone-400">
        <KeyRound size={14} />
        <span>
          provider:<span className="ml-1 font-medium text-stone-700 dark:text-stone-200">{provider}</span>
        </span>
      </div>

      {status?.set && !editing ? (
        <div className="flex items-center gap-2">
          <span className="flex items-center gap-1.5 rounded-lg bg-emerald-50 px-2.5 py-1.5 text-[12.5px] text-emerald-700 dark:bg-emerald-500/15 dark:text-emerald-300">
            <Check size={14} /> 已设置 · ····{status.last4}
          </span>
          <button
            className="rounded-lg px-2.5 py-1.5 text-[12.5px] text-stone-500 ring-1 ring-stone-200 transition hover:bg-stone-50 dark:text-stone-300 dark:ring-ink-600 dark:hover:bg-ink-800"
            onClick={() => setEditing(true)}
          >
            更换
          </button>
          <button
            className="rounded-lg px-2.5 py-1.5 text-[12.5px] text-rose-500 ring-1 ring-rose-200 transition hover:bg-rose-50 dark:ring-rose-500/30 dark:hover:bg-rose-500/10"
            onClick={clear}
          >
            清除
          </button>
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <input
            type="password"
            autoFocus={editing}
            className="min-w-0 flex-1 rounded-lg border border-stone-200 bg-white px-2.5 py-1.5 text-[12.5px] text-stone-700 outline-none focus:border-ember-300 dark:border-ink-600 dark:bg-ink-900 dark:text-stone-100"
            placeholder={`粘贴你的 ${provider} API Key`}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") save();
              else if (e.key === "Escape") {
                setEditing(false);
                setDraft("");
              }
            }}
          />
          <button
            className="shrink-0 rounded-lg bg-ember-500 px-3 py-1.5 text-[12.5px] font-medium text-ink-900 transition hover:bg-ember-600 disabled:opacity-40"
            onClick={save}
            disabled={saving || draft.trim() === ""}
          >
            保存
          </button>
        </div>
      )}

      <p className="mt-2 text-[11.5px] text-stone-500 dark:text-stone-500">
        本机加密存储(系统钥匙串),不上传、不写入代码。
      </p>
    </div>
  );
}
