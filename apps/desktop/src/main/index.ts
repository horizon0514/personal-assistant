import "./app-identity"; // 必须最先执行:设 app 名与 userData 目录(早于任何持久化模块)
import { join } from "node:path";
import { userInfo } from "node:os";
import { execFileSync } from "node:child_process";
import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import { registerIpc } from "./ipc";
import { setMainWindow } from "./main-window";
import { installAppMenu } from "./menu";
import { appSettings, type ThemeSource } from "./app-settings";
import { initAutoUpdate, checkForUpdatesManual } from "./updater";

const BG_LIGHT = "#f3f7f5";
const BG_DARK = "#0e1411";
const themedBg = (): string => (nativeTheme.shouldUseDarkColors ? BG_DARK : BG_LIGHT);
const PRELOAD = join(__dirname, "../preload/index.mjs");

/** 渲染入口加载:dev 走 vite 服务,prod 走打好的 html。 */
function loadEntry(win: BrowserWindow, htmlFile: string): void {
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) void win.loadURL(htmlFile === "index.html" ? devUrl : `${devUrl}/${htmlFile}`);
  else void win.loadFile(join(__dirname, `../renderer/${htmlFile}`));
}

// ── 设置窗(独立 BrowserWindow,单实例)──────────────────────
let settingsWin: BrowserWindow | undefined;
function openSettings(): void {
  if (settingsWin && !settingsWin.isDestroyed()) {
    settingsWin.focus();
    return;
  }
  settingsWin = new BrowserWindow({
    width: 720,
    height: 520,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    title: "设置",
    show: false,
    backgroundColor: themedBg(),
    webPreferences: { preload: PRELOAD, sandbox: false, contextIsolation: true, nodeIntegration: false }
  });
  settingsWin.once("ready-to-show", () => settingsWin?.show());
  settingsWin.on("closed", () => (settingsWin = undefined));
  loadEntry(settingsWin, "settings.html");
}

function createWindow(): void {
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Akari",
    show: false,
    // macOS:隐藏标题栏 + 红绿灯内移
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: isMac ? { x: 16, y: 18 } : undefined,
    backgroundColor: themedBg(),
    webPreferences: {
      preload: PRELOAD,
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false,
      webviewTag: true // 内置调研浏览器用 <webview> 嵌在 ArtifactPanel
    }
  });

  win.once("ready-to-show", () => win.show());
  setMainWindow(win);
  loadEntry(win, "index.html");
}

/**
 * 系统账户名(本地软件可直接取,纯本地不外传),供空白页问候个性化。
 * 优先 macOS 显示全名(id -F)→ 退登录短名 → 再退空串(纯时段问候)。
 */
function systemUserName(): string {
  if (process.platform === "darwin") {
    try {
      const full = execFileSync("id", ["-F"], { encoding: "utf8", timeout: 1000 }).trim();
      if (full) return full;
    } catch {
      /* 退到短名 */
    }
  }
  try {
    return userInfo().username || "";
  } catch {
    return "";
  }
}

// 占位 IPC:渲染层握手用
ipcMain.handle("app:ping", () => "pong");
ipcMain.handle("app:version", () => app.getVersion());
ipcMain.handle("system:userName", () => systemUserName());
// 打开设置窗(切换器「设置」入口 + ⌘,)
ipcMain.handle("settings:open", () => openSettings());
// 全局设置:主题
ipcMain.handle("settings:getTheme", () => appSettings.getTheme());
ipcMain.handle("settings:setTheme", (_e, theme: ThemeSource) => {
  appSettings.setTheme(theme);
  return appSettings.getTheme();
});

// 主题/系统外观变化 → 所有窗口同步底色(单一监听,避免每窗累积)
nativeTheme.on("updated", () => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.setBackgroundColor(themedBg());
  }
});

// 领域 IPC(会话/审批/批量预览/可逆性)
registerIpc();

app.whenReady().then(() => {
  appSettings.apply(); // 应用持久化主题(影响后续窗口底色 + prefers-color-scheme)
  installAppMenu(openSettings, checkForUpdatesManual);
  createWindow();
  initAutoUpdate();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
