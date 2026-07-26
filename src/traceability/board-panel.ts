import * as vscode from "vscode";
import { contentSecurityPolicy, createNonce } from "../utils/webview";
import { boardFragment } from "./board-fragment";
import { BoardSurface, BoardSurfaceDeps } from "./board-surface";
import { LINK_FRAGMENT, LinkSurface } from "./link-picker-panel";
import { PUBLISH_FRAGMENT, PublishDialogDelegate, PublishSurface } from "./publish-dialog-panel";
import { SurfaceHost, SurfaceName } from "./webview-host";

const VIEW_TYPE = "playwrightBddRunner.coverageBoard";

type BoardTab = "mapping" | "matrix" | "executions";
type ShellTab = BoardTab | "publish" | "link";

export interface BoardPanelDeps extends BoardSurfaceDeps {
  readonly providerLabel: string;
  // The Publish tab's callbacks: the search/browse/attach delegate the surface calls into, and the
  // command the shell fires when the tab is activated with no publish already underway.
  readonly publishDelegate: PublishDialogDelegate;
  startPublish(): void;
}

/**
 * The Coverage Board (View 2) — a singleton, document-like webview in the editor area (a second open
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
  public readonly board: BoardSurface;
  public readonly publish: PublishSurface;
  public readonly link: LinkSurface;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    deps: BoardPanelDeps
  ) {
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
      // Reveal wherever it already lives — don't yank a board the user parked in another column.
      BoardPanel.current.panel.reveal();
      return BoardPanel.current;
    }
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, "Coverage Board", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    });
    const instance = new BoardPanel(panel, deps);
    BoardPanel.current = instance;
    panel.webview.html = renderDocument(deps.providerLabel);
    instance.activateTab("mapping");
    return instance;
  }

  // The Mapping tab's checked scenario cards, empty when no board is open. The bulk-create command
  // reads the selection through here, so the palette entry and the board's own button see the same one.
  public static selectedScenarios(): readonly string[] {
    return BoardPanel.current?.board.selectedScenarios() ?? [];
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
      this.flush();
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

  private flush(): void {
    if (this.ready) {
      return;
    }
    this.ready = true;
    for (const message of this.queue) {
      Promise.resolve(this.panel.webview.postMessage(message)).catch(() => undefined);
    }
    this.queue.length = 0;
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

const SHELL_CSS = `
  body { margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  header { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; padding: 0.9rem 1.1rem 0.7rem; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); }
  header h1 { font-size: 1.2rem; font-weight: 600; margin: 0; }
  .tabs { display: inline-flex; border: 1px solid var(--vscode-widget-border, var(--vscode-focusBorder)); border-radius: 4px; overflow: hidden; }
  .tab { padding: 0.35rem 0.8rem; background: transparent; color: var(--vscode-foreground); border: none; cursor: pointer; font-family: inherit; font-size: inherit; }
  .tab + .tab { border-left: 1px solid var(--vscode-widget-border, var(--vscode-focusBorder)); }
  .tab.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .tab[hidden] { display: none; }
  .scope[hidden] { display: none; }
  .scope select {
    padding: 0.4rem 0.5rem;
    color: var(--vscode-dropdown-foreground, var(--vscode-foreground));
    background: var(--vscode-dropdown-background, var(--vscode-input-background));
    border: 1px solid var(--vscode-dropdown-border, var(--vscode-input-border, transparent));
    border-radius: 3px;
    font-family: inherit;
    font-size: inherit;
  }
  .scope select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .search { flex: 1; min-width: 12rem; }
  .search[hidden] { display: none; }
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
  main { padding: 1rem 1.1rem; }
  .pane[hidden] { display: none; }`;

const ROUTER_SCRIPT = `
  (function () {
    const vscodeApi = acquireVsCodeApi();
    const handlers = {};
    let shellHandler = null;
    window.__spec = {
      post: function (surface, msg) { msg.surface = surface; vscodeApi.postMessage(msg); },
      postShell: function (msg) { vscodeApi.postMessage(msg); },
      register: function (surface, handler) { handlers[surface] = handler; },
      registerShell: function (handler) { shellHandler = handler; },
    };
    window.addEventListener('message', function (event) {
      const msg = event.data;
      if (msg && msg.surface) { const handler = handlers[msg.surface]; if (handler) { handler(msg); } }
      else if (shellHandler) { shellHandler(msg); }
    });
  })();`;

const SHELL_SCRIPT = `
  (function () {
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

    window.__spec.postShell({ type: 'ready' });
  })();`;

function renderDocument(providerLabel: string): string {
  const nonce = createNonce();
  const board = boardFragment(providerLabel);
  const styles = [SHELL_CSS, board.css, PUBLISH_FRAGMENT.css, LINK_FRAGMENT.css].join("\n");
  const panes = [
    board.paneHtml,
    `    <section id="pane-publish" class="pane" data-tab="publish" hidden>\n      ${PUBLISH_FRAGMENT.paneHtml}\n    </section>`,
    `    <section id="pane-link" class="pane" data-tab="link" hidden>\n      ${LINK_FRAGMENT.paneHtml}\n    </section>`,
  ].join("\n");
  const scripts = [ROUTER_SCRIPT, SHELL_SCRIPT, board.script, PUBLISH_FRAGMENT.script, LINK_FRAGMENT.script]
    .map((script) => `<script nonce="${nonce}">${script}</script>`)
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
  <main>
${panes}
  </main>
${scripts}
</body>
</html>`;
}
