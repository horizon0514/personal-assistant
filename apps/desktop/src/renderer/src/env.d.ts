/// <reference types="vite/client" />
import type { PaApi } from "../../preload";

declare global {
  interface Window {
    pa: PaApi;
  }
}

export {};
