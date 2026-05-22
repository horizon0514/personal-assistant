/**
 * 自动更新:基于 electron-updater + GitHub Releases(发布源在 electron-builder.yml 的 publish 配置)。
 *
 * 工作方式:
 *  - 应用启动后静默检查 → 有新版自动后台下载 → 下载完成弹窗询问「立即重启 / 稍后」。
 *  - 「稍后」则在下次退出时自动安装(autoInstallOnAppQuit)。
 *  - 之后每 4 小时再查一次。
 *  - 菜单「检查更新…」可手动触发并给出反馈。
 *
 * 注意:
 *  - 仅打包后(app.isPackaged)生效;dev 下跳过(否则 electron-updater 会找 dev-app-update.yml 报错)。
 *  - macOS 的自动更新要求应用已代码签名(Squirrel.Mac 限制);未签名时下载会安装失败。
 *    Windows 不要求签名即可自更新。签名配置就绪前,mac 端可视为「仅检测、提示手动下载」。
 */
import { app, BrowserWindow, dialog } from "electron";
// electron-updater 是 CJS,在 ESM 下需走 default 导入再解构。
import electronUpdater from "electron-updater";
const { autoUpdater } = electronUpdater;

const CHECK_INTERVAL_MS = 4 * 60 * 60 * 1000; // 4 小时

let manualCheck = false; // 手动检查时才在「已是最新/出错」时弹窗,避免静默检查打扰

function notify(message: string, detail?: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const opts = { type: "info" as const, title: "软件更新", message, detail, buttons: ["好"] };
  if (win) void dialog.showMessageBox(win, opts);
  else void dialog.showMessageBox(opts);
}

function wireEvents(): void {
  autoUpdater.on("update-available", (info) => {
    if (manualCheck) notify(`发现新版本 ${info.version}`, "正在后台下载,完成后会提示你重启更新。");
  });

  autoUpdater.on("update-not-available", () => {
    if (manualCheck) notify("已是最新版本");
    manualCheck = false;
  });

  autoUpdater.on("error", (err) => {
    console.error("[updater] error:", err);
    if (manualCheck) notify("检查更新失败", String(err?.message ?? err));
    manualCheck = false;
  });

  autoUpdater.on("update-downloaded", async (info) => {
    manualCheck = false;
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
    const opts = {
      type: "info" as const,
      title: "软件更新",
      message: `新版本 ${info.version} 已下载完成`,
      detail: "重启应用即可完成更新。也可以稍后退出时自动安装。",
      buttons: ["立即重启", "稍后"],
      defaultId: 0,
      cancelId: 1
    };
    const { response } = win ? await dialog.showMessageBox(win, opts) : await dialog.showMessageBox(opts);
    if (response === 0) {
      setImmediate(() => autoUpdater.quitAndInstall());
    }
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

/** 菜单「检查更新…」:手动触发,会在无更新/出错时给出反馈。 */
export function checkForUpdatesManual(): void {
  if (!app.isPackaged) {
    notify("开发模式下不检查更新", "请在打包后的应用中使用自动更新。");
    return;
  }
  manualCheck = true;
  void autoUpdater.checkForUpdates().catch((err) => {
    console.error("[updater] manual check failed:", err);
  });
}
