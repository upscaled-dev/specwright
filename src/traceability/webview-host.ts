// The Coverage Board is one webview document hosting several routed surfaces. Every surface talks to
// the extension host through a `SurfaceHost` rather than owning its own `WebviewPanel`, so the shell
// (BoardPanel) keeps a single `acquireVsCodeApi()`, one CSP/nonce, and one message channel.
export type SurfaceName = "board" | "publish" | "link";

// The reserved untagged shell messages that ride the same channel as the surface-tagged ones. `ready`
// and `tab` flow webview → host; `activate` and `linkTab` flow host → webview. A surface must never
// tag one of its own messages with these types — the router only dispatches by `surface`, so they stay
// distinguishable only while they carry no `surface`.
export type ShellMessageType = "ready" | "tab" | "activate" | "linkTab";

// The presentation seam each surface controller is built against. `post` stamps the surface tag and
// rides the shell's ready-gated queue; `onMessage` receives that surface's inbound (tagged) messages.
// `activate` brings a surface's tab forward (defaulting to the caller's own surface); `setTabVisible`
// is only meaningful for the contextual Link tab.
export interface SurfaceHost {
  post(message: object): void;
  onMessage(handler: (message: unknown) => void): void;
  reveal(): void;
  activate(surface?: SurfaceName): void;
  onDidDispose(handler: () => void): void;
  isDisposed(): boolean;
  setTabVisible(visible: boolean, title?: string): void;
}

// A surface's contribution to the shared document: its pane-scoped CSS, the static skeleton painted into
// its pane, and the webview script that hydrates it through `window.__spec`.
export interface SurfaceFragment {
  readonly css: string;
  readonly paneHtml: string;
  readonly script: string;
}
