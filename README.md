<p align="center">
  <img src="apps/site/public/icon.svg" alt="Akari" width="120" height="120" />
</p>

<h1 align="center">Akari（灯）</h1>

<p align="center">面向知识工作者/白领的、去终端化的<strong>本地电脑助理</strong>。Chat 为入口,底层是能自主多步执行的 agent。</p>

---

> 用一句话让它替你操作文件、网页与文档——本地运行,登录态闭网访问,带个人记忆。

## 一句话定位

本地操作 ＋ 登录态闭网访问 ＋ 个人记忆 —— 不是又一个面向开发者的 CLI agent。

## 它能替你做什么

- **文件** — 查找、整理、批量改名与移动;改动可预览 diff、可一键回滚。
- **网页调研** — 用内置浏览器搜索、抓取、提炼,把散落的信息整理成结论(非 headless、不走搜索 API)。
- **浏览器(登录态 + 自动化)** — 用助理自己的浏览器身份访问闭网内容(Gmail / 内部系统 / 付费订阅),并能在页面上**点击、填表、翻页**;登录态本地持久留存。
- **文档** — 读取与处理本地文档(含 PDF / 纯文本),抽取要点为你所用。

## 为什么敢用

- **建议-审批 + 分级权限** — 动作按风险分级,敏感操作先征得同意;权限可设常驻规则,不被反复打扰。
- **可逆撤销** — 破坏性操作有追加式 journal,文件改动可预览、可回滚,删除走软删除回收区。
- **个人记忆** — 记住你的偏好与关键事实,且**可见可编辑**——是助理,不是黑箱。
- **本地运行 / 零后端 / BYO Key** — 数据与操作留在本机,自带模型 Key 客户端直连,不经第三方服务器。

## 技术栈速览

- **Electron**(UI 三平台,操作层先 Mac)+ **Node** 工具层
- **pi**(`earendil-works/pi`)做 agent 内核:loop / 上下文压缩 / 会话 / hooks
- **模型**:专注 **DeepSeek**(BYO Key + 客户端直连,零后端);模型调用走网关抽象,将来可切服务器中转 / 订阅制而不返工
- **内置浏览器**:驱动 Electron 自带 Chromium,自动化经 `webContents.debugger`(进程内 CDP,不开远程调试端口、不接管用户 Chrome);操作时页面上有虚拟光标可见地点按
- 安全:建议-审批 + 分级权限,文件操作可预览 / 可回滚

## 开发

```bash
pnpm install        # 安装(首次会下载 Electron 二进制)
pnpm dev            # 起 Electron 窗口(electron-vite,HMR)
pnpm -r typecheck   # 全包类型检查
pnpm --filter @pa/desktop build   # 构建 desktop
```

要求 Node >= 22、pnpm 10。

可选环境变量(`apps/desktop/.env`,见 `.env.example`):

- `MAIN_VITE_PROVIDER` / `MAIN_VITE_MODEL` / `MAIN_VITE_API_KEY` — dev 兜底的模型与 Key
- `MAIN_VITE_VISION=1` — 强制把模型标注为支持图片输入(默认关;仅当所用模型的 API 真收图时再开)

## 目录

- `apps/desktop` — Electron(main + preload + renderer/React)
- `apps/site` — Akari 官网(下载落地页)
- `packages/domain-core` — 共享领域类型与事件
- `packages/ctx-*` — 限界上下文(task / trust / reversibility / memory)
- `packages/cap-*` — 能力(filesystem / document / webresearch / browser)
- `packages/infra` — 模型网关 / 持久化 / Keychain

## 文档

- 设计讨论纪要与决策树:[`research/design-discussion.md`](research/design-discussion.md)
- Prompt cache 与压缩(pi 实测行为 + 工程取舍):[`research/prompt-cache-and-compaction.md`](research/prompt-cache-and-compaction.md)
