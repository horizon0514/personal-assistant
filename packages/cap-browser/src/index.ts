/**
 * @pa/cap-browser — BrowserSession Capability(支撑域)
 *
 * 网页调研工具:web_search(抓搜索引擎结果)+ web_fetch(抓单页正文)。
 * 本包**不依赖 Electron**——只定义工具 schema 与编排,把实际的浏览器驱动
 * 抽象成 BrowserController 接口,由组合根(apps/desktop/main)注入 Electron 实现。
 *
 * 架构决策见 research/design-discussion.md「内置浏览器调研」节:
 * 驱动 Electron 自带 Chromium(可见、非 headless、persist 登录态),不接管用户 Chrome、不用搜索 API。
 */
import { Type } from "@earendil-works/pi-ai";
import type { AgentTool, AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Capability, RiskLevel } from "@pa/domain-core";

const CAPABILITY: Capability = "browser";

/** 一条搜索结果。 */
export interface SearchHit {
  title: string;
  url: string;
  snippet?: string;
}

/** 抓取到的页面正文。 */
export interface FetchedPage {
  title: string;
  url: string; // 实际落地 URL(可能经重定向)
  text: string;
}

/**
 * 浏览器驱动抽象。Electron 实现见 apps/desktop/src/main/browser-manager.ts。
 * 实现需保证:实例保活跨多次调用、可见、使用持久 partition(登录态留存)。
 */
export interface BrowserController {
  /** 搜索:导航到搜索引擎并抓取结果列表。signal 用于中断(停止运行)。 */
  search(query: string, limit: number, signal?: AbortSignal): Promise<SearchHit[]>;
  /** 抓取:打开 URL 并提取可读正文。signal 用于中断(停止运行)。 */
  fetch(url: string, signal?: AbortSignal): Promise<FetchedPage>;
}

function textResult<T>(text: string, details: T): AgentToolResult<T> {
  return { content: [{ type: "text", text }], details };
}

const MAX_FETCH_CHARS = 200_000;

const searchParams = Type.Object({
  query: Type.String({ description: "搜索关键词" }),
  limit: Type.Optional(Type.Number({ description: "返回结果条数上限(默认 8)" }))
});

const fetchParams = Type.Object({
  url: Type.String({ description: "要抓取的网页绝对 URL(http/https)" })
});

/**
 * 创建浏览器工具。controller 由组合根注入(Electron 驱动)。
 */
export function createBrowserTools(controller: BrowserController): AgentTool<any>[] {
  const webSearch: AgentTool<typeof searchParams> = {
    name: "web_search",
    label: "网页搜索",
    description:
      "用内置浏览器搜索网络,返回结果列表(标题/URL/摘要)。拿到结果后用 web_fetch 打开具体页面读正文。",
    parameters: searchParams,
    execute: async (_id, { query, limit }, signal) => {
      const hits = await controller.search(query, limit ?? 8, signal);
      const text = hits.length
        ? hits.map((h, i) => `${i + 1}. ${h.title}\n   ${h.url}${h.snippet ? `\n   ${h.snippet}` : ""}`).join("\n")
        : `没有搜到「${query}」的结果。`;
      return textResult(text, { query, count: hits.length, hits });
    }
  };

  const webFetch: AgentTool<typeof fetchParams> = {
    name: "web_fetch",
    label: "抓取网页",
    description:
      "用内置浏览器打开一个网页并提取可读正文。需登录的页面会在可见浏览器里提示登录,登录态本地持久留存。",
    parameters: fetchParams,
    execute: async (_id, { url }, signal) => {
      const page = await controller.fetch(url, signal);
      const truncated = page.text.length > MAX_FETCH_CHARS;
      const body = truncated ? `${page.text.slice(0, MAX_FETCH_CHARS)}\n\n…(已截断)` : page.text;
      const text = `# ${page.title}\n${page.url}\n\n${body}`;
      return textResult(text, { url: page.url, title: page.title, chars: page.text.length, truncated });
    }
  };

  return [webSearch, webFetch];
}

export const browserToolNames: ReadonlySet<string> = new Set(["web_search", "web_fetch"]);

/** 调研为只读联网,自动放行(不审批)。 */
export const browserToolRisk: Readonly<Record<string, RiskLevel>> = {
  web_search: "ReadOnly",
  web_fetch: "ReadOnly"
};

export const browserGuidelines = `## 网页调研(用内置浏览器)
- 先 web_search 铺开找候选,再 web_fetch 打开具体页面读正文——不要只看搜索摘要就下结论。
- 把语义意图拆成多个查询(同义词、中英文、限定词),必要时多搜几次、换关键词迭代。
- web_fetch 若返回登录/验证页,告诉用户在弹出的浏览器里登录一次,登录态会本地留存,之后可重试。
- 调研是只读的,放心多查;基于"实际读到的页面内容"作答,并给出来源 URL。`;

export { CAPABILITY as browserCapability };
