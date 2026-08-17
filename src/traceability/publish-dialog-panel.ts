import type { Disposable, Event } from "vscode";
import { escapeHtml } from "../utils/webview";
import { errMsg, serverText } from "../utils/text";
import { PublishTarget } from "./contracts";
import { AttachmentSuggestion, PublishDialogModel, PublishDialogResult, PublishRunOption } from "./publish-flow";
import { SurfaceFragment, SurfaceHost } from "./webview-host";
import { WEBVIEW_ATTACHMENT_LIMIT, type PublishClientMessage } from "../webview/protocol";

const IMPORT_HINT = "Create → POST /import/execution/cucumber/multipart · Append → POST /import/execution";
const IDLE_HINT = "Pick a run to publish and its details appear here.";
// The dialog is open but its run history emptied underneath it (a clear, or every run aged out). A form
// over no runs would offer a Publish button with nothing behind it.
const NO_RUNS_HINT = "No runs left to publish. Run some tests and they appear here.";
const ATTACHMENT_LIMIT_HINT = `Choose at most ${WEBVIEW_ATTACHMENT_LIMIT} attachments.`;

// The still-pending count after an in-dialog attach-pending action; 0 clears the banner.
export interface PendingAttachmentsResult {
  readonly remaining: number;
}

// The delegate the surface calls back into. `searchTargets` rejects (NotSupportedError) without Jira
// creds; the surface only calls it when `jiraSearchAvailable`. `browseFiles` opens the native file
// picker behind a mockable seam (the surface never imports `showOpenDialog` directly, so the unit rig
// can drive it) and returns the picked files with their sizes. `attachPending` uploads a run's ledgered
// pending files WITHOUT a reimport and returns how many still failed.
export interface PublishDialogDelegate {
  searchTargets(
    kind: "execution" | "test-plan" | "project",
    query: string,
    signal?: AbortSignal
  ): Promise<readonly PublishTarget[]>;
  browseFiles(): Promise<readonly AttachmentSuggestion[]>;
  attachPending(runId: string): Promise<PendingAttachmentsResult>;
  // The local run history changed. The dialog outlives the moment its list was built (the user runs tests
  // and comes back to it), so it re-derives the dropdown from `runOptions` rather than showing what the
  // store held when it opened.
  readonly onDidChangeRuns: Event<void>;
  runOptions(): readonly PublishRunOption[];
}

// One command-level publish attempt. The identity is closed over here so every present/retry/finally
// callback can prove it still owns the surface before changing terminal UI.
export interface PublishFlowSession {
  present(model: PublishDialogModel): Promise<PublishDialogResult | undefined>;
  presentRetry(selectedRunId: string): Promise<PublishDialogResult | undefined>;
  markSettled(): boolean;
  isLatest(): boolean;
}

// The pick that still stands: the one asked for while its run is offered, else the newest run there is,
// else nothing. Both the in-place refresh and the retry answer the same question about a moved list.
function selectionAmong(runs: readonly PublishRunOption[], preferred: string): string {
  return runs.some((run) => run.id === preferred) ? preferred : (runs[0]?.id ?? "");
}

// A run's pending-attachments banner after an in-dialog retry: the still-failing count, or no banner at
// all once nothing is left. The same move the webview makes on a `pending-result`.
function withPending(run: PublishRunOption, remaining: number): PublishRunOption {
  if (remaining > 0 && run.pendingAttachments) {
    return { ...run, pendingAttachments: { target: run.pendingAttachments.target, count: remaining } };
  }
  return { ...run, pendingAttachments: undefined };
}

/**
 * The View 3 publish dialog, hosted as the board's permanent Publish tab. Constructed once with a
 * `SurfaceHost`, the delegate, and a `startPublish` callback (invoked when the user activates the tab
 * with no publish underway). `present` hydrates the tab with a run model and resolves to the confirmed
 * `PublishDialogResult`, or `undefined` on cancel/close/supersede, the flow's zero-transport signal.
 * The surface owns run selection and search/browse/attach seams; the webview paints the run dropdown,
 * banners, and form from the posted model.
 */
export class PublishSurface {
  // The live present's resolver, when one is waiting.
  private pending: { resolve: (result: PublishDialogResult | undefined) => void } | undefined;
  // The model the tab is showing, amended as the dialog's own actions change it, so a re-hydration and a
  // retry both replay the run the user last saw and never the present-time snapshot.
  private model: PublishDialogModel | undefined;
  // Whether the document that painted `model` is still standing. A rebuilt webview comes back blank, so
  // the retry's lightweight reveal would show an empty form with a live Publish button.
  private painted = false;
  private searchController: AbortController | undefined;
  private readonly pendingUploads = new Set<string>();
  private attachmentWarning: string | undefined;
  private generation = 0;
  private flowGeneration = 0;
  private activeFlow: number | undefined;
  private publishing = false;
  private readonly runsSubscription: Disposable;

  constructor(
    private readonly host: SurfaceHost<"publish">,
    private readonly delegate: PublishDialogDelegate,
    private readonly startPublish: () => void
  ) {
    host.onMessage((message) => this.handle(message));
    host.onDidDispose(() => this.dispose());
    // Off the mutation path: the store announces a change as it seals a run, and re-deriving the options
    // re-reads every publishable run's source. The hop keeps that off the caller that just sealed.
    this.runsSubscription = delegate.onDidChangeRuns(() => queueMicrotask(() => this.refreshRuns()));
  }

  public beginFlow(): PublishFlowSession {
    const identity = ++this.flowGeneration;
    this.generation += 1;
    this.resolvePending(undefined);
    this.searchController?.abort();
    this.searchController = undefined;
    this.activeFlow = identity;
    return {
      present: (model) => this.presentFor(identity, model),
      presentRetry: (selectedRunId) => this.presentRetryFor(identity, selectedRunId),
      markSettled: () => this.markSettledFor(identity),
      isLatest: () => this.flowGeneration === identity,
    };
  }

  private presentFor(identity: number, model: PublishDialogModel): Promise<PublishDialogResult | undefined> {
    if (this.activeFlow !== identity) {
      return Promise.resolve(undefined);
    }
    this.generation += 1;
    this.resolvePending(undefined);
    this.searchController?.abort();
    this.searchController = undefined;
    this.publishing = false;
    this.setModel(model);
    this.paint();
    this.host.activate();
    return this.arm();
  }

  // A publish that failed leaves the dialog unfinished, so the tab comes back off Publishing… on the run
  // the user picked, and the present goes live again so the retry's confirm has a resolver waiting. While
  // the document that painted the form is still standing that is a reveal, keeping every field they filled
  // in; once it has been rebuilt there is nothing left to reveal, so the model is painted in full instead.
  //
  // Either way the reveal carries the run list AS IT STANDS: the busy window is exactly when a run seals or
  // ages out, and a dropdown that still showed the old one would send the retry at a run that is gone.
  // Resolves undefined at once when the board is gone or a newer present already owns the tab.
  private presentRetryFor(identity: number, selectedRunId: string): Promise<PublishDialogResult | undefined> {
    if (this.activeFlow !== identity || this.pending || this.model === undefined || this.host.isDisposed()) {
      return Promise.resolve(undefined);
    }
    const runs = this.model.runs;
    this.model = { ...this.model, selectedRunId: selectionAmong(runs, selectedRunId) };
    this.publishing = false;
    if (this.painted) {
      this.host.post({ type: "retry", runs, selectedRunId: this.model.selectedRunId });
      this.replayBusy();
    } else {
      this.paint();
    }
    this.host.activate();
    return this.arm();
  }

  private arm(): Promise<PublishDialogResult | undefined> {
    return new Promise<PublishDialogResult | undefined>((resolve) => {
      this.pending = { resolve };
    });
  }

  private paint(): void {
    if (this.model === undefined) {return;}
    this.host.post({ type: "model", model: this.model });
    this.replayBusy();
    if (this.attachmentWarning) {
      this.host.post({ type: "attachment-error", text: this.attachmentWarning });
    }
    this.painted = true;
  }

  private replayBusy(): void {
    this.host.post({ type: "publish-busy", busy: this.publishing });
    for (const runId of this.pendingUploads) {
      this.host.post({ type: "pending-busy", runId, busy: true });
    }
  }

  private setModel(model: PublishDialogModel): void {
    const suggestions = model.attachments.suggestions;
    this.attachmentWarning = suggestions.length > WEBVIEW_ATTACHMENT_LIMIT ? ATTACHMENT_LIMIT_HINT : undefined;
    this.model = suggestions.length > WEBVIEW_ATTACHMENT_LIMIT
      ? {
          ...model,
          attachments: { ...model.attachments, suggestions: suggestions.slice(0, WEBVIEW_ATTACHMENT_LIMIT) },
        }
      : model;
  }

  // A rebuilt webview (window reload, a move between editor groups) comes back on the idle hint with a
  // blank form, so a present still waiting repaints its run rather than stranding the user in front of a
  // dead tab, and one that has already been answered records that its paint is gone.
  public rehydrate(): void {
    this.painted = false;
    if ((this.pending || this.publishing) && this.model !== undefined) {
      this.paint();
    }
  }

  // A run recorded while the dialog sits open belongs in the dropdown without a reopen. Nothing is built
  // unless a dialog is actually live: re-deriving the options re-reads every publishable run's source, and
  // the tab has nowhere to put them.
  //
  // A publish in flight (the confirm resolved, the busy pane up) owns both the screen and the pick it went
  // out with, so the fresh list rides the model and nothing is posted: moving the selection there would
  // stomp the very form the retry promises to restore. The retry's own reveal carries the list on.
  //
  // The `painted` check guards an invariant rather than a live case: every route that arms a pending paints
  // first, so a pending present always has a painted document behind it.
  private refreshRuns(): void {
    const model = this.model;
    if (model === undefined || this.host.isDisposed()) {
      return;
    }
    const runs = this.delegate.runOptions();
    if (this.pending === undefined) {
      this.model = { ...model, runs };
      return;
    }
    const selectedRunId = selectionAmong(runs, model.selectedRunId);
    this.model = { ...model, runs, selectedRunId };
    if (this.painted) {
      this.host.post({ type: "runs", runs, selectedRunId });
      this.replayBusy();
    }
  }

  // Called in the flow's finally: clears the busy state to an idle placeholder, staying on the Publish
  // tab (toasts convey the outcome). False when a newer present has already superseded this one, which
  // is also what tells the settling flow it no longer owns the tab.
  //
  // Settling for a flow that still owned the tab also retires the model: the tab now shows the idle hint,
  // so there is nothing left for a retry to come back to. Without that, a publish still in flight from an
  // EARLIER flow could fail later and re-arm itself over whatever model a newer one had left behind.
  private markSettledFor(identity: number): boolean {
    if (this.activeFlow !== identity || this.pending) {
      return false;
    }
    this.activeFlow = undefined;
    this.model = undefined;
    this.painted = false;
    this.publishing = false;
    this.host.post({ type: "settled" });
    return true;
  }

  // The user activated the Publish tab: start a fresh publish only when none is underway; otherwise the
  // shell has already re-activated the in-progress form.
  public onManualActivate(): void {
    if (this.activeFlow !== undefined || this.pending || this.publishing) {
      if (!this.painted && this.model !== undefined) {
        this.paint();
      } else if (this.model !== undefined) {
        this.replayBusy();
      }
      return;
    }
    this.startPublish();
  }

  public dispose(): void {
    this.generation += 1;
    this.activeFlow = undefined;
    this.resolvePending(undefined);
    this.searchController?.abort();
    this.searchController = undefined;
    this.runsSubscription.dispose();
  }

  private handle(message: PublishClientMessage): void {
    if (message.type === "cancel") {
      if (!this.pending) {
        this.host.post(this.publishing ? { type: "publish-busy", busy: true } : { type: "settled" });
        return;
      }
      this.generation += 1;
      this.searchController?.abort();
      this.searchController = undefined;
      this.publishing = false;
      this.resolvePending(undefined);
      this.host.post({ type: "settled" });
      this.host.activate("board");
    } else if (message.type === "confirm") {
      if (this.authorizeConfirm(message)) {
        this.publishing = true;
        this.host.post({ type: "publish-busy", busy: true });
        this.resolvePending({ runId: message.runId, request: message.request, attachments: message.attachments });
      }
    } else if (message.type === "selectRun") {
      if (this.pending && this.model?.runs.some((run) => run.id === message.runId)) {
        this.model = { ...this.model, selectedRunId: message.runId };
      }
    } else if (message.type === "search") {
      this.runSearch(message).catch(() => undefined);
    } else if (message.type === "browse") {
      this.runBrowse().catch(() => undefined);
    } else if (message.type === "attachPending") {
      this.runAttachPending(message).catch(() => undefined);
    }
  }

  private authorizeConfirm(message: Extract<PublishClientMessage, { type: "confirm" }>): boolean {
    const model = this.model;
    if (this.settled() || message.runId !== model?.selectedRunId ||
        model.runs.some((run) => run.id === message.runId) !== true) {
      return false;
    }
    if (message.request.mode === "append") {
      if (message.request.executionKey.trim() === "") {return false;}
    } else if (message.request.project.trim() === "" || message.request.summary.trim() === "") {
      return false;
    }
    if (message.attachments.length > WEBVIEW_ATTACHMENT_LIMIT) {
      this.host.post({ type: "attachment-error", text: ATTACHMENT_LIMIT_HINT });
      return false;
    }
    const offered = new Set(model.attachments.suggestions
      .filter((file) => file.size <= model.attachments.uploadLimitBytes)
      .map((file) => file.path));
    const selected = new Set(message.attachments);
    if (selected.size !== message.attachments.length ||
        (message.attachments.length > 0 && (!model.attachments.available || message.attachments.some((path) => !offered.has(path))))) {
      this.host.post({ type: "attachment-error", text: "Choose attachments from the files currently offered." });
      return false;
    }
    return true;
  }

  private resolvePending(result: PublishDialogResult | undefined): void {
    const pending = this.pending;
    if (!pending) {
      return;
    }
    this.pending = undefined;
    pending.resolve(result);
  }

  // The picked files ride the model as further suggestions, which is how the webview paints them, so a
  // re-hydration brings back the rows the user chose instead of an empty attachment list.
  private async runBrowse(): Promise<void> {
    const model = this.model;
    const generation = this.generation;
    if (this.settled() || !model?.attachments.available) {
      return;
    }
    const files = await this.delegate.browseFiles();
    if (this.settled() || this.generation !== generation) {
      return;
    }
    const existing = new Set(this.model?.attachments.suggestions.map((file) => file.path));
    const novel: AttachmentSuggestion[] = [];
    for (const file of files) {
      if (!existing.has(file.path)) {
        existing.add(file.path);
        novel.push(file);
      }
    }
    if (existing.size > WEBVIEW_ATTACHMENT_LIMIT) {
      this.host.post({ type: "attachment-error", text: ATTACHMENT_LIMIT_HINT });
      return;
    }
    this.amend((model) => ({
      ...model,
      attachments: { ...model.attachments, suggestions: [...model.attachments.suggestions, ...novel] },
    }));
    this.host.post({ type: "browse-result", items: novel.map((f) => ({ path: f.path, name: f.name, size: f.size })) });
  }

  private async runAttachPending(message: Extract<PublishClientMessage, { type: "attachPending" }>): Promise<void> {
    const model = this.model;
    const generation = this.generation;
    const run = model?.runs.find((candidate) => candidate.id === message.runId);
    if (this.settled() || message.runId !== model?.selectedRunId || !run?.pendingAttachments) {
      this.host.post({ type: "pending-busy", runId: message.runId, busy: this.pendingUploads.has(message.runId) });
      return;
    }
    if (this.pendingUploads.has(message.runId)) {
      this.host.post({ type: "pending-busy", runId: message.runId, busy: true });
      return;
    }
    this.pendingUploads.add(message.runId);
    this.host.post({ type: "pending-busy", runId: message.runId, busy: true });
    try {
      const result = await this.delegate.attachPending(message.runId);
      if (this.host.isDisposed() || this.generation !== generation || this.model === undefined) {
        return;
      }
      this.amend((model) => ({
        ...model,
        runs: model.runs.map((candidate) => (
          candidate.id === message.runId ? withPending(candidate, result.remaining) : candidate
        )),
      }));
      this.host.post({ type: "pending-result", runId: message.runId, remaining: result.remaining });
    } catch (error) {
      if (!this.host.isDisposed() && this.generation === generation && this.model !== undefined) {
        this.host.post({ type: "attachment-error", text: `Attaching pending files failed: ${serverText(errMsg(error))}` });
      }
    } finally {
      this.pendingUploads.delete(message.runId);
      if (!this.host.isDisposed()) {
        this.host.post({ type: "pending-busy", runId: message.runId, busy: false });
      }
    }
  }

  private amend(update: (model: PublishDialogModel) => PublishDialogModel): void {
    if (this.model !== undefined) {
      this.model = update(this.model);
    }
  }

  private async runSearch(message: Extract<PublishClientMessage, { type: "search" }>): Promise<void> {
    if (this.settled() || !this.model?.jiraSearchAvailable) {
      return;
    }
    this.searchController?.abort();
    const controller = new AbortController();
    this.searchController = controller;
    try {
      const targets = await this.delegate.searchTargets(message.kind, message.query, controller.signal);
      if (controller.signal.aborted || this.settled()) {
        return;
      }
      this.host.post({
        type: "search-result",
        token: message.token,
        kind: message.kind,
        items: targets.map((t) => ({ key: t.ref.key, label: t.label })),
      });
    } catch (error) {
      if (controller.signal.aborted || this.settled()) {
        return;
      }
      const reason = serverText(errMsg(error));
      this.host.post({ type: "search-result", token: message.token, kind: message.kind, items: [], error: reason });
    }
  }

  // A response is stale once the present has resolved (confirm/cancel/supersede) or the panel is gone.
  private settled(): boolean {
    return this.pending === undefined || this.host.isDisposed();
  }
}

const PUBLISH_CSS = `
  #pane-publish { max-width: 34rem; }
  #pane-publish .idle { color: var(--vscode-descriptionForeground); font-style: italic; padding: 0.5rem 0; }
  #pane-publish .busy { color: var(--vscode-descriptionForeground); font-style: italic; padding: 0.5rem 0; }
  #pane-publish h1 { font-size: 1.3rem; font-weight: 600; margin: 0 0 0.25rem; }
  #pane-publish .subtitle { color: var(--vscode-descriptionForeground); margin: 0.75rem 0 1rem; }
  #pane-publish .banner {
    color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
    background: var(--vscode-inputValidation-warningBackground, transparent);
    border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-focusBorder));
    border-radius: 3px;
    padding: 0.5rem 0.65rem;
    margin: 0 0 1rem;
  }
  #pane-publish .banner.pending { display: flex; align-items: center; gap: 0.6rem; }
  #pane-publish .banner.pending span { flex: 1; }
  #pane-publish fieldset { border: none; margin: 0; padding: 0; }
  #pane-publish .radio-row { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.5rem; }
  #pane-publish label { display: block; margin-top: 1rem; font-weight: 600; }
  #pane-publish .radio-row label { display: inline; margin: 0; font-weight: 400; }
  #pane-publish input[type="text"], #pane-publish select {
    width: 100%;
    box-sizing: border-box;
    margin-top: 0.35rem;
    padding: 0.4rem 0.5rem;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
    font-family: inherit;
    font-size: inherit;
  }
  #pane-publish input:focus, #pane-publish select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  #pane-publish .hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 0.25rem; }
  #pane-publish .field-error { color: var(--vscode-errorForeground); font-size: 0.85em; min-height: 1.1em; margin-top: 0.25rem; }
  #pane-publish .results { list-style: none; margin: 0.35rem 0 0; padding: 0; border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
  #pane-publish .results:empty { display: none; border: none; }
  #pane-publish .results li { padding: 0.35rem 0.5rem; cursor: pointer; }
  #pane-publish .results li:hover { background: var(--vscode-list-hoverBackground); }
  #pane-publish .results li.search-error { color: var(--vscode-errorForeground); cursor: default; }
  #pane-publish .results li.search-error:hover { background: none; }
  #pane-publish .attach-list { list-style: none; margin: 0.5rem 0 0; padding: 0; }
  #pane-publish .attach-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.3rem 0; }
  #pane-publish .attach-row .name { flex: 1; min-width: 0; overflow-wrap: anywhere; }
  #pane-publish .attach-row .size { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  #pane-publish .attach-row .over { color: var(--vscode-errorForeground); font-size: 0.85em; }
  #pane-publish .disabled-note { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 0.5rem; font-style: italic; }
  #pane-publish .actions { display: flex; gap: 0.6rem; margin-top: 1.5rem; }
  #pane-publish button { padding: 0.45rem 0.9rem; border: none; border-radius: 2px; cursor: pointer; font-family: inherit; }
  #pane-publish button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  #pane-publish button.primary:hover { background: var(--vscode-button-hoverBackground); }
  #pane-publish button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  #pane-publish button.link { background: none; color: var(--vscode-textLink-foreground); padding: 0; text-align: left; flex: none; }
  #pane-publish .footer { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 1.25rem; }`;

const PUBLISH_PANE = `<div id="publish-idle" class="idle">${escapeHtml(IDLE_HINT)}</div>
      <div id="publish-empty" class="idle" hidden>${escapeHtml(NO_RUNS_HINT)}</div>
      <div id="publish-busy" class="busy" role="status" aria-live="polite" hidden>Publishing…</div>
      <div id="publish-form" hidden>
        <h1 id="publish-title"></h1>

        <label for="run-select">Run</label>
        <select id="run-select"></select>

        <p class="subtitle" id="subtitle" aria-live="polite"></p>
        <div id="banners" role="status" aria-live="polite"></div>

        <fieldset>
          <div class="radio-row">
            <input type="radio" id="mode-create" name="publish-mode" value="create-new" checked>
            <label for="mode-create">Create new execution</label>
          </div>
          <div class="radio-row">
            <input type="radio" id="mode-append" name="publish-mode" value="append">
            <label for="mode-append">Add to existing execution</label>
          </div>
        </fieldset>

        <div id="create-fields">
          <label for="project">Project key</label>
          <input id="project" type="text" spellcheck="false" autocapitalize="characters" aria-invalid="false" aria-describedby="project-hint err-project">
          <ul id="project-results" class="results"></ul>
          <div class="hint" id="project-hint" hidden>from this run's test keys</div>
          <div id="err-project" class="field-error" aria-live="polite"></div>

          <label for="summary">Summary</label>
          <input id="summary" type="text" aria-invalid="false" aria-describedby="err-summary">
          <div id="err-summary" class="field-error" aria-live="polite"></div>

          <label for="plan">Test Plan key (optional)</label>
          <input id="plan" type="text" spellcheck="false" autocapitalize="characters">
          <ul id="plan-results" class="results"></ul>

          <label for="environments">Environments (optional, comma-separated)</label>
          <input id="environments" type="text" spellcheck="false">
        </div>

        <div id="append-fields" hidden>
          <label for="execution">Execution key</label>
          <input id="execution" type="text" spellcheck="false" autocapitalize="characters" aria-invalid="false" aria-describedby="exec-hint err-execution">
          <p class="hint" id="exec-hint"></p>
          <ul id="exec-results" class="results"></ul>
          <div id="err-execution" class="field-error" aria-live="polite"></div>
        </div>

        <label>Run-level attachments</label>
        <p class="hint" id="attach-hint" role="status" aria-live="polite"></p>
        <ul id="attach-list" class="attach-list"></ul>
        <button id="browse" class="link" type="button" hidden>Add files…</button>
        <p class="disabled-note" id="attach-disabled" hidden></p>

        <div class="actions">
          <button id="publish" class="primary" type="button">Publish</button>
          <button id="cancel" class="secondary" type="button">Cancel</button>
        </div>
        <p class="footer">${escapeHtml(IMPORT_HINT)}</p>
      </div>`;

export const PUBLISH_FRAGMENT: SurfaceFragment = {
  css: PUBLISH_CSS,
  paneHtml: PUBLISH_PANE,
};
