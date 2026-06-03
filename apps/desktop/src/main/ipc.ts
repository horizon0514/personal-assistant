/**
 * IPC 注册:把渲染层通道映射到 agent facade。
 * 分组:workspace / session / chat / approval / batch / reversibility / memory。
 */
import { type IpcMainEvent, ipcMain } from "electron";
import type { ScheduleDraft } from "@pa/infra";
import { agent } from "./agent";
import { schedules } from "./scheduler";
import { readEvalTelemetry } from "./eval-telemetry";

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

  // Work Plan:开工对齐回应(就这么干 / 调一下带反馈 / 取消)
  ipcMain.on(
    "plan:resolve",
    (
      _e,
      p: {
        requestId: string;
        result:
          | { kind: "confirm"; plan: { deliverables: string[]; criteria: string[] } }
          | { kind: "feedback"; text: string }
          | { kind: "cancel" };
      }
    ) => agent.resolvePlan(p.requestId, p.result)
  );

  // ask_user:用户对提问卡的回答
  ipcMain.on("ask:resolve", (_e, p: { requestId: string; answer: string }) =>
    agent.resolveAsk(p.requestId, p.answer)
  );

  // Reversibility:journal / 撤销
  ipcMain.handle("reversibility:list", () => agent.listJournal());
  ipcMain.handle("reversibility:undoLast", () => agent.undoLast());

  // Scheduled Tasks:定时任务 CRUD + 立即运行(均返回最新列表)
  ipcMain.handle("schedule:list", () => schedules.list());
  ipcMain.handle("schedule:create", (_e, draft: ScheduleDraft) => schedules.create(draft));
  ipcMain.handle("schedule:update", (_e, p: { id: string; patch: Partial<ScheduleDraft> }) =>
    schedules.update(p.id, p.patch)
  );
  ipcMain.handle("schedule:remove", (_e, id: string) => schedules.remove(id));
  ipcMain.handle("schedule:runNow", (_e, id: string) => schedules.runNow(id));

  // 验收可观测:读取 + 聚合 eval-telemetry.jsonl(全局,供设置窗「验收质量」面板)
  ipcMain.handle("evalTelemetry:get", () => readEvalTelemetry());

  // Personal Memory:列出 / 软删(遗忘)/ 恢复(按 wsId)
  ipcMain.handle("memory:list", (_e, wsId: string) => agent.listMemory(wsId));
  ipcMain.handle("memory:listForgotten", (_e, wsId: string) => agent.listForgottenMemory(wsId));
  ipcMain.on("memory:remove", (_e, p: { wsId: string; id: string }) => agent.removeMemory(p.wsId, p.id));
  ipcMain.on("memory:restore", (_e, p: { wsId: string; id: string }) => agent.restoreMemory(p.wsId, p.id));
}
