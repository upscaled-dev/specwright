import * as vscode from "vscode";
import { serverText } from "../utils/text";
import { contentSecurityPolicy, createNonce, escapeHtml } from "../utils/webview";
import { XRAY_SETUP_MASK } from "../webview/setup-protocol";
import type { XrayRegion } from "./xray-region";

export function renderXraySetupDocument(
  webview: vscode.Webview,
  assetRoot: vscode.Uri,
  session: string,
  site: string,
  region: XrayRegion,
  hasCredentials: boolean,
  hasJira: boolean
): string {
  const nonce = createNonce();
  const assetUri = vscode.Uri.joinPath(assetRoot, "xray-setup.js");
  const scriptUri = typeof webview.asWebviewUri === "function" ? webview.asWebviewUri(assetUri) : assetUri;
  const siteValue = escapeHtml(serverText(site));
  const credentialValue = hasCredentials ? XRAY_SETUP_MASK : "";
  const jiraValue = hasJira ? XRAY_SETUP_MASK : "";
  const regionOption = (value: XrayRegion, label: string): string =>
    `<option value="${value}"${region === value ? " selected" : ""}>${label}</option>`;
  // Always emit the hint so the retained panel can un-hide it after a first-time save without a
  // re-render (a re-render would reload the page and race the posted `saved` message).
  const credHint = `<p class="hint" id="cred-hint"${hasCredentials ? "" : " hidden"}>Credentials are stored for this site. The masked fields keep the stored credentials; type over a field to replace it.</p>`;
  // Stored credentials render the neutral "checking" dot and kick off an auth-only verify; the
  // green dot only appears once that handshake succeeds. No credentials → plain red "Not connected".
  const dotClass = hasCredentials ? " checking" : "";
  const statusLabel = hasCredentials ? "Checking connection…" : "Not connected";
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${contentSecurityPolicy(nonce)}">
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
  input, select {
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
  input:focus, select:focus, button:focus {
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
<body data-session="${escapeHtml(session)}">
  <h1>Set up Xray</h1>
  <p id="setup-description">Connect Specwright to your Jira/Xray Cloud site to map scenarios, view coverage, and publish run results.</p>
  <div class="conn" role="status" aria-live="polite" aria-atomic="true">
    <span id="conn-dot" class="conn-dot${dotClass}" aria-hidden="true"></span>
    <span id="conn-label">${escapeHtml(statusLabel)}</span>
  </div>
  ${credHint}
  <form id="setup-form" aria-describedby="setup-description" aria-busy="false" novalidate>
  <label for="site">Site host</label>
  <input id="site" type="text" placeholder="acme.atlassian.net" value="${siteValue}" spellcheck="false" autocapitalize="off" autocomplete="url" aria-describedby="err-site">
  <div id="err-site" class="field-error" aria-live="polite"></div>

  <label for="region">API region</label>
  <select id="region" aria-describedby="err-region">
    ${regionOption("global", "Global")}
    ${regionOption("us", "US")}
    ${regionOption("eu", "EU")}
    ${regionOption("au", "AU")}
  </select>
  <div id="err-region" class="field-error" aria-live="polite"></div>

  <label for="clientId">Client ID</label>
  <input id="clientId" type="text" placeholder="client id" value="${credentialValue}" spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="cred-hint err-clientId">
  <div id="err-clientId" class="field-error" aria-live="polite"></div>

  <label for="clientSecret">Client secret</label>
  <input id="clientSecret" type="password" placeholder="client secret" value="${credentialValue}" spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="cred-hint err-clientSecret">
  <div id="err-clientSecret" class="field-error" aria-live="polite"></div>

  <h2>Jira access (optional)</h2>
  <p class="hint" id="jira-description">Add a Jira email and API token to list the projects you can access and verify your tagged projects exist. Leave both blank to skip.</p>

  <label for="jiraEmail">Jira email</label>
  <input id="jiraEmail" type="email" placeholder="you@example.com" value="${jiraValue}" spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="jira-description err-jiraEmail">
  <div id="err-jiraEmail" class="field-error" aria-live="polite"></div>

  <label for="jiraToken">Jira API token</label>
  <input id="jiraToken" type="password" placeholder="Jira API token" value="${jiraValue}" spellcheck="false" autocapitalize="off" autocomplete="off" aria-describedby="jira-description err-jiraToken">
  <div id="err-jiraToken" class="field-error" aria-live="polite"></div>

  <div class="actions">
    <button id="save-test" class="primary" type="button">Save &amp; Test Connection</button>
    <button id="save" class="secondary" type="button">Save</button>
  </div>
  </form>
  <div id="status" role="status" aria-live="polite" aria-atomic="true"></div>
  <div id="project-view" aria-label="Connection project results" aria-live="polite"></div>

<script nonce="${nonce}" src="${escapeHtml(scriptUri.toString())}"></script>
</body>
</html>`;
}
