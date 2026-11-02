chatgo — Clean Architecture (MVP)

Overview

- Host/UI: MyGo (native Go UI) in apps/desktop-mygo
- Agent core: pi (earendil-works/pi) hosted out-of-process in a local Node stdio bridge at apps/pi-bridge
- Protocol: NDJSON over stdio
  - init: provider/model
  - send: user text
  - stream: assistant_delta/assistant_done
  - ask_user: ask_request → ask_answer
- Model: DeepSeek by default (provider=deepseek, model=deepseek-v4-flash), BYO key via env

Why this shape

- Thin host: UI + permissions/memory live in the host; pi stays as the reasoning loop
- Clear boundary: simple text protocol, replaceable agent core
- Small surface: no thick “cap-*” domain packages; minimal primitives only

Processes and responsibilities

- apps/desktop-mygo (MyGo native UI)
  - Renders a normal chat window
  - Starts and supervises the Node bridge subprocess
  - Sends user messages and displays streaming deltas
  - Shows a simple dialog for ask_user (approval/decision) and replies back
- apps/pi-bridge (Node stdio bridge)
  - Loads pi-agent-core and pi-ai
  - Keeps a single adapter instance and runs one task at a time
  - Exposes a minimal ask_user tool
  - Streams assistant deltas and emits ask_request events

Minimal tools in MVP

- ask_user: round-trip a user question with optional discrete options
- No filesystem/browser/shell/office/etc. tools in this PR (intentionally excluded)

Deferred (explicitly out of scope for MVP)

- Browser automation (CDP) and any in-app Chromium automation
- Reversibility engine and journaling beyond the minimal demonstration
- Thick domain “cap-*” packages (filesystem, browser, document, office, shell, webresearch)
- Multi-workspace/session persistence and advanced memory/compaction strategies
- Evaluators, planning tools, and gated trust layers beyond ask_user stub
- Keychain integration (env-only BYO key for now)
- Packaging, signing, auto-update for the Go desktop app

Build & run

1) Install JS deps (from repo root):
   pnpm install
2) Set an API key (DeepSeek preferred):
   export DEEPSEEK_API_KEY=sk-...
3) Run the Go UI:
   cd apps/desktop-mygo && go run .

Swap/override model:
- The bridge accepts provider/model in the init message; UI currently defaults to deepseek/deepseek-v4-flash.

Local protocol (NDJSON)

- UI → Bridge
  - {"type":"init","provider":"deepseek","model":"deepseek-v4-flash"}
  - {"type":"send","id":"<uuid>","text":"..."}
  - {"type":"stop"}
  - {"type":"ask_answer","requestId":"...","answer":"..."}
- Bridge → UI
  - {"type":"ready","provider":"...","model":"..."}
  - {"type":"assistant_delta","id":"...","text":"..."}
  - {"type":"assistant_done","id":"..."}
  - {"type":"error","message":"..."}
  - {"type":"ask_request","requestId":"...","question":"...","options":["..."]}

Migration notes

- Old Electron desktop and packages/cap-* remain in the repo but are not referenced in this path.
- Follow-ups will rehome permissions/memory/compaction into the Go host and add a compact event stream to the UI.
