Akari MyGo Desktop (MVP)

What this is
- A minimal desktop shell for Akari built with MyGo native UI (Go), side-by-side with the existing Electron app.
- MVP scope: a single-window chat UI that can send a message and show a streaming assistant reply.
- DeepSeek support: if DEEPSEEK_API_KEY is set, calls DeepSeek Chat Completions with streaming; otherwise a local mocked stream is used.

Run locally
- Prereqs: Go (the MyGo version currently requires Go 1.27+ via toolchain auto-selection).
- Env (optional): export DEEPSEEK_API_KEY=sk-... and optionally AKARI_MODEL=deepseek-v4-flash (default: deepseek-chat).
- Start:
  - cd apps/desktop-mygo
  - go run .

Build
- cd apps/desktop-mygo && go build .
- Packaging via mygo CLI is not required for this MVP; keep using go run/build. A future PR can add mygo packaging and auto-update.

Notes on keys
- This MVP reads DEEPSEEK_API_KEY from env only. The Electron safeStorage-based secrets.json uses encryption we can’t read in Go; migrating to OS keychain will come later.
- If no key is found, the app clearly shows Chinese-friendly notice and uses a local mock stream so the UI is still usable.

Chinese-friendly UX direction
- App title and messages use Chinese labels (“我/助理”) and concise, non-CLI presentation.
- Single-window, chat-first experience; no terminal UI.

Deferred to later PRs
- Full browser/CDP automation and the complete cap-* tool surface (filesystem, document OCR, notebook, shell, office, schedule).
- SafeStorage/Keychain parity and UI for setting the key.
- Workspace/session persistence, memory, skills hot-reload, approvals, plan confirmation.
- Packaging/signing/auto-update via mygo CLI.

Repo integration
- Lives at apps/desktop-mygo; does not modify existing Electron app.
- Go tests included for basic non-UI logic (model fallback and mock streaming).

