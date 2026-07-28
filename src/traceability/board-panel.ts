import * as vscode from "vscode";
import { errMsg } from "../utils/text";
import { Logger } from "../utils/logger";
import { contentSecurityPolicy, createNonce } from "../utils/webview";
import { boardFragment } from "./board-fragment";
import { BoardSurface, BoardSurfaceDeps } from "./board-surface";
import { LINK_FRAGMENT, LinkSurface } from "./link-picker-panel";
import { PUBLISH_FRAGMENT, PublishDialogDelegate, PublishSurface } from "./publish-dialog-panel";
import { SurfaceHost, SurfaceName } from "./webview-host";

const VIEW_TYPE = "playwrightBddRunner.coverageBoard";

// One options object for both entry points, since a restored panel's webview is re-configured rather
// than trusted: the board is a blank page with scripts off.
const WEBVIEW_OPTIONS: vscode.WebviewOptions = { enableScripts: true, localResourceRoots: [] };

type BoardTab = "mapping" | "matrix" | "executions";
type ShellTab = BoardTab | "publish" | "link";

export interface BoardPanelDeps extends BoardSurfaceDeps {
  readonly providerLabel: string;
  readonly logger: Logger;
  // The editor tab's icon, one file per theme. Absent in rigs with no extension root to resolve media
  // against, where the tab is not painted anyway.
  readonly tabIcon?: { light: vscode.Uri; dark: vscode.Uri } | undefined;
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
  private readonly surfaceHandlers = new Map<SurfaceName, (message: unknown) => void>();
  private readonly queue: object[] = [];
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
      ...WEBVIEW_OPTIONS,
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
    panel.webview.options = WEBVIEW_OPTIONS;
    if (deps.tabIcon) {
      panel.iconPath = deps.tabIcon;
    }
    const instance = new BoardPanel(panel, deps);
    BoardPanel.current = instance;
    panel.webview.html = renderDocument(deps.providerLabel);
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

  // The Executions tab, where a published run's row lands. The publish flow holds the panel it opened,
  // so this one is an instance method rather than a static like the readers above.
  public showExecutions(): void {
    this.activateTab("executions");
  }

  private hostFor(surface: SurfaceName): SurfaceHost {
    return {
      post: (message) => this.postRaw({ ...message, surface }),
      onMessage: (handler) => {
        this.surfaceHandlers.set(surface, handler);
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
    const msg = message as { surface?: SurfaceName; type?: string; tab?: ShellTab };
    if (msg.surface) {
      this.surfaceHandlers.get(msg.surface)?.(message);
      return;
    }
    if (msg.type === "ready") {
      this.hydrate();
    } else if (msg.type === "tab" && msg.tab) {
      this.activateTab(msg.tab);
      if (msg.tab === "publish") {
        this.publish.onManualActivate();
      }
    }
  }

  private activateTab(tab: ShellTab): void {
    this.activeTab = tab;
    this.postRaw({ type: "activate", tab });
  }

  private setLinkTabVisible(visible: boolean, title?: string): void {
    this.postRaw({ type: "linkTab", visible, ...(title !== undefined ? { title } : {}) });
    if (!visible && this.activeTab === "link") {
      this.activateTab("mapping");
    }
  }

  // Outbound posts are held until the webview announces `ready`, then flushed in order, so a render or
  // activation queued during document construction can't race the script load.
  private postRaw(message: object): void {
    if (this.disposed) {
      return;
    }
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
      this.postRaw(message);
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

const ROUTER_SCRIPT = `
  const vscodeApi = acquireVsCodeApi();
  const handlers = {};
  let shellHandler = null;
  window.__spec = {
    post: function (surface, msg) { msg.surface = surface; vscodeApi.postMessage(msg); },
    postShell: function (msg) { vscodeApi.postMessage(msg); },
    register: function (surface, handler) { handlers[surface] = handler; },
    registerShell: function (handler) { shellHandler = handler; },
    // The webview's own display state (which matrix groups are open, how far the executions window is
    // pulled down), the only thing that survives the host rebuilding this document on a window reload.
    // One object shared by the fragments, so a write merges rather than replaces.
    state: function () { return vscodeApi.getState() || {}; },
    saveState: function (patch) { vscodeApi.setState(Object.assign({}, vscodeApi.getState(), patch)); },
  };
  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg && msg.surface) { const handler = handlers[msg.surface]; if (handler) { handler(msg); } }
    else if (shellHandler) { shellHandler(msg); }
  });`;

const SHELL_SCRIPT = `
  const tabButtons = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  const panes = Array.prototype.slice.call(document.querySelectorAll('.pane'));
  const searchBox = document.querySelector('.search');
  const scopeBox = document.querySelector('.scope');
  const boardTabs = { mapping: true, matrix: true, executions: true };

  function showTab(tab) {
    tabButtons.forEach(function (btn) { btn.classList.toggle('active', btn.dataset.tab === tab); });
    panes.forEach(function (pane) { pane.hidden = pane.dataset.tab !== tab; });
    if (searchBox) { searchBox.hidden = !boardTabs[tab]; }
    if (scopeBox) { scopeBox.hidden = !boardTabs[tab]; }
  }

  tabButtons.forEach(function (btn) {
    btn.addEventListener('click', function () { window.__spec.postShell({ type: 'tab', tab: btn.dataset.tab }); });
  });

  window.__spec.registerShell(function (msg) {
    if (msg.type === 'activate') { showTab(msg.tab); }
    else if (msg.type === 'linkTab') {
      const linkBtn = document.querySelector('.tab[data-tab="link"]');
      if (linkBtn) { linkBtn.hidden = !msg.visible; if (msg.title) { linkBtn.title = msg.title; } }
    }
  });

  window.__spec.postShell({ type: 'ready' });`;

function renderDocument(providerLabel: string): string {
  const nonce = createNonce();
  const board = boardFragment(providerLabel);
  const styles = [SHELL_CSS, board.css, PUBLISH_FRAGMENT.css, LINK_FRAGMENT.css].join("\n");
  const panes = [
    board.paneHtml,
    `    <section id="pane-publish" class="pane" data-tab="publish" hidden>\n      ${PUBLISH_FRAGMENT.paneHtml}\n    </section>`,
    `    <section id="pane-link" class="pane" data-tab="link" hidden>\n      ${LINK_FRAGMENT.paneHtml}\n    </section>`,
  ].join("\n");
  // Each script gets its own function scope: the fragments share nothing but `window.__spec`, and two
  // top-level `const`s of the same name across sibling scripts is a parse error that kills the second.
  const scripts = [ROUTER_SCRIPT, SHELL_SCRIPT, board.script, PUBLISH_FRAGMENT.script, LINK_FRAGMENT.script]
    .map((script) => `<script nonce="${nonce}">(function () {${script}\n})();</script>`)
    .join("\n");
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
<body>
  <header>
    <h1>Coverage Board</h1>
    <div class="tabs" role="tablist">
      <button class="tab" data-tab="mapping" type="button">Mapping</button>
      <button class="tab" data-tab="matrix" type="button">Matrix</button>
      <button class="tab" data-tab="executions" type="button">Executions</button>
      <button class="tab" data-tab="publish" type="button">Publish</button>
      <button class="tab" data-tab="link" type="button" hidden>Link</button>
    </div>
    <div class="scope"><select id="scope-select" title="Scope the board to one project"></select></div>
    <div class="search"><input id="search" type="text" spellcheck="false" autocomplete="off" placeholder="Filter by key, tag, file…"></div>
  </header>
  <div id="sync-strip" class="sync-strip" role="status" hidden><span id="sync-strip-text"></span><span class="bar"></span></div>
  <main>
${panes}
  </main>
${scripts}
</body>
</html>`;
}
