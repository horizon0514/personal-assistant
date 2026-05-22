# @pa/infra

Infra —— Model Gateway(pi-ai 封装)/ 持久化(现文件 JSON,SQLite 待做)/ 密钥(safeStorage)(通用底座)

已实现:`createModel`(pi-ai 网关,带 forceVision 覆盖)+ `readJson`/`writeJson` + `WorkspaceStore`/`SessionStore`(文件 JSON 持久化)。密钥用 Electron `safeStorage`(实现在 desktop 主进程 `key-store.ts`)。职责与模型见 [`research/domain-model.md`](../../research/domain-model.md)。
