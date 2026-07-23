import * as vscode from "vscode";
import { contentSecurityPolicy, createNonce, escapeHtml } from "../utils/webview";
import {
  BoardScenarioCard,
  BoardTestCard,
  BoardViewModel,
  ExecutionRow,
  MatrixRow,
  filterBoardViewModel,
  filterExecutionRows,
} from "./board-data";
import { LINK_FRAGMENT, LinkSurface } from "./link-picker-panel";
import { PUBLISH_FRAGMENT, PublishDialogDelegate, PublishSurface } from "./publish-dialog-panel";
import { SurfaceHost, SurfaceName } from "./webview-host";

const VIEW_TYPE = "playwrightBddRunner.coverageBoard";

type BoardTab = "mapping" | "matrix" | "executions";
type ShellTab = BoardTab | "publish" | "link";

interface SearchMessage {
  type: "search";
  value: string;
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
type BoardIncoming = SearchMessage | DropMessage | OpenMessage;

interface RenderMessage {
  type: "render";
  scenarios: readonly BoardScenarioCard[];
  tests: readonly BoardTestCard[];
  matrix: readonly MatrixRow[];
  executions: readonly ExecutionRow[];
}

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
  // The Publish tab's callbacks: the search/browse/attach delegate the surface calls into, and the
  // command the shell fires when the tab is activated with no publish already underway.
  readonly publishDelegate: PublishDialogDelegate;
  startPublish(): void;
}

// The Mapping/Matrix/Executions surface. It paints all three board panes from one filtered view model
// (the shell owns which pane is visible), forwards drops and execution-link clicks, and re-renders on
// the subsystem's snapshot-change event. Every render round-trips through the vscode-free
// `filterBoardViewModel`, so the webview JS stays thin and untested.
class BoardSurface {
  private query = "";
  private model: BoardViewModel;
  private executions: readonly ExecutionRow[];

  constructor(
    private readonly host: SurfaceHost,
    private readonly deps: BoardPanelDeps
  ) {
    this.model = deps.buildModel();
    this.executions = deps.buildExecutions();
    host.onMessage((message) => this.handle(message as BoardIncoming));
    const subscription = deps.onDidChange(() => this.refresh());
    host.onDidDispose(() => subscription.dispose());
    this.render();
  }

  private handle(message: BoardIncoming): void {
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
    this.query = message.value;
    this.render();
  }

  private refresh(): void {
    this.model = this.deps.buildModel();
    this.executions = this.deps.buildExecutions();
    this.render();
  }

  private render(): void {
    const filtered = filterBoardViewModel(this.model, this.query);
    const message: RenderMessage = {
      type: "render",
      scenarios: filtered.scenarios,
      tests: filtered.tests,
      matrix: filtered.matrix,
      executions: filterExecutionRows(this.executions, this.query),
    };
    this.host.post(message);
  }
}

/**
 * The Coverage Board (View 2) — a singleton, document-like webview in the editor area (a second open
 * reveals the existing panel). The board is one of several surfaces routed through a shared document:
 * the shell owns the single WebviewPanel, one `acquireVsCodeApi()`, the tab strip, and a ready-gated
 * outbound queue, then dispatches inbound messages by `surface`. The Mapping tab drags an untraced
 * scenario onto a test card (and an orphan test onto a scenario) to write its `@TEST_` tag; the Matrix
 * tab is the requirement/test/scenario/tag/result table; the Executions tab lists what this workspace
 * has published. Every board render round-trips through the vscode-free `filterBoardViewModel`.
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
  private readonly surfaces: object[] = [];
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
    this.surfaces.push(new BoardSurface(this.hostFor("board"), deps));
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

  private hostFor(surface: SurfaceName): SurfaceHost {
    return {
      post: (message) => this.postRaw({ ...message, surface }),
      onMessage: (handler) => {
        this.surfaceHandlers.set(surface, handler);
      },
      reveal: () => this.panel.reveal(),
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

const BOARD_CSS = `
  .board-pane .mapping-hint { margin: 0 0 1rem; padding: 0.5rem 0.7rem; border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); border-radius: 5px; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); color: var(--vscode-descriptionForeground); font-size: 0.85em; line-height: 1.4; }
  .board-pane .columns { display: grid; grid-template-columns: 1fr auto 1fr; gap: 1rem; align-items: start; }
  .board-pane .column h2 { font-size: 0.8rem; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); font-weight: 600; margin: 0 0 0.6rem; }
  .board-pane .count { color: var(--vscode-descriptionForeground); font-weight: 400; }
  .board-pane .cards { display: flex; flex-direction: column; gap: 0.5rem; }
  .board-pane .card {
    border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent));
    border-radius: 5px;
    padding: 0.55rem 0.65rem;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
  }
  .board-pane .card .title { font-weight: 600; word-break: break-word; }
  .board-pane .card .key { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground); }
  .board-pane .card .meta { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 0.2rem; word-break: break-all; }
  .board-pane .pills { display: flex; flex-wrap: wrap; gap: 0.3rem; margin-top: 0.4rem; }
  .board-pane .pill { font-size: 0.72rem; padding: 0.08rem 0.4rem; border-radius: 999px; background: var(--vscode-badge-background); color: var(--vscode-badge-foreground); }
  .board-pane .pill.orphan { background: var(--vscode-inputValidation-warningBackground, var(--vscode-badge-background)); color: var(--vscode-inputValidation-warningForeground, var(--vscode-badge-foreground)); }
  .board-pane .gutter { display: flex; align-items: center; justify-content: center; align-self: stretch; min-width: 5.5rem; }
  .board-pane .gutter span { color: var(--vscode-descriptionForeground); font-style: italic; font-size: 0.85em; text-align: center; }
  .board-pane .empty { color: var(--vscode-descriptionForeground); font-style: italic; padding: 0.4rem 0; }
  .board-pane .muted { color: var(--vscode-descriptionForeground); font-style: italic; }
  .board-pane .card[draggable="true"] { cursor: grab; }
  .board-pane .card.drop-target { outline: 2px dashed var(--vscode-focusBorder); outline-offset: -2px; }
  .board-pane .matrix-scroll { overflow: auto; max-height: calc(100vh - 9rem); border: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); border-radius: 5px; }
  .board-pane table.matrix { border-collapse: collapse; width: 100%; font-size: 0.9em; }
  .board-pane table.matrix th, .board-pane table.matrix td { text-align: left; padding: 0.4rem 0.6rem; white-space: nowrap; border-bottom: 1px solid var(--vscode-widget-border, var(--vscode-panel-border, transparent)); }
  .board-pane table.matrix thead th { position: sticky; top: 0; z-index: 1; background: var(--vscode-editorWidget-background, var(--vscode-editor-background)); font-weight: 600; }
  .board-pane table.matrix td.hole { background: var(--vscode-inputValidation-warningBackground, transparent); }
  .board-pane table.matrix .key { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground); }
  .board-pane table.matrix a.link { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground); cursor: pointer; text-decoration: none; }
  .board-pane table.matrix a.link:hover { text-decoration: underline; }`;

function boardPanesHtml(providerLabel: string): string {
  const testsHeading = escapeHtml(`${providerLabel} tests`);
  const testColumn = escapeHtml(`${providerLabel} test`);
  return `    <section id="pane-mapping" class="pane board-pane" data-tab="mapping" hidden>
      <p class="mapping-hint">Drag a scenario from the left onto a test on the right to link them. Orphaned tests can also be dragged onto a scenario.</p>
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
    <section id="pane-matrix" class="pane board-pane" data-tab="matrix" hidden>
      <div class="matrix-scroll">
        <table class="matrix">
          <thead>
            <tr><th>Requirement</th><th>${testColumn}</th><th>Scenario</th><th>Tag in file</th><th>Last result</th></tr>
          </thead>
          <tbody id="matrix-rows"></tbody>
        </table>
      </div>
    </section>
    <section id="pane-executions" class="pane board-pane" data-tab="executions" hidden>
      <div id="executions-empty" class="empty" hidden>Publishes from this workspace appear here.</div>
      <div id="executions-scroll" class="matrix-scroll">
        <table class="matrix">
          <thead>
            <tr><th>Execution</th><th>Summary</th><th>Action</th><th>Imported</th><th>Pass rate</th><th>Published</th><th>From here</th></tr>
          </thead>
          <tbody id="executions-rows"></tbody>
        </table>
      </div>
    </section>`;
}

const BOARD_SCRIPT = `
  const search = document.getElementById('search');
  const scenarioCards = document.getElementById('scenario-cards');
  const testCards = document.getElementById('test-cards');
  const scenarioCount = document.getElementById('scenario-count');
  const testCount = document.getElementById('test-count');
  const matrixRows = document.getElementById('matrix-rows');
  const executionsRows = document.getElementById('executions-rows');
  const executionsEmpty = document.getElementById('executions-empty');
  const executionsScroll = document.getElementById('executions-scroll');

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
      window.__spec.post('board', { type: 'drop', scenario: scenario, key: key });
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
        window.__spec.post('board', { type: 'open', key: row.key });
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

  search.addEventListener('input', function () { window.__spec.post('board', { type: 'search', value: search.value }); });

  window.__spec.register('board', function (msg) {
    if (msg.type === 'render') {
      renderScenarios(msg.scenarios || []);
      renderTests(msg.tests || []);
      renderMatrix(msg.matrix || []);
      renderExecutions(msg.executions || []);
    }
  });`;

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
    const boardTabs = { mapping: true, matrix: true, executions: true };

    function showTab(tab) {
      tabButtons.forEach(function (btn) { btn.classList.toggle('active', btn.dataset.tab === tab); });
      panes.forEach(function (pane) { pane.hidden = pane.dataset.tab !== tab; });
      if (searchBox) { searchBox.hidden = !boardTabs[tab]; }
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
  const styles = [SHELL_CSS, BOARD_CSS, PUBLISH_FRAGMENT.css, LINK_FRAGMENT.css].join("\n");
  const panes = [
    boardPanesHtml(providerLabel),
    `    <section id="pane-publish" class="pane" data-tab="publish" hidden>\n      ${PUBLISH_FRAGMENT.paneHtml}\n    </section>`,
    `    <section id="pane-link" class="pane" data-tab="link" hidden>\n      ${LINK_FRAGMENT.paneHtml}\n    </section>`,
  ].join("\n");
  const scripts = [ROUTER_SCRIPT, SHELL_SCRIPT, BOARD_SCRIPT, PUBLISH_FRAGMENT.script, LINK_FRAGMENT.script]
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
    <div class="search"><input id="search" type="text" spellcheck="false" autocomplete="off" placeholder="Filter by key, tag, file…"></div>
  </header>
  <main>
${panes}
  </main>
${scripts}
</body>
</html>`;
}
