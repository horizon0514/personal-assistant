import "./app-identity"; // 必须最先执行:设 app 名与 userData 目录(早于任何持久化模块)
import { join } from "node:path";
import { userInfo } from "node:os";
import { execFileSync } from "node:child_process";
import { app, BrowserWindow, ipcMain, nativeTheme, Notification, screen } from "electron";
import { registerIpc } from "./ipc";
import { agent } from "./agent";
import { disposeOffice } from "@pa/cap-office";
import { getMainWindow, setMainWindow } from "./main-window";
import { installAppMenu, installContextMenu } from "./menu";
import { appSettings, type ThemeSource, type WindowBounds } from "./app-settings";
import { approvalAllowlist } from "./approval-allowlist";
import { initAutoUpdate, checkForUpdatesManual } from "./updater";
import { startScheduler, schedules } from "./scheduler";
import type { ScheduleRecord } from "@pa/infra";

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
  installContextMenu(settingsWin.webContents);
  loadEntry(settingsWin, "settings.html");
}

const DEFAULT_BOUNDS: WindowBounds = { width: 1200, height: 800 };

/** 保存的窗口位置若整体落在所有显示器之外(换了显示器/分辨率),丢弃 x/y 由系统居中,只留尺寸。 */
function sanitizeBounds(b: WindowBounds): WindowBounds {
  if (b.x == null || b.y == null) return { width: b.width, height: b.height };
  const onScreen = screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return b.x! < a.x + a.width && b.x! + b.width > a.x && b.y! < a.y + a.height && b.y! + b.height > a.y;
  });
  return onScreen ? b : { width: b.width, height: b.height };
}

function createWindow(): void {
  const isMac = process.platform === "darwin";
  const saved = appSettings.getWindowBounds();
  const bounds = sanitizeBounds(saved ?? DEFAULT_BOUNDS);
  const win = new BrowserWindow({
    ...bounds, // 恢复上次尺寸/位置(原生应用都记忆)
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
  // 关窗前记住尺寸/位置(getNormalBounds:最大化/全屏时取还原后的尺寸,不存全屏值)。
  win.on("close", () => appSettings.setWindowBounds(win.getNormalBounds()));
  installContextMenu(win.webContents);
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
// 已记住的「允许」操作:设置面板查看/移除/清空(对应审批卡的「总是同意」)
ipcMain.handle("approvals:list", () => approvalAllowlist.list());
ipcMain.handle("approvals:remove", (_e, id: string) => {
  approvalAllowlist.remove(id);
  return approvalAllowlist.list();
});
ipcMain.handle("approvals:clear", () => {
  approvalAllowlist.clear();
  return approvalAllowlist.list();
});

// 主题/系统外观变化 → 所有窗口同步底色(单一监听,避免每窗累积)
nativeTheme.on("updated", () => {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.setBackgroundColor(themedBg());
  }
});

// 领域 IPC(会话/审批/批量预览/可逆性 + 定时任务)
registerIpc();

/**
 * 定时任务到点:在新会话里跑一遍指令,弹原生系统通知;点通知 → 唤起主窗并打开该会话。
 * runner 无论成败都 markRun(回写 lastRunAt),保证「当天同一任务只跑一次」的去重生效。
 */
function notifyScheduled(rec: ScheduleRecord, sessionId: string, summary: string): void {
  if (!Notification.isSupported()) return;
  const body = (summary || "已完成").replace(/\s+/g, " ").trim().slice(0, 200);
  const n = new Notification({ title: rec.title || "定时任务", body });
  n.on("click", () => {
    const win = getMainWindow();
    if (!win || win.isDestroyed()) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
    win.webContents.send("scheduler:openSession", { sessionId });
  });
  n.show();
}

startScheduler(async (rec) => {
  let sessionId = "";
  try {
    const res = await agent.runScheduledTask(rec.title, rec.prompt);
    sessionId = res.sessionId;
    notifyScheduled(rec, sessionId, res.summary);
  } catch (err) {
    console.error(`[scheduler] 任务「${rec.title}」执行失败:`, err);
  } finally {
    schedules.markRun(rec.id, Date.now(), sessionId);
  }
});

app.whenReady().then(() => {
  appSettings.apply(); // 应用持久化主题(影响后续窗口底色 + prefers-color-scheme)
  installAppMenu(openSettings, checkForUpdatesManual);
  createWindow();
  initAutoUpdate();
  // 启动补跑:把退出前没"离开"、漏掉蒸馏/沉淀的会话补上(延迟一会,避开启动繁忙)。
  setTimeout(() => agent.catchUpMemory(), 4000);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

// 退出前收掉 OfficeCLI 留下的后台常驻进程(它们会 re-parent 到 init,不随本进程消失)。
// before-quit 不能被 Electron await,故先拦下、跑清理(自带 3s 总时限,绝不卡退出)、再真正退。
// 没用过 Office 时 disposeOffice 立即返回,这条路径零开销。
let officeCleaned = false;
app.on("before-quit", (e) => {
  if (officeCleaned) return;
  e.preventDefault();
  officeCleaned = true;
  void disposeOffice().finally(() => app.quit());
});
