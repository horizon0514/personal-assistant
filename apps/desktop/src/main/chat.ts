import { type IpcMainEvent, type WebContents, ipcMain } from "electron";
import { PiAgentAdapter } from "@pa/ctx-task";
import { createGatekeeper, riskClassifierFromMap, type ApprovalAsk } from "@pa/ctx-trust";
import { createModel, envApiKeyResolver } from "@pa/infra";
import { filesystemTools, filesystemToolNames, filesystemToolRisk } from "@pa/cap-filesystem";
import { newConversationId, type Capability, type DomainEvent } from "@pa/domain-core";

const PROVIDER = import.meta.env.MAIN_VITE_PROVIDER ?? "anthropic";
const MODEL = import.meta.env.MAIN_VITE_MODEL ?? "claude-sonnet-4-6";
const API_KEY = import.meta.env.MAIN_VITE_API_KEY;

const SYSTEM_PROMPT =
  "你是一个帮助知识工作者完成任务的个人助理。简洁、准确地回答。" +
  "你可以使用工具读取本地文件系统(list_dir 列目录、read_file 读文件)。" +
  "当用户的问题涉及本地文件或目录时,主动调用这些工具获取真实信息,不要凭空臆测。";

/** 一个 chat 窗口 = 一个会话(多轮共享 transcript)*/
const conversationId = newConversationId();

export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

let adapter: PiAgentAdapter | undefined;
// 当前活动请求的渲染端(chat 单轮串行,期间回调都发往它)
let activeSender: WebContents | undefined;

function sendTo(channel: string, payload: unknown): void {
  if (activeSender && !activeSender.isDestroyed()) activeSender.send(channel, payload);
}

// 待裁决审批:actionId → resolve(approved)
const pendingApprovals = new Map<string, (approved: boolean) => void>();

/** UI 审批桥:发起审批,等用户在渲染层点同意/拒绝 */
function requestApproval(ask: ApprovalAsk): Promise<boolean> {
  return new Promise((resolve) => {
    pendingApprovals.set(ask.actionId, resolve);
    sendTo("approval:request", {
      actionId: ask.actionId,
      tool: ask.tool,
      capability: ask.capability,
      riskLevel: ask.riskLevel,
      args: ask.args
    });
  });
}

function getAdapter(): PiAgentAdapter {
  if (!adapter) {
    adapter = new PiAgentAdapter({
      model: createModel({ provider: PROVIDER, modelId: MODEL }),
      apiKeyResolver: async (provider) => API_KEY ?? (await envApiKeyResolver(provider)),
      systemPrompt: SYSTEM_PROMPT,
      tools: filesystemTools,
      gatekeeper: createGatekeeper({
        riskOf: riskClassifierFromMap({ ...filesystemToolRisk }),
        requestApproval
      }),
      capabilityOf: (tool): Capability => (filesystemToolNames.has(tool) ? "filesystem" : "filesystem"),
      onAssistantDelta: (text) => sendTo("chat:stream", { type: "delta", text } satisfies ChatStreamEvent),
      onEvent: (event: DomainEvent) => sendTo("domain:event", event)
    });
  }
  return adapter;
}

export function registerChatIpc(): void {
  ipcMain.handle("chat:model", () => `${PROVIDER} · ${MODEL}`);

  // 渲染层回传审批结果
  ipcMain.on("approval:resolve", (_e, payload: { actionId: string; approved: boolean }) => {
    const resolve = pendingApprovals.get(payload.actionId);
    if (resolve) {
      pendingApprovals.delete(payload.actionId);
      resolve(payload.approved);
    }
  });

  ipcMain.on("chat:send", async (e: IpcMainEvent, text: string) => {
    activeSender = e.sender;
    let instance: PiAgentAdapter;
    try {
      instance = getAdapter();
    } catch (err) {
      sendTo("chat:stream", { type: "error", message: `模型初始化失败:${String(err)}` });
      return;
    }
    try {
      await instance.startTask({ text, conversationId });
      sendTo("chat:stream", { type: "done" } satisfies ChatStreamEvent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendTo("chat:stream", { type: "error", message } satisfies ChatStreamEvent);
    }
  });
}
