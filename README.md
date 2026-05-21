# personal-assistant

面向知识工作者/白领的、去终端化的**本地电脑助理**。Chat 为入口,底层是能自主多步执行的 agent。

## 一句话定位

本地操作 + 登录态闭网访问 + 个人记忆 —— 不是又一个面向开发者的 CLI agent。

## 技术栈速览

- **Electron**(UI 三平台,操作层先 Mac)+ **Node** 工具层
- **pi**(`earendil-works/pi`)做 agent 内核:loop / 上下文压缩 / 会话 / hooks + 多 provider
- **BYO Key + 客户端直连**(零后端),模型调用走网关抽象
- 安全:建议-审批 + 分级权限,文件操作可预览/可回滚

## 开发

```bash
pnpm install        # 安装(首次会下载 Electron 二进制)
pnpm dev            # 起 Electron 窗口(electron-vite,HMR)
pnpm -r typecheck   # 全包类型检查
pnpm --filter @pa/desktop build   # 构建 desktop
```

要求 Node >= 22、pnpm 10。

## 目录

- `apps/desktop` — Electron(main + preload + renderer/React)
- `packages/domain-core` — 共享领域类型与事件
- `packages/ctx-*` — 限界上下文(task / trust / reversibility / memory)
- `packages/cap-*` — 能力(filesystem / webresearch / browser)
- `packages/infra` — 模型网关 / 持久化 / Keychain

## 文档

- 设计讨论纪要与决策树:[`research/design-discussion.md`](research/design-discussion.md)
