import { LinkedRow, LinkPickerRow, LinkPickerUi } from "./link-picker-flow";
import { SurfaceFragment, SurfaceHost } from "./webview-host";
import type { LinkClientMessage, LinkHostMessage } from "../webview/protocol";

export interface LinkPickerPanelOptions {
  readonly title: string;
  readonly searchPlaceholder: string;
}

// One live link-picker session on the board's contextual Link tab. It implements the vscode-free
// `LinkPickerUi` port so `runLinkPickerFlow` drives it; the webview JS stays thin (render + keyboard +
// forward intent). `settled` guards the terminal confirm/cancel; `closed` stops posts once the flow
// closes it.
class LinkSession implements LinkPickerUi {
  // The last of each message this session put on screen, in the order it first posted them, so a
  // rebuilt webview can be painted back to where the flow left it.
  private readonly painted = new Map<LinkHostMessage["type"], LinkHostMessage>();
  private searchHandler: ((value: string) => void) | undefined;
  private confirmHandler: ((id: string) => void) | undefined;
  private cancelHandler: (() => void) | undefined;
  private openLinkedHandler: ((key: string) => void) | undefined;
  private unlinkHandler: ((key: string) => void) | undefined;
  private readonly offeredIds = new Set<string>();
  private readonly linkedKeys = new Set<string>();
  private settled = false;
  private closed = false;

  constructor(
    private readonly host: SurfaceHost<"link">,
    private readonly options: LinkPickerPanelOptions,
    private readonly onClose: () => void
  ) {
    this.painted.set("reset", {
      type: "reset",
      title: options.title,
      searchPlaceholder: options.searchPlaceholder,
    });
  }

  // Everything this session owns on screen: its contextual tab and every message it has painted since,
  // starting with the reset that clears the pane. Drives both the first paint and a re-hydration; the
  // tab it brings forward is the shell's call, not the session's.
  public paint(): void {
    if (!this.live()) {
      return;
    }
    this.host.setTabVisible(true, this.options.title);
    for (const message of this.painted.values()) {
      this.post(message);
    }
  }

  public setRows(rows: readonly LinkPickerRow[]): void {
    this.offeredIds.clear();
    rows.forEach((row) => {
      if (row.kind !== "hint") {this.offeredIds.add(row.id);}
    });
    this.post({ type: "rows", rows });
  }

  public setLinked(rows: readonly LinkedRow[]): void {
    this.linkedKeys.clear();
    rows.forEach((row) => this.linkedKeys.add(row.key));
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

  public handle(message: LinkClientMessage): void {
    if (message.type === "confirm") {
      if (this.offeredIds.has(message.id)) {this.fireConfirm(message.id);}
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
      if (this.linkedKeys.has(message.key)) {this.openLinkedHandler?.(message.key);}
    } else if (message.type === "unlink") {
      if (this.linkedKeys.has(message.key)) {this.unlinkHandler?.(message.key);}
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

  // Nothing this session emits, pane message or contextual tab, may outlive the session or the document.
  private live(): boolean {
    return !this.closed && !this.host.isDisposed();
  }

  private post(message: LinkHostMessage): void {
    if (!this.live()) {
      return;
    }
    this.painted.set(message.type, message);
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

  constructor(private readonly host: SurfaceHost<"link">) {
    host.onMessage((message) => this.session?.handle(message));
    host.onDidDispose(() => this.session?.fireCancel());
  }

  public begin(options: LinkPickerPanelOptions): LinkPickerUi {
    this.session?.fireCancel();
    const session = new LinkSession(this.host, options, () => {
      if (this.session === session) {
        this.session = undefined;
      }
    });
    this.session = session;
    session.paint();
    this.host.activate();
    return session;
  }

  // A rebuilt webview lost the pane and the contextual tab with it, so a live session paints itself
  // back. Nothing to do when none is live: the fresh document already hides the tab.
  public rehydrate(): void {
    this.session?.paint();
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
  #pane-link .results { list-style: none; margin: 0.6rem 0 0; padding: 0; }
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
  #pane-link .busy { font-style: italic; }`;

const LINK_PANE = `<h1 id="link-title"></h1>
      <div id="link-linked-section" hidden>
        <h2 class="section-title">Linked</h2>
        <ul id="link-linked" class="linked-list"></ul>
        <h2 class="section-title spaced">Link another test</h2>
      </div>
      <input id="link-search" type="text" role="combobox" aria-autocomplete="list" aria-expanded="false" aria-controls="link-results" spellcheck="false" autocomplete="off" placeholder="">
      <ul id="link-results" class="results" role="listbox"></ul>
      <p class="footer">Enter to confirm · Esc to cancel <span id="link-busy" class="busy" role="status" aria-live="polite" hidden>· Searching…</span></p>`;

export const LINK_FRAGMENT: SurfaceFragment = {
  css: LINK_CSS,
  paneHtml: LINK_PANE,
};
