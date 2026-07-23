import * as vscode from "vscode";
import { contentSecurityPolicy, createNonce, escapeHtml } from "../utils/webview";
import { PublishRequest, PublishTarget } from "./contracts";
import {
  AttachmentSuggestion,
  PendingAttachmentsNotice,
  PublishDialogModel,
  PublishDialogResult,
  PublishRunOption,
  RepublishNotice,
} from "./publish-flow";

const VIEW_TYPE = "playwrightBddRunner.publishResults";
const IMPORT_HINT = "Create → POST /import/execution/cucumber/multipart · Append → POST /import/execution";

// The still-pending count after an in-dialog attach-pending action; 0 clears the banner.
export interface PendingAttachmentsResult {
  readonly remaining: number;
}

// The delegate the dialog calls back into. `searchTargets` rejects (NotSupportedError) without Jira
// creds — the dialog only calls it when `jiraSearchAvailable`. `browseFiles` opens the native file
// picker behind a mockable seam (the panel never imports `showOpenDialog` directly, so the unit rig
// can drive it) and returns the picked files with their sizes. `attachPending` uploads a run's ledgered
// pending files WITHOUT a reimport and returns how many still failed.
export interface PublishDialogDelegate {
  searchTargets(kind: "execution" | "test-plan", query: string, signal?: AbortSignal): Promise<readonly PublishTarget[]>;
  browseFiles(): Promise<readonly AttachmentSuggestion[]>;
  attachPending(runId: string): Promise<PendingAttachmentsResult>;
}

interface SearchMessage {
  type: "search";
  token: number;
  kind: "execution" | "test-plan";
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
type IncomingMessage = SearchMessage | BrowseMessage | ConfirmMessage | AttachPendingMessage | CancelMessage;

type OutgoingMessage =
  | {
      type: "search-result";
      token: number;
      kind: "execution" | "test-plan";
      items: ReadonlyArray<{ readonly key: string; readonly label: string }>;
      error?: string | undefined;
    }
  | {
      type: "browse-result";
      items: ReadonlyArray<{ readonly path: string; readonly name: string; readonly size: number }>;
    }
  | { type: "pending-result"; runId: string; remaining: number };

// Serialize a value for embedding inside a nonce'd <script> block — only `<` can break out (`</script>`).
function embedJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

// The banner wording is shared with the webview JS (which rebuilds it when the dropdown changes), so
// both must produce the same text; keep these in sync with `republishText`/`pendingText` in the script.
function modeWord(mode: RepublishNotice["mode"]): string {
  if (mode === "append") {
    return "appended";
  }
  return mode === "create-new" ? "new execution" : "";
}

function republishBannerText(notice: RepublishNotice): string {
  const when = new Date(notice.publishedAt).toLocaleString();
  const mode = modeWord(notice.mode);
  const modePart = mode ? ` (${mode})` : "";
  return `Already published to ${notice.key} on ${when}${modePart}. Publishing again creates a duplicate.`;
}

function pendingBannerText(notice: PendingAttachmentsNotice): string {
  const files = notice.count === 1 ? "file" : "files";
  return `${notice.count} attachment ${files} from the last publish to ${notice.key} did not upload.`;
}

function bannersHtml(run: PublishRunOption): string {
  const parts: string[] = [];
  if (run.republish) {
    parts.push(`<div class="banner">${escapeHtml(republishBannerText(run.republish))}</div>`);
  }
  if (run.pendingAttachments) {
    parts.push(
      `<div class="banner pending"><span>${escapeHtml(pendingBannerText(run.pendingAttachments))}</span>` +
        `<button type="button" class="link" data-attach-pending>Attach pending files</button></div>`
    );
  }
  return parts.join("\n");
}

function runOptionsHtml(runs: readonly PublishRunOption[], selectedRunId: string): string {
  return runs
    .map(
      (run) =>
        `<option value="${escapeHtml(run.id)}"${run.id === selectedRunId ? " selected" : ""}>${escapeHtml(run.label)}</option>`
    )
    .join("\n");
}

function evidenceStreamLine(stream: PublishDialogModel["attachments"]["evidenceStream"]): string {
  if (stream === "issue") {
    return "Per-test evidence uploads to the execution's Jira issue (xray.attachTo).";
  }
  if (stream === "both") {
    return "Per-test evidence rides the result payload and the Jira issue (xray.attachTo).";
  }
  return "Per-test evidence rides the result payload (xray.attachTo).";
}

function attachmentsHint(stream: PublishDialogModel["attachments"]["evidenceStream"]): string {
  return `${evidenceStreamLine(stream)} These run-level files always attach to the execution's Jira issue.`;
}

function renderHtml(model: PublishDialogModel): string {
  const nonce = createNonce();
  const selected = model.runs.find((run) => run.id === model.selectedRunId) ?? model.runs[0];
  if (selected === undefined) {
    return "";
  }
  const planValue = escapeHtml(selected.prefillPlanKey ?? "");
  const attachModel = { ...model.attachments, hint: attachmentsHint(model.attachments.evidenceStream) };
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(nonce)}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Publish run results</title>
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 1.25rem;
    max-width: 34rem;
  }
  h1 { font-size: 1.3rem; font-weight: 600; margin: 0 0 0.25rem; }
  .subtitle { color: var(--vscode-descriptionForeground); margin: 0.75rem 0 1rem; }
  .banner {
    color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
    background: var(--vscode-inputValidation-warningBackground, transparent);
    border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-focusBorder));
    border-radius: 3px;
    padding: 0.5rem 0.65rem;
    margin: 0 0 1rem;
  }
  .banner.pending { display: flex; align-items: center; gap: 0.6rem; }
  .banner.pending span { flex: 1; }
  fieldset { border: none; margin: 0; padding: 0; }
  .radio-row { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.5rem; }
  label { display: block; margin-top: 1rem; font-weight: 600; }
  .radio-row label { display: inline; margin: 0; font-weight: 400; }
  input[type="text"], select {
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
  input:focus, select:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 0.25rem; }
  .field-error { color: var(--vscode-errorForeground); font-size: 0.85em; min-height: 1.1em; margin-top: 0.25rem; }
  .results { list-style: none; margin: 0.35rem 0 0; padding: 0; border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
  .results:empty { display: none; border: none; }
  .results li { padding: 0.35rem 0.5rem; cursor: pointer; }
  .results li:hover { background: var(--vscode-list-hoverBackground); }
  .attach-list { list-style: none; margin: 0.5rem 0 0; padding: 0; }
  .attach-row { display: flex; align-items: center; gap: 0.5rem; padding: 0.3rem 0; }
  .attach-row .name { flex: 1; }
  .attach-row .size { color: var(--vscode-descriptionForeground); font-size: 0.85em; }
  .attach-row .over { color: var(--vscode-errorForeground); font-size: 0.85em; }
  .disabled-note { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 0.5rem; font-style: italic; }
  [hidden] { display: none !important; }
  .actions { display: flex; gap: 0.6rem; margin-top: 1.5rem; }
  button { padding: 0.45rem 0.9rem; border: none; border-radius: 2px; cursor: pointer; font-family: inherit; }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  button.link { background: none; color: var(--vscode-textLink-foreground); padding: 0; text-align: left; flex: none; }
  .footer { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 1.25rem; }
</style>
</head>
<body>
  <h1>${escapeHtml(model.title)}</h1>

  <label for="run-select">Run</label>
  <select id="run-select">${runOptionsHtml(model.runs, selected.id)}</select>

  <p class="subtitle" id="subtitle">${escapeHtml(selected.subtitle)}</p>
  <div id="banners">${bannersHtml(selected)}</div>

  <fieldset>
    <div class="radio-row">
      <input type="radio" id="mode-create" name="mode" value="create-new" checked>
      <label for="mode-create">Create new execution</label>
    </div>
    <div class="radio-row">
      <input type="radio" id="mode-append" name="mode" value="append">
      <label for="mode-append">Add to existing execution</label>
    </div>
  </fieldset>

  <div id="create-fields">
    <label for="project">Project key</label>
    <input id="project" type="text" spellcheck="false" autocapitalize="characters" value="${escapeHtml(selected.project.value)}">
    <div class="hint" id="project-hint"${selected.project.fromDerivation ? "" : " hidden"}>from this run's test keys</div>
    <div id="err-project" class="field-error"></div>

    <label for="summary">Summary</label>
    <input id="summary" type="text" value="${escapeHtml(selected.defaultSummary)}">

    <label for="plan">Test Plan key (optional)</label>
    <input id="plan" type="text" spellcheck="false" autocapitalize="characters" value="${planValue}">
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

<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const searchable = ${model.jiraSearchAvailable ? "true" : "false"};
  const attachModel = ${embedJson(attachModel)};
  const runs = ${embedJson(model.runs)};
  let selectedRunId = ${embedJson(selected.id)};
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
  const errProject = document.getElementById('err-project');
  const errExecution = document.getElementById('err-execution');
  const execHint = document.getElementById('exec-hint');
  const attachHint = document.getElementById('attach-hint');
  const attachList = document.getElementById('attach-list');
  const browseButton = document.getElementById('browse');
  const attachDisabled = document.getElementById('attach-disabled');

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
      btn.addEventListener('click', function () { vscodeApi.postMessage({ type: 'attachPending', runId: run.id }); });
      div.appendChild(span);
      div.appendChild(btn);
      banners.appendChild(div);
    }
  }
  // Switching runs re-derives everything the selected run owns: subtitle, project prefill + hint,
  // the summary default, the plan prefill, and both banners (§ points 1–4).
  function applyRun(run) {
    subtitle.textContent = run.subtitle;
    projectInput.value = run.project.value;
    projectHint.hidden = !run.project.fromDerivation;
    summaryInput.value = run.defaultSummary;
    planInput.value = run.prefillPlanKey || '';
    renderBanners(run);
  }
  runSelect.addEventListener('change', function () {
    selectedRunId = runSelect.value;
    const run = findRun(selectedRunId);
    if (run) { applyRun(run); }
  });
  renderBanners(findRun(selectedRunId));

  execHint.textContent = searchable
    ? 'Type a project key to search its Test Executions, or type an execution key directly.'
    : 'Type the execution key to append to. Add Jira access in Xray setup to search instead.';

  function formatSize(bytes) {
    if (bytes >= 1024 * 1024) { return (bytes / (1024 * 1024)).toFixed(1) + ' MB'; }
    if (bytes >= 1024) { return Math.round(bytes / 1024) + ' KB'; }
    return bytes + ' B';
  }

  const seenPaths = new Set();

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

  if (attachModel.available) {
    attachHint.textContent = attachModel.hint;
    browseButton.hidden = false;
    for (const file of attachModel.suggestions) { addAttachmentRow(file); }
    browseButton.addEventListener('click', function () { vscodeApi.postMessage({ type: 'browse' }); });
  } else {
    attachHint.hidden = true;
    attachDisabled.hidden = false;
    attachDisabled.textContent = attachModel.reason || 'Add Jira access in Xray setup to attach run-level files.';
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

  let token = 0;
  const timers = {};

  function currentMode() {
    return document.querySelector('input[name="mode"]:checked').value;
  }

  function applyMode() {
    const append = currentMode() === 'append';
    appendFields.hidden = !append;
    createFields.hidden = append;
  }

  for (const radio of document.querySelectorAll('input[name="mode"]')) {
    radio.addEventListener('change', applyMode);
  }
  applyMode();

  function runSearch(kind, query, listEl, targetInput) {
    if (!searchable) { return; }
    const myToken = ++token;
    clearTimeout(timers[kind]);
    timers[kind] = setTimeout(function () {
      vscodeApi.postMessage({ type: 'search', token: myToken, kind: kind, query: query });
    }, 400);
    listEl.__token = myToken;
    listEl.__input = targetInput;
  }

  execInput.addEventListener('input', function () { runSearch('execution', execInput.value.trim(), execResults, execInput); });
  planInput.addEventListener('input', function () { runSearch('test-plan', planInput.value.trim(), planResults, planInput); });

  function renderResults(listEl, items) {
    listEl.textContent = '';
    for (const item of items) {
      const li = document.createElement('li');
      li.textContent = item.label;
      li.addEventListener('click', function () {
        listEl.__input.value = item.key;
        listEl.textContent = '';
      });
      listEl.appendChild(li);
    }
  }

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg.type === 'search-result') {
      const listEl = msg.kind === 'execution' ? execResults : planResults;
      if (listEl.__token !== msg.token) { return; }
      renderResults(listEl, msg.error ? [] : msg.items);
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
  });

  document.getElementById('cancel').addEventListener('click', function () {
    vscodeApi.postMessage({ type: 'cancel' });
  });

  document.getElementById('publish').addEventListener('click', function () {
    errProject.textContent = '';
    errExecution.textContent = '';
    const attachments = selectedAttachments();
    if (currentMode() === 'append') {
      const executionKey = execInput.value.trim();
      if (executionKey === '') { errExecution.textContent = 'Enter the execution key to append to.'; return; }
      vscodeApi.postMessage({ type: 'confirm', runId: selectedRunId, request: { mode: 'append', executionKey: executionKey }, attachments: attachments });
      return;
    }
    const project = projectInput.value.trim();
    if (project === '') { errProject.textContent = 'Enter the project key to create the execution in.'; return; }
    const environments = envInput.value.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
    const request = { mode: 'create-new', project: project, summary: summaryInput.value.trim() };
    const plan = planInput.value.trim();
    if (plan !== '') { request.testPlanKey = plan; }
    if (environments.length > 0) { request.environments = environments; }
    vscodeApi.postMessage({ type: 'confirm', runId: selectedRunId, request: request, attachments: attachments });
  });
</script>
</body>
</html>`;
}

// The View 3 publish dialog. Reuses the shared webview scaffolding (CSP, nonce, escapeHtml; no
// secrets → no MASK). Owns run selection (newest-first dropdown), the republish and pending-attachment
// banners, and the create/append form. Resolves to the user's `PublishDialogResult` (selected run +
// request + kept attachments), or `undefined` on cancel/close — the flow makes zero transport calls for
// an undefined result.
export class PublishDialogPanel {
  private readonly disposables: vscode.Disposable[] = [];
  private searchController: AbortController | undefined;
  private settled = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly delegate: PublishDialogDelegate,
    private readonly resolve: (result: PublishDialogResult | undefined) => void
  ) {
    this.disposables.push(
      this.panel.onDidDispose(() => this.finish(undefined)),
      this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message as IncomingMessage))
    );
  }

  public static show(model: PublishDialogModel, delegate: PublishDialogDelegate): Promise<PublishDialogResult | undefined> {
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, "Publish run results", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    });
    return new Promise<PublishDialogResult | undefined>((resolve) => {
      const instance = new PublishDialogPanel(panel, delegate, resolve);
      instance.render(model);
    });
  }

  private render(model: PublishDialogModel): void {
    this.panel.webview.html = renderHtml(model);
  }

  private handleMessage(message: IncomingMessage): void {
    if (message.type === "cancel") {
      this.finish(undefined);
    } else if (message.type === "confirm") {
      this.finish({ runId: message.runId, request: message.request, attachments: message.attachments });
    } else if (message.type === "search") {
      this.runSearch(message).catch(() => undefined);
    } else if (message.type === "browse") {
      this.runBrowse().catch(() => undefined);
    } else if (message.type === "attachPending") {
      this.runAttachPending(message).catch(() => undefined);
    }
  }

  private async runBrowse(): Promise<void> {
    const files = await this.delegate.browseFiles();
    if (this.settled) {
      return;
    }
    await this.post({ type: "browse-result", items: files.map((f) => ({ path: f.path, name: f.name, size: f.size })) });
  }

  private async runAttachPending(message: AttachPendingMessage): Promise<void> {
    const result = await this.delegate.attachPending(message.runId);
    if (this.settled) {
      return;
    }
    await this.post({ type: "pending-result", runId: message.runId, remaining: result.remaining });
  }

  private async runSearch(message: SearchMessage): Promise<void> {
    this.searchController?.abort();
    const controller = new AbortController();
    this.searchController = controller;
    try {
      const targets = await this.delegate.searchTargets(message.kind, message.query, controller.signal);
      if (controller.signal.aborted || this.settled) {
        return;
      }
      await this.post({
        type: "search-result",
        token: message.token,
        kind: message.kind,
        items: targets.map((t) => ({ key: t.ref.key, label: t.label })),
      });
    } catch (error) {
      if (controller.signal.aborted || this.settled) {
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      await this.post({ type: "search-result", token: message.token, kind: message.kind, items: [], error: reason });
    }
  }

  private async post(message: OutgoingMessage): Promise<void> {
    if (this.settled) {
      return;
    }
    await this.panel.webview.postMessage(message);
  }

  private finish(result: PublishDialogResult | undefined): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.searchController?.abort();
    this.resolve(result);
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    this.panel.dispose();
  }
}
