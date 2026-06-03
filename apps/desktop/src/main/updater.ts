/**
 * 自动更新:基于 electron-updater + GitHub Releases(发布源在 electron-builder.yml 的 publish 配置)。
 *
 * 工作方式:
 *  - 应用启动后静默检查 → 有新版自动后台下载 → 状态实时推给渲染层,由应用内 banner 展示(见 UpdateBanner)。
 *  - 之后每 4 小时再查一次。菜单「检查更新…」可手动触发,无更新/出错时给原生弹窗反馈。
 *
 * 注意:
 *  - 仅打包后(app.isPackaged)生效;dev 下跳过(否则 electron-updater 会找 dev-app-update.yml 报错)。
 *  - macOS 的自动更新要求应用已代码签名(Squirrel.Mac 限制);未签名时下载/安装会失败(走 error)。
 *    此时 banner 退化为「发现新版本 → 前往下载页手动更新」。Windows 不要求签名即可自更新。
 */
import { app, BrowserWindow, dialog, shell } from "electron";
// electron-updater 是 CJS,在 ESM 下需走 default 导入再解构。
import electronUpdater from "electron-updater";
const { autoUpdater } = electronUpdater;

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 小时
const RELEASES_URL = "https://github.com/horizon0514/personal-assistant/releases/latest";

/** 推给渲染层的更新状态(应用内 banner 据此渲染)。 */
export type UpdateStatus =
  | { state: "idle" }
  | { state: "available"; version: string }
  | { state: "downloading"; version: string; percent: number }
  | { state: "downloaded"; version: string }
  | { state: "error"; version?: string; message: string };

let lastStatus: UpdateStatus = { state: "idle" };
let pendingVersion = ""; // download-progress 不带版本号,从 update-available 记下来
let manualCheck = false; // 手动检查时才在「已是最新/出错」弹原生窗,避免静默检查打扰

function setStatus(s: UpdateStatus): void {
  lastStatus = s;
  for (const win of BrowserWindow.getAllWindows()) win.webContents.send("update:status", s);
}

/** 当前更新状态(渲染层 banner 挂载时拉一次,补上挂载前已发生的事件)。 */
export function getUpdateStatus(): UpdateStatus {
  return lastStatus;
}

/** 渲染层「重启更新」按钮:退出并安装已下载的更新。 */
export function installUpdate(): void {
  setImmediate(() => autoUpdater.quitAndInstall());
}

/** 渲染层「前往下载」按钮(mac 未签名兜底):打开 GitHub Releases 页。 */
export function openReleasesPage(): void {
  void shell.openExternal(RELEASES_URL);
}

function notifyNative(message: string, detail?: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const opts = { type: "info" as const, title: "软件更新", message, detail, buttons: ["好"] };
  if (win) void dialog.showMessageBox(win, opts);
  else void dialog.showMessageBox(opts);
}

function wireEvents(): void {
  autoUpdater.on("update-available", (info) => {
    pendingVersion = info.version;
    setStatus({ state: "available", version: info.version });
  });

  autoUpdater.on("download-progress", (p) => {
    setStatus({ state: "downloading", version: pendingVersion, percent: Math.round(p.percent) });
  });

  autoUpdater.on("update-downloaded", (info) => {
    setStatus({ state: "downloaded", version: info.version });
  });

  autoUpdater.on("update-not-available", () => {
    setStatus({ state: "idle" });
    if (manualCheck) notifyNative("已是最新版本");
    manualCheck = false;
  });

  autoUpdater.on("error", (err) => {
    console.error("[updater] error:", err);
    setStatus({ state: "error", version: pendingVersion || undefined, message: String(err?.message ?? err) });
    if (manualCheck) notifyNative("检查更新失败", String(err?.message ?? err));
    manualCheck = false;
  });
}

/** 启动时调用一次:配置 + 首检 + 周期检查。dev 下为空操作。 */
export function initAutoUpdate(): void {
  if (!app.isPackaged) return;

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.logger = console;

  wireEvents();

  // 启动后稍等再查,避开冷启动高峰。
  setTimeout(() => void autoUpdater.checkForUpdates().catch(() => {}), 8_000);
  setInterval(() => void autoUpdater.checkForUpdates().catch(() => {}), CHECK_INTERVAL_MS);
}

/** 菜单「检查更新…」:手动触发,会在无更新/出错时给出原生反馈。 */
export function checkForUpdatesManual(): void {
  if (!app.isPackaged) {
    notifyNative("开发模式下不检查更新", "请在打包后的应用中使用自动更新。");
    return;
  }
  manualCheck = true;
  void autoUpdater.checkForUpdates().catch((err) => {
    console.error("[updater] manual check failed:", err);
  });
}
