/// <reference types="vite/client" />
import type { DetailedHTMLProps, HTMLAttributes, Ref } from "react";
import type { PaApi } from "../../preload";

/** Electron <webview> DOM 元素(仅声明本项目用到的方法)。 */
export interface ElectronWebview extends HTMLElement {
  getURL(): string;
  getTitle(): string;
  isLoading(): boolean;
  reload(): void;
  stop(): void;
}

declare global {
  interface Window {
    pa: PaApi;
  }

  namespace JSX {
    interface IntrinsicElements {
      webview: DetailedHTMLProps<HTMLAttributes<HTMLElement>, HTMLElement> & {
        src?: string;
        partition?: string;
        allowpopups?: string;
        ref?: Ref<ElectronWebview>;
      };
    }
  }
}

export {};
