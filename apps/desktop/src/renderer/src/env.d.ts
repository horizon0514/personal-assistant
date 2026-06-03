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
        /** 启用内置 PDF 阅读器(Chromium PDF viewer 是内部插件,渲染 file:// PDF 需开)。 */
        plugins?: boolean;
        ref?: Ref<ElectronWebview>;
      };
    }
  }
}

export {};
