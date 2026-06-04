/**
 * IPC 注册:把渲染层通道映射到 agent facade。
 * 分组:workspace / session / chat / approval / batch / reversibility / memory。
 */
import { type IpcMainEvent, ipcMain, dialog } from "electron";
import type { ScheduleDraft } from "@pa/infra";
import { agent } from "./agent";
import { schedules } from "./scheduler";
import { readEvalTelemetry } from "./eval-telemetry";
import { getUpdateStatus, installUpdate, openReleasesPage } from "./updater";

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
  ipcMain.handle("session:bindNotebook", (_e, p: { sessionId: string; notebook?: string }) =>
    agent.setBoundNotebook(p.sessionId, p.notebook)
  );

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
  ipcMain.on("chat:send", (e: IpcMainEvent, p: { sessionId: string; text: string; attachments?: string[] }) =>
    void agent.send(e.sender, p.sessionId, p.text, p.attachments)
  );
  ipcMain.on("chat:stop", (_e, sessionId: string) => agent.stop(sessionId));

  // Trust:单工具审批(remember=用户点了「总是同意」→ 同类操作以后免审批)
  ipcMain.on("approval:resolve", (_e, p: { actionId: string; approved: boolean; remember?: boolean }) =>
    agent.resolveApproval(p.actionId, p.approved, p.remember ?? false)
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

  // 自动更新:渲染层 banner 拉当前状态 + 触发「重启更新」/「前往下载」。状态推送走 update:status 事件。
  ipcMain.handle("update:get", () => getUpdateStatus());
  ipcMain.on("update:install", () => installUpdate());
  ipcMain.on("update:openReleases", () => openReleasesPage());

  // Personal Memory:列出 / 软删(遗忘)/ 恢复(按 wsId)
  ipcMain.handle("memory:list", (_e, wsId: string) => agent.listMemory(wsId));
  ipcMain.handle("memory:listForgotten", (_e, wsId: string) => agent.listForgottenMemory(wsId));
  ipcMain.on("memory:remove", (_e, p: { wsId: string; id: string }) => agent.removeMemory(p.wsId, p.id));
  ipcMain.on("memory:restore", (_e, p: { wsId: string; id: string }) => agent.restoreMemory(p.wsId, p.id));

  // 知识库:只读浏览 + UI 增删(增删也广播 notebook:changed,与对话工具一致刷新)
  ipcMain.handle("notebook:list", (_e, wsId: string) => agent.listNotebooks(wsId));
  ipcMain.handle("notebook:get", (_e, p: { wsId: string; name: string }) => agent.notebookDetail(p.wsId, p.name));
  ipcMain.handle("notebook:readSource", (_e, p: { wsId: string; name: string; ref: string }) =>
    agent.readNotebookSource(p.wsId, p.name, p.ref)
  );
  ipcMain.handle("notebook:create", (_e, p: { wsId: string; name: string }) => agent.createNotebook(p.wsId, p.name));
  ipcMain.handle("notebook:addSource", (_e, p: { wsId: string; notebook: string; path: string }) =>
    agent.addNotebookSource(p.wsId, p.notebook, p.path)
  );
  ipcMain.handle("notebook:removeSource", (_e, p: { wsId: string; notebook: string; ref: string }) =>
    agent.removeNotebookSource(p.wsId, p.notebook, p.ref)
  );
  // 知识库导入:限文档类型;聊天「+」菜单的「添加附件」:不限类型。共用一个多选选择框。
  ipcMain.handle("notebook:pickFiles", () =>
    pickFiles("选择要加入知识库的文档", [
      { name: "支持的文档", extensions: ["pdf", "txt", "md", "markdown", "csv", "tsv", "json", "log", "xml", "yaml", "yml"] },
      { name: "PDF", extensions: ["pdf"] },
      { name: "全部文件", extensions: ["*"] }
    ])
  );
  ipcMain.handle("dialog:pickFiles", () => pickFiles("选择文件"));
}

/** 系统文件选择框(多选),返回绝对路径数组(取消则空);filters 不传=不限类型。 */
async function pickFiles(title: string, filters?: Electron.FileFilter[]): Promise<string[]> {
  const res = await dialog.showOpenDialog({ title, properties: ["openFile", "multiSelections"], filters });
  return res.canceled ? [] : res.filePaths;
}
