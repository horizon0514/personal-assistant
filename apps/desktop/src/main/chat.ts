import { type IpcMainEvent, ipcMain } from "electron";
import { Agent } from "@earendil-works/pi-agent-core";
import { createModel, envApiKeyResolver } from "@pa/infra";

const PROVIDER = import.meta.env.MAIN_VITE_PROVIDER ?? "anthropic";
const MODEL = import.meta.env.MAIN_VITE_MODEL ?? "claude-sonnet-4-6";
const API_KEY = import.meta.env.MAIN_VITE_API_KEY;

let agent: Agent | undefined;

function getAgent(): Agent {
  if (!agent) {
    agent = new Agent({
      initialState: {
        systemPrompt: "你是一个帮助知识工作者完成任务的个人助理。简洁、准确地回答。",
        model: createModel({ provider: PROVIDER, modelId: MODEL })
      },
      // BYO key:优先用 .env 注入的 key,回退到环境变量解析(占位,后续换 Keychain)
      getApiKey: (provider) => API_KEY ?? envApiKeyResolver(provider)
    });
  }
  return agent;
}

/** 渲染层 → 主进程 的 chat 流式协议 */
export type ChatStreamEvent =
  | { type: "delta"; text: string }
  | { type: "done" }
  | { type: "error"; message: string };

export function registerChatIpc(): void {
  ipcMain.handle("chat:model", () => `${PROVIDER} · ${MODEL}`);

  ipcMain.on("chat:send", async (e: IpcMainEvent, text: string) => {
    const send = (payload: ChatStreamEvent): void => {
      if (!e.sender.isDestroyed()) e.sender.send("chat:stream", payload);
    };

    let current: Agent;
    try {
      current = getAgent();
    } catch (err) {
      send({ type: "error", message: `模型初始化失败:${String(err)}` });
      return;
    }

    const unsubscribe = current.subscribe((event) => {
      if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
        send({ type: "delta", text: event.assistantMessageEvent.delta });
      }
    });

    try {
      await current.prompt(text);
      send({ type: "done" });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // 最常见:未设置 ANTHROPIC_API_KEY
      send({ type: "error", message });
    } finally {
      unsubscribe();
    }
  });
}
