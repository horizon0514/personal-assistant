/**
 * IPC 注册:把渲染层的通道映射到 agent facade。
 * 通道按领域分组:chat(会话)/ approval(信任)/ batch(可逆性预览)/ reversibility(撤销)。
 */
import { type IpcMainEvent, ipcMain } from "electron";
import { agent } from "./agent";

export function registerIpc(): void {
  // Conversation
  ipcMain.handle("chat:model", () => agent.modelLabel());
  ipcMain.on("chat:send", (e: IpcMainEvent, text: string) => void agent.send(e.sender, text));

  // Trust:单工具审批
  ipcMain.on("approval:resolve", (_e, p: { actionId: string; approved: boolean }) =>
    agent.resolveApproval(p.actionId, p.approved)
  );

  // Reversibility:批量预览审批
  ipcMain.on("batch:resolve", (_e, p: { actionId: string; approved: boolean }) =>
    agent.resolveBatch(p.actionId, p.approved)
  );

  // Reversibility:journal / 撤销
  ipcMain.handle("reversibility:list", () => agent.listJournal());
  ipcMain.handle("reversibility:undoLast", () => agent.undoLast());

  // Personal Memory:列出 / 删除
  ipcMain.handle("memory:list", () => agent.listMemory());
  ipcMain.on("memory:remove", (_e, id: string) => agent.removeMemory(id));
}
