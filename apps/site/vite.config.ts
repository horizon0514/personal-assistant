import { defineConfig } from "vite";

// 纯静态落地页:无框架,Vite 处理 TS + Tailwind(PostCSS)+ 资源指纹。
export default defineConfig({
  build: {
    target: "es2020"
  }
});
