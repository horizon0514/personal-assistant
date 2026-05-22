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

  async fetch(url: string, signal?: AbortSignal): Promise<FetchedPage> {
    const wc = await this.navigate(url, signal);
    await new Promise((r) => setTimeout(r, 400)); // 给 SPA 一点渲染时间
    const page = (await wc.executeJavaScript(
      `(() => {
        const pick = document.querySelector('article') || document.querySelector('main') || document.body;
        const clone = pick.cloneNode(true);
        clone.querySelectorAll('script,style,noscript,nav,header,footer,aside,svg').forEach((n) => n.remove());
        const text = (clone.innerText || '').replace(/\\n{3,}/g, '\\n\\n').trim();
        return { title: document.title || '', url: location.href, text };
      })()`,
      true
    )) as FetchedPage;
    return page;
  }
}
