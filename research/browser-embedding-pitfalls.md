# 内置浏览器嵌入:踩坑实录与最终方案

> 更新:2026-05-22 · 配套:[`design-discussion.md`](design-discussion.md)「内置浏览器调研」节 · 记忆 `browser-architecture`
>
> 浏览器/网页调研是本产品的核心能力之一(联网调研、登录态闭网)。这块在 macOS + Electron 上踩了一长串坑,本文按时间顺序记录每个坑的**症状 / 根因 / 结论**,避免重走。**改这块前务必读完。**

## 0. 最终方案(先看这个)

- **驱动 Electron 自带 Chromium,不接管用户 Chrome、不 headless、不用搜索 API。**(决策见 design-discussion)
- **嵌入形态:渲染层的 `<webview>` DOM 元素**,不是 `WebContentsView` 覆盖层、不是独立弹窗。
- 关键接线:
  - 主窗口 `webPreferences.webviewTag: true`(`apps/desktop/src/main/index.ts`)。
  - `ArtifactPanel` 里 `<webview partition="persist:research" src="about:blank">`(`features/artifact/ArtifactPanel.tsx`);`<webview>` 的 JSX 类型在 `renderer/src/env.d.ts` 声明。
  - 主进程 `browser-manager.ts` 通过 `app.on("web-contents-created")`(`getType()==="webview"`)拿到 webview 的 `webContents`,用 `loadURL` + `executeJavaScript` 驱动导航与抓取。
  - 抓取前主进程发 `browser:show` → 渲染层打开「浏览器」artifact(挂载 webview);头部 URL/加载态由渲染层直接监听 webview 的 DOM 事件(`did-start-loading`/`did-stop-loading`/`did-navigate`)。
  - 工具:`cap-browser` 的 `web_search`/`web_fetch`(高层语义,决策 4);搜索抓 Bing SERP(`#b_results > li.b_algo`)。

**一句话教训:Electron 里要把网页嵌进自己的 UI 面板,首选 `<webview>`(DOM 元素,显示天然可靠);`WebContentsView` 覆盖层在 macOS + BrowserWindow 上有 z-order 死结,别碰。**

---

## 1. 坑:electron-vite 的 HMR 不重载主进程(贯穿全程的元坑)

- **症状**:改了 `apps/desktop/src/main/**` 的代码,运行中的 app 行为不变;甚至删掉的 `console.log` 还在打印。一度以为"改了没用 / 功能没生效"。
- **根因**:electron-vite dev 的 HMR 只热更**渲染层**;**主进程改动不会自动重启 Electron**。
- **结论**:**凡是改了 `main/` 下的东西,必须重启 `pnpm dev`。** 排查"我的主进程改动为什么没效果"时,第一反应就是它。

## 2. 坑:WebContentsView 首帧不绘制

- **症状**:`WebContentsView` 已 `addChildView`、bounds 正确、`setVisible(true)`、页面也 `did-finish-load`,面板里却空白。
- **根因**:WebContentsView 若加载完成时 bounds **没变动过**,偶发不触发首帧合成绘制。
- **当时的处置**:`did-finish-load` 后 `setBounds(同值)` ——侥幸有效一次(因为那次 bounds 恰好刚从 0 变成真实值)。

## 3. 坑:`waitForBounds` 反而弄坏绘制

- **症状**:为消除竞态,加了"导航前先等渲染层报来真实矩形再 loadURL",结果**更稳定地黑屏**。
- **根因**:之前能绘制,靠的正是"bounds 从 0→真实值"这个**变化**触发了重绘(发生在加载过程中)。先等到真实 bounds 再加载,反而消除了这个变化,加载完成后 bounds 再没变过 → 不绘制。`setBounds(同值)` 是空操作、不触发重绘。
- **教训**:别用"等 bounds 就绪"来消竞态;要触发绘制得制造**真实的 bounds 变化**(如高度 ±1 再复位)。但这只是治标(见下)。

## 4. 坑(根因):z-order —— BrowserWindow 的页面恒盖在 contentView 子视图之上

- **症状**:无论怎么重绘/抖动 bounds,面板里始终是占位区的底色(深色),看不到网页。
- **诊断**:打印 `win.contentView.children` → **`children = 1, ourIndex = 0`**。即 React 应用的页面**根本不在 contentView 里**(它是 BrowserWindow 自身渲染的),`contentView` 里只有我们加的浏览器视图这一个子视图,**且它被主页面合成盖在下面**。
- **根因**:`BrowserWindow` 的网页(自身 webContents)恒定渲染在 `contentView` 所有子视图**之上**。所以往 `contentView.addChildView` 加多少视图,都在主页面下面 —— **WebContentsView 覆盖层方案在 BrowserWindow 上是死结**。
- (历史背景:旧 `addBrowserView` 据说渲染在上层;新 `contentView` 模型下 BrowserWindow 的行为不同,实测如上。)

## 5. 坑:改 BaseWindow 能解 z-order,但代价巨大且引入崩溃

- **思路**:主窗口改 `BaseWindow`,React 应用挂成一个 `WebContentsView`(appView),浏览器再挂一个、后 `addChildView` → 真正叠在上面。z-order 确实解了。
- **代价/塌方**:
  - `BaseWindow` **不在 `BrowserWindow.getAllWindows()` 里**,也**没有 `.webContents`** → `broadcast`(chat 流、领域事件)、主题同步、`activate`、IPC send 全部要改用 appView 的 webContents,牵一发动全身。
  - 实测应用启动后**异常退出**(`pnpm dev` exit 0,窗口起来约十几秒后没了),原因未深究——因为方案本身已判定不值得。
- **结论**:**放弃 BaseWindow + WebContentsView 这条路。** 解 z-order 的收益配不上它的复杂度和不稳定。

## 6. 最终:切到 `<webview>`,一举绕开 1–5 的全部问题

- `<webview>` 是**渲染层 DOM 里的元素**,天然待在 ArtifactPanel 的布局位置:
  - **无 z-order 问题**(DOM 堆叠天然正确);
  - **无绘制时序问题**(浏览器引擎正常渲染 DOM);
  - **无 bounds 同步**(跟随 DOM 布局,侧栏拖宽/窗口缩放自动跟手)。
- 主窗口回到稳定的 `BrowserWindow`(仅加 `webviewTag: true`),`broadcast` 等全部维持原样。
- 主进程仍能完全控制它:经 `web-contents-created` 拿到 webview 的 `webContents`,`loadURL` / `executeJavaScript` 照旧。
- **代价**:`webviewTag` 已被 Electron 标记 deprecated。当前(Electron 33)可用、最省心;若未来移除,届时再评估官方替代(可能又回到 WebContentsView + BaseWindow,但那时生态/API 应更成熟)。

---

## 7. 其它相关的坑(同期)

- **`ERR_UNKNOWN_FILE_EXTENSION: ".ts"`**:新增的 `@pa/*` workspace 包被 electron-vite 当外部依赖、运行时直接 import 原始 `.ts`。根因:`electron.vite.config.ts` 的 `externalizeDepsPlugin({ exclude })` 漏了它。**已根治**:exclude 改为从 `package.json` 自动派生全部 `@pa/*`(该插件的 exclude **只支持精确字符串、不支持正则**——`exclude.includes(dep)`)。新增 @pa 包无需再手维护。
- **停止(abort)要能打断浏览器**:`web_fetch` 有 30s 超时,若不响应中断,点"停止"要干等。已把 pi 传给工具 `execute` 的 `signal` 一路串到 `browser-manager.navigate`:中断时 `webContents.stop()` 并立即结束。pi 的 `abort()` 不会让 `prompt()` 抛错(走 aborted 收尾、正常 resolve),所以停止后 transcript 正常落盘、无丑陋报错。
- **窗口卡隐藏态**:`BaseWindow` 那版用 `appView.webContents.once("did-finish-load", win.show())`,若该事件没触发窗口就一直隐藏。回到 BrowserWindow 后用回 `ready-to-show`。

## 8. 给后来者的硬规则

1. 改 `main/` 必重启 `pnpm dev`。
2. 面板内嵌网页 → 用 `<webview>`,别用 WebContentsView 覆盖层。
3. 新增被 main 用到的 `@pa/*` 包 → 确认它在 `apps/desktop/package.json` 依赖里即可(vite exclude 自动派生)。
4. 浏览器工具保持高层语义(`web_search`/`web_fetch`),别暴露底层 CDP(决策 4)。
5. 搜索抓 SERP 是脆的:选择器随引擎改版会失效,起步用 Bing/DuckDuckGo,避开 Google。
