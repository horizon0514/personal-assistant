import { resolve } from "node:path";
import { defineConfig, externalizeDepsPlugin } from "electron-vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  main: {
    // workspace 包(@pa/*)是 TS 源码入口,需打进 bundle 由 Vite 转译;
    // pi 等真实 node 依赖保持外部化。
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          "@pa/infra",
          "@pa/domain-core",
          "@pa/ctx-task",
          "@pa/ctx-trust",
          "@pa/ctx-reversibility",
          "@pa/ctx-memory",
          "@pa/cap-filesystem"
        ]
      })
    ],
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
        input: { index: resolve(__dirname, "src/renderer/index.html") }
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
