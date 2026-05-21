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

const PROVIDER = import.meta.env.MAIN_VITE_PROVIDER ?? "anthropic";
const MODEL = import.meta.env.MAIN_VITE_MODEL ?? "claude-sonnet-4-6";
const API_KEY = import.meta.env.MAIN_VITE_API_KEY;

const SYSTEM_PROMPT =
  "你是一个帮助知识工作者完成任务的个人助理。简洁、准确地回答。" +
  "你可以使用工具操作本地文件系统:list_dir 列目录、read_file 读文件、write_file 写单个文件。" +
  "涉及移动/重命名/删除文件时(无论一个还是多个),必须用 plan_file_changes 一次性提交全部改动," +
  "它会向用户展示完整预览并整批审批。" +
  "写入或移动文件时,缺失的目标目录会自动创建——你不需要、也无法单独创建目录,直接写/移到目标路径即可。" +
  "当用户的问题涉及本地文件或目录时,主动调用工具获取真实信息,不要凭空臆测。" +
  "重要:做完任何改动状态的操作后,必须用只读工具(如 list_dir / read_file)核实结果," +
  "确认达到预期后再向用户汇报;汇报应基于你实际观察到的事实,而不是假设操作成功。" +
  "绝不要让用户自己去验证(例如不要说『你可以用 ls 检查』)——验证是你的职责。";

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
    adapter = new PiAgentAdapter({
      model: createModel({ provider: PROVIDER, modelId: MODEL }),
      apiKeyResolver: async (provider) => API_KEY ?? (await envApiKeyResolver(provider)),
      systemPrompt: SYSTEM_PROMPT,
      tools: [...filesystemTools, createPlanFileChangesTool(requestBatchApproval)],
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
