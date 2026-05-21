/**
 * 组合根(composition root):把各限界上下文的实现装配成一个可用的 agent,
 * 并对外暴露一个面向 IPC 的 facade。IPC 注册见 ./ipc.ts。
 */
import { BrowserWindow, type WebContents } from "electron";
import { PiAgentAdapter } from "@pa/ctx-task";
import { createGatekeeper, riskClassifierFromMap, type ApprovalAsk } from "@pa/ctx-trust";
import { OperationJournal } from "@pa/ctx-reversibility";
import { createModel, envApiKeyResolver } from "@pa/infra";
import {
  createPlanFileChangesTool,
  filesystemReverser,
  filesystemTools,
  filesystemToolNames,
  filesystemToolRisk,
  type FileChangeOp
} from "@pa/cap-filesystem";
import { newConversationId, type Capability, type DomainEvent, type RiskLevel } from "@pa/domain-core";
import { buildSystemPrompt } from "./system-prompt";

const PROVIDER = import.meta.env.MAIN_VITE_PROVIDER ?? "anthropic";
const MODEL = import.meta.env.MAIN_VITE_MODEL ?? "claude-sonnet-4-6";
const API_KEY = import.meta.env.MAIN_VITE_API_KEY;

/** 一个 chat 窗口 = 一个会话(多轮共享 transcript)*/
const conversationId = newConversationId();

type ChatStreamEvent = { type: "delta"; text: string } | { type: "done" } | { type: "error"; message: string };

let adapter: PiAgentAdapter | undefined;
let activeSender: WebContents | undefined;

const journal = new OperationJournal();
journal.registerReverser("filesystem", filesystemReverser);

const pendingApprovals = new Map<string, (approved: boolean) => void>();
const pendingBatches = new Map<string, (approved: boolean) => void>();

function sendTo(channel: string, payload: unknown): void {
  if (activeSender && !activeSender.isDestroyed()) activeSender.send(channel, payload);
}

/** 广播 journal 变化到所有窗口(记账/撤销都会触发)*/
function broadcastJournal(): void {
  const view = journal.list();
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.webContents.isDestroyed()) win.webContents.send("reversibility:changed", view);
  }
}

/** UI 审批桥:发起单工具审批 */
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

/** 批量审批桥:把改动列表交给 UI 做 diff 预览 */
function requestBatchApproval(req: { actionId: string; operations: FileChangeOp[] }): Promise<boolean> {
  return new Promise((resolve) => {
    pendingBatches.set(req.actionId, resolve);
    sendTo("batch:request", req);
  });
}

function getAdapter(): PiAgentAdapter {
  if (!adapter) {
    const tools = [...filesystemTools, createPlanFileChangesTool(requestBatchApproval)];
    adapter = new PiAgentAdapter({
      model: createModel({ provider: PROVIDER, modelId: MODEL }),
      apiKeyResolver: async (provider) => API_KEY ?? (await envApiKeyResolver(provider)),
      // 动态拼接:基础行为 + 环境(日期/OS/主目录)+ 真实工具列表
      systemPrompt: buildSystemPrompt({
        tools: tools.map((t) => ({ name: t.name, description: t.description }))
      }),
      thinkingLevel: "high", // 开启推理:显著改善规划与工具使用
      tools,
      gatekeeper: createGatekeeper({
        // plan_file_changes 自带批量预览审批,gatekeeper 直接放行;其余按能力风险分级
        riskOf: (call): RiskLevel =>
          call.tool === "plan_file_changes" ? "ReadOnly" : riskClassifierFromMap({ ...filesystemToolRisk })(call),
        requestApproval
      }),
      capabilityOf: (tool): Capability => (filesystemToolNames.has(tool) ? "filesystem" : "filesystem"),
      onAssistantDelta: (text) => sendTo("chat:stream", { type: "delta", text } satisfies ChatStreamEvent),
      onEvent: (event: DomainEvent) => sendTo("domain:event", event),
      afterTool: ({ actionId, capability, tool, details, isError }) => {
        if (isError) return;
        const reversal = (details as { reversal?: { kind: string } & Record<string, unknown> } | undefined)?.reversal;
        if (!reversal) return; // 只读工具无 reversal
        const summary =
          (details as { path?: string; to?: string } | undefined)?.path ??
          (details as { to?: string } | undefined)?.to ??
          tool;
        journal.record({ actionId, capability, tool, summary, reversal });
        broadcastJournal();
      }
    });
  }
  return adapter;
}

/** 面向 IPC 的 facade */
export const agent = {
  modelLabel: (): string => `${PROVIDER} · ${MODEL}`,

  async send(sender: WebContents, text: string): Promise<void> {
    activeSender = sender;
    let instance: PiAgentAdapter;
    try {
      instance = getAdapter();
    } catch (err) {
      sendTo("chat:stream", { type: "error", message: `模型初始化失败:${String(err)}` } satisfies ChatStreamEvent);
      return;
    }
    try {
      await instance.startTask({ text, conversationId });
      sendTo("chat:stream", { type: "done" } satisfies ChatStreamEvent);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      sendTo("chat:stream", { type: "error", message } satisfies ChatStreamEvent);
    }
  },

  resolveApproval(actionId: string, approved: boolean): void {
    const resolve = pendingApprovals.get(actionId);
    if (resolve) {
      pendingApprovals.delete(actionId);
      resolve(approved);
    }
  },

  resolveBatch(actionId: string, approved: boolean): void {
    const resolve = pendingBatches.get(actionId);
    if (resolve) {
      pendingBatches.delete(actionId);
      resolve(approved);
    }
  },

  listJournal: () => journal.list(),

  async undoLast(): Promise<{ actionId: string; tool: string; summary: string } | null> {
    const entry = await journal.undoLast();
    broadcastJournal();
    return entry ? { actionId: entry.actionId, tool: entry.tool, summary: entry.summary } : null;
  }
};
