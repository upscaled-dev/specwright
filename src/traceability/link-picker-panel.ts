import * as vscode from "vscode";
import { contentSecurityPolicy, createNonce, escapeHtml } from "../utils/webview";
import { LinkedRow, LinkPickerRow, LinkPickerUi } from "./link-picker-flow";

const VIEW_TYPE = "playwrightBddRunner.linkScenario";

interface SearchMessage {
  type: "search";
  value: string;
}
interface ConfirmMessage {
  type: "confirm";
  id: string;
}
interface CancelMessage {
  type: "cancel";
}
interface ReadyMessage {
  type: "ready";
}
interface OpenLinkedMessage {
  type: "openLinked";
  key: string;
}
interface UnlinkMessage {
  type: "unlink";
  key: string;
}
type IncomingMessage =
  | SearchMessage
  | ConfirmMessage
  | CancelMessage
  | ReadyMessage
  | OpenLinkedMessage
  | UnlinkMessage;

interface RowsMessage {
  type: "rows";
  rows: readonly LinkPickerRow[];
}
interface LinkedMessage {
  type: "linked";
  rows: readonly LinkedRow[];
}
interface BusyMessage {
  type: "busy";
  busy: boolean;
}
type OutgoingMessage = RowsMessage | LinkedMessage | BusyMessage;

export interface LinkPickerPanelOptions {
  readonly title: string;
  readonly searchPlaceholder: string;
}

function renderHtml(options: LinkPickerPanelOptions): string {
  const nonce = createNonce();
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(nonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(options.title)}</title>
<style>
  body { margin: 0; font-family: var(--vscode-font-family); font-size: var(--vscode-font-size); color: var(--vscode-foreground); }
  .backdrop {
    position: fixed;
    inset: 0;
    display: flex;
    align-items: flex-start;
    justify-content: center;
    padding-top: 12vh;
    background: rgba(0, 0, 0, 0.4);
  }
  .card {
    width: min(90vw, 34rem);
    box-sizing: border-box;
    padding: 1.1rem 1.25rem 1rem;
    background: var(--vscode-editorWidget-background, var(--vscode-editor-background));
    border: 1px solid var(--vscode-widget-border, var(--vscode-focusBorder));
    border-radius: 6px;
    box-shadow: 0 8px 24px rgba(0, 0, 0, 0.4);
  }
  h1 { font-size: 1.15rem; font-weight: 600; margin: 0 0 0.75rem; }
  h2.section-title { font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); margin: 0 0 0.4rem; }
  h2.section-title.spaced { margin-top: 0.9rem; }
  .linked-list { list-style: none; margin: 0 0 0.2rem; padding: 0; }
  .linked-row { display: flex; align-items: baseline; gap: 0.6rem; padding: 0.35rem 0.5rem; border-radius: 3px; }
  .linked-row .actions { margin-left: auto; display: flex; gap: 0.4rem; flex: none; }
  .linked-row button {
    font-family: var(--vscode-font-family);
    font-size: 0.85em;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-button-border, var(--vscode-widget-border, transparent));
    border-radius: 3px;
    padding: 0.15rem 0.5rem;
    cursor: pointer;
  }
  .linked-row button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
  .warn { color: var(--vscode-list-warningForeground, var(--vscode-editorWarning-foreground)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  input {
    width: 100%;
    box-sizing: border-box;
    padding: 0.5rem 0.6rem;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px;
  }
  input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .results { list-style: none; margin: 0.6rem 0 0; padding: 0; max-height: 45vh; overflow-y: auto; }
  .row { display: flex; align-items: baseline; gap: 0.6rem; padding: 0.35rem 0.5rem; cursor: pointer; border-radius: 3px; }
  .row.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  .key { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground); white-space: nowrap; }
  .row.active .key { color: inherit; }
  .summary { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .row.active .summary { color: inherit; }
  .create .create-label { font-style: italic; color: var(--vscode-textLink-foreground); }
  .row.active .create-label { color: inherit; }
  .hint-row { cursor: default; color: var(--vscode-descriptionForeground); font-style: italic; }
  .footer { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin: 0.75rem 0 0; }
  .busy { font-style: italic; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
  <div class="backdrop">
    <div class="card" role="dialog" aria-label="${escapeHtml(options.title)}">
      <h1>${escapeHtml(options.title)}</h1>
      <div id="linkedSection" hidden>
        <h2 class="section-title">Linked</h2>
        <ul id="linked" class="linked-list"></ul>
        <h2 class="section-title spaced">Link another test</h2>
      </div>
      <input id="search" type="text" spellcheck="false" autocomplete="off" placeholder="${escapeHtml(options.searchPlaceholder)}" autofocus>
      <ul id="results" class="results"></ul>
      <p class="footer">Enter to confirm · Esc to cancel <span id="busy" class="busy" hidden>· Searching…</span></p>
    </div>
  </div>
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const search = document.getElementById('search');
  const results = document.getElementById('results');
  const linkedSection = document.getElementById('linkedSection');
  const linkedList = document.getElementById('linked');
  const busy = document.getElementById('busy');
  let rows = [];
  let linkedRows = [];
  let highlightedId = null;
  let highlightedIndex = -1;

  // The "Linked" section sits outside the navigable results list, so its rows are inherently skipped
  // by the arrow keys and Enter — they are informational and carry only mouse actions.
  function renderLinked() {
    linkedSection.hidden = linkedRows.length === 0;
    linkedList.textContent = '';
    linkedRows.forEach(function (row) {
      const li = document.createElement('li');
      li.className = 'linked-row';
      const key = document.createElement('span');
      key.className = 'key';
      key.textContent = row.key;
      li.appendChild(key);
      if (row.remoteMissing) {
        const warn = document.createElement('span');
        warn.className = 'warn';
        warn.textContent = '⚠ not found on remote';
        li.appendChild(warn);
      } else if (row.summary) {
        const summary = document.createElement('span');
        summary.className = 'summary';
        summary.textContent = row.summary;
        li.appendChild(summary);
      }
      const actions = document.createElement('span');
      actions.className = 'actions';
      const open = document.createElement('button');
      open.type = 'button';
      open.textContent = 'Open in Jira';
      open.addEventListener('click', function () { vscodeApi.postMessage({ type: 'openLinked', key: row.key }); });
      const unlink = document.createElement('button');
      unlink.type = 'button';
      unlink.textContent = 'Unlink';
      unlink.addEventListener('click', function () { vscodeApi.postMessage({ type: 'unlink', key: row.key }); });
      actions.appendChild(open);
      actions.appendChild(unlink);
      li.appendChild(actions);
      linkedList.appendChild(li);
    });
  }

  function navigable() {
    const out = [];
    rows.forEach(function (row, index) { if (row.kind !== 'hint') { out.push(index); } });
    return out;
  }

  // Preserve the highlight on the same row id across re-renders (so a debounced remote append doesn't
  // yank it to the top); if that row is gone, clamp to the navigable row nearest the old position.
  function resolveHighlight() {
    const nav = navigable();
    if (nav.length === 0) { highlightedId = null; highlightedIndex = -1; return; }
    let index = rows.findIndex(function (row) { return row.id === highlightedId; });
    if (index < 0 || rows[index].kind === 'hint') {
      const target = highlightedIndex < 0 ? nav[0] : highlightedIndex;
      index = nav.reduce(function (best, candidate) {
        return Math.abs(candidate - target) < Math.abs(best - target) ? candidate : best;
      }, nav[0]);
    }
    highlightedIndex = index;
    highlightedId = rows[index].id;
  }

  function render() {
    resolveHighlight();
    results.textContent = '';
    rows.forEach(function (row, index) {
      const li = document.createElement('li');
      const hint = row.kind === 'hint';
      li.className = 'row'
        + (row.kind === 'create' ? ' create' : '')
        + (hint ? ' hint-row' : '')
        + (index === highlightedIndex ? ' active' : '');
      if (hint) {
        const note = document.createElement('span');
        note.textContent = row.key;
        li.appendChild(note);
      } else if (row.kind === 'create') {
        const label = document.createElement('span');
        label.className = 'create-label';
        label.textContent = row.key;
        li.appendChild(label);
      } else {
        const key = document.createElement('span');
        key.className = 'key';
        key.textContent = row.key;
        li.appendChild(key);
        if (row.summary) {
          const summary = document.createElement('span');
          summary.className = 'summary';
          summary.textContent = row.summary;
          li.appendChild(summary);
        }
      }
      if (!hint) {
        li.addEventListener('click', function () { confirmRow(index); });
        li.addEventListener('mousemove', function () {
          if (highlightedId !== row.id) { highlightedId = row.id; highlightedIndex = index; render(); }
        });
      }
      results.appendChild(li);
    });
  }

  function confirmRow(index) {
    const row = rows[index];
    if (row && row.kind !== 'hint') { vscodeApi.postMessage({ type: 'confirm', id: row.id }); }
  }

  function move(delta) {
    const nav = navigable();
    if (nav.length === 0) { return; }
    let pos = nav.indexOf(highlightedIndex);
    if (pos < 0) { pos = 0; }
    pos = (pos + delta + nav.length) % nav.length;
    highlightedIndex = nav[pos];
    highlightedId = rows[highlightedIndex].id;
    render();
    const active = results.children[highlightedIndex];
    if (active) { active.scrollIntoView({ block: 'nearest' }); }
  }

  search.addEventListener('input', function () {
    vscodeApi.postMessage({ type: 'search', value: search.value });
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Enter') { event.preventDefault(); confirmRow(highlightedIndex); }
    else if (event.key === 'Escape') { event.preventDefault(); vscodeApi.postMessage({ type: 'cancel' }); }
  });

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg.type === 'rows') {
      rows = msg.rows || [];
      render();
    } else if (msg.type === 'linked') {
      linkedRows = msg.rows || [];
      renderLinked();
    } else if (msg.type === 'busy') {
      busy.hidden = !msg.busy;
    }
  });

  search.focus();
  vscodeApi.postMessage({ type: 'ready' });
</script>
</body>
</html>`;
}

/**
 * The Link Scenario picker webview — a centered modal card over a dimmed backdrop. Reuses the publish
 * dialog's plumbing (CSP, nonce'd script, theme-aware, no secrets → no MASK) and implements the
 * vscode-free `LinkPickerUi` port so the flow drives it. The webview JS is deliberately thin (render +
 * keyboard + forward intent); every decision lives in `runLinkPickerFlow`, so it is not unit-tested.
 */
export class LinkPickerPanel implements LinkPickerUi {
  private readonly disposables: vscode.Disposable[] = [];
  private searchHandler: ((value: string) => void) | undefined;
  private confirmHandler: ((id: string) => void) | undefined;
  private cancelHandler: (() => void) | undefined;
  private openLinkedHandler: ((key: string) => void) | undefined;
  private unlinkHandler: ((key: string) => void) | undefined;
  private settled = false;
  private disposed = false;
  private lastRows: readonly LinkPickerRow[] = [];
  private lastLinked: readonly LinkedRow[] = [];
  private lastBusy = false;

  private constructor(private readonly panel: vscode.WebviewPanel) {
    this.disposables.push(
      this.panel.onDidDispose(() => this.fireCancel()),
      this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message as IncomingMessage))
    );
  }

  public static open(options: LinkPickerPanelOptions): LinkPickerPanel {
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, options.title, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    });
    const instance = new LinkPickerPanel(panel);
    panel.webview.html = renderHtml(options);
    return instance;
  }

  public setRows(rows: readonly LinkPickerRow[]): void {
    this.lastRows = rows;
    this.post({ type: "rows", rows });
  }

  public setLinked(rows: readonly LinkedRow[]): void {
    this.lastLinked = rows;
    this.post({ type: "linked", rows });
  }

  public setBusy(busy: boolean): void {
    this.lastBusy = busy;
    this.post({ type: "busy", busy });
  }

  public onSearch(handler: (value: string) => void): void {
    this.searchHandler = handler;
  }

  public onConfirm(handler: (id: string) => void): void {
    this.confirmHandler = handler;
  }

  public onCancel(handler: () => void): void {
    this.cancelHandler = handler;
  }

  public onOpenLinked(handler: (key: string) => void): void {
    this.openLinkedHandler = handler;
  }

  public onUnlink(handler: (key: string) => void): void {
    this.unlinkHandler = handler;
  }

  public close(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    this.panel.dispose();
  }

  // The webview attaches its message listener before it can receive anything, then announces `ready`;
  // replaying the last state here closes the window where a row/busy post could race the load.
  private handleMessage(message: IncomingMessage): void {
    if (message.type === "ready") {
      this.post({ type: "linked", rows: this.lastLinked });
      this.post({ type: "rows", rows: this.lastRows });
      if (this.lastBusy) {
        this.post({ type: "busy", busy: true });
      }
      return;
    }
    if (this.settled) {
      return;
    }
    if (message.type === "search") {
      this.searchHandler?.(message.value);
    } else if (message.type === "confirm") {
      this.fireConfirm(message.id);
    } else if (message.type === "cancel") {
      this.fireCancel();
    } else if (message.type === "openLinked") {
      this.openLinkedHandler?.(message.key);
    } else if (message.type === "unlink") {
      this.unlinkHandler?.(message.key);
    }
  }

  private fireConfirm(id: string): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.confirmHandler?.(id);
  }

  private fireCancel(): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.cancelHandler?.();
  }

  private post(message: OutgoingMessage): void {
    if (this.disposed) {
      return;
    }
    Promise.resolve(this.panel.webview.postMessage(message)).catch(() => undefined);
  }
}
