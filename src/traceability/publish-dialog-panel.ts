import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { PublishRequest, PublishTarget } from "./contracts";
import { PublishDialogModel } from "./publish-flow";

const VIEW_TYPE = "playwrightBddRunner.publishResults";
const IMPORT_HINT = "Create → POST /import/execution/cucumber/multipart · Append → POST /import/execution";

// The delegate the dialog calls back into for the execution/test-plan pickers. `searchTargets`
// rejects (NotSupportedError) without Jira creds — the dialog only calls it when `jiraSearchAvailable`.
export interface PublishDialogDelegate {
  searchTargets(kind: "execution" | "test-plan", query: string, signal?: AbortSignal): Promise<readonly PublishTarget[]>;
}

interface SearchMessage {
  type: "search";
  token: number;
  kind: "execution" | "test-plan";
  query: string;
}
interface ConfirmMessage {
  type: "confirm";
  request: PublishRequest;
}
interface CancelMessage {
  type: "cancel";
}
type IncomingMessage = SearchMessage | ConfirmMessage | CancelMessage;

type OutgoingMessage = {
  type: "search-result";
  token: number;
  kind: "execution" | "test-plan";
  items: ReadonlyArray<{ readonly key: string; readonly label: string }>;
  error?: string | undefined;
};

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function bannerHtml(model: PublishDialogModel): string {
  if (model.alreadyPublished === undefined) {
    return "";
  }
  const when = new Date(model.alreadyPublished.publishedAt).toLocaleString();
  const text = `This run was already published to ${model.alreadyPublished.key} on ${when}. Publishing again creates a duplicate.`;
  return `<div class="banner">${escapeHtml(text)}</div>`;
}

function renderHtml(model: PublishDialogModel): string {
  const nonce = randomBytes(16).toString("hex");
  const planValue = escapeHtml(model.prefillPlanKey ?? "");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
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
  .subtitle { color: var(--vscode-descriptionForeground); margin: 0 0 1rem; }
  .banner {
    color: var(--vscode-inputValidation-warningForeground, var(--vscode-foreground));
    background: var(--vscode-inputValidation-warningBackground, transparent);
    border: 1px solid var(--vscode-inputValidation-warningBorder, var(--vscode-focusBorder));
    border-radius: 3px;
    padding: 0.5rem 0.65rem;
    margin: 0 0 1rem;
  }
  fieldset { border: none; margin: 0; padding: 0; }
  .radio-row { display: flex; align-items: center; gap: 0.4rem; margin-top: 0.5rem; }
  label { display: block; margin-top: 1rem; font-weight: 600; }
  .radio-row label { display: inline; margin: 0; font-weight: 400; }
  input[type="text"] {
    width: 100%;
    box-sizing: border-box;
    margin-top: 0.35rem;
    padding: 0.4rem 0.5rem;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
  }
  input:focus { outline: 1px solid var(--vscode-focusBorder); outline-offset: -1px; }
  .hint { color: var(--vscode-descriptionForeground); font-size: 0.9em; margin-top: 0.25rem; }
  .field-error { color: var(--vscode-errorForeground); font-size: 0.85em; min-height: 1.1em; margin-top: 0.25rem; }
  .results { list-style: none; margin: 0.35rem 0 0; padding: 0; border: 1px solid var(--vscode-input-border, transparent); border-radius: 2px; }
  .results:empty { display: none; border: none; }
  .results li { padding: 0.35rem 0.5rem; cursor: pointer; }
  .results li:hover { background: var(--vscode-list-hoverBackground); }
  [hidden] { display: none !important; }
  .actions { display: flex; gap: 0.6rem; margin-top: 1.5rem; }
  button { padding: 0.45rem 0.9rem; border: none; border-radius: 2px; cursor: pointer; font-family: inherit; }
  button.primary { color: var(--vscode-button-foreground); background: var(--vscode-button-background); }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary { color: var(--vscode-button-secondaryForeground); background: var(--vscode-button-secondaryBackground); }
  .footer { color: var(--vscode-descriptionForeground); font-size: 0.85em; margin-top: 1.25rem; }
</style>
</head>
<body>
  <h1>${escapeHtml(model.title)}</h1>
  <p class="subtitle">${escapeHtml(model.subtitle)}</p>
  ${bannerHtml(model)}

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
    <input id="project" type="text" spellcheck="false" autocapitalize="characters" value="${escapeHtml(model.defaultProjectKey)}">
    <div id="err-project" class="field-error"></div>

    <label for="summary">Summary</label>
    <input id="summary" type="text" value="${escapeHtml(model.defaultSummary)}">

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

  <div class="actions">
    <button id="publish" class="primary" type="button">Publish</button>
    <button id="cancel" class="secondary" type="button">Cancel</button>
  </div>
  <p class="footer">${escapeHtml(IMPORT_HINT)}</p>

<script nonce="${nonce}">
  const vscodeApi = acquireVsCodeApi();
  const searchable = ${model.jiraSearchAvailable ? "true" : "false"};
  const createFields = document.getElementById('create-fields');
  const appendFields = document.getElementById('append-fields');
  const projectInput = document.getElementById('project');
  const summaryInput = document.getElementById('summary');
  const planInput = document.getElementById('plan');
  const envInput = document.getElementById('environments');
  const execInput = document.getElementById('execution');
  const execResults = document.getElementById('exec-results');
  const planResults = document.getElementById('plan-results');
  const errProject = document.getElementById('err-project');
  const errExecution = document.getElementById('err-execution');
  const execHint = document.getElementById('exec-hint');
  execHint.textContent = searchable
    ? 'Type a project key to search its Test Executions, or type an execution key directly.'
    : 'Type the execution key to append to. Add Jira access in Xray setup to search instead.';

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
    }
  });

  document.getElementById('cancel').addEventListener('click', function () {
    vscodeApi.postMessage({ type: 'cancel' });
  });

  document.getElementById('publish').addEventListener('click', function () {
    errProject.textContent = '';
    errExecution.textContent = '';
    if (currentMode() === 'append') {
      const executionKey = execInput.value.trim();
      if (executionKey === '') { errExecution.textContent = 'Enter the execution key to append to.'; return; }
      vscodeApi.postMessage({ type: 'confirm', request: { mode: 'append', executionKey: executionKey } });
      return;
    }
    const project = projectInput.value.trim();
    if (project === '') { errProject.textContent = 'Enter the project key to create the execution in.'; return; }
    const environments = envInput.value.split(',').map(function (s) { return s.trim(); }).filter(function (s) { return s !== ''; });
    const request = { mode: 'create-new', project: project, summary: summaryInput.value.trim() };
    const plan = planInput.value.trim();
    if (plan !== '') { request.testPlanKey = plan; }
    if (environments.length > 0) { request.environments = environments; }
    vscodeApi.postMessage({ type: 'confirm', request: request });
  });
</script>
</body>
</html>`;
}

// The View 3 publish dialog. Reuses the setup-panel plumbing (CSP, theme-aware, nonce'd script, no
// secrets → no MASK). Resolves to the user's `PublishRequest`, or `undefined` on cancel/close — the
// flow makes zero transport calls for an undefined result.
export class PublishDialogPanel {
  private readonly disposables: vscode.Disposable[] = [];
  private searchController: AbortController | undefined;
  private settled = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly delegate: PublishDialogDelegate,
    private readonly resolve: (request: PublishRequest | undefined) => void
  ) {
    this.disposables.push(
      this.panel.onDidDispose(() => this.finish(undefined)),
      this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message as IncomingMessage))
    );
  }

  public static show(model: PublishDialogModel, delegate: PublishDialogDelegate): Promise<PublishRequest | undefined> {
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, "Publish run results", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    });
    return new Promise<PublishRequest | undefined>((resolve) => {
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
      this.finish(message.request);
    } else if (message.type === "search") {
      this.runSearch(message).catch(() => undefined);
    }
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

  private finish(request: PublishRequest | undefined): void {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.searchController?.abort();
    this.resolve(request);
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    this.panel.dispose();
  }
}
