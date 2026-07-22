import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import {
  BoardScenarioCard,
  BoardTestCard,
  BoardViewModel,
  ExecutionRow,
  MatrixRow,
  filterBoardViewModel,
  filterExecutionRows,
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
interface DropMessage {
  type: "drop";
  scenario: string;
  key: string;
}
interface OpenMessage {
  type: "open";
  key: string;
}
type IncomingMessage = ReadyMessage | SearchMessage | TabMessage | DropMessage | OpenMessage;

interface RenderMessage {
  type: "render";
  activeTab: BoardTab;
  scenarios: readonly BoardScenarioCard[];
  tests: readonly BoardTestCard[];
  matrix: readonly MatrixRow[];
  executions: readonly ExecutionRow[];
}
type OutgoingMessage = RenderMessage;

// The board is a document-like surface, so its data source is the stable subsystem — not a one-shot
// snapshot — letting it re-render across syncs and provider swaps while the panel stays open.
// `applyDrop` is the drag-to-link seam: the webview posts a normalized {scenario, key} and the host
// validates and writes the tag, then the snapshot rebuild re-renders the board (no hand-patching here).
export interface BoardPanelDeps {
  readonly providerLabel: string;
  buildModel(): BoardViewModel;
  // The Executions tab's rows, read from the publish ledger — what this workspace has published, never
  // a live remote query. Rebuilt alongside the model on every refresh.
  buildExecutions(): readonly ExecutionRow[];
  readonly onDidChange: vscode.Event<void>;
  applyDrop(scenario: string, key: string): Promise<void>;
  // An Executions row's key link: routed through the host's browseIssue path.
  openExecution(key: string): void;
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
  const testColumn = escapeHtml(`${providerLabel} test`);
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
  .card[draggable="true"] { cursor: grab; }
  .card.drop-target { outline: 2px dashed var(--vscode-focusBorder); outline-offset: -2px; }
  .matrix-scroll { overflow: auto; max-height: calc(100vh - 9rem); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); border-radius: 5px; }
  table.matrix { border-collapse: collapse; width: 100%; font-size: 0.9em; }
  table.matrix th, table.matrix td { text-align: left; padding: 0.4rem 0.6rem; white-space: nowrap; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); }
  table.matrix thead th { position: sticky; top: 0; z-index: 1; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); font-weight: 600; }
  table.matrix td.hole { background: var(--vscode-inputValidation-warningBackground, transparent); }
  table.matrix .key { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground); }
  table.matrix a.link { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  table.matrix a.link:hover { text-decoration: underline; }
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
      <div class="matrix-scroll">
        <table class="matrix">
          <thead>
            <tr><th>Requirement</th><th>${testColumn}</th><th>Scenario</th><th>Tag in file</th><th>Last result</th></tr>
          </thead>
          <tbody id="matrix-rows"></tbody>
        </table>
      </div>
    </section>
    <section id="pane-executions" class="pane" hidden>
      <div id="executions-empty" class="empty" hidden>Publishes from this workspace appear here.</div>
      <div id="executions-scroll" class="matrix-scroll">
        <table class="matrix">
          <thead>
            <tr><th>Execution</th><th>Summary</th><th>Action</th><th>Imported</th><th>Pass rate</th><th>Published</th><th>From here</th></tr>
          </thead>
          <tbody id="executions-rows"></tbody>
        </table>
      </div>
    </section>
  </main>
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const search = document.getElementById('search');
  const scenarioCards = document.getElementById('scenario-cards');
  const testCards = document.getElementById('test-cards');
  const scenarioCount = document.getElementById('scenario-count');
  const testCount = document.getElementById('test-count');
  const matrixRows = document.getElementById('matrix-rows');
  const executionsRows = document.getElementById('executions-rows');
  const executionsEmpty = document.getElementById('executions-empty');
  const executionsScroll = document.getElementById('executions-scroll');
  const tabs = Array.prototype.slice.call(document.querySelectorAll('.tab'));
  const panes = {
    mapping: document.getElementById('pane-mapping'),
    matrix: document.getElementById('pane-matrix'),
    executions: document.getElementById('pane-executions'),
  };

  // A scenario card carries kind 'scenario' + its location; a test card kind 'test' + its key. A drop
  // is valid only across kinds, so a scenario lands on any test card and an orphan test on a scenario,
  // never like on like. The drop normalizes both directions to {scenario, key}.
  let dragged = null;
  function clearDropTargets() {
    const marked = document.querySelectorAll('.drop-target');
    for (const el of Array.prototype.slice.call(marked)) { el.classList.remove('drop-target'); }
  }
  function wireCardDrag(el, kind, id, draggable) {
    if (draggable) {
      el.draggable = true;
      el.addEventListener('dragstart', function (e) {
        dragged = { kind: kind, id: id };
        if (e.dataTransfer) { e.dataTransfer.effectAllowed = 'link'; }
      });
      el.addEventListener('dragend', function () { dragged = null; clearDropTargets(); });
    }
    el.addEventListener('dragover', function (e) {
      if (dragged && dragged.kind !== kind) {
        e.preventDefault();
        if (e.dataTransfer) { e.dataTransfer.dropEffect = 'link'; }
        el.classList.add('drop-target');
      }
    });
    el.addEventListener('dragleave', function () { el.classList.remove('drop-target'); });
    el.addEventListener('drop', function (e) {
      if (!dragged || dragged.kind === kind) { return; }
      e.preventDefault();
      el.classList.remove('drop-target');
      const scenario = dragged.kind === 'scenario' ? dragged.id : id;
      const key = dragged.kind === 'scenario' ? id : dragged.id;
      vscodeApi.postMessage({ type: 'drop', scenario: scenario, key: key });
      dragged = null;
    });
  }

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
      wireCardDrag(el, 'scenario', card.dropId, true);
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
      wireCardDrag(el, 'test', card.key, card.pills.indexOf('orphan') !== -1);
      testCards.appendChild(el);
    }
  }

  function matrixCell(text, isKey) {
    const td = document.createElement('td');
    if (text === '') { td.className = 'hole'; }
    else {
      td.textContent = text;
      if (isKey) { td.className = 'key'; }
    }
    return td;
  }

  function renderMatrix(rows) {
    matrixRows.textContent = '';
    if (rows.length === 0) {
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 5;
      td.className = 'empty';
      td.textContent = 'Nothing to trace yet.';
      tr.appendChild(td);
      matrixRows.appendChild(tr);
      return;
    }
    for (const row of rows) {
      const tr = document.createElement('tr');
      tr.appendChild(matrixCell(row.requirement, false));
      tr.appendChild(matrixCell(row.test, true));
      tr.appendChild(matrixCell(row.scenario, false));
      tr.appendChild(matrixCell(row.tag, true));
      tr.appendChild(matrixCell(row.result, false));
      matrixRows.appendChild(tr);
    }
  }

  function executionCell(text) {
    const td = document.createElement('td');
    td.textContent = text;
    return td;
  }

  function renderExecutions(rows) {
    executionsRows.textContent = '';
    const empty = rows.length === 0;
    executionsEmpty.hidden = !empty;
    executionsScroll.hidden = empty;
    if (empty) { return; }
    for (const row of rows) {
      const tr = document.createElement('tr');
      const keyTd = document.createElement('td');
      const link = document.createElement('a');
      link.className = 'link';
      link.href = '#';
      link.textContent = row.key;
      link.addEventListener('click', function (e) {
        e.preventDefault();
        vscodeApi.postMessage({ type: 'open', key: row.key });
      });
      keyTd.appendChild(link);
      tr.appendChild(keyTd);
      tr.appendChild(executionCell(row.summary));
      tr.appendChild(executionCell(row.action));
      tr.appendChild(executionCell(row.resultsImported));
      tr.appendChild(executionCell(row.passRate));
      tr.appendChild(executionCell(row.publishedAt));
      tr.appendChild(executionCell(String(row.timesFromHere)));
      executionsRows.appendChild(tr);
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
      renderMatrix(msg.matrix || []);
      renderExecutions(msg.executions || []);
    }
  });

  vscodeApi.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

/**
 * The Coverage Board (View 2) — a singleton, document-like webview in the editor area (a second open
 * reveals the existing panel, unlike the modal dialogs). The Mapping tab lets an untraced scenario be
 * dragged onto a test card (and an orphan test onto a scenario) to write its `@TEST_` tag; the Matrix
 * tab is the requirement/test/scenario/tag/result table; the Executions tab lists what this workspace
 * has published, read from the publish ledger, each key linking out through browseIssue. Header
 * search, tab state, and drop validation live here (the extension host) so the webview JS stays thin
 * and untested; every render round-trips through the vscode-free
 * `buildBoardViewModel`/`filterBoardViewModel`, and a drop routes to `applyDrop`. The panel re-renders
 * on the subsystem's snapshot-change event and disposes that subscription with itself.
 */
export class BoardPanel {
  private static current: BoardPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private activeTab: BoardTab = "mapping";
  private query = "";
  private model: BoardViewModel;
  private executions: readonly ExecutionRow[];

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: BoardPanelDeps
  ) {
    this.model = deps.buildModel();
    this.executions = deps.buildExecutions();
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
    if (message.type === "drop") {
      // The write, its snapshot rebuild, and the follow-up re-render are the host's job. Nothing is
      // posted back here: a valid drop re-renders via onDidChange, a stale one toasts and leaves the
      // board as-is for a retry.
      this.deps.applyDrop(message.scenario, message.key).catch(() => undefined);
      return;
    }
    if (message.type === "open") {
      this.deps.openExecution(message.key);
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
    this.executions = this.deps.buildExecutions();
    this.post(this.renderMessage());
  }

  private renderMessage(): RenderMessage {
    const filtered = filterBoardViewModel(this.model, this.query);
    return {
      type: "render",
      activeTab: this.activeTab,
      scenarios: filtered.scenarios,
      tests: filtered.tests,
      matrix: filtered.matrix,
      executions: filterExecutionRows(this.executions, this.query),
    };
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
