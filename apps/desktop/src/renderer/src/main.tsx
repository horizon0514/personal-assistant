import React from "react";
import ReactDOM from "react-dom/client";
import { App } from "./App";
import "./fonts";
import "./index.css";

// 平台标记:供 CSS 按平台取舍(如 Mac 用系统 overlay 滚动条)。从 UA 判断,免一次 IPC。
document.documentElement.dataset.platform = /Mac/i.test(navigator.userAgent)
  ? "mac"
  : /Win/i.test(navigator.userAgent)
    ? "win"
    : "other";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
