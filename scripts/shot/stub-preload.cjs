// 截图用:在渲染层注入一个返回模拟数据的 window.pa,使 UI 渲染出真实样态。
const P = (v) => Promise.resolve(v);
const sub = () => () => {};
const theme = process.env.SHOT_THEME || "dark";

const sessions = [
  { id: "s1", title: "整理下载文件夹里的发票，按月份归类" },
  { id: "s2", title: "调研三家 SaaS 的定价页并做对比" },
  { id: "s3", title: "把这篇 PDF 的要点提炼成提纲" }
];

const timeline = [
  { kind: "msg", id: "m1", role: "user", content: "帮我把下载文件夹里的发票整理一下，按月份归类。" },
  {
    kind: "step",
    stepId: "st1",
    index: 1,
    actions: [
      { id: "a1", stepId: "st1", tool: "list_dir", capability: "fs", status: "done", summary: "~/Downloads" },
      { id: "a2", stepId: "st1", tool: "read_file", capability: "fs", status: "done", summary: "invoice_8842.pdf" }
    ]
  },
  {
    kind: "msg",
    id: "m2",
    role: "assistant",
    content:
      "找到 **6 个 PDF 发票**。我打算按「年-月」归类到 `发票/2026-05/`，并重命名为「日期_金额」。\n\n这是可逆操作，执行后你随时可以一键撤销。要我继续吗？"
  }
];

window.pa = {
  ping: () => P("pong"),
  appVersion: () => P("0.0.2"),
  settings: { open: () => P(), getTheme: () => P(theme), setTheme: () => P(theme) },
  workspace: {
    list: () => P([{ id: "w1", name: "我的工作区" }, { id: "w2", name: "研究" }]),
    active: () => P("w1"),
    create: () => P({ id: "w9", name: "新工作区" }),
    rename: () => P([]),
    delete: () => P({ workspaces: [], activeWorkspaceId: "w1" }),
    switch: () => P([])
  },
  session: {
    list: () => P(sessions),
    create: () => P({ id: "sN", title: "新会话" }),
    open: () => P(timeline),
    archive: () => P(),
    listArchived: () => P([]),
    unarchive: () => P(),
    onChanged: sub
  },
  secret: {
    apiKeyStatus: () => P({ provider: "deepseek", set: true, last4: "7f3a" }),
    setApiKey: () => P({ provider: "deepseek", set: true, last4: "7f3a" }),
    clearApiKey: () => P({ provider: "deepseek", set: false })
  },
  chat: { send: () => {}, stop: () => {}, model: () => P("deepseek-chat"), onStream: sub },
  domain: { onEvent: sub },
  step: { onResult: sub },
  browser: { onShow: sub },
  approval: { onRequest: sub, resolve: () => {} },
  batch: { onRequest: sub, resolve: () => {} },
  reversibility: { list: () => P([]), undoLast: () => P(null), onChanged: sub },
  memory: { list: () => P([]), listForgotten: () => P([]), remove: () => {}, restore: () => {}, onChanged: sub }
};
