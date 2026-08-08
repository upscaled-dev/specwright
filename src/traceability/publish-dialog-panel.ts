import type { Disposable, Event } from "vscode";
import { escapeHtml } from "../utils/webview";
import { errMsg, serverText } from "../utils/text";
import { PublishRequest, PublishTarget } from "./contracts";
import { AttachmentSuggestion, PublishDialogModel, PublishDialogResult, PublishRunOption } from "./publish-flow";
import { SurfaceFragment, SurfaceHost } from "./webview-host";

const IMPORT_HINT = "Create → POST /import/execution/cucumber/multipart · Append → POST /import/execution";
const IDLE_HINT = "Pick a run to publish and its details appear here.";
// The dialog is open but its run history emptied underneath it (a clear, or every run aged out). A form
// over no runs would offer a Publish button with nothing behind it.
const NO_RUNS_HINT = "No runs left to publish. Run some tests and they appear here.";

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

interface SearchMessage {
  type: "search";
  token: number;
  kind: "execution" | "test-plan" | "project";
  query: string;
}
interface BrowseMessage {
  type: "browse";
}
interface ConfirmMessage {
  type: "confirm";
  runId: string;
  request: PublishRequest;
  attachments: string[];
}
interface AttachPendingMessage {
  type: "attachPending";
  runId: string;
}
interface CancelMessage {
  type: "cancel";
}
type PublishIncoming = SearchMessage | BrowseMessage | ConfirmMessage | AttachPendingMessage | CancelMessage;

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
  private readonly runsSubscription: Disposable;

  constructor(
    private readonly host: SurfaceHost,
    private readonly delegate: PublishDialogDelegate,
    private readonly startPublish: () => void
  ) {
    host.onMessage((message) => this.handle(message as PublishIncoming));
    host.onDidDispose(() => this.dispose());
    // Off the mutation path: the store announces a change as it seals a run, and re-deriving the options
    // re-reads every publishable run's source. The hop keeps that off the caller that just sealed.
    this.runsSubscription = delegate.onDidChangeRuns(() => queueMicrotask(() => this.refreshRuns()));
  }

  // Hydrate the tab with a run model and await the user's decision. A present while one is pending
  // resolves the prior as undefined (supersede), then re-hydrates.
  public present(model: PublishDialogModel): Promise<PublishDialogResult | undefined> {
    this.resolvePending(undefined);
    this.searchController?.abort();
    this.searchController = undefined;
    this.model = model;
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
  public presentRetry(selectedRunId: string): Promise<PublishDialogResult | undefined> {
    if (this.pending || this.model === undefined || this.host.isDisposed()) {
      return Promise.resolve(undefined);
    }
    const runs = this.model.runs;
    this.model = { ...this.model, selectedRunId: selectionAmong(runs, selectedRunId) };
    if (this.painted) {
      this.host.post({ type: "retry", runs, selectedRunId: this.model.selectedRunId });
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
    this.host.post({ type: "model", model: this.model });
    this.painted = true;
  }

  // A rebuilt webview (window reload, a move between editor groups) comes back on the idle hint with a
  // blank form, so a present still waiting repaints its run rather than stranding the user in front of a
  // dead tab, and one that has already been answered records that its paint is gone.
  public rehydrate(): void {
    this.painted = false;
    if (this.pending && this.model !== undefined) {
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
    }
  }

  // Called in the flow's finally: clears the busy state to an idle placeholder, staying on the Publish
  // tab (toasts convey the outcome). False when a newer present has already superseded this one, which
  // is also what tells the settling flow it no longer owns the tab.
  //
  // Settling for a flow that still owned the tab also retires the model: the tab now shows the idle hint,
  // so there is nothing left for a retry to come back to. Without that, a publish still in flight from an
  // EARLIER flow could fail later and re-arm itself over whatever model a newer one had left behind.
  public markSettled(): boolean {
    if (this.pending) {
      return false;
    }
    this.model = undefined;
    this.painted = false;
    this.host.post({ type: "settled" });
    return true;
  }

  // The user activated the Publish tab: start a fresh publish only when none is underway; otherwise the
  // shell has already re-activated the in-progress form.
  public onManualActivate(): void {
    if (this.pending) {
      return;
    }
    this.startPublish();
  }

  public dispose(): void {
    this.resolvePending(undefined);
    this.searchController?.abort();
    this.runsSubscription.dispose();
  }

  private handle(message: PublishIncoming): void {
    if (message.type === "cancel") {
      this.resolvePending(undefined);
      this.host.activate("board");
    } else if (message.type === "confirm") {
      this.resolvePending({ runId: message.runId, request: message.request, attachments: message.attachments });
    } else if (message.type === "search") {
      this.runSearch(message).catch(() => undefined);
    } else if (message.type === "browse") {
      this.runBrowse().catch(() => undefined);
    } else if (message.type === "attachPending") {
      this.runAttachPending(message).catch(() => undefined);
    }
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
    const files = await this.delegate.browseFiles();
    if (this.settled()) {
      return;
    }
    this.amend((model) => ({
      ...model,
      attachments: { ...model.attachments, suggestions: [...model.attachments.suggestions, ...files] },
    }));
    this.host.post({ type: "browse-result", items: files.map((f) => ({ path: f.path, name: f.name, size: f.size })) });
  }

  private async runAttachPending(message: AttachPendingMessage): Promise<void> {
    const result = await this.delegate.attachPending(message.runId);
    if (this.settled()) {
      return;
    }
    this.amend((model) => ({
      ...model,
      runs: model.runs.map((run) => (run.id === message.runId ? withPending(run, result.remaining) : run)),
    }));
    this.host.post({ type: "pending-result", runId: message.runId, remaining: result.remaining });
  }

  private amend(update: (model: PublishDialogModel) => PublishDialogModel): void {
    if (this.model !== undefined) {
      this.model = update(this.model);
    }
  }

  private async runSearch(message: SearchMessage): Promise<void> {
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
      <div id="publish-busy" class="busy" hidden>Publishing…</div>
      <div id="publish-form" hidden>
        <h1 id="publish-title"></h1>

        <label for="run-select">Run</label>
        <select id="run-select"></select>

        <p class="subtitle" id="subtitle"></p>
        <div id="banners"></div>

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
          <input id="project" type="text" spellcheck="false" autocapitalize="characters">
          <ul id="project-results" class="results"></ul>
          <div class="hint" id="project-hint" hidden>from this run's test keys</div>
          <div id="err-project" class="field-error"></div>

          <label for="summary">Summary</label>
          <input id="summary" type="text">
          <div id="err-summary" class="field-error"></div>

          <label for="plan">Test Plan key (optional)</label>
          <input id="plan" type="text" spellcheck="false" autocapitalize="characters">
          <ul id="plan-results" class="results"></ul>

          <label for="environments">Environments (optional, comma-separated)</label>
          <input id="environments" type="text" spellcheck="false">
        </div>

        <div id="append-fields" hidden>
          <label for="execution">Execution key</label>
          <input id="execution" type="text" spellcheck="false" autocapitalize="characters">
          <p class="hint" id="exec-hint"></p>
          <ul id="exec-results" class="results"></ul>
          <div id="err-execution" class="field-error"></div>
        </div>

        <label>Run-level attachments</label>
        <p class="hint" id="attach-hint"></p>
        <ul id="attach-list" class="attach-list"></ul>
        <button id="browse" class="link" type="button" hidden>Add files…</button>
        <p class="disabled-note" id="attach-disabled" hidden></p>

        <div class="actions">
          <button id="publish" class="primary" type="button">Publish</button>
          <button id="cancel" class="secondary" type="button">Cancel</button>
        </div>
        <p class="footer">${escapeHtml(IMPORT_HINT)}</p>
      </div>`;

const PUBLISH_SCRIPT = `
  const idleBox = document.getElementById('publish-idle');
  const emptyBox = document.getElementById('publish-empty');
  const busyBox = document.getElementById('publish-busy');
  const formBox = document.getElementById('publish-form');
  const titleEl = document.getElementById('publish-title');
  const runSelect = document.getElementById('run-select');
  const subtitle = document.getElementById('subtitle');
  const banners = document.getElementById('banners');
  const createFields = document.getElementById('create-fields');
  const appendFields = document.getElementById('append-fields');
  const projectInput = document.getElementById('project');
  const projectHint = document.getElementById('project-hint');
  const summaryInput = document.getElementById('summary');
  const planInput = document.getElementById('plan');
  const envInput = document.getElementById('environments');
  const execInput = document.getElementById('execution');
  const execResults = document.getElementById('exec-results');
  const planResults = document.getElementById('plan-results');
  const projectResults = document.getElementById('project-results');
  const errProject = document.getElementById('err-project');
  const errSummary = document.getElementById('err-summary');
  const errExecution = document.getElementById('err-execution');
  const execHint = document.getElementById('exec-hint');
  const attachHint = document.getElementById('attach-hint');
  const attachList = document.getElementById('attach-list');
  const browseButton = document.getElementById('browse');
  const attachDisabled = document.getElementById('attach-disabled');
  const modeCreate = document.getElementById('mode-create');

  let runs = [];
  let selectedRunId = null;
  let searchable = false;
  let knownKeys = [];
  let attachModel = { available: false, suggestions: [], uploadLimitBytes: 0, evidenceStream: 'evidence' };
  let seenPaths = new Set();
  let token = 0;
  const timers = {};

  function findRun(id) { return runs.find(function (r) { return r.id === id; }); }

  // Both banners print the target the host resolved (a key, or its phrase for a publish the import
  // response never named); neither works out what to call it.
  function republishText(n) {
    const when = new Date(n.publishedAt).toLocaleString();
    if (n.outcomeUnknown) {
      return 'The previous publish possibly succeeded on ' + when + ' (correlation ' + n.operationId + '). Check Xray before explicitly publishing again; another publish may create a duplicate.';
    }
    const mode = n.mode === 'append' ? 'appended' : (n.mode === 'create-new' ? 'new execution' : '');
    const modePart = mode ? ' (' + mode + ')' : '';
    return 'Already published to ' + n.target + ' on ' + when + modePart + '. Publishing again creates a duplicate.';
  }
  function pendingText(n) {
    const files = n.count === 1 ? 'file' : 'files';
    return n.count + ' attachment ' + files + ' from the last publish to ' + n.target + ' did not upload.';
  }
  function evidenceStreamLine(stream) {
    if (stream === 'issue') { return "Per-test evidence uploads to the execution's Jira issue (xray.attachTo)."; }
    if (stream === 'both') { return "Per-test evidence rides the result payload and the Jira issue (xray.attachTo)."; }
    return "Per-test evidence rides the result payload (xray.attachTo).";
  }
  function attachHintText(att) {
    return evidenceStreamLine(att.evidenceStream) + " These run-level files always attach to the execution's Jira issue.";
  }
  function renderBanners(run) {
    banners.textContent = '';
    if (run.republish) {
      const div = document.createElement('div');
      div.className = 'banner';
      div.textContent = republishText(run.republish);
      banners.appendChild(div);
    }
    if (run.pendingAttachments) {
      const div = document.createElement('div');
      div.className = 'banner pending';
      const span = document.createElement('span');
      span.textContent = pendingText(run.pendingAttachments);
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'link';
      btn.textContent = 'Attach pending files';
      btn.addEventListener('click', function () { window.__spec.post('publish', { type: 'attachPending', runId: run.id }); });
      div.appendChild(span);
      div.appendChild(btn);
      banners.appendChild(div);
    }
  }
  // Switching runs re-derives everything the selected run owns: subtitle, project prefill + hint,
  // the summary default, the plan prefill, and both banners.
  function applyRun(run) {
    subtitle.textContent = run.subtitle;
    projectInput.value = run.project.value;
    projectHint.hidden = !run.project.fromDerivation && !run.project.fromScope;
    projectHint.textContent = run.project.fromScope ? "from the board's project scope" : "from this run's test keys";
    summaryInput.value = run.defaultSummary;
    planInput.value = run.prefillPlanKey || '';
    clearResults(projectResults);
    renderBanners(run);
  }

  function formatSize(bytes) {
    if (bytes >= 1024 * 1024) { return (bytes / (1024 * 1024)).toFixed(1) + ' MB'; }
    if (bytes >= 1024) { return Math.round(bytes / 1024) + ' KB'; }
    return bytes + ' B';
  }

  function addAttachmentRow(file) {
    if (seenPaths.has(file.path)) { return; }
    seenPaths.add(file.path);
    const over = file.size > attachModel.uploadLimitBytes;
    const row = document.createElement('li');
    row.className = 'attach-row';
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.className = 'attach-check';
    check.checked = !over;
    check.disabled = over;
    check.dataset.path = file.path;
    const name = document.createElement('span');
    name.className = 'name';
    name.textContent = file.name;
    const size = document.createElement('span');
    size.className = 'size';
    size.textContent = formatSize(file.size);
    row.appendChild(check);
    row.appendChild(name);
    row.appendChild(size);
    if (over) {
      const warn = document.createElement('span');
      warn.className = 'over';
      warn.textContent = 'over limit';
      row.appendChild(warn);
    }
    attachList.appendChild(row);
  }

  function selectedAttachments() {
    const paths = [];
    if (attachModel.available) {
      for (const cb of document.querySelectorAll('.attach-check')) {
        if (cb.checked && !cb.disabled) { paths.push(cb.dataset.path); }
      }
    }
    return paths;
  }

  function currentMode() {
    return document.querySelector('input[name="publish-mode"]:checked').value;
  }

  function applyMode() {
    const append = currentMode() === 'append';
    appendFields.hidden = !append;
    createFields.hidden = append;
  }

  function runSearch(kind, query, listEl, targetInput) {
    if (!searchable) { return; }
    const myToken = ++token;
    clearTimeout(timers[kind]);
    timers[kind] = setTimeout(function () {
      window.__spec.post('publish', { type: 'search', token: myToken, kind: kind, query: query });
    }, 400);
    listEl.__token = myToken;
    listEl.__input = targetInput;
  }

  // A cleared list also retires its token, so a debounced response still in flight cannot repaint a
  // field the user has already committed or dismissed.
  function clearResults(listEl) {
    listEl.textContent = '';
    listEl.__token = -1;
  }

  // A failed search prints why, above whatever local matches still stand: an empty list alone reads
  // as "no such issue", which is the one thing a failure does not tell us.
  function renderSearchError(listEl, message) {
    const li = document.createElement('li');
    li.className = 'search-error';
    li.textContent = message;
    listEl.insertBefore(li, listEl.firstChild);
  }

  function renderResults(listEl, items) {
    listEl.textContent = '';
    for (const item of items) {
      const li = document.createElement('li');
      li.textContent = item.label;
      // mousedown, not click: the list must commit before the input's blur can dismiss it.
      li.addEventListener('mousedown', function () {
        listEl.__input.value = item.key;
        clearResults(listEl);
      });
      listEl.appendChild(li);
    }
  }

  function matchingKnownKeys(query) {
    const needle = query.toLowerCase();
    return knownKeys.filter(function (key) { return needle === '' || key.toLowerCase().indexOf(needle) >= 0; });
  }

  // Known project keys are local data, so this list renders with or without Jira search; a live result
  // for the same query merges over it when one arrives.
  function showKnownKeys(query) {
    projectResults.__input = projectInput;
    renderResults(projectResults, matchingKnownKeys(query).map(function (key) { return { key: key, label: key }; }));
  }

  // A remote hit wins its slot; the local keys the site did not return still follow, so a project known
  // only from the workspace's own config stays reachable.
  function mergedProjectItems(items) {
    const merged = items.slice();
    const seen = new Set(items.map(function (item) { return item.key; }));
    for (const key of matchingKnownKeys(projectInput.value.trim())) {
      if (!seen.has(key)) { merged.push({ key: key, label: key }); }
    }
    return merged;
  }

  // The pane on screen, tracked here because the webview moves it on its own (a click shows busy, Cancel
  // shows idle) a whole postMessage hop before the host learns of it. A host-driven update that arrives
  // inside that hop must not overrule what the user is looking at.
  let visible = 'idle';

  function show(which) {
    visible = which;
    idleBox.hidden = which !== 'idle';
    emptyBox.hidden = which !== 'empty';
    busyBox.hidden = which !== 'busy';
    formBox.hidden = which !== 'form';
  }

  // The pane a run list implies, but only where the user is already reading the run list. Busy belongs to
  // a publish in flight and idle to a dialog that has finished; neither is the host's to take back.
  function showForRuns() {
    if (visible === 'form' || visible === 'empty') { show(runs.length === 0 ? 'empty' : 'form'); }
  }

  // The dropdown and the selection the host now holds. The fields follow only when the pick actually
  // moved, which happens only when the run the user had chosen stopped being offered; everything else on
  // the form is theirs. Shared by the in-place refresh and the retry, which carries the same list.
  function applyRuns(msg) {
    const had = selectedRunId;
    runs = msg.runs || [];
    selectedRunId = msg.selectedRunId;
    renderRunOptions();
    const selected = findRun(selectedRunId);
    if (selected && selectedRunId !== had) { applyRun(selected); }
  }

  // The dropdown alone, off whatever runs and selection are in hand. A whole-model paint and an in-place
  // run refresh build it the same way; only the refresh leaves the rest of the form standing.
  function renderRunOptions() {
    runSelect.textContent = '';
    runs.forEach(function (run) {
      const opt = document.createElement('option');
      opt.value = run.id;
      opt.textContent = run.label;
      if (run.id === selectedRunId) { opt.selected = true; }
      runSelect.appendChild(opt);
    });
  }

  // Repaint the whole form from a fresh run model, clearing every mutable field first so a second
  // present never inherits the previous run's dropdown, banners, prefill, attach rows, or mode.
  function applyModel(model) {
    runs = model.runs || [];
    selectedRunId = model.selectedRunId;
    searchable = !!model.jiraSearchAvailable;
    knownKeys = model.knownProjectKeys || [];
    attachModel = model.attachments;
    seenPaths = new Set();
    titleEl.textContent = model.title;
    renderRunOptions();
    const selected = findRun(selectedRunId) || runs[0];
    errProject.textContent = '';
    errSummary.textContent = '';
    errExecution.textContent = '';
    execInput.value = '';
    envInput.value = '';
    clearResults(execResults);
    clearResults(planResults);
    clearResults(projectResults);
    modeCreate.checked = true;
    applyMode();
    execHint.textContent = searchable
      ? 'Type a project key to search its Test Executions, or type an execution key directly.'
      : 'Type the execution key to append to. Add Jira access in Xray setup to search instead.';
    attachList.textContent = '';
    if (attachModel.available) {
      attachHint.hidden = false;
      attachHint.textContent = attachHintText(attachModel);
      attachDisabled.hidden = true;
      browseButton.hidden = false;
      (attachModel.suggestions || []).forEach(addAttachmentRow);
    } else {
      attachHint.hidden = true;
      browseButton.hidden = true;
      attachDisabled.hidden = false;
      attachDisabled.textContent = attachModel.reason || 'Add Jira access in Xray setup to attach run-level files.';
    }
    if (selected) { selectedRunId = selected.id; applyRun(selected); }
    // A whole-model paint over an emptied list reaches here through a reload or a retry on a rebuilt
    // document, and a form with nothing in its dropdown offers a Publish button with nothing behind it.
    show(runs.length === 0 ? 'empty' : 'form');
  }

  runSelect.addEventListener('change', function () {
    selectedRunId = runSelect.value;
    const run = findRun(selectedRunId);
    if (run) { applyRun(run); }
  });
  for (const radio of document.querySelectorAll('input[name="publish-mode"]')) {
    radio.addEventListener('change', applyMode);
  }
  execInput.addEventListener('input', function () { runSearch('execution', execInput.value.trim(), execResults, execInput); });
  planInput.addEventListener('input', function () { runSearch('test-plan', planInput.value.trim(), planResults, planInput); });
  projectInput.addEventListener('focus', function () { showKnownKeys(''); });
  projectInput.addEventListener('input', function () {
    const query = projectInput.value.trim();
    showKnownKeys(query);
    runSearch('project', query, projectResults, projectInput);
  });
  projectInput.addEventListener('blur', function () { clearResults(projectResults); });
  projectInput.addEventListener('keydown', function (event) {
    if (event.key === 'Escape') { clearResults(projectResults); }
  });

  document.getElementById('cancel').addEventListener('click', function () {
    show('idle');
    window.__spec.post('publish', { type: 'cancel' });
  });

  document.getElementById('publish').addEventListener('click', function () {
    errProject.textContent = '';
    errSummary.textContent = '';
    errExecution.textContent = '';
    const attachments = selectedAttachments();
    if (currentMode() === 'append') {
      const executionKey = execInput.value.trim();
      if (executionKey === '') { errExecution.textContent = 'Enter the execution key to append to.'; return; }
      show('busy');
      window.__spec.post('publish', { type: 'confirm', runId: selectedRunId, request: { mode: 'append', executionKey: executionKey }, attachments: attachments });
      return;
    }
    const project = projectInput.value.trim();
    if (project === '') { errProject.textContent = 'Enter the project key to create the execution in.'; return; }
    const summary = summaryInput.value.trim();
    if (summary === '') { errSummary.textContent = 'Enter a summary for the new execution.'; return; }
    const environments = envInput.value.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
    const request = { mode: 'create-new', project: project, summary: summary };
    const plan = planInput.value.trim();
    if (plan !== '') { request.testPlanKey = plan; }
    if (environments.length > 0) { request.environments = environments; }
    show('busy');
    window.__spec.post('publish', { type: 'confirm', runId: selectedRunId, request: request, attachments: attachments });
  });

  window.__spec.register('publish', function (msg) {
    if (msg.type === 'model') {
      applyModel(msg.model);
    } else if (msg.type === 'runs') {
      // The list always lands; the pane only follows where the run list is what the user is reading.
      applyRuns(msg);
      showForRuns();
    } else if (msg.type === 'retry') {
      // A failed publish comes back to the form, and it comes back to the list as it stands now: runs
      // recorded while the publish was out are offered, and evicted ones are not.
      applyRuns(msg);
      show(runs.length === 0 ? 'empty' : 'form');
    } else if (msg.type === 'settled') {
      show('idle');
    } else if (msg.type === 'search-result') {
      const listEl = msg.kind === 'execution' ? execResults : (msg.kind === 'project' ? projectResults : planResults);
      if (listEl.__token !== msg.token) { return; }
      const items = msg.error ? [] : msg.items;
      renderResults(listEl, msg.kind === 'project' ? mergedProjectItems(items) : items);
      if (msg.error) { renderSearchError(listEl, 'Search failed: ' + msg.error); }
    } else if (msg.type === 'browse-result') {
      for (const file of msg.items) { addAttachmentRow(file); }
    } else if (msg.type === 'pending-result') {
      const run = findRun(msg.runId);
      if (run) {
        run.pendingAttachments = msg.remaining > 0 && run.pendingAttachments
          ? { target: run.pendingAttachments.target, count: msg.remaining }
          : undefined;
        if (msg.runId === selectedRunId) { renderBanners(run); }
      }
    }
  });`;

export const PUBLISH_FRAGMENT: SurfaceFragment = {
  css: PUBLISH_CSS,
  paneHtml: PUBLISH_PANE,
  script: PUBLISH_SCRIPT,
};
