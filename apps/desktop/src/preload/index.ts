import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
import type { DomainEvent } from "@pa/domain-core";
import type { JournalView } from "@pa/ctx-reversibility";
import type { MemoryView } from "@pa/ctx-memory";
export type { MemoryView };
import type { EvalTelemetrySummary, PersistedEvalRecord } from "../main/eval-telemetry";
export type { EvalTelemetrySummary, PersistedEvalRecord };
import type { FileChangeOp } from "@pa/cap-filesystem";
import type { WorkspaceRecord, SessionRecord, ScheduleRecord, ScheduleDraft } from "@pa/infra";

export type { WorkspaceRecord, SessionRecord, ScheduleRecord, ScheduleDraft };

export interface BatchRequest {
  actionId: string;
  operations: FileChangeOp[];
}

export type ThemeSource = "light" | "dark" | "system";

export interface ApiKeyStatus {
  provider: string;
  set: boolean;
  last4?: string;
}

/** memory:changed 负载:带 wsId,消费方按所选 workspace 过滤。 */
export interface MemoryChange {
  wsId: string;
  items: MemoryView[];
}

/** 重建历史会话用的 timeline 项(由主进程从 transcript 映射,与实时事件形状一致)。 */
export interface PersistedAction {
  id: string;
  stepId: string;
  tool: string;
  capability: string;
  status: "done" | "failed";
  error?: string;
  /** 工具结果文本(可查看工具),供"查看"按钮重开到 artifact 面板 */
  resultBody?: string;
}

/** step:result 负载:某动作产出的可查看文本结果。 */
export interface StepResult {
  actionId: string;
  body: string;
}
export type TimelineItem =
  | { kind: "msg"; id: string; role: "user" | "assistant"; content: string }
  | { kind: "step"; stepId: string; index: number; actions: PersistedAction[] };

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

/** plan:request 负载:执行器起草的待确认开工计划。 */
export interface PlanRequest {
  requestId: string;
  deliverables: string[];
  criteria: string[];
}

/** ask:request 负载:执行器向用户提出的待回答问题。 */
export interface AskRequest {
  requestId: string;
  question: string;
  options: string[];
}

/**
 * 受控 IPC 桥。渲染层只能通过 window.pa 访问主进程能力。
 */
const api = {
  ping: (): Promise<string> => ipcRenderer.invoke("app:ping"),
  appVersion: (): Promise<string> => ipcRenderer.invoke("app:version"),
  /** 系统账户名(本地取,供空白页问候个性化);取不到为空串 */
  userName: (): Promise<string> => ipcRenderer.invoke("system:userName"),
  settings: {
    /** 打开独立设置窗(单实例) */
    open: (): Promise<void> => ipcRenderer.invoke("settings:open"),
    getTheme: (): Promise<ThemeSource> => ipcRenderer.invoke("settings:getTheme"),
    setTheme: (theme: ThemeSource): Promise<ThemeSource> => ipcRenderer.invoke("settings:setTheme", theme)
  },
  workspace: {
    list: (): Promise<WorkspaceRecord[]> => ipcRenderer.invoke("workspace:list"),
    active: (): Promise<string> => ipcRenderer.invoke("workspace:active"),
    create: (name: string): Promise<WorkspaceRecord> => ipcRenderer.invoke("workspace:create", name),
    rename: (wsId: string, name: string): Promise<WorkspaceRecord[]> =>
      ipcRenderer.invoke("workspace:rename", { wsId, name }),
    /** 删除 workspace(级联),返回剩余列表 + 新的当前 workspace */
    delete: (wsId: string): Promise<{ workspaces: WorkspaceRecord[]; activeWorkspaceId: string }> =>
      ipcRenderer.invoke("workspace:delete", wsId),
    /** 切换 workspace,返回该 workspace 的会话列表 */
    switch: (wsId: string): Promise<SessionRecord[]> => ipcRenderer.invoke("workspace:switch", wsId)
  },
  session: {
    list: (): Promise<SessionRecord[]> => ipcRenderer.invoke("session:list"),
    create: (): Promise<SessionRecord> => ipcRenderer.invoke("session:create"),
    /** 打开会话,返回重建好的 timeline */
    open: (sessionId: string): Promise<TimelineItem[]> => ipcRenderer.invoke("session:open", sessionId),
    /** 归档会话(从列表隐藏,不删 transcript) */
    archive: (sessionId: string): Promise<void> => ipcRenderer.invoke("session:archive", sessionId),
    /** 当前 workspace 的已归档会话 */
    listArchived: (): Promise<SessionRecord[]> => ipcRenderer.invoke("session:listArchived"),
    /** 恢复归档会话(重回活跃列表) */
    unarchive: (sessionId: string): Promise<void> => ipcRenderer.invoke("session:unarchive", sessionId),
    /** 会话列表变化(如自动命名/落盘后) */
    onChanged: (cb: (sessions: SessionRecord[]) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: SessionRecord[]): void => cb(payload);
      ipcRenderer.on("session:changed", listener);
      return () => ipcRenderer.removeListener("session:changed", listener);
    }
  },
  secret: {
    apiKeyStatus: (): Promise<ApiKeyStatus> => ipcRenderer.invoke("secret:apiKeyStatus"),
    setApiKey: (key: string): Promise<ApiKeyStatus> => ipcRenderer.invoke("secret:setApiKey", key),
    clearApiKey: (): Promise<ApiKeyStatus> => ipcRenderer.invoke("secret:clearApiKey")
  },
  /** 拖入文件:在渲染层从 File 对象取其本地绝对路径(Electron 33 起 File.path 已移除,须用 webUtils)。 */
  files: {
    pathForDropped: (file: File): string => webUtils.getPathForFile(file)
  },
  chat: {
    send: (sessionId: string, text: string, attachments?: string[]): void =>
      ipcRenderer.send("chat:send", { sessionId, text, attachments }),
    /** 停止当前会话正在进行的运行 */
    stop: (sessionId: string): void => ipcRenderer.send("chat:stop", sessionId),
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
  step: {
    /** 订阅可查看工具的结果文本(live 运行时),供"查看"按钮重开到 artifact 面板 */
    onResult: (cb: (res: StepResult) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: StepResult): void => cb(payload);
      ipcRenderer.on("step:result", listener);
      return () => ipcRenderer.removeListener("step:result", listener);
    }
  },
  browser: {
    /** 主进程请求打开「浏览器」artifact(抓取前自动弹出,渲染层据此挂载 <webview>) */
    onShow: (cb: () => void): (() => void) => {
      const listener = (): void => cb();
      ipcRenderer.on("browser:show", listener);
      return () => ipcRenderer.removeListener("browser:show", listener);
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
  batch: {
    /** 订阅批量改动预览请求 */
    onRequest: (cb: (req: BatchRequest) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: BatchRequest): void => cb(payload);
      ipcRenderer.on("batch:request", listener);
      return () => ipcRenderer.removeListener("batch:request", listener);
    },
    resolve: (actionId: string, approved: boolean): void =>
      ipcRenderer.send("batch:resolve", { actionId, approved })
  },
  plan: {
    /** 订阅开工对齐请求(执行器动手前起草) */
    onRequest: (cb: (req: PlanRequest) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: PlanRequest): void => cb(payload);
      ipcRenderer.on("plan:request", listener);
      return () => ipcRenderer.removeListener("plan:request", listener);
    },
    /** 回传用户决定:就这么干 / 调一下(带反馈) / 取消 */
    resolve: (
      requestId: string,
      result:
        | { kind: "confirm"; plan: { deliverables: string[]; criteria: string[] } }
        | { kind: "feedback"; text: string }
        | { kind: "cancel" }
    ): void => ipcRenderer.send("plan:resolve", { requestId, result })
  },
  ask: {
    /** 订阅执行器的提问请求(执行中需用户拍板) */
    onRequest: (cb: (req: AskRequest) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: AskRequest): void => cb(payload);
      ipcRenderer.on("ask:request", listener);
      return () => ipcRenderer.removeListener("ask:request", listener);
    },
    /** 回传用户的回答(自由输入或所选项) */
    resolve: (requestId: string, answer: string): void =>
      ipcRenderer.send("ask:resolve", { requestId, answer })
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
  },
  schedule: {
    list: (): Promise<ScheduleRecord[]> => ipcRenderer.invoke("schedule:list"),
    create: (draft: ScheduleDraft): Promise<ScheduleRecord[]> => ipcRenderer.invoke("schedule:create", draft),
    update: (id: string, patch: Partial<ScheduleDraft>): Promise<ScheduleRecord[]> =>
      ipcRenderer.invoke("schedule:update", { id, patch }),
    remove: (id: string): Promise<ScheduleRecord[]> => ipcRenderer.invoke("schedule:remove", id),
    /** 立即运行一次(测试 / 手动触发),返回最新列表 */
    runNow: (id: string): Promise<ScheduleRecord[]> => ipcRenderer.invoke("schedule:runNow", id),
    /** 点系统通知后,主进程要求打开某条产出会话 */
    onOpenSession: (cb: (p: { sessionId: string }) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: { sessionId: string }): void => cb(payload);
      ipcRenderer.on("scheduler:openSession", listener);
      return () => ipcRenderer.removeListener("scheduler:openSession", listener);
    },
    /** 定时任务被(模型/其他窗口)改动 → 推最新列表,面板实时刷新 */
    onChanged: (cb: (list: ScheduleRecord[]) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, list: ScheduleRecord[]): void => cb(list);
      ipcRenderer.on("schedule:changed", listener);
      return () => ipcRenderer.removeListener("schedule:changed", listener);
    }
  },
  memory: {
    list: (wsId: string): Promise<MemoryView[]> => ipcRenderer.invoke("memory:list", wsId),
    listForgotten: (wsId: string): Promise<MemoryView[]> => ipcRenderer.invoke("memory:listForgotten", wsId),
    /** 软删(遗忘),可恢复 */
    remove: (wsId: string, id: string): void => ipcRenderer.send("memory:remove", { wsId, id }),
    restore: (wsId: string, id: string): void => ipcRenderer.send("memory:restore", { wsId, id }),
    /** 记忆变化(含 agent 后台写入);payload 带 wsId,消费方按所选 workspace 过滤 */
    onChanged: (cb: (payload: MemoryChange) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: MemoryChange): void => cb(payload);
      ipcRenderer.on("memory:changed", listener);
      return () => ipcRenderer.removeListener("memory:changed", listener);
    }
  },
  evalTelemetry: {
    /** 读取 + 聚合验收 telemetry(全局,供设置窗「验收质量」面板) */
    get: (): Promise<EvalTelemetrySummary> => ipcRenderer.invoke("evalTelemetry:get")
  }
};

contextBridge.exposeInMainWorld("pa", api);

export type PaApi = typeof api;
