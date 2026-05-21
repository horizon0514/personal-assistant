# Personal Assistant — 技术选型

> 配套阅读:[`design-discussion.md`](design-discussion.md) · [`domain-model.md`](domain-model.md)
> 日期:2026-05-21

## 选型总表

| 层 | 选型 | 备注/理由 |
|----|------|-----------|
| 语言 | **TypeScript** | 全程 TS,贴合前端团队 |
| 客户端 | **Electron** | UI 三平台;操作层先 Mac |
| 前端框架 | **React** | Electron 生态最厚、招人易、pi web UI 同系 |
| Agent 内核 | **pi**(pi-agent-core + pi-ai) | loop/compaction/session/hooks + 多 provider;ACL 包裹 |
| 仓库结构 | **pnpm workspaces monorepo** | 包对齐限界上下文;暂不上 turborepo |
| Electron 构建 | **electron-vite + electron-builder** | Vite 开发体验 + builder 打包 |
| 持久化 | **混合:SQLite(better-sqlite3)+ 文件** | journal/session/approval 进 SQLite(事务性);memory 用 Markdown/文件(可见可编辑) |
| 状态管理 | **Zustand** | 轻、适合高频流式更新 |
| 组件库 | **shadcn/ui**(Radix + Tailwind) | 拥有源码,适合定制信任 UX |
| 样式 | **Tailwind CSS** | |
| 浏览器自动化 | **Playwright** | persistent context = App 内置专用 profile |
| 凭证存储 | **OS Keychain** | 浏览器登录态 |
| 模型访问 | **BYO Key + 客户端直连** | 经网关抽象,后续可切服务器中转 |
| 文档读取 | `pdfjs-dist`(PDF)· `mammoth`(docx)· `xlsx`(表格) | |
| 文档产出 | `docx`(Word)· `exceljs`(Excel) | |
| 测试 | **vitest**(与 pi 一致)+ Playwright(e2e) | |

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

- **Electron main**:跑 pi 的 Agent、各 Capability 执行、SQLite、Keychain、Playwright
- **preload**:暴露受控 IPC 桥
- **renderer(React)**:Chat + 计划/工作区面板,经 IPC 订阅领域事件流
- 领域事件分发机制(进程内 vs 总线)待定 —— 见 TODO
