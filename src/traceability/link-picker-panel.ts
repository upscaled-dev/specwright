import { LinkedRow, LinkPickerRow, LinkPickerUi } from "./link-picker-flow";
import { SurfaceFragment, SurfaceHost } from "./webview-host";

export interface LinkPickerPanelOptions {
  readonly title: string;
  readonly searchPlaceholder: string;
}

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
interface OpenLinkedMessage {
  type: "openLinked";
  key: string;
}
interface UnlinkMessage {
  type: "unlink";
  key: string;
}
type LinkIncoming = SearchMessage | ConfirmMessage | CancelMessage | OpenLinkedMessage | UnlinkMessage;

// One live link-picker session on the board's contextual Link tab. It implements the vscode-free
// `LinkPickerUi` port so `runLinkPickerFlow` drives it; the webview JS stays thin (render + keyboard +
// forward intent). `settled` guards the terminal confirm/cancel; `closed` stops posts once the flow
// closes it.
class LinkSession implements LinkPickerUi {
  private searchHandler: ((value: string) => void) | undefined;
  private confirmHandler: ((id: string) => void) | undefined;
  private cancelHandler: (() => void) | undefined;
  private openLinkedHandler: ((key: string) => void) | undefined;
  private unlinkHandler: ((key: string) => void) | undefined;
  private settled = false;
  private closed = false;

  constructor(
    private readonly host: SurfaceHost,
    private readonly onClose: () => void
  ) {}

  public setRows(rows: readonly LinkPickerRow[]): void {
    this.post({ type: "rows", rows });
  }

  public setLinked(rows: readonly LinkedRow[]): void {
    this.post({ type: "linked", rows });
  }

  public setBusy(busy: boolean): void {
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

  // Marks the session settled, hides the contextual Link tab (the shell returns to Mapping), and drops
  // the session from the surface. It does not dispose the shared document.
  public close(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.host.setTabVisible(false);
    this.onClose();
  }

  public handle(message: LinkIncoming): void {
    if (message.type === "confirm") {
      this.fireConfirm(message.id);
      return;
    }
    if (message.type === "cancel") {
      this.fireCancel();
      return;
    }
    if (this.settled) {
      return;
    }
    if (message.type === "search") {
      this.searchHandler?.(message.value);
    } else if (message.type === "openLinked") {
      this.openLinkedHandler?.(message.key);
    } else if (message.type === "unlink") {
      this.unlinkHandler?.(message.key);
    }
  }

  public fireCancel(): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.cancelHandler?.();
  }

  private fireConfirm(id: string): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.confirmHandler?.(id);
  }

  private post(message: object): void {
    if (this.closed || this.host.isDisposed()) {
      return;
    }
    this.host.post(message);
  }
}

/**
 * The Link Scenario picker, hosted on the board's contextual Link tab. Constructed once with a
 * `SurfaceHost`; `begin` supersedes any live session (firing its cancel), resets the pane, reveals the
 * Link tab, and returns a fresh `LinkPickerUi` session for `runLinkPickerFlow` to drive. Closing a
 * session hides the tab and returns to Mapping without tearing down the shared document.
 */
export class LinkSurface {
  private session: LinkSession | undefined;

  constructor(private readonly host: SurfaceHost) {
    host.onMessage((message) => this.session?.handle(message as LinkIncoming));
    host.onDidDispose(() => this.session?.fireCancel());
  }

  public begin(options: LinkPickerPanelOptions): LinkPickerUi {
    this.session?.fireCancel();
    const session = new LinkSession(this.host, () => {
      if (this.session === session) {
        this.session = undefined;
      }
    });
    this.session = session;
    this.host.post({ type: "reset", title: options.title, searchPlaceholder: options.searchPlaceholder });
    this.host.setTabVisible(true, options.title);
    this.host.activate();
    return session;
  }

  public dispose(): void {
    this.session?.fireCancel();
  }
}

const LINK_CSS = `
  #pane-link { max-width: 40rem; }
  #pane-link h1 { font-size: 1.15rem; font-weight: 600; margin: 0 0 0.75rem; }
  #pane-link h2.section-title { font-size: 0.8rem; font-weight: 600; text-transform: uppercase; letter-spacing: 0.04em; color: var(--vscode-descriptionForeground); margin: 0 0 0.4rem; }
  #pane-link h2.section-title.spaced { margin-top: 0.9rem; }
  #pane-link .linked-list { list-style: none; margin: 0 0 0.2rem; padding: 0; }
  #pane-link .linked-row { display: flex; align-items: baseline; gap: 0.6rem; padding: 0.35rem 0.5rem; border-radius: 3px; }
  #pane-link .linked-row .actions { margin-left: auto; display: flex; gap: 0.4rem; flex: none; }
  #pane-link .linked-row button {
    font-family: var(--vscode-font-family);
    font-size: 0.85em;
    color: var(--vscode-button-secondaryForeground, var(--vscode-foreground));
    background: var(--vscode-button-secondaryBackground, transparent);
    border: 1px solid var(--vscode-button-border, var(--vscode-widget-border, transparent));
    border-radius: 3px;
    padding: 0.15rem 0.5rem;
    cursor: pointer;
  }
  #pane-link .linked-row button:hover { background: var(--vscode-button-secondaryHoverBackground, var(--vscode-list-hoverBackground)); }
  #pane-link .warn { color: var(--vscode-list-warningForeground, var(--vscode-editorWarning-foreground)); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #pane-link input {
    width: 100%;
    box-sizing: border-box;
    padding: 0.5rem 0.6rem;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 3px;
  }
  #pane-link input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #pane-link .results { list-style: none; margin: 0.6rem 0 0; padding: 0; max-height: 45vh; overflow-y: auto; }
  #pane-link .row { display: flex; align-items: baseline; gap: 0.6rem; padding: 0.35rem 0.5rem; cursor: pointer; border-radius: 3px; }
  #pane-link .row.active { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); }
  #pane-link .key { font-family: var(--vscode-editor-font-family, monospace); color: var(--vscode-textLink-foreground); white-space: nowrap; }
  #pane-link .row.active .key { color: inherit; }
  #pane-link .summary { color: var(--vscode-descriptionForeground); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  #pane-link .row.active .summary { color: inherit; }
  #pane-link .create .create-label { font-style: italic; color: var(--vscode-textLink-foreground); }
  #pane-link .row.active .create-label { color: inherit; }
  #pane-link .hint-row { cursor: default; color: var(--vscode-descriptionForeground); font-style: italic; }
  #pane-link .footer { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin: 0.75rem 0 0; }
  #pane-link .busy { font-style: italic; }
  #pane-link [hidden] { display: none !important; }`;

const LINK_PANE = `<h1 id="link-title"></h1>
      <div id="link-linked-section" hidden>
        <h2 class="section-title">Linked</h2>
        <ul id="link-linked" class="linked-list"></ul>
        <h2 class="section-title spaced">Link another test</h2>
      </div>
      <input id="link-search" type="text" spellcheck="false" autocomplete="off" placeholder="">
      <ul id="link-results" class="results"></ul>
      <p class="footer">Enter to confirm · Esc to cancel <span id="link-busy" class="busy" hidden>· Searching…</span></p>`;

const LINK_SCRIPT = `
  const linkPane = document.getElementById('pane-link');
  const title = document.getElementById('link-title');
  const search = document.getElementById('link-search');
  const results = document.getElementById('link-results');
  const linkedSection = document.getElementById('link-linked-section');
  const linkedList = document.getElementById('link-linked');
  const busy = document.getElementById('link-busy');
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
      open.addEventListener('click', function () { window.__spec.post('link', { type: 'openLinked', key: row.key }); });
      const unlink = document.createElement('button');
      unlink.type = 'button';
      unlink.textContent = 'Unlink';
      unlink.addEventListener('click', function () { window.__spec.post('link', { type: 'unlink', key: row.key }); });
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
    if (row && row.kind !== 'hint') { window.__spec.post('link', { type: 'confirm', id: row.id }); }
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
    window.__spec.post('link', { type: 'search', value: search.value });
  });

  document.addEventListener('keydown', function (event) {
    if (linkPane.hidden) { return; }
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Enter') { event.preventDefault(); confirmRow(highlightedIndex); }
    else if (event.key === 'Escape') { event.preventDefault(); window.__spec.post('link', { type: 'cancel' }); }
  });

  window.__spec.register('link', function (msg) {
    if (msg.type === 'reset') {
      title.textContent = msg.title;
      search.placeholder = msg.searchPlaceholder;
      search.value = '';
      rows = [];
      linkedRows = [];
      highlightedId = null;
      highlightedIndex = -1;
      busy.hidden = true;
      renderLinked();
      render();
      setTimeout(function () { search.focus(); }, 0);
    } else if (msg.type === 'rows') {
      rows = msg.rows || [];
      render();
    } else if (msg.type === 'linked') {
      linkedRows = msg.rows || [];
      renderLinked();
    } else if (msg.type === 'busy') {
      busy.hidden = !msg.busy;
    }
  });`;

export const LINK_FRAGMENT: SurfaceFragment = {
  css: LINK_CSS,
  paneHtml: LINK_PANE,
  script: LINK_SCRIPT,
};
