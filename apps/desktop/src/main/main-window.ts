/**
 * 主窗口引用持有。index.ts 创建主窗口后写入;需要向渲染层发 IPC 或获取主窗口的模块从这里读。
 */
import type { BrowserWindow } from "electron";

let mainWindow: BrowserWindow | undefined;

export function setMainWindow(win: BrowserWindow): void {
  mainWindow = win;
  win.on("closed", () => {
    if (mainWindow === win) mainWindow = undefined;
  });
}

export function getMainWindow(): BrowserWindow | undefined {
  return mainWindow;
}

export function getMainWebContents(): Electron.WebContents | undefined {
  return mainWindow?.webContents;
}
