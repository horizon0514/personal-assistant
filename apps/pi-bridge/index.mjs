#!/usr/bin/env node
/**
 * Minimal stdio bridge for pi: NDJSON in/out.
 *
 * Protocol (stdin ->):
 * - {"type":"init","provider":"deepseek","model":"deepseek-v4-flash"}
 * - {"type":"send","id":"<uuid>","text":"..."}
 * - {"type":"stop"}
 * - {"type":"ask_answer","requestId":"...","answer":"..."}
 *
 * Events (stdout <-):
 * - {"type":"ready"}
 * - {"type":"assistant_delta","id":"...","text":"..."}
 * - {"type":"assistant_done","id":"..."}
 * - {"type":"error","message":"..."}
 * - {"type":"ask_request","requestId":"...","question":"...","options":["..."]}
 */
import readline from "node:readline";
import { randomUUID } from "node:crypto";
import { Agent } from "@earendil-works/pi-agent-core";
import {
  registerBuiltInApiProviders,
  Type,
  // getModel is exported with constrained types; cast to loosen.
  getModel as _getModel
} from "@earendil-works/pi-ai";

registerBuiltInApiProviders();
const getModel = /** @type {(p: string, m: string) => any} */ (_getModel);

/** Write one NDJSON line to stdout. */
function emit(event) {
  try {
    process.stdout.write(JSON.stringify(event) + "\n");
  } catch {
    // If stdout is broken, there's nothing else to do.
  }
}

/** Resolve API key by provider from environment (BYO key). */
async function resolveApiKey(provider) {
  const map = {
    deepseek: process.env.DEEPSEEK_API_KEY ?? process.env.MAIN_VITE_API_KEY ?? process.env.OPENAI_API_KEY,
    openai: process.env.OPENAI_API_KEY ?? process.env.MAIN_VITE_API_KEY,
    anthropic: process.env.ANTHROPIC_API_KEY
  };
  return map[provider] || process.env.API_KEY || undefined;
}

let provider = "deepseek";
let modelId = "deepseek-v4-flash";
let agent = /** @type {Agent | null} */ (null);
let currentRunId = "";

/** Minimal ask_user tool (approval/question stub). */
const askUserTool = {
  name: "ask_user",
  description: "Ask the user a question to make a decision and wait for an answer.",
  parameters: Type.Object({
    question: Type.String({ description: "Question to ask the user" }),
    options: Type.Optional(Type.Array(Type.String(), { description: "Optional discrete options" }))
  }),
  /**
   * @param {string} id
   * @param {{ question: string, options?: string[] }} args
   * @param {AbortSignal} _signal
   * @param {(partial: { content?: Array<{type:'text',text:string}> }) => void} _onPartial
   */
  execute: async (id, args, _signal, _onPartial) => {
    const requestId = randomUUID();
    emit({
      type: "ask_request",
      requestId,
      question: String(args.question ?? ""),
      options: Array.isArray(args.options) ? args.options : []
    });
    const answer = await waitForAskAnswer(requestId);
    return {
      content: [{ type: "text", text: `用户回答: ${answer}` }],
      details: { requestId, answer }
    };
  }
};

/** Map of pending ask resolvers. */
const pendingAsks = new Map();
function waitForAskAnswer(requestId) {
  return new Promise((resolve) => pendingAsks.set(requestId, resolve));
}
function resolveAsk(requestId, answer) {
  const r = pendingAsks.get(requestId);
  if (r) {
    pendingAsks.delete(requestId);
    r(answer);
  }
}

function buildAgent() {
  const model = getModel(provider, modelId);
  const a = new Agent({
    initialState: {
      systemPrompt:
        "You are chatgo, a helpful personal assistant. Keep responses concise and actionable unless asked for detail.",
      model,
      thinkingLevel: "high",
      tools: [askUserTool]
    },
    getApiKey: resolveApiKey
  });
  a.subscribe(async (event) => {
    if (event.type === "message_update" && event.assistantMessageEvent?.type === "text_delta") {
      if (!currentRunId) return;
      emit({ type: "assistant_delta", id: currentRunId, text: event.assistantMessageEvent.delta });
    } else if (
      event.type === "message_end" &&
      event.message?.role === "assistant" &&
      !event.message.errorMessage
    ) {
      if (!currentRunId) return;
      emit({ type: "assistant_done", id: currentRunId });
    } else if (event.type === "agent_end") {
      // no-op
    }
  });
  return a;
}

async function handleInit(msg) {
  provider = typeof msg.provider === "string" && msg.provider ? msg.provider : provider;
  modelId = typeof msg.model === "string" && msg.model ? msg.model : modelId;
  const cwd = typeof msg.cwd === "string" && msg.cwd ? msg.cwd : undefined;
  try {
    if (cwd) {
      try {
        process.chdir(cwd);
      } catch (e) {
        emit({ type: "error", message: `failed to chdir to cwd: ${cwd}: ${String(e)}` });
      }
    }
    agent = buildAgent();
    emit({ type: "ready", provider, model: modelId, cwd: cwd ?? process.cwd() });
  } catch (e) {
    emit({ type: "error", message: `init failed: ${String(e)}` });
  }
}

async function handleSend(msg) {
  if (!agent) agent = buildAgent();
  const text = String(msg.text ?? "").trim();
  if (!text) return;
  const id = typeof msg.id === "string" && msg.id ? msg.id : randomUUID();
  currentRunId = id;
  try {
    await agent.prompt(text);
    // Agent will emit message_end; errors are delivered as a final assistant message with stopReason "error".
    // We synthesize a lightweight error event only when the last message carries errorMessage.
    const last = agent.state.messages[agent.state.messages.length - 1];
    if (last?.role === "assistant" && last.errorMessage) {
      emit({ type: "error", message: String(last.errorMessage) });
    }
  } catch (e) {
    emit({ type: "error", message: String(e) });
  } finally {
    currentRunId = "";
  }
}

function handleStop() {
  agent?.abort?.();
}

// NDJSON stdin loop
const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on("line", async (line) => {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    emit({ type: "error", message: "invalid json" });
    return;
  }
  const t = msg?.type;
  if (t === "init") return void handleInit(msg);
  if (t === "send") return void handleSend(msg);
  if (t === "stop") return void handleStop();
  if (t === "ask_answer") return void resolveAsk(String(msg.requestId ?? ""), String(msg.answer ?? ""));
  emit({ type: "error", message: `unknown message type: ${String(t)}` });
});
rl.on("close", () => {
  process.exit(0);
});
