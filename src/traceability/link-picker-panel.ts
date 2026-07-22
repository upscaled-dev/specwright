import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { LinkPickerRow, LinkPickerUi } from "./link-picker-flow";

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
type IncomingMessage = SearchMessage | ConfirmMessage | CancelMessage | ReadyMessage;

interface RowsMessage {
  type: "rows";
  rows: readonly LinkPickerRow[];
}
interface BusyMessage {
  type: "busy";
  busy: boolean;
}
type OutgoingMessage = RowsMessage | BusyMessage;

export interface LinkPickerPanelOptions {
  readonly title: string;
  readonly searchPlaceholder: string;
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderHtml(options: LinkPickerPanelOptions): string {
  const nonce = randomBytes(16).toString("hex");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
      <input id="search" type="text" spellcheck="false" autocomplete="off" placeholder="${escapeHtml(options.searchPlaceholder)}" autofocus>
      <ul id="results" class="results"></ul>
      <p class="footer">Enter to confirm · Esc to cancel <span id="busy" class="busy" hidden>· Searching…</span></p>
    </div>
  </div>
<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const search = document.getElementById('search');
  const results = document.getElementById('results');
  const busy = document.getElementById('busy');
  let rows = [];
  let highlightedId = null;
  let highlightedIndex = -1;

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
  private settled = false;
  private disposed = false;
  private lastRows: readonly LinkPickerRow[] = [];
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
