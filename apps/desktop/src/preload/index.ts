import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { DomainEvent } from "@pa/domain-core";
import type { JournalView } from "@pa/ctx-reversibility";

export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export interface ApprovalRequest {
  actionId: string;
  tool: string;
  capability: string;
  riskLevel: string;
  args: Record<string, unknown>;
}

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
  },
  approval: {
    /** 订阅审批请求,返回取消订阅函数 */
    onRequest: (cb: (req: ApprovalRequest) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: ApprovalRequest): void => cb(payload);
      ipcRenderer.on("approval:request", listener);
      return () => ipcRenderer.removeListener("approval:request", listener);
    },
    /** 回传用户决定 */
    resolve: (actionId: string, approved: boolean): void =>
      ipcRenderer.send("approval:resolve", { actionId, approved })
  },
  reversibility: {
    list: (): Promise<JournalView[]> => ipcRenderer.invoke("reversibility:list"),
    undoLast: (): Promise<{ actionId: string; tool: string; summary: string } | null> =>
      ipcRenderer.invoke("reversibility:undoLast"),
    onChanged: (cb: (entries: JournalView[]) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: JournalView[]): void => cb(payload);
      ipcRenderer.on("reversibility:changed", listener);
      return () => ipcRenderer.removeListener("reversibility:changed", listener);
    }
  }
};

contextBridge.exposeInMainWorld("pa", api);

export type PaApi = typeof api;
