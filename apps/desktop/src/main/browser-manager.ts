/**
 * 内置浏览器驱动(BrowserController 的 Electron 实现)。
 *
 * 形态:渲染层 ArtifactPanel 里挂一个 <webview>(DOM 元素,天然待在面板区域,无 z-order /
 * 绘制时序 / bounds 同步问题)。主进程通过 web-contents-created 拿到该 webview 的 webContents,
 * 用它 loadURL + executeJavaScript 来驱动导航与抓取。
 *
 * 架构见 research/design-discussion.md「内置浏览器调研」:驱动 Electron 自带 Chromium,
 * 可见、非 headless、持久 partition(登录态留存),不接管用户 Chrome、不用搜索 API。
 */
import { app, type WebContents } from "electron";
import type { BrowserController, FetchedPage, SearchHit } from "@pa/cap-browser";
import { getMainWebContents } from "./main-window";

const LOAD_TIMEOUT_MS = 30_000;
/** 搜索引擎:Bing 对真实浏览器抓取稳定、反爬温和。 */
const SEARCH_URL = (q: string): string => `https://www.bing.com/search?q=${encodeURIComponent(q)}`;

export class BrowserManager implements BrowserController {
  private webview: WebContents | undefined;
  private waiters: ((wc: WebContents) => void)[] = [];

  constructor() {
    // 渲染层挂载 <webview> 时,这里拿到它的 webContents
    app.on("web-contents-created", (_e, contents) => {
      if (contents.getType() !== "webview") return;
      this.webview = contents;
      this.waiters.splice(0).forEach((w) => w(contents));
      contents.on("destroyed", () => {
        if (this.webview === contents) this.webview = undefined;
      });
    });
  }

  /** 让面板挂载/显示 <webview> 并拿到其 webContents(已就绪则立即返回)。 */
  private async ensureWebview(): Promise<WebContents> {
    getMainWebContents()?.send("browser:show"); // 通知渲染层打开「浏览器」artifact(挂载 webview)
    if (this.webview && !this.webview.isDestroyed()) return this.webview;
    return new Promise<WebContents>((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("内置浏览器未就绪(webview 未挂载)")), 5000);
      this.waiters.push((wc) => {
        clearTimeout(t);
        resolve(wc);
      });
    });
  }

  /** 导航并等待加载完成(带超时 + 中断)。 */
  private async navigate(url: string, signal?: AbortSignal): Promise<WebContents> {
    const wc = await this.ensureWebview();
    if (signal?.aborted) throw new Error("已取消");
    const load = wc.loadURL(url).catch((err: { code?: string }) => {
      if (err?.code && err.code !== "ERR_ABORTED") throw err;
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`加载超时(${LOAD_TIMEOUT_MS}ms):${url}`)), LOAD_TIMEOUT_MS);
    });
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      if (!signal) return;
      onAbort = (): void => {
        wc.stop();
        reject(new Error("已取消"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([load, timeout, aborted]);
    } finally {
      if (timer) clearTimeout(timer);
      if (signal && onAbort) signal.removeEventListener("abort", onAbort);
    }
    return wc;
  }

  async search(query: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]> {
    const wc = await this.navigate(SEARCH_URL(query), signal);
    const hits = (await wc.executeJavaScript(
      `(() => {
        const out = [];
        for (const li of document.querySelectorAll('#b_results > li.b_algo')) {
          const a = li.querySelector('h2 a');
          if (!a || !a.href) continue;
          const snippetEl = li.querySelector('.b_caption p, .b_algoSlug');
          out.push({
            title: (a.textContent || '').trim(),
            url: a.href,
            snippet: snippetEl ? (snippetEl.textContent || '').trim() : undefined
          });
          if (out.length >= ${Math.max(1, Math.min(limit, 25))}) break;
        }
        return out;
      })()`,
      true
    )) as SearchHit[];
    return hits;
  }

  // ── 网页操作(自动化)─────────────────────────────────────
  // 复用同一个可见 webview。读类查询走 executeJavaScript;真实输入事件(可信、过 isTrusted
  // 校验)与截图走 webContents.debugger(进程内 CDP,不开 --remote-debugging-port)。

  /** 附着调试器(幂等)。DevTools 已打开时会占用,提示用户关闭。 */
  private ensureDebugger(wc: WebContents): void {
    if (wc.debugger.isAttached()) return;
    try {
      wc.debugger.attach("1.3");
    } catch {
      throw new Error("无法附着浏览器调试器(可能 DevTools 已打开),请关闭后重试");
    }
  }

  /** 当前已挂载的 webview(供操作类工具用;未就绪则报错,不自动导航)。 */
  private async currentWebview(signal?: AbortSignal): Promise<WebContents> {
    if (signal?.aborted) throw new Error("已取消");
    const wc = await this.ensureWebview();
    return wc;
  }

  /**
   * 操作(点击/回车)后等页面落定再返回——否则整页跳转还没开始就 getURL() 拿到旧 URL,
   * 上层会误以为"没生效"。逻辑:短窗口内若触发了主框架导航,就等它 did-stop-loading;
   * 没触发(SPA 内更新或无跳转)则早返回。
   */
  private waitForSettle(wc: WebContents, maxMs: number): Promise<void> {
    return new Promise((resolve) => {
      let navigated = false;
      const onStart = (
        _e: unknown,
        _url: string,
        _isInPlace: boolean,
        isMainFrame: boolean
      ): void => {
        if (isMainFrame) navigated = true;
      };
      const onStop = (): void => {
        if (navigated) finish();
      };
      const finish = (): void => {
        clearTimeout(hard);
        clearTimeout(soft);
        wc.off("did-start-navigation", onStart);
        wc.off("did-stop-loading", onStop);
        resolve();
      };
      wc.on("did-start-navigation", onStart);
      wc.on("did-stop-loading", onStop);
      const soft = setTimeout(() => !navigated && finish(), 450); // 没触发导航,早返回
      const hard = setTimeout(finish, maxMs); // 导航卡住的兜底上限
    });
  }

  /**
   * 在页面里注入/移动一个虚拟光标浮层(真实光标不动,这里给用户一个可见的"它在点哪")。
   * 浮层挂在 documentElement 下、pointer-events:none、不进 body(不污染正文抓取);
   * 导航后随新文档消失,每次操作前重新注入。click=true 时在落点放一圈涟漪。
   * 返回前等动画走完,让随后真正的 CDP 事件与光标到位对齐。
   */
  private async showCursor(wc: WebContents, x: number, y: number, click: boolean): Promise<void> {
    await wc.executeJavaScript(
      `(() => {
        const ID = '__pa_cursor';
        let c = document.getElementById(ID);
        if (!c) {
          c = document.createElement('div');
          c.id = ID;
          c.style.cssText = 'position:fixed;left:0;top:0;width:22px;height:22px;z-index:2147483647;pointer-events:none;transition:transform .35s cubic-bezier(.22,.61,.36,1);transform:translate(-120px,-120px);will-change:transform';
          c.innerHTML = '<svg width="22" height="22" viewBox="0 0 22 22" style="filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))"><path d="M3 3 L3 17 L7.4 13 L10.4 19.4 L13 18.2 L10 12 L16 12 Z" fill="#fff" stroke="#111" stroke-width="1.3" stroke-linejoin="round"/></svg>';
          const ring = document.createElement('div');
          ring.id = ID + '_ring';
          ring.style.cssText = 'position:fixed;left:0;top:0;width:34px;height:34px;margin:-17px 0 0 -17px;border-radius:50%;border:2px solid rgba(59,130,246,.9);background:rgba(59,130,246,.18);z-index:2147483646;pointer-events:none;opacity:0;transform:translate(-120px,-120px) scale(.3);transition:transform .3s ease,opacity .3s ease';
          document.documentElement.appendChild(c);
          document.documentElement.appendChild(ring);
        }
        c.style.transform = 'translate(' + ${x} + 'px,' + ${y} + 'px)';
        if (${click ? "true" : "false"}) {
          const ring = document.getElementById(ID + '_ring');
          if (ring) setTimeout(() => {
            ring.style.transition = 'none';
            ring.style.transform = 'translate(' + ${x} + 'px,' + ${y} + 'px) scale(.3)';
            ring.style.opacity = '1';
            requestAnimationFrame(() => {
              ring.style.transition = 'transform .4s ease,opacity .5s ease';
              ring.style.transform = 'translate(' + ${x} + 'px,' + ${y} + 'px) scale(1.5)';
              ring.style.opacity = '0';
            });
          }, 340);
        }
      })()`,
      true
    );
    await new Promise((r) => setTimeout(r, click ? 420 : 360)); // 等光标滑到位再触发真实事件
  }

  /**
   * 定位元素并判断它能否「按坐标点」:返回视口内中心坐标 + clickable 标志。
   * clickable=false 的常见原因:零尺寸(如百度 #su,尺寸全靠尚未生效的 CSS sprite)、
   * 在视口外、或被其它元素遮挡(elementFromPoint 命中的不是它)。这些情形下按坐标点
   * 会静默打偏(甚至点到 (0,0) 的别的元素)却谎报成功——上层应改走 JS 兜底。
   */
  private async locate(
    wc: WebContents,
    selector: string
  ): Promise<{ found: false } | { found: true; x: number; y: number; clickable: boolean }> {
    return (await wc.executeJavaScript(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return { found: false };
        el.scrollIntoView({ block: 'center', inline: 'center' });
        const r = el.getBoundingClientRect();
        const x = r.left + r.width / 2, y = r.top + r.height / 2;
        const sizeOk = r.width > 0 && r.height > 0;
        const inView = x >= 0 && y >= 0 && x <= window.innerWidth && y <= window.innerHeight;
        let hit = false;
        if (sizeOk && inView) {
          const top = document.elementFromPoint(x, y);
          hit = !!top && (top === el || el.contains(top) || top.contains(el));
        }
        return { found: true, x, y, clickable: sizeOk && inView && hit };
      })()`,
      true
    )) as { found: false } | { found: true; x: number; y: number; clickable: boolean };
  }

  /** JS 兜底点击(isTrusted=false,但对表单提交/普通按钮可靠):坐标点不可用时用。 */
  private async jsClick(wc: WebContents, selector: string): Promise<void> {
    await wc.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el) { el.focus(); el.click(); } })()`,
      true
    );
  }

  async click(selector: string, signal?: AbortSignal): Promise<{ url: string }> {
    const wc = await this.currentWebview(signal);
    const loc = await this.locate(wc, selector);
    if (!loc.found) throw new Error(`找不到元素:${selector}`);
    if (signal?.aborted) throw new Error("已取消");
    this.ensureDebugger(wc);
    if (loc.clickable) {
      await this.showCursor(wc, loc.x, loc.y, true); // 虚拟光标滑到落点 + 涟漪
      const base = { x: loc.x, y: loc.y, button: "left", clickCount: 1 };
      await wc.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", ...base });
      await wc.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", ...base });
    } else {
      // 零尺寸/视口外/被遮挡:按坐标点会打偏,退到 JS click(对表单提交可靠)。
      await this.jsClick(wc, selector);
    }
    await this.waitForSettle(wc, 8000); // 等可能的整页跳转落定,再返回真实 URL
    return { url: wc.getURL() };
  }

  async type(
    selector: string,
    text: string,
    opts: { clear?: boolean; submit?: boolean },
    signal?: AbortSignal
  ): Promise<{ url: string }> {
    const wc = await this.currentWebview(signal);
    // 1. 定位 + 滚动到可见,拿可点中心坐标(后面用真实鼠标点击来「真聚焦」)。
    const loc = await this.locate(wc, selector);
    if (!loc.found) throw new Error(`找不到输入框:${selector}`);
    if (signal?.aborted) throw new Error("已取消");
    this.ensureDebugger(wc);
    // 2. 聚焦:坐标可用时用真实鼠标点击聚焦(insertText 要求真焦点,JS focus() 在部分站点不生效);
    //    坐标不可用(零尺寸/遮挡/视口外)时退到 JS focus()——否则点击打偏,焦点没拿到,
    //    后面的 insertText 和回车提交都会落空(见 #su/#kw 零尺寸导致点击与回车双失效的真因)。
    if (loc.clickable) {
      await this.showCursor(wc, loc.x, loc.y, true); // 虚拟光标滑到输入框 + 涟漪
      const click = { x: loc.x, y: loc.y, button: "left", clickCount: 1 };
      await wc.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", ...click });
      await wc.debugger.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", ...click });
    } else {
      await wc.executeJavaScript(
        `(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el && el.focus) el.focus(); })()`,
        true
      );
    }
    // 3. 清空(原生 setter + 派发事件,兼容受控输入)。
    if (opts.clear) await this.setInputValue(wc, selector, "");
    // 4. 可信文本输入。
    await wc.debugger.sendCommand("Input.insertText", { text });
    // 5. 回读校验:CDP 没落地(框未变)就用原生 setter 兜底,保证可见地写进去、不谎报成功。
    const actual = (await wc.executeJavaScript(
      `(() => { const el = document.querySelector(${JSON.stringify(selector)}); return el ? ('value' in el ? el.value : el.textContent) : null; })()`,
      true
    )) as string | null;
    const expected = opts.clear ? text : undefined;
    const landed = expected !== undefined ? actual === expected : (actual ?? "").includes(text);
    if (!landed) await this.setInputValue(wc, selector, expected ?? `${actual ?? ""}${text}`);
    // 6. 提交。
    if (opts.submit) {
      const enter = { key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 };
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", ...enter });
      await wc.debugger.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
      await this.waitForSettle(wc, 8000); // 回车提交多会整页跳转,等落定
    }
    return { url: wc.getURL() };
  }

  /** 用原生 value setter 设值并派发 input/change(兜底路径,兼容 React 等受控输入)。 */
  private async setInputValue(wc: WebContents, selector: string, value: string): Promise<void> {
    await wc.executeJavaScript(
      `(() => {
        const el = document.querySelector(${JSON.stringify(selector)});
        if (!el) return;
        const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set && 'value' in el) {
          setter.set.call(el, ${JSON.stringify(value)});
        } else {
          el.textContent = ${JSON.stringify(value)};
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      })()`,
      true
    );
  }

  async waitFor(selector: string, timeoutMs: number, signal?: AbortSignal): Promise<{ found: boolean }> {
    const wc = await this.currentWebview(signal);
    const deadline = Date.now() + Math.max(0, timeoutMs);
    do {
      if (signal?.aborted) throw new Error("已取消");
      const found = (await wc.executeJavaScript(
        `!!document.querySelector(${JSON.stringify(selector)})`,
        true
      )) as boolean;
      if (found) return { found: true };
      await new Promise((r) => setTimeout(r, 200));
    } while (Date.now() < deadline);
    return { found: false };
  }


  async screenshot(signal?: AbortSignal): Promise<{ data: string; url: string }> {
    const wc = await this.currentWebview(signal);
    this.ensureDebugger(wc);
    const res = (await wc.debugger.sendCommand("Page.captureScreenshot", { format: "png" })) as {
      data: string;
    };
    console.log(`[browser] 截图完成 ${Math.round((res.data.length * 3) / 4 / 1024)}KB @ ${wc.getURL()}`);
    return { data: res.data, url: wc.getURL() };
  }

  /** 提取当前 webview 已加载页面的可读正文(不导航)。fetch 与 current 共用。 */
  private async readReadable(wc: WebContents): Promise<FetchedPage> {
    return (await wc.executeJavaScript(
      `(() => {
        const pick = document.querySelector('article') || document.querySelector('main') || document.body;
        const clone = pick.cloneNode(true);
        clone.querySelectorAll('script,style,noscript,nav,header,footer,aside,svg').forEach((n) => n.remove());
        const text = (clone.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
        return { title: document.title || '', url: location.href, text };
      })()`,
      true
    )) as FetchedPage;
  }

  async fetch(url: string, signal?: AbortSignal): Promise<FetchedPage> {
    const wc = await this.navigate(url, signal);
    await new Promise((r) => setTimeout(r, 400)); // 给 SPA 一点渲染时间
    return this.readReadable(wc);
  }

  /** 读当前 webview 正在显示的页面(用户可能手动导航过来的),不触发导航。 */
  async current(signal?: AbortSignal): Promise<FetchedPage> {
    const wc = await this.currentWebview(signal);
    return this.readReadable(wc);
  }
}
