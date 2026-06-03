import { useEffect, useState, type ReactNode } from "react";
import { Brain, Gauge, Info, KeyRound, Palette, SlidersHorizontal } from "lucide-react";
import { AkariMark } from "../shell/AkariMark";
import type { WorkspaceRecord } from "../../../../preload";
import { ApiKeySection } from "./ApiKeySection";
import { ThemePanel } from "./ThemePanel";
import { MemoryList } from "../memory/MemoryList";
import { EvalTelemetryPanel } from "../telemetry/EvalTelemetryPanel";

type Section = "model" | "general" | "telemetry" | "about" | "memory" | "preferences";

/** 设置窗根:左分组 sidebar + 右详情。应用组(全局)/ 工作空间组(按所选 wsId)。 */
export function SettingsApp(): JSX.Element {
  const [section, setSection] = useState<Section>("model");
  const [workspaces, setWorkspaces] = useState<WorkspaceRecord[]>([]);
  const [wsId, setWsId] = useState("");

  useEffect(() => {
    void (async () => {
      const [list, active] = await Promise.all([window.pa.workspace.list(), window.pa.workspace.active()]);
      setWorkspaces(list);
      setWsId(active);
    })();
  }, []);

  return (
    <div className="flex h-screen w-screen bg-[#fafafa] text-stone-800 dark:bg-[#0b0c0e] dark:text-stone-100">
      <nav className="flex w-52 shrink-0 flex-col gap-0.5 overflow-auto border-r border-stone-200/70 px-2 py-3 dark:border-white/5">
        <Group title="应用" />
        <NavItem icon={<KeyRound size={15} />} label="模型 / API Key" active={section === "model"} onClick={() => setSection("model")} />
        <NavItem icon={<Palette size={15} />} label="通用" active={section === "general"} onClick={() => setSection("general")} />
        <NavItem icon={<Gauge size={15} />} label="验收质量" active={section === "telemetry"} onClick={() => setSection("telemetry")} />
        <NavItem icon={<Info size={15} />} label="关于" active={section === "about"} onClick={() => setSection("about")} />

        <Group title="工作空间" />
        <div className="px-2 pb-1">
          <select
            className="w-full rounded-lg border border-stone-200 bg-white px-2 py-1 text-[12.5px] text-stone-700 outline-none dark:border-white/10 dark:bg-ink-800 dark:text-stone-200"
            value={wsId}
            onChange={(e) => setWsId(e.target.value)}
          >
            {workspaces.map((w) => (
              <option key={w.id} value={w.id}>
                {w.name}
              </option>
            ))}
          </select>
        </div>
        <NavItem icon={<Brain size={15} />} label="记忆" active={section === "memory"} onClick={() => setSection("memory")} />
        <NavItem icon={<SlidersHorizontal size={15} />} label="偏好" active={section === "preferences"} onClick={() => setSection("preferences")} />
      </nav>

      <main className="flex-1 overflow-auto px-6 py-5">
        {section === "model" && (
          <Pane title="模型 / API Key" hint="全局,所有工作空间共用">
            <ApiKeySection />
          </Pane>
        )}
        {section === "general" && (
          <Pane title="通用">
            <ThemePanel />
          </Pane>
        )}
        {section === "telemetry" && (
          <Pane title="验收质量" hint="全局,所有工作空间共用" wide>
            <EvalTelemetryPanel />
          </Pane>
        )}
        {section === "about" && (
          <Pane title="关于">
            <About />
          </Pane>
        )}
        {section === "memory" && (
          <Pane title="记忆" hint={workspaces.find((w) => w.id === wsId)?.name}>
            {wsId && <MemoryList workspaceId={wsId} />}
          </Pane>
        )}
        {section === "preferences" && (
          <Pane title="偏好" hint={workspaces.find((w) => w.id === wsId)?.name}>
            <p className="text-[12.5px] text-stone-500 dark:text-stone-500">偏好设置即将上线(按工作空间隔离)。</p>
          </Pane>
        )}
      </main>
    </div>
  );
}

function Group({ title }: { title: string }): JSX.Element {
  return (
    <div className="px-2 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-wide text-stone-500 dark:text-stone-500">
      {title}
    </div>
  );
}

function NavItem({
  icon,
  label,
  active,
  onClick
}: {
  icon: ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      className={
        "flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition " +
        (active
          ? "bg-ember-100/70 font-medium text-ember-700 dark:bg-ember-500/15 dark:text-ember-100"
          : "text-stone-500 hover:bg-stone-100 dark:text-stone-300 dark:hover:bg-ink-800")
      }
      onClick={onClick}
    >
      {icon}
      {label}
    </button>
  );
}

function Pane({ title, hint, children, wide }: { title: string; hint?: string; children: ReactNode; wide?: boolean }): JSX.Element {
  return (
    <section className={"mx-auto " + (wide ? "max-w-2xl" : "max-w-md")}>
      <div className="mb-3 flex items-baseline gap-2">
        <h2 className="text-[15px] font-semibold text-stone-700 dark:text-stone-200">{title}</h2>
        {hint && <span className="text-[11px] text-stone-500 dark:text-stone-500">{hint}</span>}
      </div>
      {children}
    </section>
  );
}

function About(): JSX.Element {
  const [version, setVersion] = useState("");
  useEffect(() => {
    void window.pa.appVersion().then(setVersion);
  }, []);
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3">
        <AkariMark alt="" className="h-11 w-11 rounded-2xl shadow-glow" />
        <div>
          <div className="font-mono text-[18px] font-bold lowercase tracking-[0.16em] text-ember-600 dark:text-ember-400">
            akari
          </div>
          <div className="text-[12px] text-stone-500 dark:text-stone-400">版本 {version || "—"}</div>
        </div>
      </div>
      <p className="max-w-md text-[12.5px] leading-relaxed text-stone-500 dark:text-stone-400">
        面向知识工作者的去终端化本地电脑助理 · 本地运行、登录态闭网访问、个人记忆 · 隐私不出机。
      </p>
      <p className="text-[12.5px] font-medium text-ember-500">难办的事,先点一盏灯</p>
    </div>
  );
}
