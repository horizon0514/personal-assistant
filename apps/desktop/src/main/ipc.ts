/**
 * IPC 注册:把渲染层通道映射到 agent facade。
 * 分组:workspace / session / chat / approval / batch / reversibility / memory。
 */
import { type IpcMainEvent, ipcMain } from "electron";
import { agent } from "./agent";

export function registerIpc(): void {
  // Workspace
  ipcMain.handle("workspace:list", () => agent.listWorkspaces());
  ipcMain.handle("workspace:active", () => agent.activeWorkspace());
  ipcMain.handle("workspace:create", (_e, name: string) => agent.createWorkspace(name));
  ipcMain.handle("workspace:rename", (_e, p: { wsId: string; name: string }) =>
    agent.renameWorkspace(p.wsId, p.name)
  );
  ipcMain.handle("workspace:delete", (_e, wsId: string) => agent.deleteWorkspace(wsId));
  ipcMain.handle("workspace:switch", (_e, wsId: string) => {
    agent.switchWorkspace(wsId);
    return agent.listSessions();
  });

  // Session
  ipcMain.handle("session:list", () => agent.listSessions());
  ipcMain.handle("session:create", () => agent.createSession());
  ipcMain.handle("session:open", (_e, sessionId: string) => agent.openSession(sessionId));
  ipcMain.handle("session:archive", (_e, sessionId: string) => agent.archiveSession(sessionId));
  ipcMain.handle("session:listArchived", () => agent.listArchivedSessions());
  ipcMain.handle("session:unarchive", (_e, sessionId: string) => agent.unarchiveSession(sessionId));

  // Secret:BYO API Key(全局)
  ipcMain.handle("secret:apiKeyStatus", () => agent.apiKeyStatus());
  ipcMain.handle("secret:setApiKey", (_e, key: string) => {
    agent.setApiKey(key);
    return agent.apiKeyStatus();
  });
  ipcMain.handle("secret:clearApiKey", () => {
    agent.clearApiKey();
    return agent.apiKeyStatus();
  });

  // Conversation
  ipcMain.handle("chat:model", () => agent.modelLabel());
  ipcMain.on("chat:send", (e: IpcMainEvent, p: { sessionId: string; text: string }) =>
    void agent.send(e.sender, p.sessionId, p.text)
  );
  ipcMain.on("chat:stop", (_e, sessionId: string) => agent.stop(sessionId));

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

  // Personal Memory:列出 / 软删(遗忘)/ 恢复(按 wsId)
  ipcMain.handle("memory:list", (_e, wsId: string) => agent.listMemory(wsId));
  ipcMain.handle("memory:listForgotten", (_e, wsId: string) => agent.listForgottenMemory(wsId));
  ipcMain.on("memory:remove", (_e, p: { wsId: string; id: string }) => agent.removeMemory(p.wsId, p.id));
  ipcMain.on("memory:restore", (_e, p: { wsId: string; id: string }) => agent.restoreMemory(p.wsId, p.id));
}
