import { escapeHtml } from "../utils/webview";
import { errMsg, scrubJwtLike } from "../utils/text";
import { PublishRequest, PublishTarget } from "./contracts";
import { AttachmentSuggestion, PublishDialogModel, PublishDialogResult, PublishRunOption } from "./publish-flow";
import { SurfaceFragment, SurfaceHost } from "./webview-host";

const IMPORT_HINT = "Create → POST /import/execution/cucumber/multipart · Append → POST /import/execution";
const IDLE_HINT = "Pick a run to publish and its details appear here.";

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

// A run's pending-attachments banner after an in-dialog retry: the still-failing count, or no banner at
// all once nothing is left. The same move the webview makes on a `pending-result`.
function withPending(run: PublishRunOption, remaining: number): PublishRunOption {
  if (remaining > 0 && run.pendingAttachments) {
    return { ...run, pendingAttachments: { key: run.pendingAttachments.key, count: remaining } };
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
  // The live present: its resolver and the model the tab is currently showing. The model is amended as
  // the dialog's own actions change it, so what a re-hydration replays is the run the user last saw and
  // never the present-time snapshot.
  private pending: { model: PublishDialogModel; resolve: (result: PublishDialogResult | undefined) => void } | undefined;
  private searchController: AbortController | undefined;

  constructor(
    private readonly host: SurfaceHost,
    private readonly delegate: PublishDialogDelegate,
    private readonly startPublish: () => void
  ) {
    host.onMessage((message) => this.handle(message as PublishIncoming));
    host.onDidDispose(() => this.dispose());
  }

  // Hydrate the tab with a run model and await the user's decision. A present while one is pending
  // resolves the prior as undefined (supersede), then re-hydrates.
  public present(model: PublishDialogModel): Promise<PublishDialogResult | undefined> {
    this.resolvePending(undefined);
    this.searchController?.abort();
    this.searchController = undefined;
    this.host.post({ type: "model", model });
    this.host.activate();
    return new Promise<PublishDialogResult | undefined>((resolve) => {
      this.pending = { model, resolve };
    });
  }

  // A rebuilt webview (window reload, a move between editor groups) comes back on the idle hint, so a
  // present still waiting repaints its run rather than stranding the user in front of a dead tab.
  public rehydrate(): void {
    if (this.pending) {
      this.host.post({ type: "model", model: this.pending.model });
    }
  }

  // Called in the flow's finally: clears the busy state to an idle placeholder, staying on the Publish
  // tab (toasts convey the outcome). A no-op when a newer present has already superseded this one.
  public markSettled(): void {
    if (this.pending) {
      return;
    }
    this.host.post({ type: "settled" });
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
    if (this.pending) {
      this.pending = { ...this.pending, model: update(this.pending.model) };
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
      const reason = scrubJwtLike(errMsg(error));
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

  function republishText(n) {
    const when = new Date(n.publishedAt).toLocaleString();
    const mode = n.mode === 'append' ? 'appended' : (n.mode === 'create-new' ? 'new execution' : '');
    const modePart = mode ? ' (' + mode + ')' : '';
    return 'Already published to ' + n.key + ' on ' + when + modePart + '. Publishing again creates a duplicate.';
  }
  function pendingText(n) {
    const files = n.count === 1 ? 'file' : 'files';
    return n.count + ' attachment ' + files + ' from the last publish to ' + n.key + ' did not upload.';
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

  function show(which) {
    idleBox.hidden = which !== 'idle';
    busyBox.hidden = which !== 'busy';
    formBox.hidden = which !== 'form';
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
    runSelect.textContent = '';
    runs.forEach(function (run) {
      const opt = document.createElement('option');
      opt.value = run.id;
      opt.textContent = run.label;
      if (run.id === selectedRunId) { opt.selected = true; }
      runSelect.appendChild(opt);
    });
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
    show('form');
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
    } else if (msg.type === 'settled') {
      show('idle');
    } else if (msg.type === 'search-result') {
      const listEl = msg.kind === 'execution' ? execResults : (msg.kind === 'project' ? projectResults : planResults);
      if (listEl.__token !== msg.token) { return; }
      const items = msg.error ? [] : msg.items;
      renderResults(listEl, msg.kind === 'project' ? mergedProjectItems(items) : items);
    } else if (msg.type === 'browse-result') {
      for (const file of msg.items) { addAttachmentRow(file); }
    } else if (msg.type === 'pending-result') {
      const run = findRun(msg.runId);
      if (run) {
        run.pendingAttachments = msg.remaining > 0 && run.pendingAttachments
          ? { key: run.pendingAttachments.key, count: msg.remaining }
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
