import type { IpcApi } from './shared/types';

declare global {
  interface Window {
    api: IpcApi;
  }
}

/** Typed bridge to the main process (see electron/preload.ts). */
export const api = window.api;
