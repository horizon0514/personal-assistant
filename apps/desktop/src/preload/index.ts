import { contextBridge, ipcRenderer } from "electron";

/**
 * 受控 IPC 桥。渲染层只能通过 window.pa 访问主进程能力。
 * 后续在此暴露领域事件订阅 / 命令派发,而非裸 ipcRenderer。
 */
const api = {
  ping: (): Promise<string> => ipcRenderer.invoke("app:ping")
};

contextBridge.exposeInMainWorld("pa", api);

export type PaApi = typeof api;
