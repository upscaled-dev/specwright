import * as vscode from "vscode";
import { errMsg } from "../utils/text";
import { Logger } from "../utils/logger";
import { contentSecurityPolicy, createNonce } from "../utils/webview";
import { boardFragment } from "./board-fragment";
import { BoardSurface, BoardSurfaceDeps } from "./board-surface";
import { LINK_FRAGMENT, LinkSurface } from "./link-picker-panel";
import { PUBLISH_FRAGMENT, PublishDialogDelegate, PublishSurface } from "./publish-dialog-panel";
import { SurfaceHost, SurfaceName } from "./webview-host";
import {
  parseClientEnvelope,
  WEBVIEW_PROTOCOL_VERSION,
  type ClientMessage,
  type ClientMessageBySurface,
  type HostMessageBySurface,
  type ShellTab,
} from "../webview/protocol";

const VIEW_TYPE = "playwrightBddRunner.coverageBoard";

// One options object for both entry points, since a restored panel's webview is re-configured rather
// than trusted: the board is a blank page with scripts off.
// The settings a board REBUILD reads: the sync scope and the default project decide the project universe
// its scope selector coerces against, and the site scopes the ledger rows the Executions tab lists. The
// publish settings (work type, report globs, attach mode) are deliberately absent: they are read when a
// publish runs, not when the board is built, so a rebuild would show the user nothing new.
const BOARD_SETTINGS = [
  "playwrightBddRunner.xray.syncProjectKeys",
  "playwrightBddRunner.xray.defaultProjectKey",
  "playwrightBddRunner.xray.siteUrl",
];

export function affectsBoard(event: vscode.ConfigurationChangeEvent): boolean {
  return BOARD_SETTINGS.some((setting) => event.affectsConfiguration(setting));
}

export interface BoardPanelDeps extends BoardSurfaceDeps {
  readonly providerLabel: string;
  readonly logger: Logger;
  // The editor tab's icon, one file per theme. Absent in rigs with no extension root to resolve media
  // against, where the tab is not painted anyway.
  readonly tabIcon?: { light: vscode.Uri; dark: vscode.Uri } | undefined;
  readonly webviewAssetRoot: vscode.Uri;
  // The Publish tab's callbacks: the search/browse/attach delegate the surface calls into, and the
  // command the shell fires when the tab is activated with no publish already underway.
  readonly publishDelegate: PublishDialogDelegate;
  startPublish(): void;
}

/**
 * The Coverage Board (View 2), a singleton, document-like webview in the editor area (a second open
 * reveals the existing panel). The board is one of several surfaces routed through a shared document:
 * the shell owns the single WebviewPanel, one `acquireVsCodeApi()`, the tab strip, and a ready-gated
 * outbound queue, then dispatches inbound messages by `surface`. Its document is assembled from the
 * board, publish, and link fragments.
 */
export class BoardPanel {
  private static current: BoardPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly disposeHandlers: Array<() => void> = [];
  private readonly surfaceHandlers = new Map<SurfaceName, (message: ClientMessage) => void>();
  private readonly queue: object[] = [];
  private readonly session = createNonce();
  private revision = 0;
  private ready = false;
  private disposed = false;
  private activeTab: ShellTab = "mapping";
  private readonly logger: Logger;
  public readonly board: BoardSurface;
  public readonly publish: PublishSurface;
  public readonly link: LinkSurface;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    deps: BoardPanelDeps
  ) {
    this.logger = deps.logger;
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message) => this.handleInbound(message))
    );
    this.board = new BoardSurface(this.hostFor("board"), deps);
    this.publish = new PublishSurface(this.hostFor("publish"), deps.publishDelegate, deps.startPublish);
    this.link = new LinkSurface(this.hostFor("link"));
  }

  public static open(deps: BoardPanelDeps): BoardPanel {
    if (BoardPanel.current) {
      // Reveal wherever it already lives; don't yank a board the user parked in another column.
      BoardPanel.current.panel.reveal();
      return BoardPanel.current;
    }
    // Beside, not Active: the board is worked alongside the feature file it links, so taking that
    // editor's column would make the user park the board before they could drag anything into a tag.
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, "Coverage Board", vscode.ViewColumn.Beside, {
      enableScripts: true,
      localResourceRoots: [deps.webviewAssetRoot],
      retainContextWhenHidden: true,
    });
    return BoardPanel.adopt(panel, deps);
  }

  // A board tab a window reload restored comes back as a bare panel with a blank document, and the
  // extension host restarted holding none of its state, so it is wired from scratch like a fresh open.
  // Anything that stops that wiring takes the tab down with it: a panel left behind here is a blank
  // document nothing will ever paint.
  public static registerSerializer(deps: () => BoardPanelDeps): vscode.Disposable {
    return vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, {
      deserializeWebviewPanel: (panel: vscode.WebviewPanel) => {
        try {
          if (BoardPanel.current) {
            // Show the board the user already has rather than let the restored tab just vanish.
            BoardPanel.current.panel.reveal();
            panel.dispose();
          } else {
            BoardPanel.adopt(panel, deps());
          }
        } catch {
          panel.dispose();
        }
        return Promise.resolve();
      },
    });
  }

  private static adopt(panel: vscode.WebviewPanel, deps: BoardPanelDeps): BoardPanel {
    panel.webview.options = { enableScripts: true, localResourceRoots: [deps.webviewAssetRoot] };
    if (deps.tabIcon) {
      panel.iconPath = deps.tabIcon;
    }
    const instance = new BoardPanel(panel, deps);
    BoardPanel.current = instance;
    panel.webview.html = renderDocument(panel.webview, deps.providerLabel, deps.webviewAssetRoot, instance.session);
    instance.activateTab("mapping");
    return instance;
  }

  // The Mapping tab's checked scenario cards and checked test cards, empty when no board is open. The
  // authoring commands read their selection through here, so a palette entry and the board's own
  // buttons see the same one.
  public static selectedScenarios(): readonly string[] {
    return BoardPanel.current?.board.selectedScenarios() ?? [];
  }

  public static selectedTests(): readonly string[] {
    return BoardPanel.current?.board.selectedTests() ?? [];
  }

  // The sync progress strip's line, or "" to clear it. Static like the selection readers: the command
  // layer reports a run's progress without holding a board, and a closed board drops it.
  public static reportSyncProgress(text: string): void {
    BoardPanel.current?.board.syncProgress(text);
  }

  // Whether a board is on screen. Machine-driven refreshes ask before doing the work: a board builds
  // itself when it opens, so rebuilding for one that is not there buys the user nothing.
  public static isOpen(): boolean {
    return BoardPanel.current !== undefined;
  }

  // The Executions tab, where a published run's row lands. The publish flow holds the panel it opened,
  // so this one is an instance method rather than a static like the readers above.
  public showExecutions(): void {
    this.activateTab("executions");
  }

  // Closing the board takes down the surface a publish is driven from (its busy pane, its retry dialog,
  // its banners), so the flow that opened this panel treats the close as its cancellation. The panel
  // outlives any one flow, so the returned subscription is how a finished flow stops holding it.
  public onDidDispose(handler: () => void): vscode.Disposable {
    this.disposeHandlers.push(handler);
    return {
      dispose: () => {
        const at = this.disposeHandlers.indexOf(handler);
        if (at > -1) {this.disposeHandlers.splice(at, 1);}
      },
    };
  }

  private hostFor<S extends SurfaceName>(surface: S): SurfaceHost<S> {
    return {
      post: (message) => this.postRaw(message, surface),
      onMessage: (handler) => {
        this.surfaceHandlers.set(surface, (message) => handler(message as ClientMessageBySurface[S]));
      },
      activate: (target) => this.activateTab(tabFor(target ?? surface)),
      onDidDispose: (handler) => {
        this.disposeHandlers.push(handler);
      },
      isDisposed: () => this.disposed,
      setTabVisible: (visible, title) => this.setLinkTabVisible(visible, title),
    };
  }

  private handleInbound(message: unknown): void {
    if (this.disposed) {
      return;
    }
    const envelope = parseClientEnvelope(message);
    if (envelope?.session !== this.session) {return;}
    const body = envelope.body;
    if (body.type !== "ready" && envelope.revision !== this.revision) {return;}
    if (envelope.surface !== "shell") {
      this.surfaceHandlers.get(envelope.surface)?.(body);
      return;
    }
    if (body.type === "ready" && envelope.revision === 0) {
      this.hydrate();
    } else if (body.type === "tab") {
      this.activateTab(body.tab);
      if (body.tab === "publish") {
        this.publish.onManualActivate();
      }
    }
  }

  private activateTab(tab: ShellTab): void {
    this.activeTab = tab;
    this.postRaw({ type: "activate", tab }, "shell");
  }

  private setLinkTabVisible(visible: boolean, title?: string): void {
    this.postRaw({ type: "linkTab", visible, ...(title !== undefined ? { title } : {}) }, "shell");
    if (!visible && this.activeTab === "link") {
      this.activateTab("mapping");
    }
  }

  // Outbound posts are held until the webview announces `ready`, then flushed in order, so a render or
  // activation queued during document construction can't race the script load.
  private postRaw<S extends keyof HostMessageBySurface>(body: HostMessageBySurface[S], surface: S): void {
    if (this.disposed) {
      return;
    }
    const message = {
      version: WEBVIEW_PROTOCOL_VERSION,
      session: this.session,
      revision: ++this.revision,
      surface,
      body,
    };
    if (!this.ready) {
      this.queue.push(message);
      return;
    }
    Promise.resolve(this.panel.webview.postMessage(message)).catch(() => undefined);
  }

  // `ready` arrives again whenever VS Code rebuilds the webview's DOM (a window reload, a move between
  // editor groups), and that fresh document starts with every pane hidden and no data in it. The first
  // ready only flushes, since the queue it drains already holds that opening activation and render.
  private hydrate(): void {
    const first = !this.ready;
    this.ready = true;
    for (const message of this.queue.splice(0)) {
      Promise.resolve(this.panel.webview.postMessage(message)).catch(() => undefined);
    }
    if (first) {
      return;
    }
    this.activateTab(this.activeTab);
    this.replay("board", () => this.board.rehydrate());
    this.replay("publish", () => this.publish.rehydrate());
    this.replay("link", () => this.link.rehydrate());
  }

  // The replays are independent paints of one blank document, so a section that throws must cost only its
  // own pane: swallowing it here is what keeps a failing rehydrate from leaving the whole board empty.
  private replay(surface: SurfaceName, rehydrate: () => void): void {
    try {
      rehydrate();
    } catch (error) {
      this.logger.warn(`Repainting the ${surface} surface failed`, { error: errMsg(error) });
    }
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (BoardPanel.current === this) {
      BoardPanel.current = undefined;
    }
    for (const handler of this.disposeHandlers) {
      handler();
    }
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    this.panel.dispose();
  }
}

function tabFor(surface: SurfaceName): ShellTab {
  if (surface === "publish") {
    return "publish";
  }
  if (surface === "link") {
    return "link";
  }
  return "mapping";
}

// The document is an app frame, not a page: the body is a flex column of header, sync strip, and main,
// and only the panes inside main scroll. `padding: 0` cancels the padding the webview host injects,
// which is worth about 40px of a half-window board. One `[hidden]` rule serves every surface, and its
// `!important` is what keeps a hidden pane hidden against the `display: flex` the panes now carry.
const SHELL_CSS = `
  html, body { height: 100%; }
  body { margin: 0; padding: 0; display: flex; flex-direction: column; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  [hidden] { display: none !important; }
  header { flex: none; display: flex; align-items: center; gap: 0.6rem; flex-wrap: wrap; padding: 0.5rem 1.1rem; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); }
  header h1 { position: absolute; width: 1px; height: 1px; margin: -1px; padding: 0; overflow: hidden; clip: rect(0 0 0 0); clip-path: inset(50%); white-space: nowrap; border: 0; }
  .tabs { display: inline-flex; border: 1px solid var(--vscode-widget-border, var(--vscode-focusBorder)); border-radius: 4px; overflow: hidden; }
  .tab { padding: 0.35rem 0.8rem; background: transparent; color: var(--vscode-foreground); border: none; cursor: pointer; font-family: inherit; font-size: inherit; }
  .tab + .tab { border-left: 1px solid var(--vscode-widget-border, var(--vscode-focusBorder)); }
  .tab.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .scope select {
    max-width: 11rem;
    text-overflow: ellipsis;
    padding: 0.4rem 0.5rem;
    color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
    background: var(--vscode-dropdown-background, var(--vscode-input-background));
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
    border-radius: 3px;
    font-family: inherit;
    font-size: inherit;
  }
  .scope select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .search { flex: 1; min-width: 8rem; }
  .search input {
    width: 100%;
    box-sizing: border-box;
    padding: 0.45rem 0.6rem;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px;
  }
  .search input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  main { flex: 1; min-height: 0; padding: 0.75rem 1.1rem; }
  .pane { height: 100%; box-sizing: border-box; overflow-y: auto; }
  .sync-strip { flex: none; display: flex; align-items: center; gap: 0.7rem; padding: 0.3rem 1.1rem 0.4rem; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); color: var(--vscode-descriptionForeground); font-size: 0.82em; }
  .sync-strip .bar { position: relative; flex: 1; height: 2px; overflow: hidden; background: var(--vscode-widget-border, var(--vscode-panel-border, transparent)); }
  .sync-strip .bar::after { content: ''; position: absolute; top: 0; bottom: 0; left: 0; width: 25%; background: var(--vscode-progressBar-background, var(--vscode-textLink-foreground)); animation: sync-strip-slide 1.6s linear infinite; }
  @keyframes sync-strip-slide { from { transform: translateX(-100%); } to { transform: translateX(400%); } }`;

function renderDocument(
  webview: vscode.Webview,
  providerLabel: string,
  assetRoot: vscode.Uri,
  session: string
): string {
  const nonce = createNonce();
  const assetUri = vscode.Uri.joinPath(assetRoot, "coverage-board.js");
  const scriptUri = typeof webview.asWebviewUri === "function" ? webview.asWebviewUri(assetUri) : assetUri;
  const board = boardFragment(providerLabel);
  const styles = [SHELL_CSS, board.css, PUBLISH_FRAGMENT.css, LINK_FRAGMENT.css].join("\n");
  const panes = [
    board.paneHtml,
    `    <section id="pane-publish" class="pane" data-tab="publish" role="tabpanel" aria-labelledby="tab-publish" hidden>\n      ${PUBLISH_FRAGMENT.paneHtml}\n    </section>`,
    `    <section id="pane-link" class="pane" data-tab="link" role="tabpanel" aria-labelledby="tab-link" hidden>\n      ${LINK_FRAGMENT.paneHtml}\n    </section>`,
  ].join("\n");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(nonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Coverage Board</title>
<style>${styles}
</style>
</head>
<body data-session="${session}">
  <header>
    <h1>Coverage Board</h1>
    <div class="tabs" role="tablist" aria-label="Coverage views">
      <button id="tab-mapping" class="tab" data-tab="mapping" role="tab" aria-controls="pane-mapping" aria-selected="false" tabindex="-1" type="button">Mapping</button>
      <button id="tab-matrix" class="tab" data-tab="matrix" role="tab" aria-controls="pane-matrix" aria-selected="false" tabindex="-1" type="button">Matrix</button>
      <button id="tab-executions" class="tab" data-tab="executions" role="tab" aria-controls="pane-executions" aria-selected="false" tabindex="-1" type="button">Executions</button>
      <button id="tab-publish" class="tab" data-tab="publish" role="tab" aria-controls="pane-publish" aria-selected="false" tabindex="-1" type="button">Publish</button>
      <button id="tab-link" class="tab" data-tab="link" role="tab" aria-controls="pane-link" aria-selected="false" tabindex="-1" type="button" hidden>Link</button>
    </div>
    <div class="scope"><select id="scope-select" aria-label="Project scope" title="Scope the board to one project"></select></div>
    <div class="search"><input id="search" type="text" spellcheck="false" autocomplete="off" aria-label="Filter coverage board" placeholder="Filter by key, tag, file…"></div>
  </header>
  <div id="sync-strip" class="sync-strip" role="status" hidden><span id="sync-strip-text"></span><span class="bar"></span></div>
  <main>
${panes}
  </main>
<script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
}
