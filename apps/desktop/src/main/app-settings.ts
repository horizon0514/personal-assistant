/**
 * 全局应用设置(跨 workspace),存 userData/settings.json。
 * 目前:主题。主题经 nativeTheme.themeSource 驱动 —— 自动覆盖所有窗口的
 * prefers-color-scheme(我们 CSS / Tailwind 都走媒体查询),无需切 class。
 */
import { app, nativeTheme } from "electron";
import { join } from "node:path";
import { readJson, writeJson } from "@pa/infra";

export type ThemeSource = "light" | "dark" | "system";

interface AppSettings {
  theme: ThemeSource;
}

const DEFAULT: AppSettings = { theme: "system" };

function file(): string {
  return join(app.getPath("userData"), "settings.json");
}

function read(): AppSettings {
  return { ...DEFAULT, ...readJson<Partial<AppSettings>>(file(), {}) };
}

export const appSettings = {
  getTheme(): ThemeSource {
    return read().theme;
  },
  setTheme(theme: ThemeSource): void {
    writeJson(file(), { ...read(), theme });
    nativeTheme.themeSource = theme;
  },
  /** 启动时把持久化的主题应用到 nativeTheme。 */
  apply(): void {
    nativeTheme.themeSource = read().theme;
  }
};
