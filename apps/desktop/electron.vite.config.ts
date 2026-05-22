import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

// workspace 包(@pa/*)是 TS 源码入口,必须打进 bundle 由 Vite 转译,否则 main 进程
// 运行时直接 import .ts 会 ERR_UNKNOWN_FILE_EXTENSION。externalizeDepsPlugin 的 exclude
// 只支持精确字符串匹配(运行时是 exclude.includes(dep)),不支持正则——所以从
// package.json 自动派生全部 @pa/* 依赖,新增包无需再手维护此列表。
const pkg = JSON.parse(readFileSync(resolve(__dirname, "package.json"), "utf8")) as {
  dependencies?: Record<string, string>;
};
const paPackages = Object.keys(pkg.dependencies ?? {}).filter((d) => d.startsWith("@pa/"));

export default defineConfig({
  main: {
    // pi 等真实 node 依赖保持外部化;@pa/* 全部 bundle(见上)。
    plugins: [externalizeDepsPlugin({ exclude: paPackages })],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") }
      }
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") }
      }
    }
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, "src/renderer/index.html"),
          settings: resolve(__dirname, "src/renderer/settings.html")
        }
      }
    },
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src")
      }
    },
    plugins: [react()]
  }
});
