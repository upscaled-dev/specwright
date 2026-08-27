/// <reference path="../../webview/client/globals.d.ts" />

import { build } from "esbuild";
import axe from "axe-core";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { readFile } from "node:fs/promises";
import { JSDOM } from "jsdom";
import * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import { TestDiscoveryManager } from "../../core/test-discovery-manager";
import { FeatureParser } from "../../parsers/feature-parser";
import { buildBoardViewModel } from "../../traceability/board-data";
import type { TraceabilityAdapter } from "../../traceability/contracts";
import { RunResultStore } from "../../traceability/run-result-store";
import { renderTraceabilityViewDocument } from "../../traceability/traceability-view-document";
import { projectTraceabilityTree } from "../../traceability/traceability-tree-projection";
import { TraceabilityModel, type TraceabilitySnapshot } from "../../traceability/traceability-model";
import { TraceabilityViewProvider } from "../../traceability/traceability-view-provider";
import { Logger } from "../../utils/logger";
import { PlaywrightJsonParser } from "../../utils/playwright-json-parser";
import { TRACEABILITY_VIEW_PROTOCOL_VERSION, type TraceabilityHostBody, type TraceabilityWireRow } from "../../webview/traceability-view-protocol";
import { XrayClient, type FetchLike } from "../../xray/xray-client";
import { XrayMetadataCapability } from "../../xray/xray-metadata";
import { XrayMetadataCache } from "../../xray/xray-metadata-cache";
import {
  XrayOrganizationCache,
  XrayOrganizationCapability,
  XrayOrganizationReader,
} from "../../xray/xray-organization";
import type { ExtensionConfig } from "../../core/extension-config";
import { TraceabilityPublishCommands, type TraceabilityPublishCommandDeps } from "../../commands/traceability-publish-commands";
import type { ExecutionGateway, RunIntent } from "../../core/run-contracts";
import { WorkspaceTrust } from "../../core/workspace-trust";
import { ArtifactBuilder, RunArtifactStore } from "../../traceability/run-artifact-store";
import { executionClientContext } from "../../ui/execution-client-context";

const OPEN = { id: "open", label: "Open", icon: "go-to-file" } as const;
const OPEN_REMOTE = { id: "open", label: "Open in tracker", icon: "link-external" } as const;
const COPY = { id: "copy", label: "Copy", icon: "copy" } as const;

let bundle: Promise<string> | undefined;
function clientCode(): Promise<string> {
  bundle ??= build({ entryPoints: ["src/webview/traceability-view.ts"], bundle: true, platform: "browser", format: "iife", outfile: "dist/traceability-view.js" })
    .then(() => readFile("dist/traceability-view.js", "utf8"));
  return bundle;
}

async function rig(restored?: unknown): Promise<{ dom: JSDOM; messages: unknown[]; states: unknown[]; send(body: TraceabilityHostBody, revision?: number): void }> {
  const webview = { cspSource: "https://traceability.test", asWebviewUri: (uri: vscode.Uri) => uri } as vscode.Webview;
  const html = renderTraceabilityViewDocument(webview, vscode.Uri.file("/dist"), "local").replace(/<script[^>]*src="[^"]*"><\/script>/, "");
  const dom = new JSDOM(html, { pretendToBeVisual: true, runScripts: "outside-only", url: "https://traceability.test" });
  Object.defineProperty(dom.window, "TextEncoder", { value: TextEncoder });
  const messages: unknown[] = [];
  const states: unknown[] = [];
  Object.defineProperty(dom.window, "acquireVsCodeApi", { value: () => ({ postMessage: (message: unknown) => messages.push(message), getState: () => restored, setState: (state: unknown) => states.push(state) }) });
  dom.window.eval(await clientCode());
  if (messages.length !== 1) {
    throw new Error(`Traceability client did not initialize: ${html}`);
  }
  const clientSession = (messages[0] as { session?: unknown }).session;
  if (typeof clientSession !== "string") {
    throw new Error("Traceability client did not provide a session.");
  }
  let revision = 0;
  return {
    dom,
    messages,
    states,
    send: (body, nextRevision) => {
      revision = nextRevision ?? revision + 1;
      dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: { version: TRACEABILITY_VIEW_PROTOCOL_VERSION, session: clientSession, revision, surface: "traceability", body } }));
    },
  };
}

async function mountProviderClient(
  provider: TraceabilityViewProvider,
  accept: (message: unknown) => Promise<boolean> = () => Promise.resolve(true)
): Promise<{ dom: JSDOM; setVisible(visible: boolean): void }> {
  let source = "";
  let receive = (_message: unknown): void => undefined;
  let post = (_message: unknown): void => undefined;
  let visible = true;
  const visibility = new vscode.EventEmitter<void>();
  const webview = {
    options: undefined,
    cspSource: "https://traceability.test",
    asWebviewUri: (uri: vscode.Uri) => uri,
    set html(value: string) { source = value; },
    postMessage: async (message: unknown): Promise<boolean> => {
      const sent = await accept(message);
      if (sent) { setImmediate(() => post(message)); }
      return sent;
    },
    onDidReceiveMessage: (listener: (message: unknown) => void) => {
      receive = listener;
      return { dispose: () => undefined };
    },
  } as unknown as vscode.Webview;
  provider.resolveWebviewView({
    webview,
    get visible() { return visible; },
    onDidChangeVisibility: visibility.event,
    onDidDispose: () => ({ dispose: () => undefined }),
  } as unknown as vscode.WebviewView);
  const dom = new JSDOM(source.replace(/<script[^>]*src="[^"]*"><\/script>/, ""), { pretendToBeVisual: true, runScripts: "outside-only", url: "https://traceability.test" });
  Object.defineProperty(dom.window, "TextEncoder", { value: TextEncoder });
  Object.defineProperty(dom.window, "acquireVsCodeApi", { value: () => ({ postMessage: receive, getState: () => undefined, setState: () => undefined }) });
  post = (message) => dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message }));
  dom.window.eval(await clientCode());
  return {
    dom,
    setVisible: (next) => {
      visible = next;
      visibility.fire();
    },
  };
}

function focusCommittedGeneration(provider: TraceabilityViewProvider): Promise<void> {
  const acknowledged = provider.acknowledgedFocusCount;
  return new Promise((resolve) => {
    const subscription = provider.onDidReceiveClientSignal((signal) => {
      if (signal === "focused" && provider.acknowledgedFocusCount > acknowledged) {
        subscription.dispose();
        resolve();
      }
    });
    provider.focusFilter();
  });
}

function memoryMemento(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
    update: (key: string, value: unknown): Promise<void> => {values.set(key, value); return Promise.resolve();},
    keys: (): readonly string[] => [...values.keys()],
  } as unknown as vscode.Memento;
}

function jsonResponse(body: unknown): Response {
  return { status: 200, ok: true, text: () => Promise.resolve(JSON.stringify(body)) } as Response;
}

function mutation(dom: JSDOM, ready: () => boolean): Promise<void> {
  if (ready()) {return Promise.resolve();}
  return new Promise((resolve) => {
    const observer = new dom.window.MutationObserver(() => {
      if (ready()) {observer.disconnect(); resolve();}
    });
    observer.observe(dom.window.document, { attributes: true, childList: true, subtree: true });
  });
}

describe("traceability view client", () => {
  it("restores the active tab, supports roving keyboard navigation, and closes stale previews on a new generation", async () => {
    const view = await rig({ view: "test-sets" });
    const tabs = [...view.dom.window.document.querySelectorAll<HTMLButtonElement>("[role=tab]")];
    const selected = (): HTMLButtonElement | undefined => tabs.find((tab) => tab.getAttribute("aria-selected") === "true");
    expect(selected()?.textContent).toBe("Test Sets");
    expect(selected()?.tabIndex).toBe(0);
    expect(tabs.filter((tab) => tab.tabIndex === 0)).toHaveLength(1);

    selected()?.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
    expect(selected()?.textContent).toBe("Repository");
    expect(view.dom.window.document.activeElement?.textContent).toBe("Repository");
    selected()?.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "Home", bubbles: true }));
    expect(selected()?.textContent).toBe("Workspace");
    selected()?.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(selected()?.textContent).toBe("Test Sets");

    view.send({
      type: "preview", generation: 0,
      preview: { previewId: "old", title: "Old preview", remoteMembers: 1, runnable: 1, remoteOnly: 0, members: [{ label: "SHOP-1", mapped: true }], displayTruncated: false },
    });
    expect(view.dom.window.document.getElementById("preview")?.hasAttribute("open")).toBe(true);
    view.dom.window.document.getElementById("cancel-preview")?.click();
    expect(view.messages.at(-1)).toMatchObject({ body: { type: "cancel-preview", previewId: "old" } });
    expect(view.dom.window.document.getElementById("preview")?.hasAttribute("open")).toBe(false);
    view.send({
      type: "preview", generation: 0,
      preview: { previewId: "escape", title: "Escape preview", remoteMembers: 1, runnable: 1, remoteOnly: 0, members: [{ label: "SHOP-1", mapped: true }], displayTruncated: false },
    });
    view.dom.window.document.getElementById("preview")?.dispatchEvent(new view.dom.window.Event("cancel", { cancelable: true }));
    expect(view.messages.at(-1)).toMatchObject({ body: { type: "cancel-preview", previewId: "escape" } });
    expect(view.dom.window.document.getElementById("preview")?.hasAttribute("open")).toBe(false);
    view.send({
      type: "preview", generation: 0,
      preview: { previewId: "stale", title: "Stale preview", remoteMembers: 1, runnable: 1, remoteOnly: 0, members: [{ label: "SHOP-1", mapped: true }], displayTruncated: false },
    });
    view.send({ type: "begin", generation: 1, state: "ready", total: 0 });
    expect(view.dom.window.document.getElementById("preview")?.hasAttribute("open")).toBe(false);
  });

  it("renders and confirms exact SHOP-301 and nested repository runs through the production Xray and bundled-client path", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "traceability-organization-client-"));
    const feature = path.join(root, "checkout.feature");
    fs.writeFileSync(feature, [
      "Feature: Checkout",
      "", "@TEST_SHOP-101", "Scenario: Add item to cart", "  Given an item",
      "", "@TEST_SHOP-117", "Scenario: Checkout as guest", "  Given a guest",
      "", "@TEST_SHOP-124", "Scenario: Pay with saved card", "  Given a saved card",
    ].join("\n"), "utf8");
    const remoteTests = [
      ["SHOP-101", "Add item to cart"],
      ["SHOP-117", "Checkout as guest"],
      ["SHOP-124", "Pay with saved card"],
      ["SHOP-130", "Payment confirmation email"],
    ] as const;
    const fetchImpl: FetchLike = (_url, init) => {
      if (!init.body || !String(init.body).includes("query")) {return Promise.resolve(jsonResponse("token"));}
      const query = (JSON.parse(String(init.body)) as { query: string }).query;
      if (query.includes("getTestSets")) {
        return Promise.resolve(jsonResponse({ data: { getTestSets: { total: 1, results: [{
          issueId: "301", jira: { key: "SHOP-301", summary: "Checkout smoke", description: "Critical checkout path" },
          tests: { total: 4, results: remoteTests.map(([key, summary]) => ({ jira: { key, summary } })) },
        }] } } }));
      }
      return Promise.resolve(jsonResponse({ data: { getTests: { total: 4, results: remoteTests.map(([key, summary]) => ({
        issueId: `${key}-id`, jira: { key, summary }, folder: { name: "Smoke", path: "/Checkout/Smoke" },
        testType: { name: "Cucumber", kind: "Gherkin" }, status: { name: "TODO" }, coverableIssues: { results: [] },
      })) } } }));
    };
    const logger = Logger.create();
    const client = new XrayClient({
      region: "global", logger, credentials: () => Promise.resolve({ clientId: "account-a", clientSecret: "secret" }), fetchImpl,
      sleep: () => Promise.resolve(), random: () => 0,
    });
    const state = memoryMemento();
    const account = (): Promise<string> => Promise.resolve("account-a");
    const identity = { endpoint: "xray.cloud.getxray.app", account, workspaceId: "ws" };
    const changed = new vscode.EventEmitter<void>();
    const config = { xrayCacheTtlMinutes: 15, xraySyncProjectKeys: ["SHOP"] } as unknown as ExtensionConfig;
    const metadata = new XrayMetadataCapability({
      client, cache: new XrayMetadataCache(state, identity), config, logger, account,
      onCredentialsChange: changed.event, listProjects: () => Promise.resolve(undefined),
    });
    const reader = new XrayOrganizationReader(client);
    const organizationCache = new XrayOrganizationCache(state, identity);
    const organization = new XrayOrganizationCapability({
      reader, metadata, cache: organizationCache, config, logger, account,
      onCredentialsChange: changed.event, projectOf: (key) => key.replace(/-\d+$/u, ""),
    });
    const discovery = { discoverTestFiles: () => Promise.resolve([feature]), dispose: () => undefined } as unknown as TestDiscoveryManager;
    const adapter: TraceabilityAdapter = {
      id: "xray", label: "Xray",
      keyGrammar: { testPrefix: "TEST_", reqPrefix: "REQ_", keyShape: /^[A-Z]+-\d+$/u, canonicalizeKey: (key) => key.toUpperCase(), projectOf: (key) => key.replace(/-\d+$/u, "") },
      browseUrl: () => undefined, metadata, organization,
    };
    const model = new TraceabilityModel(FeatureParser.create(logger), discovery, PlaywrightJsonParser.create(logger), adapter, new RunResultStore(), logger);
    let cachedOrganization: XrayOrganizationCapability | undefined;
    try {
      await metadata.sync({ projectKeys: ["SHOP"] });
      await organization.sync(["SHOP"]);
      organization.dispose();
      cachedOrganization = new XrayOrganizationCapability({
        reader, metadata, cache: organizationCache, config, logger, account,
        onCredentialsChange: changed.event, projectOf: (key) => key.replace(/-\d+$/u, ""),
      });
      await new Promise<void>((resolve) => {
        if (cachedOrganization?.snapshot().testSetProjects.length) {resolve(); return;}
        const subscription = cachedOrganization?.onDidChange(() => {subscription?.dispose(); resolve();});
      });
      await model.rebuild();
      const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), logger);
      provider.attach(model, "Xray", "test", cachedOrganization);
      provider.setConnected(true);
      const mounted = await mountProviderClient(provider);
      await focusCommittedGeneration(provider);
      const document = mounted.dom.window.document;
      document.querySelector<HTMLButtonElement>('[data-view="test-sets"]')?.click();
      expect(document.getElementById("tree")?.textContent).toContain("SHOP-301");
      expect(document.getElementById("tree")?.textContent).toContain("4 remote members · 3 runnable locally · 1 remote only");

      const intents: RunIntent[] = [];
      const artifacts = [] as ReturnType<ArtifactBuilder["seal"]>[];
      const artifactStore = new RunArtifactStore(memoryMemento(), logger);
      const identity = { engine: "core-client" as const, schemaProfile: "acceptance" };
      const run = vi.fn((prepared: { intent: RunIntent }) => {
        const context = executionClientContext(prepared.intent);
        if (!context) {throw new Error("Execution client context was not preserved.");}
        const artifact = new ArtifactBuilder(context.selection).seal("complete");
        artifactStore.append(artifact);
        artifacts.push(artifact);
        return Promise.resolve({ identity, state: "complete" as const, results: [], output: "", passed: 0, failed: 0, durationMs: 1, artifactId: artifact.id });
      });
      const gateway: ExecutionGateway = {
        running: false,
        diagnose: () => Promise.resolve([]),
        discover: () => Promise.resolve({ cases: [], diagnostics: [] }),
        prepare: (intent) => {intents.push(intent); return Promise.resolve({ operationId: `run-${intents.length}`, identity, intent });},
        run,
        debug: () => Promise.reject(new Error("not used")),
        cancel: () => Promise.resolve(), dispose: () => undefined,
      };
      const subsystem = {
        getSnapshot: () => model.snapshot,
        getActiveAdapter: () => adapter,
        rebuildNow: () => Promise.resolve(),
      };
      const publishCommands = new TraceabilityPublishCommands(logger, {
        config, fallbackAdapter: () => adapter, subsystem: () => subsystem,
        board: () => undefined, projectUniverse: () => [], rebuild: () => Promise.resolve(true),
        linkScenarioForRef: () => Promise.resolve(), credentials: () => Promise.resolve(undefined),
        jiraCredentials: () => Promise.resolve(undefined), hasJiraCredentials: () => Promise.resolve(false),
        publishLedger: () => undefined, siteUrl: () => "", idleEvent: changed.event,
        runArtifactStore: artifactStore, executionGateway: gateway, featureParser: FeatureParser.create(logger),
        workspaceTrust: new WorkspaceTrust(() => true), attachmentSpoolRoot: () => root,
        mutation: <T>(run: () => Promise<T>) => run(),
      } as unknown as TraceabilityPublishCommandDeps);
      const execute = vi.spyOn(vscode.commands, "executeCommand").mockImplementation((command: string, ...args: unknown[]) =>
        command === "playwrightBddRunner.traceability.runAndPublish"
          ? publishCommands.runAndPublish(...args)
          : Promise.resolve(undefined)
      );
      document.querySelector<HTMLButtonElement>('button[aria-label="Open in tracker: SHOP-301"]')?.click();
      expect(execute).toHaveBeenLastCalledWith(
        "playwrightBddRunner.traceability.openIssue",
        expect.objectContaining({ kind: "testSet", testSetKey: "SHOP-301", testKey: "SHOP-301" })
      );
      document.querySelector<HTMLButtonElement>('button[aria-label="Copy key: SHOP-301"]')?.click();
      expect(execute).toHaveBeenLastCalledWith(
        "playwrightBddRunner.traceability.copyKey",
        expect.objectContaining({ kind: "testSet", testSetKey: "SHOP-301", testKey: "SHOP-301" })
      );
      document.querySelector<HTMLButtonElement>('button[aria-label="Run Set and publish: SHOP-301"]')?.click();
      await mutation(mounted.dom, () => document.getElementById("preview")?.hasAttribute("open") === true);
      expect(document.getElementById("preview-summary")?.textContent).toBe("4 remote members · 3 runnable locally · 1 remote only");
      document.getElementById("confirm-preview")?.click();
      await vi.waitFor(() => expect(intents).toHaveLength(1));
      expect(run).toHaveBeenCalledTimes(1);
      expect(intents[0]?.targets.map((target) => target.kind === "scenario" ? target.scenario.name : target.kind)).toEqual([
        "Add item to cart", "Checkout as guest", "Pay with saved card",
      ]);

      document.querySelector<HTMLButtonElement>('[data-view="repository"]')?.click();
      expect(document.getElementById("tree")?.textContent).toContain("Checkout");
      document.querySelector<HTMLElement>('[data-id][aria-expanded="false"]')?.querySelector<HTMLButtonElement>(".twisty")?.click();
      expect(document.getElementById("tree")?.textContent).toContain("Smoke");
      document.querySelector<HTMLButtonElement>('button[aria-label="Run folder and publish: Smoke"]')?.click();
      await mutation(mounted.dom, () => document.getElementById("preview")?.hasAttribute("open") === true);
      document.getElementById("confirm-preview")?.click();
      await vi.waitFor(() => expect(intents).toHaveLength(2));
      expect(run).toHaveBeenCalledTimes(2);
      expect(intents[1]?.targets.map((target) => target.kind === "scenario" ? target.scenario.name : target.kind)).toEqual([
        "Add item to cart", "Checkout as guest", "Pay with saved card",
      ]);
      expect(artifacts.map((artifact) => artifact.selection)).toEqual([
        expect.objectContaining({ kind: "test-set", testSetKey: "SHOP-301", scenarios: expect.arrayContaining([
          expect.objectContaining({ name: "Add item to cart" }),
          expect.objectContaining({ name: "Checkout as guest" }),
          expect.objectContaining({ name: "Pay with saved card" }),
        ]) }),
        expect.objectContaining({ kind: "repository-folder", projectKey: "SHOP", folderPath: "/Checkout/Smoke", scenarios: expect.any(Array) }),
      ]);
      expect(artifacts[0]?.selection.kind === "test-set" ? artifacts[0].selection.scenarios : []).toHaveLength(3);
      expect(artifacts[1]?.selection.kind === "repository-folder" ? artifacts[1].selection.scenarios : []).toHaveLength(3);
      expect(JSON.stringify(artifacts.map((artifact) => artifact.selection))).not.toContain("memberKeys");
      execute.mockRestore();
      provider.dispose();
    } finally {
      cachedOrganization?.dispose();
      model.dispose();
      await metadata.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("renders the same Xray-tagged feature mapping as Coverage Board and recovers it after a failed visible transfer", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "traceability-view-client-"));
    const feature = path.join(root, "calculator.feature");
    const logger = Logger.create();
    const adapter: TraceabilityAdapter = {
      id: "xray",
      label: "Xray",
      keyGrammar: { testPrefix: "TEST_", reqPrefix: "REQ_", keyShape: /^[A-Z]+-\d+$/, canonicalizeKey: (key) => key.toUpperCase() },
      browseUrl: () => undefined,
    };
    const discovery = {
      discoverTestFiles: () => Promise.resolve([feature]),
      dispose: () => undefined,
    } as unknown as TestDiscoveryManager;
    const model = new TraceabilityModel(
      FeatureParser.create(logger), discovery, PlaywrightJsonParser.create(logger), adapter, new RunResultStore(), logger
    );
    const writeFeature = (key: string, name: string): void => fs.writeFileSync(feature, `Feature: Calculator\n\n@TEST_${key}\nScenario: ${name}\n  Given a calculator\n`, "utf8");
    try {
      writeFeature("CALC-41", "Initial Xray calculation");
      await model.rebuild();

      let dropNextPopulatedChunk = false;
      let droppedChunk = (): void => undefined;
      const dropped = new Promise<void>((resolve) => { droppedChunk = resolve; });
      const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), logger);
      provider.attach(model, "Xray", "test");
      provider.setConnected(true);
      const client = await mountProviderClient(provider, (message) => {
        const body = (message as { body: { type: string; total?: number } }).body;
        if (dropNextPopulatedChunk && body.type === "chunk") {
          dropNextPopulatedChunk = false;
          droppedChunk();
          return Promise.resolve(false);
        }
        return Promise.resolve(true);
      });
      await focusCommittedGeneration(provider);
      const board = (): ReturnType<typeof buildBoardViewModel> => buildBoardViewModel(model.snapshot, [root], "TEST_", false);
      expect(board().mapped).toEqual(expect.arrayContaining([expect.objectContaining({ key: "CALC-41", links: [expect.objectContaining({ name: "Initial Xray calculation" })] })]));
      const filter = client.dom.window.document.getElementById("filter") as HTMLInputElement;
      filter.value = "initial xray";
      filter.dispatchEvent(new client.dom.window.Event("input", { bubbles: true }));
      expect(client.dom.window.document.getElementById("tree")?.textContent).toContain("Initial Xray calculation");
      expect(client.dom.window.document.getElementById("tree")?.textContent).toContain("CALC-41");

      dropNextPopulatedChunk = true;
      writeFeature("CALC-42", "Dropped Xray calculation");
      await model.rebuild();
      await dropped;
      expect(board().mapped).toEqual(expect.arrayContaining([expect.objectContaining({ key: "CALC-42", links: [expect.objectContaining({ name: "Dropped Xray calculation" })] })]));

      writeFeature("CALC-43", "Recovered Xray calculation");
      await model.rebuild();
      await focusCommittedGeneration(provider);
      filter.value = "recovered xray";
      filter.dispatchEvent(new client.dom.window.Event("input", { bubbles: true }));
      expect(board().mapped).toEqual(expect.arrayContaining([expect.objectContaining({ key: "CALC-43", links: [expect.objectContaining({ name: "Recovered Xray calculation" })] })]));
      expect(client.dom.window.document.getElementById("tree")?.textContent).toContain("Recovered Xray calculation");
      expect(client.dom.window.document.getElementById("tree")?.textContent).toContain("CALC-43");
      expect(client.dom.window.document.getElementById("tree")?.hasAttribute("aria-busy")).toBe(false);
      expect(client.dom.window.document.getElementById("tree")?.hasAttribute("aria-disabled")).toBe(false);
    } finally {
      model.dispose();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("commits populated provider projections on initial reveal, rebuild, and re-reveal", async () => {
    const changes = new vscode.EventEmitter<void>();
    let snapshot: TraceabilitySnapshot = {
      links: [{
        testKey: "CALC-1",
        scenario: { filePath: "/workspace/calculator.feature", line: 1, name: "Mapped calculation", kind: "scenario" },
        reqKeys: [],
      }],
      untraced: [],
      orphans: [],
      stale: false,
      completeProjects: [],
      errors: [],
    };
    const provider = new TraceabilityViewProvider(vscode.Uri.file("/dist"), Logger.create());
    provider.attach({ get snapshot(): TraceabilitySnapshot { return snapshot; }, onDidChange: changes.event } as TraceabilityModel, "Xray", "test");
    provider.setConnected(true);

    const initial = await mountProviderClient(provider);
    await focusCommittedGeneration(provider);
    const initialFilter = initial.dom.window.document.getElementById("filter") as HTMLInputElement;
    initialFilter.value = "mapped calculation";
    initialFilter.dispatchEvent(new initial.dom.window.Event("input", { bubbles: true }));
    expect(initial.dom.window.document.getElementById("tree")?.textContent).toContain("Mapped calculation");

    initial.setVisible(false);
    snapshot = {
      ...snapshot,
      links: [{ ...snapshot.links[0]!, scenario: { ...snapshot.links[0]!.scenario, name: "Rebuilt calculation" } }],
    };
    changes.fire();
    initial.setVisible(true);
    await focusCommittedGeneration(provider);
    initialFilter.value = "rebuilt calculation";
    initialFilter.dispatchEvent(new initial.dom.window.Event("input", { bubbles: true }));
    expect(initial.dom.window.document.getElementById("tree")?.textContent).toContain("Rebuilt calculation");
  });

  it("commits populated projected rows and filters them", async () => {
    const snapshot: TraceabilitySnapshot = {
      links: [{
        testKey: "CALC-1",
        scenario: { filePath: "/workspace/calculator.feature", line: 1, name: "Mapped calculation", kind: "scenario" },
        reqKeys: [],
      }],
      untraced: [],
      orphans: [],
      stale: false,
      completeProjects: [],
      errors: [],
    };
    const projection = projectTraceabilityTree(
      { get snapshot(): TraceabilitySnapshot { return snapshot; } } as TraceabilityModel,
      "Xray",
      "test",
      true,
      undefined,
      true
    );
    expect(projection.rows.find((row) => row.label === "Mapped calculation")?.description).toBeUndefined();

    const view = await rig();
    view.send({ type: "begin", generation: 1, state: projection.state, total: projection.rows.length });
    view.send({ type: "chunk", generation: 1, offset: 0, rows: projection.rows as readonly TraceabilityWireRow[] });
    view.send({ type: "end", generation: 1 });

    expect(view.dom.window.document.querySelector("[role=treeitem]")?.textContent).toContain("Untraced scenarios");
    const filter = view.dom.window.document.getElementById("filter") as HTMLInputElement;
    filter.value = "mapped calculation";
    filter.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
    expect(view.dom.window.document.getElementById("tree")?.textContent).toContain("Mapped calculation");
  });

  it("keeps a chunked generation non-actionable until its exact end", async () => {
    const view = await rig();
    view.send({ type: "begin", generation: 1, state: "ready", total: 2 });
    view.send({ type: "chunk", generation: 1, offset: 0, rows: [{ id: "root", label: "Mapped", icon: "folder", expandable: true, actions: [] }] });
    expect(view.dom.window.document.querySelectorAll("[role=treeitem]")).toHaveLength(0);
    expect(view.dom.window.document.getElementById("tree")?.getAttribute("aria-busy")).toBe("true");
    view.send({ type: "chunk", generation: 1, offset: 1, rows: [{ id: "child", parentId: "root", label: "Scenario", icon: "circle-outline", expandable: false, actions: [OPEN] }] });
    view.send({ type: "end", generation: 1 });
    expect(view.dom.window.document.querySelectorAll("[role=treeitem]").length).toBeGreaterThan(0);
    expect(view.dom.window.document.getElementById("tree")?.hasAttribute("aria-busy")).toBe(false);
    expect(view.dom.window.document.getElementById("tree")?.getAttribute("aria-multiselectable")).toBe("true");
  });

  it("acknowledges host filter focus only for the committed generation", async () => {
    const view = await rig();
    view.send({ type: "begin", generation: 1, state: "ready", total: 1 });
    view.send({ type: "chunk", generation: 1, offset: 0, rows: [{ id: "row", label: "Row", icon: "info", expandable: false, actions: [] }] });
    view.send({ type: "end", generation: 1 });
    view.send({ type: "focus-filter", generation: 1 });
    expect(view.dom.window.document.activeElement?.id).toBe("filter");
    expect(view.messages.at(-1)).toMatchObject({ body: { type: "focused", generation: 1 } });
  });

  it("virtualizes a large committed tree and retains matching ancestors when filtered", async () => {
    const view = await rig();
    Object.defineProperty(view.dom.window.document.getElementById("tree"), "clientHeight", { configurable: true, value: 84 });
    const rows = Array.from({ length: 10_001 }, (_, index) => ({
      id: index === 0 ? "root" : `row-${index}`,
      ...(index === 0 ? {} : { parentId: "root" }),
      label: index === 0 ? "Root" : `Scenario ${index}`,
      icon: "circle",
      expandable: index === 0,
      actions: [],
    }));
    view.send({ type: "begin", generation: 2, state: "ready", total: rows.length });
    for (let offset = 0; offset < rows.length; offset += 256) {
      view.send({ type: "chunk", generation: 2, offset, rows: rows.slice(offset, offset + 256) });
    }
    view.send({ type: "end", generation: 2 });
    expect(view.dom.window.document.querySelectorAll("[role=treeitem]").length).toBeLessThan(32);
    expect(view.states.at(-1)).toMatchObject({ expanded: [], collapsedRoots: [] });
    const tree = view.dom.window.document.getElementById("tree") as HTMLElement;
    tree.scrollTop = 9_000 * 28;
    tree.dispatchEvent(new view.dom.window.Event("scroll"));
    const deep = view.dom.window.document.querySelector("[data-id=row-9000]");
    expect(deep).not.toBeNull();
    expect(deep?.getAttribute("aria-posinset")).toBe("9000");
    expect(deep?.getAttribute("aria-setsize")).toBe("10000");
    const filter = view.dom.window.document.getElementById("filter") as HTMLInputElement;
    filter.value = "Scenario 10000";
    filter.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
    expect(view.dom.window.document.getElementById("tree")?.textContent).toContain("Root");
    expect(view.dom.window.document.getElementById("tree")?.textContent).toContain("Scenario 10000");
    filter.value = "no matching traceability row";
    filter.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
    expect(view.dom.window.document.querySelectorAll("[role=treeitem]")).toHaveLength(0);
    filter.value = "";
    filter.dispatchEvent(new view.dom.window.Event("input", { bubbles: true }));
    Object.defineProperty(tree, "clientHeight", { configurable: true, value: 168 });
    view.dom.window.dispatchEvent(new view.dom.window.Event("resize"));
    expect(view.dom.window.document.querySelectorAll("[role=treeitem]").length).toBeLessThan(40);
  });

  it("activates a row default action on primary click without activating multi-selection", async () => {
    const view = await rig();
    const rows = [{ id: "scenario", label: "Scenario", icon: "circle-outline", expandable: false, actions: [COPY, OPEN], defaultAction: "open" }];
    view.send({ type: "begin", generation: 1, state: "ready", total: 1 });
    view.send({ type: "chunk", generation: 1, offset: 0, rows });
    view.send({ type: "end", generation: 1 });
    const row = view.dom.window.document.querySelector<HTMLElement>("[data-id=scenario]")!;
    expect(row.querySelector(".codicon[data-icon=circle-outline]")).not.toBeNull();
    expect(row.querySelector<HTMLButtonElement>(".actions button")?.title).toBe("Copy");
    expect(row.querySelector(".actions button .codicon")).not.toBeNull();
    row.dispatchEvent(new view.dom.window.MouseEvent("click", { bubbles: true }));
    expect(view.messages.at(-1)).toMatchObject({ body: { type: "action", id: "scenario", action: "open" } });
    const messages = view.messages.length;
    row.dispatchEvent(new view.dom.window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
    expect(view.messages).toHaveLength(messages);
  });

  it("restores primary activation only for rows that had a native TreeItem command", async () => {
    const view = await rig();
    const rows: readonly TraceabilityWireRow[] = [
      { id: "connection", label: "Xray Cloud", icon: "cloud", expandable: false, actions: [{ id: "connect", label: "Set up connection", icon: "plug" }], defaultAction: "connect" },
      { id: "scenario", label: "Mapped scenario", icon: "circle-outline", expandable: false, actions: [OPEN], defaultAction: "open" },
      { id: "untraced", label: "Untraced scenario", icon: "circle-large-outline", expandable: false, actions: [OPEN], defaultAction: "open" },
      { id: "orphan", label: "CALC-9", icon: "beaker", expandable: false, actions: [OPEN_REMOTE], defaultAction: "open" },
    ];
    view.send({ type: "begin", generation: 1, state: "ready", total: rows.length });
    view.send({ type: "chunk", generation: 1, offset: 0, rows });
    view.send({ type: "end", generation: 1 });
    for (const row of rows) {
      view.dom.window.document.querySelector<HTMLElement>(`[data-id="${row.id}"]`)?.click();
    }
    expect(view.messages.slice(1).map((message) => (message as { body: { action: string } }).body.action)).toEqual(["connect", "open", "open", "open"]);
  });

  it("keeps an all-views row and its actions on every tab while the rest stay on their own", async () => {
    const view = await rig();
    const selectSyncProjects = { id: "select-sync-projects", label: "Select projects to sync", icon: "checklist" } as const;
    const rows: readonly TraceabilityWireRow[] = [
      { id: "connection", view: "all", label: "Xray Cloud", icon: "cloud", expandable: false, actions: [selectSyncProjects] },
      { id: "workspace-row", view: "workspace", label: "Mapped scenario", icon: "circle-outline", expandable: false, actions: [] },
      { id: "repository-row", view: "repository", label: "SHOP repository", icon: "repo", expandable: false, actions: [] },
      { id: "test-set-row", view: "test-sets", label: "SHOP-301", icon: "folder", expandable: false, actions: [] },
    ];
    view.send({ type: "begin", generation: 1, state: "ready", total: rows.length });
    view.send({ type: "chunk", generation: 1, offset: 0, rows });
    view.send({ type: "end", generation: 1 });
    const shownIds = (): string[] => [...view.dom.window.document.querySelectorAll<HTMLElement>("[role=treeitem]")].map((row) => row.dataset["id"] ?? "");
    const scopeAction = (): HTMLButtonElement | null =>
      view.dom.window.document.querySelector<HTMLButtonElement>('[data-id="connection"] .actions button[title="Select projects to sync"]');

    expect(shownIds()).toEqual(["connection", "workspace-row"]);
    expect(scopeAction()).not.toBeNull();

    view.dom.window.document.querySelector<HTMLButtonElement>('[data-view="repository"]')?.click();
    expect(shownIds()).toEqual(["connection", "repository-row"]);
    expect(scopeAction()).not.toBeNull();

    view.dom.window.document.querySelector<HTMLButtonElement>('[data-view="test-sets"]')?.click();
    expect(shownIds()).toEqual(["connection", "test-set-row"]);
    scopeAction()?.click();
    expect(view.messages.at(-1)).toMatchObject({ body: { type: "action", id: "connection", action: "select-sync-projects" } });
  });

  it("defaults returning and new roots while preserving an explicit collapse across grouping changes", async () => {
    const view = await rig();
    const send = (generation: number, rows: readonly TraceabilityWireRow[]): void => {
      view.send({ type: "begin", generation, state: "ready", total: rows.length });
      view.send({ type: "chunk", generation, offset: 0, rows });
      view.send({ type: "end", generation });
    };
    const testRows: readonly TraceabilityWireRow[] = [{ id: "test-root", label: "Mapped tests", icon: "folder", expandable: true, actions: [] }, { id: "test-child", parentId: "test-root", label: "Test child", icon: "circle-outline", expandable: false, actions: [] }];
    send(1, testRows);
    expect(view.dom.window.document.querySelector("[data-id=test-child]")).not.toBeNull();
    send(2, [{ id: "file-root", label: "feature.feature", icon: "file", expandable: true, actions: [] }, { id: "file-child", parentId: "file-root", label: "File child", icon: "circle-outline", expandable: false, actions: [] }]);
    expect(view.dom.window.document.querySelector("[data-id=file-child]")).not.toBeNull();
    send(3, testRows);
    expect(view.dom.window.document.querySelector("[data-id=test-child]")).not.toBeNull();
    (view.dom.window.document.querySelector<HTMLButtonElement>("[data-id=test-root] button")!).click();
    expect(view.dom.window.document.querySelector("[data-id=test-child]")).toBeNull();
    send(4, [{ id: "file-root", label: "feature.feature", icon: "file", expandable: true, actions: [] }]);
    send(5, testRows);
    expect(view.dom.window.document.querySelector("[data-id=test-child]")).toBeNull();
    send(6, [...testRows, { id: "new-root", label: "New section", icon: "folder", expandable: true, actions: [] }, { id: "new-child", parentId: "new-root", label: "New child", icon: "circle-outline", expandable: false, actions: [] }]);
    expect(view.dom.window.document.querySelector("[data-id=new-child]")).not.toBeNull();
  });

  it("rejects skipped and mixed transfers without making stale rows actionable, then recovers on a later begin", async () => {
    const view = await rig();
    const row = { id: "scenario", label: "Scenario", icon: "circle-outline", expandable: false, actions: [OPEN], defaultAction: "open" };
    view.send({ type: "begin", generation: 1, state: "ready", total: 1 });
    view.send({ type: "chunk", generation: 1, offset: 0, rows: [row] });
    view.send({ type: "end", generation: 1 });
    const readyMessages = view.messages.length;
    view.send({ type: "begin", generation: 2, state: "ready", total: 1 });
    const item = view.dom.window.document.querySelector<HTMLElement>("[role=treeitem]")!;
    item.dispatchEvent(new view.dom.window.MouseEvent("dblclick", { bubbles: true }));
    item.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(view.messages).toHaveLength(readyMessages);
    expect(view.dom.window.document.getElementById("tree")?.getAttribute("aria-disabled")).toBe("true");
    view.send({ type: "chunk", generation: 3, offset: 0, rows: [row] });
    view.send({ type: "end", generation: 2 });
    expect(view.dom.window.document.getElementById("tree")?.getAttribute("aria-busy")).toBe("true");
    view.send({ type: "chunk", generation: 2, offset: 0, rows: [row] }, 99);
    expect(view.dom.window.document.getElementById("tree")?.getAttribute("aria-busy")).toBe("true");
    view.send({ type: "begin", generation: 3, state: "ready", total: 1 }, 7);
    view.send({ type: "chunk", generation: 3, offset: 0, rows: [row] });
    view.send({ type: "end", generation: 3 });
    expect(view.dom.window.document.getElementById("tree")?.hasAttribute("aria-busy")).toBe(false);
    view.dom.window.document.querySelector<HTMLElement>("[role=treeitem]")?.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(view.messages).toHaveLength(readyMessages + 1);
  });

  it("keeps a persisted root collapse and uses defaultAction", async () => {
    const view = await rig({ expanded: [], collapsedRoots: ["root"], selected: [] });
    const rows = [
      { id: "root", label: "Root", icon: "folder", expandable: true, actions: [] },
      { id: "child", parentId: "root", label: "Child", icon: "circle-outline", expandable: false, actions: [COPY, OPEN], defaultAction: "open" },
    ];
    view.send({ type: "begin", generation: 1, state: "ready", total: rows.length });
    view.send({ type: "chunk", generation: 1, offset: 0, rows });
    view.send({ type: "end", generation: 1 });
    expect(view.dom.window.document.querySelector("[data-id=child]")).toBeNull();
    const root = view.dom.window.document.querySelector<HTMLElement>("[data-id=root]")!;
    const right = new view.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true });
    root.dispatchEvent(right);
    expect(right.defaultPrevented).toBe(true);
    const child = view.dom.window.document.querySelector<HTMLElement>("[data-id=child]")!;
    child.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(view.messages.at(-1)).toMatchObject({ body: { type: "action", action: "open", id: "child" } });
  });

  it("maintains one roving row and focuses an offscreen keyboard target", async () => {
    const view = await rig();
    Object.defineProperty(view.dom.window.document.getElementById("tree"), "clientHeight", { configurable: true, value: 84 });
    const rows = Array.from({ length: 40 }, (_, index) => ({ id: `row-${index}`, label: `Row ${index}`, icon: "circle", expandable: false, actions: [] }));
    view.send({ type: "begin", generation: 1, state: "ready", total: rows.length });
    view.send({ type: "chunk", generation: 1, offset: 0, rows });
    view.send({ type: "end", generation: 1 });
    const first = view.dom.window.document.querySelector<HTMLElement>("[data-id=row-0]")!;
    expect(view.dom.window.document.querySelectorAll("[role=treeitem][tabindex=\"0\"]")).toHaveLength(1);
    expect(first.getAttribute("aria-level")).toBe("1");
    first.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "PageDown", bubbles: true }));
    expect(view.dom.window.document.activeElement?.getAttribute("data-id")).toBe("row-3");
    view.dom.window.document.querySelector<HTMLElement>("[data-id=row-3]")?.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "End", bubbles: true }));
    expect(view.dom.window.document.querySelector("[data-id=row-39]")).not.toBeNull();
    expect(view.dom.window.document.activeElement?.getAttribute("data-id")).toBe("row-39");
  });

  it("keeps one range anchor across repeated Shift movement and preserves selection on Ctrl movement", async () => {
    const view = await rig();
    Object.defineProperty(view.dom.window.document.getElementById("tree"), "clientHeight", { configurable: true, value: 140 });
    const rows = Array.from({ length: 5 }, (_, index) => ({ id: `row-${index}`, label: `Row ${index}`, icon: "circle-outline", expandable: false, actions: [] }));
    view.send({ type: "begin", generation: 1, state: "ready", total: rows.length });
    view.send({ type: "chunk", generation: 1, offset: 0, rows });
    view.send({ type: "end", generation: 1 });
    view.dom.window.document.querySelector<HTMLElement>("[data-id=row-0]")?.click();
    view.dom.window.document.querySelector<HTMLElement>("[data-id=row-0]")?.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }));
    view.dom.window.document.querySelector<HTMLElement>("[data-id=row-1]")?.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", shiftKey: true, bubbles: true }));
    expect([...view.dom.window.document.querySelectorAll("[role=treeitem][aria-selected=true]")].map((item) => item.getAttribute("data-id"))).toEqual(["row-0", "row-1", "row-2"]);
    view.dom.window.document.querySelector<HTMLElement>("[data-id=row-2]")?.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", ctrlKey: true, bubbles: true }));
    expect(view.dom.window.document.activeElement?.getAttribute("data-id")).toBe("row-3");
    expect([...view.dom.window.document.querySelectorAll("[role=treeitem][aria-selected=true]")].map((item) => item.getAttribute("data-id"))).toEqual(["row-0", "row-1", "row-2"]);
  });

  it("keeps a workspace selection, focus, and anchor across a tab round trip", async () => {
    const view = await rig();
    const rows: readonly TraceabilityWireRow[] = [
      { id: "w1", label: "Workspace one", icon: "circle-outline", expandable: false, actions: [], view: "workspace" },
      { id: "w2", label: "Workspace two", icon: "circle-outline", expandable: false, actions: [], view: "workspace" },
      { id: "w3", label: "Workspace three", icon: "circle-outline", expandable: false, actions: [], view: "workspace" },
      { id: "r1", label: "SHOP", icon: "repo", expandable: false, actions: [], view: "repository" },
    ];
    view.send({ type: "begin", generation: 1, state: "ready", total: rows.length });
    view.send({ type: "chunk", generation: 1, offset: 0, rows });
    view.send({ type: "end", generation: 1 });
    const document = view.dom.window.document;
    const selectedIds = (): string[] => [...document.querySelectorAll("[role=treeitem][aria-selected=true]")].map((item) => item.getAttribute("data-id") ?? "");
    document.querySelector<HTMLElement>("[data-id=w1]")?.click();
    document.querySelector<HTMLElement>("[data-id=w2]")?.dispatchEvent(new view.dom.window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
    expect(selectedIds()).toEqual(["w1", "w2"]);

    document.querySelector<HTMLButtonElement>('[data-view="repository"]')?.click();
    expect(selectedIds()).toEqual([]);
    document.querySelector<HTMLButtonElement>('[data-view="workspace"]')?.click();

    expect(selectedIds()).toEqual(["w1", "w2"]);
    expect(document.querySelector("[role=treeitem][tabindex='0']")?.getAttribute("data-id")).toBe("w2");
    document.querySelector<HTMLElement>("[data-id=w3]")?.dispatchEvent(new view.dom.window.MouseEvent("click", { bubbles: true, shiftKey: true }));
    expect(selectedIds()).toEqual(["w2", "w3"]);
  });

  it("does not let twisty or inline action key events trigger their row handlers", async () => {
    const view = await rig();
    const rows = [
      { id: "root", label: "Root", icon: "folder", expandable: true, actions: [] },
      { id: "child", parentId: "root", label: "Child", icon: "circle-outline", expandable: false, actions: [COPY], defaultAction: "copy" },
    ];
    view.send({ type: "begin", generation: 1, state: "ready", total: rows.length });
    view.send({ type: "chunk", generation: 1, offset: 0, rows });
    view.send({ type: "end", generation: 1 });
    const twisty = view.dom.window.document.querySelector<HTMLButtonElement>("[data-id=root] button")!;
    twisty.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(view.dom.window.document.querySelector("[data-id=child]")).not.toBeNull();
    const action = view.dom.window.document.querySelector<HTMLButtonElement>("[data-id=child] .actions button")!;
    action.dispatchEvent(new view.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(view.messages).toHaveLength(1);
  });

  it("caps multi-selection at 128 rows and announces the limit", async () => {
    const view = await rig();
    const rows = Array.from({ length: 257 }, (_, index) => ({ id: `row-${index}`, label: `Row ${index}`, icon: "circle", expandable: false, actions: [] }));
    view.send({ type: "begin", generation: 1, state: "ready", total: rows.length });
    for (let offset = 0; offset < rows.length; offset += 256) {
      view.send({ type: "chunk", generation: 1, offset, rows: rows.slice(offset, offset + 256) });
    }
    view.send({ type: "end", generation: 1 });
    const tree = view.dom.window.document.getElementById("tree") as HTMLElement;
    for (let index = 0; index < rows.length; index += 1) {
      tree.scrollTop = index * 28;
      tree.dispatchEvent(new view.dom.window.Event("scroll"));
      const item = view.dom.window.document.querySelector<HTMLElement>(`[data-id="row-${index}"]`)!;
      item.dispatchEvent(new view.dom.window.MouseEvent("click", { bubbles: true, ctrlKey: true }));
    }
    expect(view.dom.window.document.getElementById("status")?.textContent).toBe("Selection is limited to 128 rows.");
  });

  it("has no serious or critical accessibility violations after a bundled render", async () => {
    const view = await rig();
    const rows = [
      { id: "root", label: "Mapped", icon: "folder", tone: "info" as const, expandable: true, actions: [] },
      { id: "child", parentId: "root", label: "Scenario", icon: "pass", tone: "success" as const, expandable: false, actions: [OPEN], defaultAction: "open" },
    ];
    view.send({ type: "begin", generation: 1, state: "ready", total: rows.length });
    view.send({ type: "chunk", generation: 1, offset: 0, rows });
    view.send({ type: "end", generation: 1 });
    const result = await axe.run(view.dom.window.document.documentElement, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
  });

  it("renders host-authorized disconnected, untrusted, and empty state affordances", async () => {
    const view = await rig({ filter: "x".repeat(5_000), expanded: ["stale"] });
    const disconnected = { id: "state-disconnected", label: "Set up Xray", description: "Set up Xray integration to map scenarios and publish results.", tooltip: "Set up", icon: "plug", tone: "info" as const, expandable: false, actions: [{ id: "connect", label: "Set up connection", icon: "plug" }, { id: "hide", label: "Hide Traceability", icon: "eye-closed" }], defaultAction: "connect" };
    view.send({ type: "begin", generation: 1, state: "disconnected", total: 1 });
    view.send({ type: "chunk", generation: 1, offset: 0, rows: [disconnected] });
    view.send({ type: "end", generation: 1 });
    expect(view.dom.window.document.getElementById("tree")?.getAttribute("role")).toBe("region");
    expect(view.dom.window.document.querySelector(".state-title")?.textContent).toBe("Set up Xray");
    const filter = view.dom.window.document.getElementById("filter") as HTMLInputElement;
    expect(filter.maxLength).toBe(4_096);
    expect(filter.value).toHaveLength(4_096);
    expect(view.states.at(-1)).toMatchObject({ expanded: ["stale"] });
    (view.dom.window.document.querySelector(".state-actions button") as HTMLButtonElement).click();
    expect(view.messages.at(-1)).toMatchObject({ body: { type: "action", action: "connect", id: "state-disconnected" } });
    const result = await axe.run(view.dom.window.document.documentElement, { rules: { "color-contrast": { enabled: false } } });
    expect(result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);

    const untrusted = { id: "state-untrusted", label: "Workspace trust required", description: "Traceability stays offline while this workspace is untrusted.", tooltip: "Trust", icon: "shield", tone: "warning" as const, expandable: false, actions: [{ id: "manage-trust", label: "Manage workspace trust", icon: "shield" }], defaultAction: "manage-trust" };
    view.send({ type: "begin", generation: 2, state: "untrusted", total: 1 });
    view.send({ type: "chunk", generation: 2, offset: 0, rows: [untrusted] });
    view.send({ type: "end", generation: 2 });
    (view.dom.window.document.querySelector(".state-actions button") as HTMLButtonElement).click();
    expect(view.messages.at(-1)).toMatchObject({ body: { type: "action", action: "manage-trust", id: "state-untrusted" } });

    const empty = { id: "state-empty", label: "No Xray-tagged scenarios found yet.", description: "Add @TEST_KEY tags to scenarios. Local mappings update automatically.", tooltip: "Add tags", icon: "info", tone: "muted" as const, expandable: false, actions: [] };
    view.send({ type: "begin", generation: 3, state: "empty", total: 1 });
    view.send({ type: "chunk", generation: 3, offset: 0, rows: [empty] });
    view.send({ type: "end", generation: 3 });
    expect(view.dom.window.document.querySelector(".state-title")?.textContent).toBe("No Xray-tagged scenarios found yet.");
    expect(view.dom.window.document.querySelector(".state-actions")).toBeNull();
    expect(view.dom.window.document.getElementById("tree")?.tabIndex).toBe(0);

    const ready = { id: "ready", label: "Ready", icon: "info", expandable: false, actions: [] };
    view.send({ type: "begin", generation: 4, state: "ready", total: 1 });
    view.send({ type: "chunk", generation: 4, offset: 0, rows: [ready] });
    view.send({ type: "end", generation: 4 });
    expect(view.states.at(-1)).toMatchObject({ expanded: [] });
    expect(view.dom.window.document.getElementById("tree")?.getAttribute("aria-multiselectable")).toBe("true");

    view.send({ type: "begin", generation: 5, state: "disconnected", total: 1 });
    view.send({ type: "chunk", generation: 5, offset: 0, rows: [disconnected] });
    view.send({ type: "end", generation: 5 });
    expect(view.dom.window.document.getElementById("tree")?.getAttribute("role")).toBe("region");
    expect(view.dom.window.document.getElementById("tree")?.hasAttribute("aria-multiselectable")).toBe(false);
  });
});
