# @pa/cap-browser

BrowserSession Capability —— 内置浏览器调研 + 网页自动化(支撑域)

驱动 Electron 自带 Chromium(可见、非 headless、`persist:research` 持久登录态),不接管用户 Chrome、不用搜索 API。本包保持 **electron-free**:只定义 `BrowserController` 接口与工具 schema,Electron 驱动实现在 `apps/desktop/src/main/browser-manager.ts`,由组合根注入。

工具:

- `web_search` / `web_fetch` —— 只读调研(搜索 SERP、抓单页正文)。
- `read_current_page` —— 读当前正显示的页面(不导航;用户手动翻页/问「我在看什么」时用)。
- `browser_click` / `browser_type` —— 网页操作(click/type 带可选 `waitFor`:操作后等某元素出现)。
- `browser_screenshot` —— 截图(默认隐藏,仅模型支持看图时启用)。

自动化驱动用 Electron `webContents.debugger`(进程内 CDP),**不用 Playwright / `--remote-debugging-port`**——避免暴露本机调试端口,详见 [`research/design-discussion.md`](../../research/design-discussion.md)「内置浏览器调研」节。
