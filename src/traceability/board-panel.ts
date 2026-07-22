import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  BoardScenarioCard,
  BoardTestCard,
  BoardViewModel,
  filterBoardViewModel,
} from "./board-data";

const VIEW_TYPE = "playwrightBddRunner.coverageBoard";

export type BoardTab = "mapping" | "matrix" | "executions";

interface ReadyMessage {
  type: "ready";
}
interface SearchMessage {
  type: "search";
  value: string;
}
interface TabMessage {
  type: "tab";
  tab: BoardTab;
}
type IncomingMessage = ReadyMessage | SearchMessage | TabMessage;

interface RenderMessage {
  type: "render";
  activeTab: BoardTab;
  scenarios: readonly BoardScenarioCard[];
  tests: readonly BoardTestCard[];
}
type OutgoingMessage = RenderMessage;

// The board is a document-like surface, so its data source is the stable subsystem — not a one-shot
// snapshot — letting it re-render across syncs and provider swaps while the panel stays open.
export interface BoardPanelDeps {
  readonly providerLabel: string;
  buildModel(): BoardViewModel;
  readonly onDidChange: vscode.Event<void>;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderHtml(providerLabel: string): string {
  const nonce = randomBytes(16).toString("hex");
  const testsHeading = escapeHtml(`${providerLabel} tests`);
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Coverage Board</title>
<style>
  body { margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  header { display: flex; align-items: center; gap: 1rem; flex-wrap: wrap; padding: 0.9rem 1.1rem 0.7rem; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); }
  h1 { font-size: 1.2rem; font-weight: 600; margin: 0; }
  .tabs { display: inline-flex; border: 1px solid var(--vscode-widget-border, var(--vscode-focusBorder)); border-radius: 4px; overflow: hidden; }
  .tab { padding: 0.35rem 0.8rem; background: transparent; color: var(--vscode-foreground); border: none; cursor: pointer; font-family: inherit; font-size: inherit; }
  .tab + .tab { border-left: 1px solid var(--vscode-widget-border, var(--vscode-focusBorder)); }
  .tab.active { background: var(--vscode-button-background); color: var(--vscode-button-foreground); }
  .search { flex: 1; min-width: 12rem; }
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
  .pane[hidden] { display: none; }
  .columns { display: grid; grid-template-columns: 1fr auto 1fr; gap: 1rem; align-items: start; }
  .column h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); font-weight: 600; margin: 0 0 0.6rem; }
  .count { color: var(--vscode-descriptionForeground); font-weight: 400; }
  .cards { display: flex; flex-direction: column; gap: 0.5rem; }
  .card {
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent));
    border-radius: 5px;
    padding: 0.55rem 0.65rem;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  .card .title { font-weight: 600; word-break: break-word; }
  .card .key { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground); }
  .card .meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 0.2rem; word-break: break-all; }
  .pills { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.4rem; }
  .pill { font-size: 0.72rem; padding: 0.08rem 0.4rem; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .pill.orphan { background: var(--vscode-inputValidation-warningBackground, var(--vscode-badge-background)); color: var(--vscode-inputValidation-warningForeground, var(--vscode-badge-foreground)); }
  .gutter { display: flex; align-items: center; justify-content: center; align-self: stretch; min-width: 5.5rem; }
  .gutter span { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 0.85em; text-align: center; }
  .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 0.4rem 0; }
  .muted { color: var(--vscode-descriptionForeground); font-style: italic; }
</style>
</head>
<body>
  <header>
    <h1>Coverage Board</h1>
    <div class="tabs" role="tablist">
      <button class="tab" data-tab="mapping" type="button">Mapping</button>
      <button class="tab" data-tab="matrix" type="button">Matrix</button>
      <button class="tab" data-tab="executions" type="button">Executions</button>
    </div>
    <div class="search"><input id="search" type="text" spellcheck="false" autocomplete="off" placeholder="Filter by key, tag, file…"></div>
  </header>
  <main>
    <section id="pane-mapping" class="pane" hidden>
      <div class="columns">
        <div class="column">
          <h2>Untraced scenarios <span id="scenario-count" class="count"></span></h2>
          <div id="scenario-cards" class="cards"></div>
        </div>
        <div class="gutter"><span>drag to link</span></div>
        <div class="column">
          <h2>${testsHeading} <span id="test-count" class="count"></span></h2>
          <div id="test-cards" class="cards"></div>
        </div>
      </div>
    </section>
    <section id="pane-matrix" class="pane" hidden>
      <p class="muted">Coverage matrix — coming in the next slice.</p>
    </section>
    <section id="pane-executions" class="pane" hidden>
      <p class="muted">Executions — design pending review.</p>
    </section>
  </main>
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const search = document.getElementById('search');
  const scenarioCards = document.getElementById('scenario-cards');
  const testCards = document.getElementById('test-cards');
  const scenarioCount = document.getElementById('scenario-count');
  const testCount = document.getElementById('test-count');
  const tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  const panes = {
    mapping: document.getElementById('pane-mapping'),
    matrix: document.getElementById('pane-matrix'),
    executions: document.getElementById('pane-executions'),
  };

  function pillEl(text) {
    const el = document.createElement('span');
    el.className = text === 'orphan' ? 'pill orphan' : 'pill';
    el.textContent = text;
    return el;
  }

  function pillsEl(pills) {
    const wrap = document.createElement('div');
    wrap.className = 'pills';
    for (const pill of pills) { wrap.appendChild(pillEl(pill)); }
    return wrap;
  }

  function renderScenarios(cards) {
    scenarioCards.textContent = '';
    scenarioCount.textContent = '(' + cards.length + ')';
    if (cards.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No untraced scenarios.';
      scenarioCards.appendChild(empty);
      return;
    }
    for (const card of cards) {
      const el = document.createElement('div');
      el.className = 'card';
      const title = document.createElement('div');
      title.className = 'title';
      title.textContent = card.name;
      el.appendChild(title);
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.textContent = card.location;
      el.appendChild(meta);
      el.appendChild(pillsEl(card.pills));
      scenarioCards.appendChild(el);
    }
  }

  function renderTests(cards) {
    testCards.textContent = '';
    testCount.textContent = '(' + cards.length + ')';
    if (cards.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No tests.';
      testCards.appendChild(empty);
      return;
    }
    for (const card of cards) {
      const el = document.createElement('div');
      el.className = 'card';
      const title = document.createElement('div');
      title.className = 'title key';
      title.textContent = card.key;
      el.appendChild(title);
      if (card.summary) {
        const meta = document.createElement('div');
        meta.className = 'meta';
        meta.textContent = card.summary;
        el.appendChild(meta);
      }
      el.appendChild(pillsEl(card.pills));
      testCards.appendChild(el);
    }
  }

  function showTab(tab) {
    for (const t of tabs) { t.classList.toggle('active', t.dataset.tab === tab); }
    for (const name of Object.keys(panes)) { panes[name].hidden = name !== tab; }
  }

  for (const t of tabs) {
    t.addEventListener('click', function () { vscodeApi.postMessage({ type: 'tab', tab: t.dataset.tab }); });
  }
  search.addEventListener('input', function () { vscodeApi.postMessage({ type: 'search', value: search.value }); });

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg.type === 'render') {
      showTab(msg.activeTab);
      renderScenarios(msg.scenarios || []);
      renderTests(msg.tests || []);
    }
  });

  vscodeApi.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

/**
 * The Coverage Board (View 2) — a singleton, document-like webview in the editor area (a second open
 * reveals the existing panel, unlike the modal dialogs). This slice ships the shell plus a read-only
 * Mapping tab: untraced scenario cards, a static "drag to link" gutter (no drag yet), and the remote
 * test cards. Matrix and Executions are placeholder panes. Header search and tab state live here (the
 * extension host) so the webview JS stays thin and untested; every render round-trips through the
 * vscode-free `buildBoardViewModel`/`filterBoardViewModel`. The panel re-renders on the subsystem's
 * snapshot-change event and disposes that subscription with itself.
 */
export class BoardPanel {
  private static current: BoardPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private activeTab: BoardTab = "mapping";
  private query = "";
  private model: BoardViewModel;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: BoardPanelDeps
  ) {
    this.model = deps.buildModel();
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message as IncomingMessage)),
      this.deps.onDidChange(() => this.refresh())
    );
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
    panel.webview.html = renderHtml(deps.providerLabel);
    return instance;
  }

  private handleMessage(message: IncomingMessage): void {
    if (this.disposed) {
      return;
    }
    if (message.type === "search") {
      this.query = message.value;
    } else if (message.type === "tab") {
      this.activeTab = message.tab;
    }
    this.post(this.renderMessage());
  }

  private refresh(): void {
    this.model = this.deps.buildModel();
    this.post(this.renderMessage());
  }

  private renderMessage(): RenderMessage {
    const filtered = filterBoardViewModel(this.model, this.query);
    return { type: "render", activeTab: this.activeTab, scenarios: filtered.scenarios, tests: filtered.tests };
  }

  private post(message: OutgoingMessage): void {
    if (this.disposed) {
      return;
    }
    Promise.resolve(this.panel.webview.postMessage(message)).catch(() => undefined);
  }

  public dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    if (BoardPanel.current === this) {
      BoardPanel.current = undefined;
    }
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    this.panel.dispose();
  }
}
