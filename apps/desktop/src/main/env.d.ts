/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MAIN_VITE_PROVIDER?: string;
  readonly MAIN_VITE_MODEL?: string;
  readonly MAIN_VITE_API_KEY?: string;
  /** "0" 关闭 vision 覆盖(默认开):给模型标注支持图片输入,让截图真发给模型。 */
  readonly MAIN_VITE_VISION?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
