/// <reference path="../../webview/client/globals.d.ts" />

import axe from "axe-core";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import * as vscode from "vscode";
import { afterEach, describe, expect, it } from "vitest";
import {
  XraySetupPanel,
  type XraySetupDelegate,
} from "../../xray/xray-setup-panel";
import type {
  SetupClientMessage,
  SetupEnvelope,
  SetupHostMessage,
} from "../../webview/setup-protocol";

const MASK = "••••••••";

interface SetupClientRig {
  readonly dom: JSDOM;
  readonly posted: Array<SetupEnvelope<SetupClientMessage>>;
  readonly stateCalls: { get: number; set: number };
  readonly state: Record<string, unknown>;
  send(body: SetupHostMessage): void;
  sendRaw(message: unknown): void;
}

const panels = vscode.window as unknown as {
  __webviewPanels: Array<{ webview: { html: string } }>;
  __resetWebviewPanels(): void;
};

let bundledClient: Promise<string> | undefined;

function clientCode(): Promise<string> {
  bundledClient ??= build({
    entryPoints: ["src/webview/xray-setup.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
  }).then((output) => output.outputFiles[0]!.text);
  return bundledClient;
}

function delegate(hasCredentials = false, hasJira = false): XraySetupDelegate {
  const connected = {
    ok: true,
    stage: "ok" as const,
    site: "acme.atlassian.net",
    message: "Connected to acme.atlassian.net",
  };
  return {
    workspaceAvailable: () => true,
    currentSite: () => "acme.atlassian.net",
    currentRegion: () => "global",
    hasCredentials: () => Promise.resolve(hasCredentials),
    getCredentials: () => Promise.resolve(hasCredentials ? { clientId: "stored-id", clientSecret: "stored-secret" } : undefined),
    saveSetup: () => Promise.resolve("acme.atlassian.net"),
    hasJiraCredentials: () => Promise.resolve(hasJira),
    getJiraCredentials: () => Promise.resolve(hasJira ? { email: "stored@example.com", token: "stored-token" } : undefined),
    probeConnection: () => Promise.resolve(connected),
    verifyConnection: () => Promise.resolve(connected),
  };
}

async function productionHtml(hasCredentials = false, hasJira = false): Promise<string> {
  await XraySetupPanel.show(delegate(hasCredentials, hasJira), vscode.Uri.file("/extension/dist"));
  const html = panels.__webviewPanels.at(-1)!.webview.html;
  await XraySetupPanel.close();
  return html;
}

async function rig(
  hasCredentials = false,
  hasJira = false,
  initialState: Record<string, unknown> | undefined = undefined
): Promise<SetupClientRig> {
  const dom = new JSDOM(await productionHtml(hasCredentials, hasJira), {
    pretendToBeVisual: true,
    runScripts: "outside-only",
  });
  const posted: Array<SetupEnvelope<SetupClientMessage>> = [];
  const stateCalls = { get: 0, set: 0 };
  let state = initialState;
  Object.defineProperty(dom.window, "acquireVsCodeApi", {
    value: () => ({
      postMessage: (message: SetupEnvelope<SetupClientMessage>) => posted.push(message),
      getState: () => {stateCalls.get += 1; return state;},
      setState: (next: Record<string, unknown>) => {stateCalls.set += 1; state = next;},
    }),
  });
  dom.window.eval(await clientCode());
  const session = dom.window.document.body.dataset["session"] ?? "";
  const documentId = posted[0]?.document ?? "";
  let revision = 0;
  const sendRaw = (message: unknown): void => {
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message }));
  };
  return {
    dom,
    posted,
    stateCalls,
    get state() {return state ?? {};},
    send: (body) => sendRaw({
      version: 1,
      session,
      document: documentId,
      revision: ++revision,
      surface: "setup",
      body,
    }),
    sendRaw,
  };
}

async function expectNoSeriousViolations(dom: JSDOM): Promise<void> {
  // JSDOM cannot resolve VS Code theme custom properties to colors, so contrast has no meaningful
  // computed values here. Every semantic axe rule still runs against the production document.
  const result = await axe.run(dom.window.document.documentElement, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(result.violations.filter((violation) =>
    violation.impact === "serious" || violation.impact === "critical"
  )).toEqual([]);
}

afterEach(async () => {
  await XraySetupPanel.close();
  panels.__resetWebviewPanels();
});

describe("Xray setup browser client", () => {
  it("executes the actual bundle and sends secrets only in one save intent without persisting them", async () => {
    const client = await rig(true, true);
    expect(client.posted).toEqual([expect.objectContaining({
      version: 1,
      revision: 0,
      surface: "setup",
      body: { type: "ready" },
    })]);
    const document = client.dom.window.document;
    const secret = "unique-client-secret-value";
    (document.getElementById("clientSecret") as HTMLInputElement).value = secret;
    (document.getElementById("save-test") as HTMLButtonElement).click();

    const save = client.posted.at(-1)!;
    expect(save.body).toMatchObject({ type: "save", clientSecret: secret, test: true });
    expect((document.getElementById("save-test") as HTMLButtonElement).disabled).toBe(false);
    expect(client.stateCalls).toEqual({ get: 1, set: 1 });
    expect(Object.keys(client.state)).toEqual(["setupDocument"]);
    expect(JSON.stringify(client.state)).not.toContain(secret);
    expect(JSON.stringify(client.posted).split(secret)).toHaveLength(2);

    client.send({ type: "busy", busy: true, testing: true });
    expect((document.getElementById("save-test") as HTMLButtonElement).disabled).toBe(true);
    client.send({ type: "saved", site: "acme.atlassian.net", region: "au", jira: true });
    expect((document.getElementById("clientSecret") as HTMLInputElement).value).toBe(MASK);
    expect((document.getElementById("jiraToken") as HTMLInputElement).value).toBe(MASK);
    expect(document.getElementById("status")?.textContent).toContain("Testing connection");
    client.send({ type: "busy", busy: false, testing: true });
    expect((document.getElementById("save-test") as HTMLButtonElement).disabled).toBe(false);
    expect(client.stateCalls).toEqual({ get: 1, set: 1 });
  });

  it("persists only a document token and chains a genuine client reload", async () => {
    const first = await rig();
    const previousDocument = first.posted[0]!.document;
    first.send({ type: "validation", errors: { site: "Enter a site" } });
    expect(first.dom.window.document.activeElement).toBe(
      first.dom.window.document.getElementById("site")
    );

    const reloaded = await rig(false, false, first.state);

    expect(reloaded.posted[0]).toMatchObject({
      document: expect.any(String),
      revision: 0,
      body: { type: "ready", previousDocument },
    });
    expect(reloaded.posted[0]!.document).not.toBe(previousDocument);
    expect(Object.keys(reloaded.state)).toEqual(["setupDocument"]);

    reloaded.send({
      type: "form-state",
      site: "new.atlassian.net",
      region: "au",
      credentials: true,
      jira: true,
    });
    reloaded.send({ type: "conn-state", state: "checking", label: "Checking connection…" });
    reloaded.send({
      type: "project-view",
      hasJira: true,
      jiraProjects: [{ key: "NEW", name: "New project" }],
      jiraTruncated: false,
      probed: [{ project: "NEW", totalTests: 2 }],
    });
    reloaded.send({ type: "busy", busy: true, testing: true });
    const document = reloaded.dom.window.document;
    expect((document.getElementById("site") as HTMLInputElement).value).toBe("new.atlassian.net");
    expect((document.getElementById("region") as HTMLSelectElement).value).toBe("au");
    expect((document.getElementById("clientSecret") as HTMLInputElement).value).toBe(MASK);
    expect((document.getElementById("jiraToken") as HTMLInputElement).value).toBe(MASK);
    expect(document.getElementById("conn-label")?.textContent).toBe("Checking connection…");
    expect(document.getElementById("project-view")?.textContent).toContain("NEW: 2 Xray tests");
    expect((document.getElementById("save-test") as HTMLButtonElement).disabled).toBe(true);
    expect((document.getElementById("site") as HTMLInputElement).hasAttribute("aria-invalid")).toBe(false);
    expect(document.getElementById("err-site")?.textContent).toBe("");
    expect(document.getElementById("status")?.classList.contains("error")).toBe(false);
    expect(document.activeElement).toBe(document.body);
  });

  it("ignores malformed, foreign, wrong-version, and nonmonotonic host envelopes", async () => {
    const client = await rig();
    const session = client.posted[0]!.session;
    const documentId = client.posted[0]!.document;
    const document = client.dom.window.document;
    const valid = {
      version: 1,
      session,
      document: documentId,
      revision: 4,
      surface: "setup",
      body: { type: "conn-state", state: "connected", label: "Connected" },
    };
    client.sendRaw({ ...valid, version: 2 });
    client.sendRaw({ ...valid, session: "foreign" });
    client.sendRaw({ ...valid, document: "f".repeat(32) });
    client.sendRaw({ ...valid, body: { type: "busy", busy: true, testing: false, extra: true } });
    expect(document.getElementById("conn-label")?.textContent).toBe("Not connected");

    client.sendRaw(valid);
    client.sendRaw({ ...valid, revision: 3, body: { type: "error", message: "stale" } });
    client.sendRaw({ ...valid, revision: 5, body: { type: "unknown" } });
    expect(document.getElementById("conn-label")?.textContent).toBe("Connected");
    expect(document.getElementById("status")?.textContent).not.toContain("stale");
  });

  it("focuses and clears invalid fields, renders masks and project status, and stays axe-clean", async () => {
    const client = await rig();
    const document = client.dom.window.document;
    client.send({
      type: "validation",
      errors: { site: "Enter a site", clientSecret: "Enter a secret" },
    });
    const site = document.getElementById("site") as HTMLInputElement;
    const secret = document.getElementById("clientSecret") as HTMLInputElement;
    expect(document.activeElement).toBe(site);
    expect(site.getAttribute("aria-invalid")).toBe("true");
    expect(secret.getAttribute("aria-invalid")).toBe("true");

    site.value = "acme.atlassian.net";
    site.dispatchEvent(new client.dom.window.Event("input", { bubbles: true }));
    expect(site.hasAttribute("aria-invalid")).toBe(false);
    expect(document.getElementById("err-site")?.textContent).toBe("");

    client.send({ type: "saved", site: "acme.atlassian.net", region: "eu", jira: true });
    client.send({ type: "conn-state", state: "connected", label: "Connected to acme.atlassian.net" });
    client.send({
      type: "project-view",
      hasJira: true,
      jiraProjects: [{ key: "CALC", name: "Calculator" }],
      jiraTruncated: false,
      probed: [{ project: "CALC", totalTests: 12, existsOnSite: true }],
    });
    expect(document.getElementById("conn-dot")?.classList.contains("connected")).toBe(true);
    expect(document.getElementById("project-view")?.textContent).toContain("CALC: Calculator");
    expect(document.getElementById("project-view")?.textContent).toContain("CALC: 12 Xray tests");
    expect((document.getElementById("clientId") as HTMLInputElement).value).toBe(MASK);
    expect(secret.hasAttribute("aria-invalid")).toBe(false);

    client.send({ type: "saved", site: "other.atlassian.net", region: "us", jira: false });
    expect(document.getElementById("project-view")?.textContent).toBe("");
    await expectNoSeriousViolations(client.dom);
  });
});
