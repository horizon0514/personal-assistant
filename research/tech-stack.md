# Personal Assistant — 技术选型

> 配套阅读:[`design-discussion.md`](design-discussion.md) · [`domain-model.md`](domain-model.md)
> 初定 2026-05-21 · 校正于 2026-05-22:加「状态」列区分**已用 / 选了还没做 / 已改方向**。仅两处真改方向(浏览器驱动 Playwright→CDP、产品侧多 provider→专注 deepseek);其余「未做」项仍是选型,不是弃用。

## 选型总表

> 状态图例:✅ 已用 · 🚧 选了还没做 · 🔄 已改方向

| 层 | 选型 | 状态 | 备注/理由 |
|----|------|------|-----------|
| 语言 | **TypeScript** | ✅ | 全程 TS,贴合前端团队 |
| 客户端 | **Electron** | ✅ | UI 三平台;操作层先 Mac |
| 前端框架 | **React** | ✅ | Electron 生态最厚、招人易、pi web UI 同系 |
| Agent 内核 | **pi**(pi-agent-core + pi-ai) | ✅ | loop/compaction/session/hooks;ACL 包裹。pi-ai 本身多 provider,但**产品侧专注 deepseek**(不做 provider 切换 UI),网关保留切换口子 |
| 仓库结构 | **pnpm workspaces monorepo** | ✅ | 包对齐限界上下文;暂不上 turborepo |
| Electron 构建 | **electron-vite + electron-builder** | ✅ | Vite 开发体验 + builder 打包 |
| 持久化 | **混合:SQLite(better-sqlite3)+ 文件** | 🚧 | **现状:全用文件 JSON**(`infra` readJson/writeJson:workspace/session/transcript/journal/memory)。SQLite 仍是目标(journal/session 事务性),数据量大或需查询时再上 |
| 状态管理 | **Zustand** | ✅ | 轻、适合高频流式更新 |
| 组件库 | **shadcn/ui**(Radix + Tailwind) | 🚧 | 选型未变;现仅用 Tailwind + 自建组件,shadcn/Radix 尚未引入 |
| 样式 | **Tailwind CSS** | ✅ | |
| 浏览器驱动 | ~~Playwright~~ → **Electron `webContents.debugger`(进程内 CDP)** | 🔄 | **已改方向(2026-05-22)**:驱动内置 `<webview>` Chromium,**不用 Playwright、不开 `--remote-debugging-port`**(避免本机调试端口暴露 cookie/DOM)。详见 design-discussion「内置浏览器调研」 |
| 浏览器登录态 | **webview `persist:research` partition** | ✅ | 用助理自己的浏览器身份,cookie 持久留存,不接管用户 Chrome |
| 凭证存储 | **Electron `safeStorage`**(原写 OS Keychain) | ✅ | API key 加密落盘 `userData/secrets.json`(mac 下底层走 Keychain);浏览器登录态在 webview partition |
| 模型访问 | **BYO Key + 客户端直连** | ✅ | 经网关抽象,后续可切服务器中转 / 订阅制 |
| 文档读取 | `pdf-parse`(PDF,已用)· `mammoth`(docx)· `xlsx`(表格) | 🚧 | PDF + 纯文本类已做(用 `pdf-parse` 替了原计划的 pdfjs-dist);docx / 表格 / 图片 OCR 待做 |
| 文档产出 | `docx`(Word)· `exceljs`(Excel) | 🚧 | 选型未变,尚未实现 |
| 测试 | **vitest**(已用)+ Playwright(e2e,待做) | 🚧 | 多包单测已有;e2e 待做 |

## 仓库骨架

```
personal-assistant/
├── apps/
│   └── desktop/              # Electron(main + preload + renderer/React)
├── packages/
│   ├── domain-core/          # 共享领域类型(Action/Task/Plan)+ 事件定义
│   ├── ctx-task/             # Task Orchestration(含 pi ACL)
│   ├── ctx-trust/            # Trust & Governance
│   ├── ctx-reversibility/    # Reversibility
│   ├── ctx-memory/           # Personal Memory
│   ├── cap-filesystem/       # FileSystem Capability
│   ├── cap-webresearch/      # WebResearch Capability
│   ├── cap-browser/          # BrowserSession Capability
│   └── infra/                # Model Gateway(pi-ai 封装)/ 持久化 / Keychain
├── pnpm-workspace.yaml
├── package.json
└── tsconfig.base.json
```

## 进程/数据流(初定)

- **Electron main**:跑 pi 的 Agent、各 Capability 执行、文件 JSON 持久化、safeStorage、内置浏览器(webview + CDP 驱动)
- **preload**:暴露受控 IPC 桥
- **renderer(React)**:Chat + 计划/工作区面板,经 IPC 订阅领域事件流
- 领域事件分发机制(进程内 vs 总线)待定 —— 见 TODO
