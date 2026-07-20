import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import { normalizeSiteUrl } from "./xray-adapter";
import { JiraProject } from "./jira-project-search";
import { XrayConnectionOutcome, XrayProjectSummary } from "./xray-connection-test";
import { XrayCredentials, XrayJiraCredentials } from "./xray-credential-store";

const VIEW_TYPE = "playwrightBddRunner.xraySetup";

// A stored credential renders as this sentinel, never the real value. Submitting it back means
// "keep what's stored" (resolved server-side against the mask-issued host); it is never itself
// stored as a credential.
const MASK = "••••••••";

export interface XraySetupDelegate {
  currentSite(): string;
  hasCredentials(site: string): Promise<boolean>;
  getCredentials(site: string): Promise<XrayCredentials | undefined>;
  saveConnection(site: string, clientId: string, clientSecret: string): Promise<string>;
  // Optional Jira access (§6 reserved slots): both-or-neither, stored/cleared for the saved host.
  hasJiraCredentials(site: string): Promise<boolean>;
  getJiraCredentials(site: string): Promise<XrayJiraCredentials | undefined>;
  saveJira(site: string, email: string, token: string): Promise<void>;
  clearJira(site: string): Promise<void>;
  // Full handshake + shape/project probes (Save & Test).
  probeConnection(site: string): Promise<XrayConnectionOutcome>;
  // Cheap auth-only handshake; drives the connection dot on open and after a plain Save.
  verifyConnection(site: string): Promise<XrayConnectionOutcome>;
}

export interface XraySetupValidationErrors {
  site?: string | undefined;
  clientId?: string | undefined;
  clientSecret?: string | undefined;
  jiraEmail?: string | undefined;
  jiraToken?: string | undefined;
}

type ConnState = "connected" | "disconnected" | "checking";

// The dot means VERIFIED, not credentials-stored: only `conn-state` moves it, and only a live auth
// handshake sets `connected`. `test-result` drives the status area separately, so a failed GraphQL
// stage can show a failure message while the dot stays connected (auth passed).
type OutgoingMessage =
  | { type: "validation"; errors: XraySetupValidationErrors }
  | { type: "saved"; site: string; jira: boolean }
  | { type: "test-result"; ok: boolean; message: string }
  | { type: "error"; message: string }
  | { type: "conn-state"; state: ConnState; label: string }
  | {
      type: "project-view";
      hasJira: boolean;
      jiraProjects: JiraProject[];
      jiraTruncated: boolean;
      probed: XrayProjectSummary[];
      jiraError?: string | undefined;
    };

interface SaveMessage {
  type: "save";
  site: string;
  clientId: string;
  clientSecret: string;
  jiraEmail: string;
  jiraToken: string;
  test: boolean;
}

interface ResolvedJira {
  email: string;
  token: string;
  // true → both present, store; false → both absent, clear/skip.
  store: boolean;
  emailError?: string | undefined;
  tokenError?: string | undefined;
}

interface VerifyOptions {
  announceChecking: boolean;
  statusOnSuccess: boolean;
  throwPrefix: string;
}

interface ResolvedCredentials {
  clientId: string;
  clientSecret: string;
  clientIdError?: string | undefined;
  clientSecretError?: string | undefined;
}

// Extension-side, authoritative rules mirrored from the former connect() input boxes. Validate the
// normalized host, not the raw string: "https://" trims non-empty but normalizes to "", which would
// store secrets under a degenerate key no command can ever address again.
export function validateXraySetupInput(
  site: string,
  clientId: string,
  clientSecret: string
): XraySetupValidationErrors | undefined {
  const errors: XraySetupValidationErrors = {};
  const normalized = normalizeSiteUrl(site);
  if (normalized === "") {
    errors.site = "Enter a host like acme.atlassian.net";
  } else {
    try {
      if (new URL(`https://${normalized}`).hostname !== normalized) {
        errors.site = "Enter a bare host (no path or port), like acme.atlassian.net";
      }
    } catch {
      errors.site = "Not a valid host";
    }
  }
  if (clientId.trim() === "") {
    errors.clientId = "Client id is required";
  }
  if (clientSecret.trim() === "") {
    errors.clientSecret = "Client secret is required";
  }
  return Object.keys(errors).length > 0 ? errors : undefined;
}

function escapeAttr(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function renderHtml(site: string, hasCredentials: boolean, hasJira: boolean): string {
  const nonce = randomBytes(16).toString("hex");
  const siteValue = escapeAttr(site);
  const credentialValue = hasCredentials ? MASK : "";
  const jiraValue = hasJira ? MASK : "";
  // Always emit the hint so the retained panel can un-hide it after a first-time save without a
  // re-render (a re-render would reload the page and race the posted `saved` message).
  const credHint = `<p class="hint" id="cred-hint"${hasCredentials ? "" : " hidden"}>Credentials are stored for this site. The masked fields keep the stored credentials — type over a field to replace it.</p>`;
  // Stored credentials render the neutral "checking" dot and kick off an auth-only verify; the
  // green dot only appears once that handshake succeeds. No credentials → plain red "Not connected".
  const dotClass = hasCredentials ? " checking" : "";
  const statusLabel = hasCredentials ? "Checking connection…" : "Not connected";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Set up Xray</title>
<style>
  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    padding: 1.25rem;
    max-width: 34rem;
  }
  h1 { font-size: 1.3rem; font-weight: 600; margin: 0 0 0.75rem; }
  p { line-height: 1.4; }
  .hint { color: var(--vscode-descriptionForeground); }
  .conn { display: flex; align-items: center; gap: 0.5rem; margin: 0.75rem 0; }
  .conn-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    background: var(--vscode-testing-iconFailed, #e51400);
    flex: none;
  }
  .conn-dot.connected { background: var(--vscode-testing-iconPassed, #388a34); }
  .conn-dot.checking { background: var(--vscode-descriptionForeground); }
  label { display: block; margin-top: 1rem; font-weight: 600; }
  input {
    width: 100%;
    box-sizing: border-box;
    margin-top: 0.35rem;
    padding: 0.4rem 0.5rem;
    color: var(--vscode-input-foreground);
    background: var(--vscode-input-background);
    border: 1px solid var(--vscode-input-border, transparent);
    border-radius: 2px;
  }
  input::placeholder { color: var(--vscode-input-placeholderForeground); }
  input:focus {
    outline: 1px solid var(--vscode-focusBorder);
    outline-offset: -1px;
  }
  .field-error {
    color: var(--vscode-errorForeground);
    font-size: 0.85em;
    min-height: 1.1em;
    margin-top: 0.25rem;
  }
  .actions { display: flex; gap: 0.6rem; margin-top: 1.5rem; }
  button {
    padding: 0.45rem 0.9rem;
    border: none;
    border-radius: 2px;
    cursor: pointer;
    font-family: inherit;
  }
  button.primary {
    color: var(--vscode-button-foreground);
    background: var(--vscode-button-background);
  }
  button.primary:hover { background: var(--vscode-button-hoverBackground); }
  button.secondary {
    color: var(--vscode-button-secondaryForeground);
    background: var(--vscode-button-secondaryBackground);
  }
  button.secondary:hover { background: var(--vscode-button-secondaryHoverBackground); }
  #status { margin-top: 1rem; min-height: 1.2em; color: var(--vscode-descriptionForeground); }
  #status.error { color: var(--vscode-errorForeground); }
  h2 { font-size: 1rem; font-weight: 600; margin: 1.75rem 0 0; }
  #project-view:empty { display: none; }
  #project-view { margin-top: 1.25rem; }
  .pv-heading { font-weight: 600; margin-top: 1rem; }
  .pv-note { color: var(--vscode-errorForeground); margin-top: 1rem; }
  .pv-list { margin: 0.35rem 0 0; padding-left: 1.1rem; }
  .pv-list li { line-height: 1.5; }
</style>
</head>
<body>
  <h1>Set up Xray</h1>
  <p>Connect Specwright to your Jira/Xray Cloud site to map scenarios, view coverage, and publish run results.</p>
  <div class="conn">
    <span id="conn-dot" class="conn-dot${dotClass}"></span>
    <span id="conn-label">${escapeAttr(statusLabel)}</span>
  </div>
  ${credHint}
  <label for="site">Site host</label>
  <input id="site" type="text" placeholder="acme.atlassian.net" value="${siteValue}" spellcheck="false" autocapitalize="off">
  <div id="err-site" class="field-error"></div>

  <label for="clientId">Client ID</label>
  <input id="clientId" type="text" placeholder="client id" value="${credentialValue}" spellcheck="false" autocapitalize="off">
  <div id="err-clientId" class="field-error"></div>

  <label for="clientSecret">Client secret</label>
  <input id="clientSecret" type="password" placeholder="client secret" value="${credentialValue}" spellcheck="false" autocapitalize="off">
  <div id="err-clientSecret" class="field-error"></div>

  <h2>Jira access (optional)</h2>
  <p class="hint">Add a Jira email and API token to list the projects you can access and verify your tagged projects exist. Leave both blank to skip.</p>

  <label for="jiraEmail">Jira email</label>
  <input id="jiraEmail" type="text" placeholder="you@example.com" value="${jiraValue}" spellcheck="false" autocapitalize="off">
  <div id="err-jiraEmail" class="field-error"></div>

  <label for="jiraToken">Jira API token</label>
  <input id="jiraToken" type="password" placeholder="Jira API token" value="${jiraValue}" spellcheck="false" autocapitalize="off">
  <div id="err-jiraToken" class="field-error"></div>

  <div class="actions">
    <button id="save-test" class="primary" type="button">Save &amp; Test Connection</button>
    <button id="save" class="secondary" type="button">Save</button>
  </div>
  <div id="status"></div>
  <div id="project-view"></div>

<script nonce="${nonce}">
  const MASK = ${JSON.stringify(MASK)};
  const vscodeApi = acquireVsCodeApi();
  const siteInput = document.getElementById('site');
  const idInput = document.getElementById('clientId');
  const secretInput = document.getElementById('clientSecret');
  const jiraEmailInput = document.getElementById('jiraEmail');
  const jiraTokenInput = document.getElementById('jiraToken');
  const statusEl = document.getElementById('status');
  const projectView = document.getElementById('project-view');
  const errSite = document.getElementById('err-site');
  const errId = document.getElementById('err-clientId');
  const errSecret = document.getElementById('err-clientSecret');
  const errJiraEmail = document.getElementById('err-jiraEmail');
  const errJiraToken = document.getElementById('err-jiraToken');
  const credHint = document.getElementById('cred-hint');
  const connDot = document.getElementById('conn-dot');
  const connLabel = document.getElementById('conn-label');
  const saveTestBtn = document.getElementById('save-test');
  const saveBtn = document.getElementById('save');
  let pendingTest = false;

  function clearErrors() {
    errSite.textContent = '';
    errId.textContent = '';
    errSecret.textContent = '';
    errJiraEmail.textContent = '';
    errJiraToken.textContent = '';
  }

  function setBusy(busy) {
    saveTestBtn.disabled = busy;
    saveBtn.disabled = busy;
  }

  function submit(test) {
    clearErrors();
    pendingTest = test;
    setBusy(true);
    statusEl.classList.remove('error');
    statusEl.textContent = test ? 'Saving and testing…' : 'Saving…';
    vscodeApi.postMessage({
      type: 'save',
      site: siteInput.value,
      clientId: idInput.value,
      clientSecret: secretInput.value,
      jiraEmail: jiraEmailInput.value,
      jiraToken: jiraTokenInput.value,
      test: test,
    });
  }

  function probedPhrase(s) {
    if (s.existsOnSite === false) { return s.project + ': not found on this site'; }
    if (s.existsOnSite === undefined && s.totalTests === 0) {
      return s.project + ": 0 Xray tests — project may not exist, can't verify without Jira access";
    }
    return s.project + ': ' + s.totalTests + ' Xray tests';
  }

  function appendList(items, toText) {
    const ul = document.createElement('ul');
    ul.className = 'pv-list';
    for (const item of items) {
      const li = document.createElement('li');
      li.textContent = toText(item);
      ul.appendChild(li);
    }
    projectView.appendChild(ul);
  }

  function appendHeading(text) {
    const el = document.createElement('div');
    el.className = 'pv-heading';
    el.textContent = text;
    projectView.appendChild(el);
  }

  // Values come from Jira and are rendered with textContent only — never innerHTML — so a project
  // name can never inject markup past the CSP.
  function renderProjectView(msg) {
    projectView.textContent = '';
    if (msg.hasJira && msg.jiraError) {
      const note = document.createElement('div');
      note.className = 'pv-note';
      note.textContent = 'Jira project list unavailable: ' + msg.jiraError;
      projectView.appendChild(note);
    } else if (msg.hasJira) {
      appendHeading(msg.jiraTruncated
        ? 'Accessible Jira projects (' + msg.jiraProjects.length + '+, list truncated)'
        : 'Accessible Jira projects (' + msg.jiraProjects.length + ')');
      appendList(msg.jiraProjects, function (p) { return p.key + ' — ' + p.name; });
    }
    if (msg.probed.length > 0) {
      appendHeading('Xray coverage for tagged projects');
      appendList(msg.probed, probedPhrase);
    }
  }

  saveTestBtn.addEventListener('click', function () { submit(true); });
  saveBtn.addEventListener('click', function () { submit(false); });

  function applyConnState(state, label) {
    connDot.classList.remove('connected', 'checking');
    if (state === 'connected') { connDot.classList.add('connected'); }
    else if (state === 'checking') { connDot.classList.add('checking'); }
    connLabel.textContent = label;
  }

  window.addEventListener('message', function (event) {
    const msg = event.data;
    if (msg.type === 'validation') {
      setBusy(false);
      statusEl.classList.remove('error');
      statusEl.textContent = '';
      errSite.textContent = msg.errors.site || '';
      errId.textContent = msg.errors.clientId || '';
      errSecret.textContent = msg.errors.clientSecret || '';
      errJiraEmail.textContent = msg.errors.jiraEmail || '';
      errJiraToken.textContent = msg.errors.jiraToken || '';
    } else if (msg.type === 'saved') {
      clearErrors();
      credHint.hidden = false;
      idInput.value = MASK;
      secretInput.value = MASK;
      jiraEmailInput.value = msg.jira ? MASK : '';
      jiraTokenInput.value = msg.jira ? MASK : '';
      siteInput.value = msg.site;
      statusEl.classList.remove('error');
      statusEl.textContent = pendingTest
        ? 'Saved credentials for ' + msg.site + '. Testing connection…'
        : 'Saved credentials for ' + msg.site + '. Checking connection…';
    } else if (msg.type === 'project-view') {
      renderProjectView(msg);
    } else if (msg.type === 'conn-state') {
      // A "checking" state is not terminal, so it must not re-enable the buttons mid-flight.
      if (msg.state !== 'checking') { setBusy(false); }
      applyConnState(msg.state, msg.label);
    } else if (msg.type === 'test-result') {
      statusEl.classList.toggle('error', !msg.ok);
      statusEl.textContent = msg.message;
    } else if (msg.type === 'error') {
      setBusy(false);
      statusEl.classList.add('error');
      statusEl.textContent = msg.message;
    }
  });
</script>
</body>
</html>`;
}

export class XraySetupPanel {
  private static current: XraySetupPanel | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  // The normalized host the current mask was rendered for. A submitted MASK only stands in for a
  // stored value when the site is still this host; a host change forces fresh credentials.
  private maskIssuedSite: string | undefined;
  // Verifications are async and overlap (open-verify racing a save-verify; two quick saves). Each
  // captures the epoch at start and only applies its result if still current, so a stale one is
  // discarded. Mirrors the connection-epoch guard in TraceabilitySubsystem.
  private verifyEpoch = 0;
  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: XraySetupDelegate
  ) {
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message as SaveMessage))
    );
  }

  public static async show(deps: XraySetupDelegate): Promise<void> {
    if (XraySetupPanel.current) {
      XraySetupPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    // retainContextWhenHidden keeps typed-but-unsaved secrets in the webview across tab switches;
    // getState/setState is deliberately never used so secrets never touch disk.
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, "Set up Xray", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [],
    });
    const instance = new XraySetupPanel(panel, deps);
    XraySetupPanel.current = instance;
    await instance.render();
  }

  private async render(): Promise<void> {
    const site = this.deps.currentSite();
    const normalized = normalizeSiteUrl(site);
    const hasCredentials = normalized !== "" && (await this.deps.hasCredentials(site));
    const hasJira = normalized !== "" && (await this.deps.hasJiraCredentials(site));
    // The mask stands in for either stored pair, so it's issued for the host if either exists.
    this.maskIssuedSite = hasCredentials || hasJira ? normalized : undefined;
    this.panel.webview.html = renderHtml(site, hasCredentials, hasJira);
    // Stored credentials: the HTML already paints the checking dot, so verify in the background and
    // let the result flip it. No credentials: stay red, make no network call.
    if (hasCredentials) {
      this.startVerify(normalized, false, {
        announceChecking: false,
        statusOnSuccess: false,
        throwPrefix: "Could not verify connection",
      }).catch(() => undefined);
    }
  }

  // A submitted MASK means "keep the stored value" — but only for the host the mask was issued for.
  // Per-field so the user can rotate one credential while leaving the other masked; a host change
  // (or a mask with nothing stored) can never carry an old secret forward.
  private async resolveCredentials(message: SaveMessage): Promise<ResolvedCredentials> {
    const idIsMask = message.clientId === MASK;
    const secretIsMask = message.clientSecret === MASK;
    if (!idIsMask && !secretIsMask) {
      return { clientId: message.clientId, clientSecret: message.clientSecret };
    }
    const submittedHost = normalizeSiteUrl(message.site);
    const sameHost = submittedHost !== "" && this.maskIssuedSite === submittedHost;
    const hostChanged = this.maskIssuedSite !== undefined && !sameHost;
    const stored = sameHost ? await this.deps.getCredentials(message.site) : undefined;

    const result: ResolvedCredentials = {
      clientId: message.clientId,
      clientSecret: message.clientSecret,
    };
    if (idIsMask) {
      if (stored) {
        result.clientId = stored.clientId;
      } else {
        result.clientIdError = hostChanged
          ? "Enter the credentials for the new site"
          : "Enter your Xray client id";
      }
    }
    if (secretIsMask) {
      if (stored) {
        result.clientSecret = stored.clientSecret;
      } else {
        result.clientSecretError = hostChanged
          ? "Enter the credentials for the new site"
          : "Enter your Xray client secret";
      }
    }
    return result;
  }

  // Jira mirror of resolveCredentials with an extra both-or-neither rule: a masked field keeps its
  // stored value (same host only), and a form with exactly one Jira field filled is rejected. Both
  // blank means "no Jira access" — a valid state that clears any stored pair.
  private async resolveJira(message: SaveMessage): Promise<ResolvedJira> {
    let email = message.jiraEmail;
    let token = message.jiraToken;
    let emailError: string | undefined;
    let tokenError: string | undefined;

    if (email === MASK || token === MASK) {
      const submittedHost = normalizeSiteUrl(message.site);
      const sameHost = submittedHost !== "" && this.maskIssuedSite === submittedHost;
      const hostChanged = this.maskIssuedSite !== undefined && !sameHost;
      const stored = sameHost ? await this.deps.getJiraCredentials(message.site) : undefined;
      const missing = hostChanged ? "Enter the Jira credentials for the new site" : undefined;
      if (email === MASK) {
        if (stored) {
          email = stored.email;
        } else {
          email = "";
          emailError = missing ?? "Enter your Jira email";
        }
      }
      if (token === MASK) {
        if (stored) {
          token = stored.token;
        } else {
          token = "";
          tokenError = missing ?? "Enter your Jira API token";
        }
      }
    }

    email = email.trim();
    token = token.trim();
    const bothOrNeither = "Enter both a Jira email and API token, or leave both blank";
    if (email !== "" && token === "" && tokenError === undefined) {
      tokenError = bothOrNeither;
    }
    if (token !== "" && email === "" && emailError === undefined) {
      emailError = bothOrNeither;
    }
    const store = email !== "" && token !== "" && emailError === undefined && tokenError === undefined;
    return {
      email,
      token,
      store,
      ...(emailError ? { emailError } : {}),
      ...(tokenError ? { tokenError } : {}),
    };
  }

  private combinedErrors(
    message: SaveMessage,
    resolved: ResolvedCredentials,
    jira: ResolvedJira
  ): XraySetupValidationErrors | undefined {
    const errors: XraySetupValidationErrors =
      validateXraySetupInput(message.site, resolved.clientId, resolved.clientSecret) ?? {};
    if (resolved.clientIdError) {
      errors.clientId = resolved.clientIdError;
    }
    if (resolved.clientSecretError) {
      errors.clientSecret = resolved.clientSecretError;
    }
    if (jira.emailError) {
      errors.jiraEmail = jira.emailError;
    }
    if (jira.tokenError) {
      errors.jiraToken = jira.tokenError;
    }
    return errors.site || errors.clientId || errors.clientSecret || errors.jiraEmail || errors.jiraToken
      ? errors
      : undefined;
  }

  private async handleMessage(message: SaveMessage): Promise<void> {
    if (message.type !== "save") {
      return;
    }
    const resolved = await this.resolveCredentials(message);
    const jira = await this.resolveJira(message);
    const errors = this.combinedErrors(message, resolved, jira);
    if (errors) {
      await this.post({ type: "validation", errors });
      return;
    }
    let site: string;
    // A thrown save must reach the form: without this the webview sits at "Saving…" forever,
    // because the rejection would vanish inside the onDidReceiveMessage handler.
    try {
      site = await this.deps.saveConnection(message.site, resolved.clientId, resolved.clientSecret);
      this.maskIssuedSite = site;
      // Jira is stored/cleared for the just-saved host; a host switch already dropped the old host's
      // Jira pair inside saveConnection, so only clear when the saved host still holds one.
      if (jira.store) {
        await this.deps.saveJira(site, jira.email, jira.token);
      } else if (await this.deps.hasJiraCredentials(site)) {
        await this.deps.clearJira(site);
      }
      await this.post({ type: "saved", site, jira: jira.store });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await this.post({ type: "error", message: `Could not save: ${reason}` });
      return;
    }
    // Every save ends with a verify: Save & Test runs the full probe, a plain Save the auth-only
    // one. Both drive the dot off the just-saved host (Fix 1).
    await this.startVerify(site, message.test, {
      announceChecking: true,
      statusOnSuccess: true,
      throwPrefix: "Saved, but the connection test failed to run",
    });
  }

  private async startVerify(site: string, full: boolean, options: VerifyOptions): Promise<void> {
    const epoch = ++this.verifyEpoch;
    if (options.announceChecking) {
      await this.post({ type: "conn-state", state: "checking", label: "Checking connection…" });
    }
    let run: Promise<XrayConnectionOutcome>;
    // A synchronous throw from the delegate (not just a rejected promise) would otherwise escape
    // handleMessage and strand the form at "Checking…" with both buttons disabled. Post the same
    // terminal pair settleVerify's async-failure path posts.
    try {
      run = full ? this.deps.probeConnection(site) : this.deps.verifyConnection(site);
    } catch (error) {
      if (this.stale(epoch)) {
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      await this.post({ type: "conn-state", state: "disconnected", label: "Not connected" });
      await this.post({ type: "error", message: `${options.throwPrefix}: ${reason}` });
      return;
    }
    await this.settleVerify(epoch, run, options, full);
  }

  private async settleVerify(
    epoch: number,
    run: Promise<XrayConnectionOutcome>,
    options: VerifyOptions,
    full: boolean
  ): Promise<void> {
    let outcome: XrayConnectionOutcome;
    try {
      outcome = await run;
    } catch (error) {
      if (this.stale(epoch)) {
        return;
      }
      const reason = error instanceof Error ? error.message : String(error);
      await this.post({ type: "conn-state", state: "disconnected", label: "Not connected" });
      await this.post({ type: "error", message: `${options.throwPrefix}: ${reason}` });
      return;
    }
    if (this.stale(epoch)) {
      return;
    }
    // Connected == a live handshake succeeded. A GraphQL-stage failure still means we authenticated,
    // so the dot stays green while test-result carries the failure message.
    const connected = outcome.ok || outcome.stage === "graphql";
    await this.post({
      type: "conn-state",
      state: connected ? "connected" : "disconnected",
      label: connected ? `Connected to ${outcome.site}` : "Not connected",
    });
    if (!outcome.ok || options.statusOnSuccess) {
      await this.post({ type: "test-result", ok: outcome.ok, message: outcome.message });
    }
    // Only the full probe carries project/Jira data; the auth-only open verify never does, so it
    // leaves the neutral initial view in place.
    if (full && this.hasProjectData(outcome)) {
      await this.post(this.projectViewMessage(outcome));
    }
  }

  private hasProjectData(outcome: XrayConnectionOutcome): boolean {
    return (
      outcome.projects !== undefined ||
      outcome.jiraProjects !== undefined ||
      outcome.jiraError !== undefined
    );
  }

  private projectViewMessage(outcome: XrayConnectionOutcome): OutgoingMessage {
    return {
      type: "project-view",
      hasJira: outcome.jiraProjects !== undefined || outcome.jiraError !== undefined,
      jiraProjects: outcome.jiraProjects ?? [],
      jiraTruncated: outcome.jiraTruncated === true,
      probed: outcome.projects ?? [],
      ...(outcome.jiraError !== undefined ? { jiraError: outcome.jiraError } : {}),
    };
  }

  private stale(epoch: number): boolean {
    return this.disposed || epoch !== this.verifyEpoch;
  }

  private async post(message: OutgoingMessage): Promise<void> {
    if (this.disposed) {
      return;
    }
    await this.panel.webview.postMessage(message);
  }

  private dispose(): void {
    this.disposed = true;
    XraySetupPanel.current = undefined;
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    this.panel.dispose();
  }
}
