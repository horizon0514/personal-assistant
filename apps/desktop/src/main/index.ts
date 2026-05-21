import { join } from "node:path";
import { app, BrowserWindow, ipcMain, nativeTheme } from "electron";
import { registerIpc } from "./ipc";

const BG_LIGHT = "#f3f7f5";
const BG_DARK = "#0e1411";
const themedBg = (): string => (nativeTheme.shouldUseDarkColors ? BG_DARK : BG_LIGHT);

function createWindow(): void {
  const isMac = process.platform === "darwin";
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "Personal Assistant",
    show: false,
    // macOS:隐藏标题栏 + 红绿灯内移 + 窗口毛玻璃
    titleBarStyle: isMac ? "hiddenInset" : "default",
    trafficLightPosition: isMac ? { x: 16, y: 18 } : undefined,
    backgroundColor: themedBg(),
    webPreferences: {
      preload: join(__dirname, "../preload/index.mjs"),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  win.once("ready-to-show", () => win.show());

  // 跟随系统浅色/深色切换更新窗口底色(避免切换时露出旧色)
  nativeTheme.on("updated", () => win.setBackgroundColor(themedBg()));

  // 开发环境由 electron-vite 注入 ELECTRON_RENDERER_URL
  const devUrl = process.env["ELECTRON_RENDERER_URL"];
  if (devUrl) {
    void win.loadURL(devUrl);
  } else {
    void win.loadFile(join(__dirname, "../renderer/index.html"));
  }
}

// 占位 IPC:渲染层握手用
ipcMain.handle("app:ping", () => "pong");

// 领域 IPC(会话/审批/批量预览/可逆性)
registerIpc();

app.whenReady().then(() => {
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});
