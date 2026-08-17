import type { ClientMessageBySurface, HostMessageBySurface, SurfaceName } from "../protocol";

declare global {
  interface SpecwrightClient {
    post<S extends SurfaceName>(surface: S, message: ClientMessageBySurface[S]): void;
    postShell(message: ClientMessageBySurface["shell"]): void;
    register<S extends SurfaceName>(surface: S, handler: (message: HostMessageBySurface[S]) => void): void;
    registerShell(handler: (message: HostMessageBySurface["shell"]) => void): void;
    state(): Record<string, unknown>;
    saveState(patch: Record<string, unknown>): void;
  }

  interface Window {
    __spec: SpecwrightClient;
  }

  function acquireVsCodeApi(): {
    postMessage(message: unknown): void;
    getState(): Record<string, unknown> | undefined;
    setState(state: Record<string, unknown>): void;
  };
}

export {};
