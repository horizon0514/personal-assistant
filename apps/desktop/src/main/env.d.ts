/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly MAIN_VITE_PROVIDER?: string;
  readonly MAIN_VITE_MODEL?: string;
  readonly MAIN_VITE_API_KEY?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
