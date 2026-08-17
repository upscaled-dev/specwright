import {
  isSetupDocument,
  isSetupHostEnvelope,
  WEBVIEW_PROTOCOL_VERSION,
  XRAY_SETUP_MASK,
  type SetupClientMessage,
  type SetupHostMessage,
  type SetupProjectSummary,
} from "./setup-protocol";

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (found === null) {throw new Error(`Missing setup element: ${id}`);}
  return found as T;
}

const site = element<HTMLInputElement>("site");
const region = element<HTMLSelectElement>("region");
const clientId = element<HTMLInputElement>("clientId");
const clientSecret = element<HTMLInputElement>("clientSecret");
const jiraEmail = element<HTMLInputElement>("jiraEmail");
const jiraToken = element<HTMLInputElement>("jiraToken");
const saveTest = element<HTMLButtonElement>("save-test");
const save = element<HTMLButtonElement>("save");
const status = element<HTMLElement>("status");
const projectView = element<HTMLElement>("project-view");
const credentialHint = element<HTMLElement>("cred-hint");
const connectionDot = element<HTMLElement>("conn-dot");
const connectionLabel = element<HTMLElement>("conn-label");
const form = element<HTMLFormElement>("setup-form");

const fields = {
  site,
  region,
  clientId,
  clientSecret,
  jiraEmail,
  jiraToken,
};
type FieldName = keyof typeof fields;
const fieldOrder = Object.keys(fields) as FieldName[];

const vscode = acquireVsCodeApi();
const session = document.body.dataset["session"] ?? "";
const persisted = vscode.getState();
const previousDocument = isSetupDocument(persisted?.["setupDocument"])
  ? persisted["setupDocument"]
  : undefined;
const documentId = documentToken();
vscode.setState({ setupDocument: documentId });
let revision = 0;
let testing = false;

function documentToken(): string {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (value) => value.toString(16).padStart(2, "0")).join("");
}

function post(body: SetupClientMessage): void {
  vscode.postMessage({
    version: WEBVIEW_PROTOCOL_VERSION,
    session,
    document: documentId,
    revision,
    surface: "setup",
    body,
  });
}

function fieldError(name: FieldName): HTMLElement {
  return element(`err-${name}`);
}

function clearFieldError(name: FieldName): void {
  fieldError(name).textContent = "";
  fields[name].removeAttribute("aria-invalid");
}

function showValidation(message: Extract<SetupHostMessage, { type: "validation" }>): void {
  let first: HTMLElement | undefined;
  for (const name of fieldOrder) {
    clearFieldError(name);
    const error = message.errors[name];
    if (error !== undefined) {
      fieldError(name).textContent = error;
      fields[name].setAttribute("aria-invalid", "true");
      first ??= fields[name];
    }
  }
  status.classList.remove("error");
  status.textContent = "Correct the highlighted fields.";
  first?.focus();
}

function setBusy(message: Extract<SetupHostMessage, { type: "busy" }>): void {
  testing = message.testing;
  saveTest.disabled = message.busy;
  save.disabled = message.busy;
  form.setAttribute("aria-busy", String(message.busy));
  if (message.busy) {
    status.classList.remove("error");
    status.textContent = message.testing ? "Saving and testing…" : "Saving…";
  }
}

function showSaved(message: Extract<SetupHostMessage, { type: "saved" }>): void {
  for (const name of fieldOrder) {clearFieldError(name);}
  projectView.replaceChildren();
  showFormState({
    type: "form-state",
    site: message.site,
    region: message.region,
    credentials: true,
    jira: message.jira,
  });
  status.classList.remove("error");
  status.textContent = `Saved credentials for ${message.site}. ${testing ? "Testing" : "Checking"} connection…`;
}

function showFormState(message: Extract<SetupHostMessage, { type: "form-state" }>): void {
  credentialHint.hidden = !message.credentials;
  clientId.value = message.credentials ? XRAY_SETUP_MASK : "";
  clientSecret.value = message.credentials ? XRAY_SETUP_MASK : "";
  jiraEmail.value = message.jira ? XRAY_SETUP_MASK : "";
  jiraToken.value = message.jira ? XRAY_SETUP_MASK : "";
  site.value = message.site;
  region.value = message.region;
}

function setConnection(message: Extract<SetupHostMessage, { type: "conn-state" }>): void {
  connectionDot.classList.remove("connected", "checking");
  if (message.state === "connected") {connectionDot.classList.add("connected");}
  if (message.state === "checking") {connectionDot.classList.add("checking");}
  connectionLabel.textContent = message.label;
}

function appendHeading(text: string): void {
  const heading = document.createElement("h3");
  heading.className = "pv-heading";
  heading.textContent = text;
  projectView.appendChild(heading);
}

function appendList<T>(items: readonly T[], text: (item: T) => string): void {
  const list = document.createElement("ul");
  list.className = "pv-list";
  for (const item of items) {
    const row = document.createElement("li");
    row.textContent = text(item);
    list.appendChild(row);
  }
  projectView.appendChild(list);
}

function projectPhrase(summary: SetupProjectSummary): string {
  if (summary.existsOnSite === false) {return `${summary.project}: not found on this site`;}
  if (summary.existsOnSite === undefined && summary.totalTests === 0) {
    return `${summary.project}: 0 Xray tests; project may not exist, can't verify without Jira access`;
  }
  return `${summary.project}: ${summary.totalTests} Xray tests`;
}

function showProjects(message: Extract<SetupHostMessage, { type: "project-view" }>): void {
  projectView.replaceChildren();
  if (message.hasJira && message.jiraError !== undefined) {
    const note = document.createElement("p");
    note.className = "pv-note";
    note.textContent = `Jira project list unavailable: ${message.jiraError}`;
    projectView.appendChild(note);
  } else if (message.hasJira) {
    appendHeading(message.jiraTruncated
      ? `Accessible Jira projects (${message.jiraProjects.length}+, list truncated)`
      : `Accessible Jira projects (${message.jiraProjects.length})`);
    appendList(message.jiraProjects, (project) => `${project.key}: ${project.name}`);
  }
  if (message.probed.length > 0) {
    appendHeading("Xray coverage for tagged projects");
    appendList(message.probed, projectPhrase);
  }
}

function handle(message: SetupHostMessage): void {
  switch (message.type) {
    case "busy": setBusy(message); return;
    case "form-state": showFormState(message); return;
    case "validation": showValidation(message); return;
    case "saved": showSaved(message); return;
    case "conn-state": setConnection(message); return;
    case "project-view": showProjects(message); return;
    case "test-result":
      status.classList.toggle("error", !message.ok);
      status.textContent = message.message;
      return;
    case "error":
      status.classList.add("error");
      status.textContent = message.message;
  }
}

function submit(test: boolean): void {
  post({
    type: "save",
    site: site.value,
    region: region.value,
    clientId: clientId.value,
    clientSecret: clientSecret.value,
    jiraEmail: jiraEmail.value,
    jiraToken: jiraToken.value,
    test,
  });
}

saveTest.addEventListener("click", () => submit(true));
save.addEventListener("click", () => submit(false));
form.addEventListener("submit", (event) => {
  event.preventDefault();
  submit(true);
});
for (const name of fieldOrder) {
  fields[name].addEventListener(name === "region" ? "change" : "input", () => clearFieldError(name));
}

window.addEventListener("message", (event: MessageEvent<unknown>) => {
  if (!isSetupHostEnvelope(event.data, session, documentId, revision)) {return;}
  revision = event.data.revision;
  handle(event.data.body);
});

post({ type: "ready", ...(previousDocument ? { previousDocument } : {}) });
