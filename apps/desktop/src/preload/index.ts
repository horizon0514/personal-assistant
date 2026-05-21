import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { DomainEvent } from "@pa/domain-core";

export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

/**
 * 受控 IPC 桥。渲染层只能通过 window.pa 访问主进程能力。
 */
const api = {
  ping: (): Promise<string> => ipcRenderer.invoke("app:ping"),
  chat: {
    send: (text: string): void => ipcRenderer.send("chat:send", text),
    model: (): Promise<string> => ipcRenderer.invoke("chat:model"),
    /** 订阅流式事件,返回取消订阅函数 */
    onStream: (cb: (event: ChatStreamEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: ChatStreamEvent): void => cb(payload);
      ipcRenderer.on("chat:stream", listener);
      return () => ipcRenderer.removeListener("chat:stream", listener);
    }
  },
  domain: {
    /** 订阅任务/动作领域事件,返回取消订阅函数 */
    onEvent: (cb: (event: DomainEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: DomainEvent): void => cb(payload);
      ipcRenderer.on("domain:event", listener);
      return () => ipcRenderer.removeListener("domain:event", listener);
    }
  }
};

contextBridge.exposeInMainWorld("pa", api);

export type PaApi = typeof api;
