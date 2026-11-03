# chatgo (MyGo)

A minimal MyGo native UI desktop chat app that hosts the UI and talks to the `pi` runtime via a local NDJSON stdio bridge.

## Architecture

- UI: MyGo native UI in Go (`apps/desktop-mygo`)
- Bridge: Node NDJSON stdio process (`apps/pi-bridge/index.mjs`) using `@earendil-works/pi-agent-core` and `@earendil-works/pi-ai`
- Protocol: NDJSON over stdio — init, send, stream deltas, ask_user round‑trip

See `ARCHITECTURE.md` at repo root for details and deferred items.

## Prerequisites

- Go 1.27.3+ (per MyGo)
- Node 22+ and `pnpm` (to install `@earendil-works/*` dependencies used by the bridge)
- A model API key (DeepSeek preferred):
  - Export `DEEPSEEK_API_KEY` (preferred), or `OPENAI_API_KEY`, or `MAIN_VITE_API_KEY`

## Setup

```bash
# from repo root
pnpm install
```

## Run (dev)

```bash
cd apps/desktop-mygo
go run .
```

## Build

```bash
cd apps/desktop-mygo
go build -o chatgo
./chatgo
```

## Notes

- If no API key is found, the app will warn and the agent will likely error out gracefully.
- Tools are intentionally minimal for MVP; only `ask_user` is wired as a stub to demonstrate the approval/interaction hook.

## Primary vs worker sessions (orchestration)

- One session is marked as primary (first by default). The user chats here day-to-day.
- Other sessions are workers, each can bind a workspace folder (path shown in the sidebar).
- From the primary composer, use “Assign…” to dispatch the current prompt to a worker (existing or New worker…). The worker runs in its own cwd via the stdio bridge, and when done a short result appears in the primary as a normal assistant bubble. The worker’s own transcript is stored locally as JSONL.
- Local-only, no account or cloud store. Dispatch is sequential in v1 (simple and reliable); parallelism can be added later.
