import { useEffect, useState, type ReactNode } from "react";
import { Monitor, Moon, Sun } from "lucide-react";
import type { ThemeSource } from "../../../../preload";

const OPTIONS: { value: ThemeSource; label: string; Icon: typeof Sun }[] = [
  { value: "light", label: "浅色", Icon: Sun },
  { value: "dark", label: "深色", Icon: Moon },
  { value: "system", label: "跟随系统", Icon: Monitor }
];

/** 主题:浅色 / 深色 / 跟随系统。经 nativeTheme.themeSource 全局生效。 */
export function ThemePanel(): JSX.Element {
  const [theme, setTheme] = useState<ThemeSource>("system");

  useEffect(() => {
    void window.pa.settings.getTheme().then(setTheme);
  }, []);

  const pick = (t: ThemeSource): void => {
    setTheme(t);
    void window.pa.settings.setTheme(t);
  };

  return (
    <Field label="外观">
      <div className="inline-flex gap-1 rounded-xl bg-stone-100 p-1 dark:bg-ink-800">
        {OPTIONS.map(({ value, label, Icon }) => (
          <button
            key={value}
            className={
              "flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-[12.5px] transition " +
              (theme === value
                ? "bg-white text-stone-800 ring-1 ring-black/[0.04] dark:bg-ink-700 dark:text-stone-100 dark:ring-white/5"
                : "text-stone-500 hover:text-stone-700 dark:text-stone-400 dark:hover:text-stone-200")
            }
            onClick={() => pick(value)}
          >
            <Icon size={14} />
            {label}
          </button>
        ))}
      </div>
    </Field>
  );
}

function Field({ label, children }: { label: string; children: ReactNode }): JSX.Element {
  return (
    <div className="space-y-1.5">
      <div className="text-[12px] font-medium text-stone-500 dark:text-stone-400">{label}</div>
      {children}
    </div>
  );
}
