/// <reference path="../../webview/client/globals.d.ts" />

import axe from "axe-core";
import { JSDOM } from "jsdom";
import * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import { browserClientCode } from "./helpers/browser-client-bundle.mjs";
import { EXECUTIONS } from "./helpers/board-panel-driver";
import { boardFragment } from "../../traceability/board-fragment";
import { BoardSurface, type BoardSurfaceDeps } from "../../traceability/board-surface";
import { buildBoardViewModel, type BoardViewModel } from "../../traceability/board-data";
import { buildTraceabilitySnapshot } from "../../traceability/traceability-model";
import { validatedAdapter } from "../../traceability/validated-adapter";
import type { TraceabilityAdapter } from "../../traceability/contracts";
import type { ExtensionConfig } from "../../core/extension-config";
import { Logger } from "../../utils/logger";
import { XrayMetadataCapability } from "../../xray/xray-metadata";
import type { XrayClient } from "../../xray/xray-client";
import type { XrayMetadataCache } from "../../xray/xray-metadata-cache";
import { LINK_FRAGMENT } from "../../traceability/link-picker-panel";
import { PUBLISH_FRAGMENT } from "../../traceability/publish-dialog-panel";
import type { SurfaceHost } from "../../traceability/webview-host";
import type {
  BoardClientMessage,
  BoardHostMessage,
  ClientMessage,
  HostMessage,
  PublishDialogModel,
  SurfaceName,
  WebviewEnvelope,
} from "../../webview/protocol";
import { parseClientEnvelope } from "../../webview/protocol";

const tabs = ["mapping", "matrix", "executions", "publish", "link"] as const;

interface ClientRig {
  readonly dom: JSDOM;
  readonly posted: Array<WebviewEnvelope<ClientMessage>>;
  readonly state: Record<string, unknown>;
  send(surface: SurfaceName | "shell", body: HostMessage): void;
  sendRaw(message: unknown): void;
}

function documentHtml(): string {
  const tabHtml = tabs.map((tab) => `<button role="tab" id="tab-${tab}" data-tab="${tab}" aria-controls="pane-${tab}" aria-selected="false" tabindex="-1"${tab === "link" ? " hidden" : ""}>${tab}</button>`).join("");
  return `<!doctype html><html lang="en"><head><title>Coverage Board</title></head><body data-session="local">
    <header><h1>Coverage Board</h1><div class="tabs" role="tablist" aria-label="Coverage views">${tabHtml}</div><div class="scope"><select id="scope-select" aria-label="View project"></select></div><div class="search"><input id="search" aria-label="Filter coverage board"></div></header>
    <div id="sync-strip" role="status" aria-live="polite" hidden><span id="sync-strip-text"></span></div>
    <main>${boardFragment("Xray").paneHtml}<section id="pane-publish" class="pane" data-tab="publish" role="tabpanel" aria-labelledby="tab-publish" hidden>${PUBLISH_FRAGMENT.paneHtml}</section><section id="pane-link" class="pane" data-tab="link" role="tabpanel" aria-labelledby="tab-link" hidden>${LINK_FRAGMENT.paneHtml}</section></main>
  </body></html>`;
}

async function rig(state: Record<string, unknown> = {}): Promise<ClientRig> {
  const dom = new JSDOM(documentHtml(), { pretendToBeVisual: true, runScripts: "outside-only" });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
  const posted: Array<WebviewEnvelope<ClientMessage>> = [];
  Object.defineProperty(dom.window, "acquireVsCodeApi", {
    value: () => ({
      postMessage: (message: WebviewEnvelope<ClientMessage>) => posted.push(message),
      getState: () => state,
      setState: (next: Record<string, unknown>) => {
        for (const key of Object.keys(state)) {delete state[key];}
        Object.assign(state, next);
      },
    }),
  });
  dom.window.eval(await browserClientCode("coverage-board"));
  let revision = 0;
  const sendRaw = (message: unknown): void => {
    dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message }));
  };
  return {
    dom,
    posted,
    state,
    send: (surface, body) => sendRaw({ version: 1, session: "local", revision: ++revision, surface, body }),
    sendRaw,
  };
}

async function bridgeBoardSurface(
  model: BoardViewModel,
  onContainerAction: (action: "createTestSet" | "addToTestSet" | "createTestPlan" | "addToTestPlan", surface: BoardSurface) => void,
  scope?: { projects: readonly string[]; project?: string }
): Promise<{ readonly client: ClientRig; readonly surface: BoardSurface; routeClientMessages(): void }> {
  const client = await rig();
  client.send("shell", { type: "activate", tab: "mapping" });
  let messageHandler = (_message: BoardClientMessage): void => undefined;
  const board = { surface: undefined as BoardSurface | undefined };
  let selectedProject = scope ? scope.project : "CALC";
  let pageSize = 50;
  const never: vscode.Event<void> = () => ({ dispose: () => undefined });
  const host: SurfaceHost<"board"> = {
    post: (message) => client.send("board", message),
    onMessage: (handler) => { messageHandler = handler; },
    activate: () => undefined,
    onDidDispose: () => undefined,
    isDisposed: () => false,
    setTabVisible: () => undefined,
  };
  const deps: BoardSurfaceDeps = {
    buildModel: () => model,
    buildExecutions: () => [],
    onDidChange: never,
    onDidChangeActivity: never,
    mutationActive: () => false,
    syncActive: () => false,
    syncPickerActive: () => false,
    applyDrop: () => Promise.resolve(),
    applyUnlink: () => Promise.resolve(),
    pushText: () => undefined,
    runSync: () => Promise.resolve(),
    syncProjects: () => scope?.projects ?? ["CALC"],
    selectSyncProjects: () => undefined,
    autoSync: () => Promise.resolve(),
    openIssue: () => undefined,
    bulkCreate: () => undefined,
    createTestSet: () => onContainerAction("createTestSet", board.surface!),
    addToTestSet: () => onContainerAction("addToTestSet", board.surface!),
    createTestPlan: () => onContainerAction("createTestPlan", board.surface!),
    addToTestPlan: () => onContainerAction("addToTestPlan", board.surface!),
    createTestExecution: () => undefined,
    knownProjects: () => scope?.projects ?? ["CALC"],
    projectScope: { get: () => selectedProject, set: (project) => { selectedProject = project; } },
    mappingPageSize: { get: () => pageSize, set: (size) => { pageSize = size; } },
  };
  const surface = new BoardSurface(host, deps);
  board.surface = surface;
  let nextMessage = client.posted.length;
  const routeClientMessages = (): void => {
    while (nextMessage < client.posted.length) {
      const message = parseClientEnvelope(client.posted[nextMessage++]);
      if (message?.surface === "board") {
        messageHandler(message.body as BoardClientMessage);
      }
    }
  };
  return { client, surface, routeClientMessages };
}

const PICKER_HINT = "Choose the projects every sync fetches, alongside the View project.";

function boardRender(selected = false): Extract<BoardHostMessage, { type: "render" }> {
  const section = { total: 1, filtered: 1, page: 0, pageSize: 25, pageCount: 1, query: "", filtering: false, selection: "none" } as const;
  const verb = { label: "Action", enabled: true, hint: "" };
  return {
    type: "render",
    scenarios: [{ name: "Login", location: "features/login.feature:3", dropId: "scenario-1", pills: [], reqKeys: [], selected }],
    available: [{ key: "CALC-1", pills: [], links: [], selected }],
    matrixPage: { filtered: 0, page: 0, pageSize: 25, pageCount: 0 },
    mapped: [], sections: { untraced: section, available: section, mapped: { ...section, total: 0, filtered: 0, pageCount: 0 } },
    pageSize: 25, matrix: [], executions: [], availableEmptyText: "No tests",
    filtering: false, projects: ["CALC"], project: "CALC", scoped: true,
    createVerb: verb, syncVerb: { label: "Sync", enabled: true, hint: "" },
    syncScopeVerb: { label: "Select projects...", enabled: true, hint: PICKER_HINT },
    untracedHelper: "", testSetVerb: verb, addToTestSetVerb: verb,
    testPlanVerb: verb, addToTestPlanVerb: verb, mappingHelper: "", executionVerb: verb,
  };
}

function mappingActionRender(): Extract<BoardHostMessage, { type: "render" }> {
  return {
    ...boardRender(),
    testSetVerb: { label: "Create Test Set from 2 tests", enabled: true, hint: "Creates a Test Set for the checked tests." },
    addToTestSetVerb: { label: "Add 2 tests to a Test Set", enabled: false, hint: "Choose a project before adding tests." },
    testPlanVerb: { label: "Create Test Plan from 2 tests", enabled: true, hint: "Creates a Test Plan for the checked tests." },
    addToTestPlanVerb: { label: "Add 2 tests to a Test Plan", enabled: false, hint: "Choose a project before adding tests." },
  };
}

function mappedRender(withLink = true): Extract<BoardHostMessage, { type: "render" }> {
  const base = boardRender();
  const mapped = [{
    key: "CALC-2", pills: [], selected: false,
    links: withLink ? [{ name: "Mapped login", location: "features/login.feature:3", unlinkId: "scenario-1" }] : [],
  }];
  return {
    ...base,
    mapped,
    sections: { ...base.sections, mapped: { ...base.sections.mapped, total: 1, filtered: 1, pageCount: 1 } },
  };
}

const publishModel: PublishDialogModel = {
  title: "Publish run",
  runs: [{ id: "run-1", label: "Latest", subtitle: "1 result", project: { value: "", fromDerivation: false }, defaultSummary: "" }],
  selectedRunId: "run-1",
  jiraSearchAvailable: false,
  knownProjectKeys: ["CALC"],
  attachments: { available: false, reason: "Unavailable", suggestions: [], uploadLimitBytes: 0, evidenceStream: "evidence" },
};

function pendingPublishModel(): PublishDialogModel {
  const run = publishModel.runs[0]!;
  return {
    ...publishModel,
    runs: [
      { ...run, id: "run-a", label: "Run A", pendingAttachments: { target: "CALC-1", count: 2 } },
      { ...run, id: "run-b", label: "Run B", pendingAttachments: { target: "CALC-2", count: 3 } },
    ],
    selectedRunId: "run-a",
  };
}

function chooseRun(client: ClientRig, runId: string): void {
  const select = client.dom.window.document.getElementById("run-select") as HTMLSelectElement;
  select.value = runId;
  select.dispatchEvent(new client.dom.window.Event("change", { bubbles: true }));
}

function clientBodies(rig: ClientRig, surface?: SurfaceName | "shell"): ClientMessage[] {
  return rig.posted.filter((message) => surface === undefined || message.surface === surface).map((message) => message.body);
}

async function expectNoSeriousViolations(dom: JSDOM): Promise<void> {
  // JSDOM has no VS Code theme values for the production CSS custom properties, so contrast has no
  // computed colors here. The semantic rules still run against the production-equivalent document.
  const result = await axe.run(dom.window.document.documentElement, { rules: { "color-contrast": { enabled: false } } });
  expect(result.violations.filter((violation) => violation.impact === "serious" || violation.impact === "critical")).toEqual([]);
}

describe("coverage board browser client", () => {
  it("filters a named test from the last of three synced projects in All Projects", async () => {
    const projects = ["CALC", "MATH", "SHOP"];
    const catalogues = new Map(projects.map((project) => [project,
      Array.from({ length: 10_000 }, (_, index) => ({
        key: `${project}-${index + 1}`,
        summary: `${project} test ${index + 1}`,
        issueId: `${project}-${index + 1}-id`,
        status: { category: "passed" as const, providerValue: "PASS", color: "#0f0" },
        gherkin: "Scenario: Check\n  Given a step",
        coverageKeys: Array.from({ length: 20 }, (_, key) => `REQ-${index + 1}-${key}`),
        repositoryFolder: { name: "Smoke", path: "/Smoke" },
        testType: { name: "Cucumber", kind: "Gherkin" },
      })),
    ]));
    const explicitKeys = [...catalogues.values()].flatMap((tests) => tests.map((test) => test.key));
    const metadata = new XrayMetadataCapability({
      client: {
        fetchProjectCatalogue: (project: string) => Promise.resolve({
          tests: catalogues.get(project) ?? [], pages: [], complete: true, truncated: false, errors: [],
        }),
        fetchTestsByKeys: () => Promise.resolve({
          tests: [...catalogues.values()].flat(), pages: [], complete: true, truncated: false, errors: [],
        }),
        invalidateAuth: () => undefined,
      } as unknown as XrayClient,
      cache: { load: () => Promise.resolve(undefined), saveForAccount: () => Promise.resolve() } as unknown as XrayMetadataCache,
      config: { xrayCacheTtlMinutes: 15 } as ExtensionConfig,
      logger: Logger.create(),
      account: () => Promise.resolve("account"),
      onCredentialsChange: new vscode.EventEmitter<void>().event,
      listProjects: () => Promise.resolve(undefined),
    });
    const grammar = {
      testPrefix: "TEST_", reqPrefix: "REQ_", keyShape: /^[A-Z]+-\d+$/u,
      canonicalizeKey: (key: string) => key.toUpperCase(),
      projectOf: (key: string) => key.replace(/-\d+$/u, ""),
    };
    const source: TraceabilityAdapter = {
      id: "xray", label: "Xray", keyGrammar: grammar, browseUrl: () => undefined, metadata,
    };
    const adapter = validatedAdapter(source, () => Promise.resolve(), () => undefined);
    try {
      await adapter.metadata!.sync({ projectKeys: projects, testKeys: explicitKeys });
      const remote = adapter.metadata!.snapshot();
      expect(remote.fetchedScopes).toHaveLength(30_003);
      expect(remote.fetchedScopes.at(-1)).toBe("SHOP-10000");
      const snapshot = buildTraceabilitySnapshot([], {}, grammar, remote);
      const model = buildBoardViewModel(snapshot, [], "TEST_", true, grammar.projectOf);
      expect(model.available).toHaveLength(30_000);
      expect(model.available.find((card) => card.key === "SHOP-10000")?.summary).toBe("SHOP test 10000");
      const bridge = await bridgeBoardSurface(model, () => undefined, { projects });
      const doc = bridge.client.dom.window.document;
      expect(remote.tests.size).toBe(30_000);
      expect((doc.getElementById("scope-select") as HTMLSelectElement).value).toBe("");
      expect(doc.querySelector("#available-cards .key-link")?.textContent).toBe("CALC-1");

      const search = doc.getElementById("available-search") as HTMLInputElement;
      search.value = "SHOP-10000";
      search.dispatchEvent(new bridge.client.dom.window.Event("input", { bubbles: true }));
      expect(clientBodies(bridge.client, "board").at(-1)).toMatchObject({ type: "columnSearch", section: "available", value: "SHOP-10000" });
      bridge.routeClientMessages();

      expect(doc.getElementById("available-cards")?.textContent).toContain("SHOP-10000");
      expect(doc.getElementById("available-cards")?.textContent).toContain("SHOP test 10000");
      bridge.client.send("shell", { type: "activate", tab: "matrix" });
      const matrixPager = doc.getElementById("matrix-paginator")!;
      expect(matrixPager.textContent).toContain("1-50 of 30000");
      search.value = "";
      search.dispatchEvent(new bridge.client.dom.window.Event("input", { bubbles: true }));
      bridge.routeClientMessages();
      matrixPager.querySelectorAll("button")[1]?.click();
      bridge.routeClientMessages();
      expect(matrixPager.textContent).toContain("51-100 of 30000");
      doc.querySelector<HTMLButtonElement>("#matrix-rows .group-toggle")?.click();
      expect(doc.getElementById("matrix-rows")?.textContent).toContain(model.matrix[50]?.test);

      const scopeSelect = doc.getElementById("scope-select") as HTMLSelectElement;
      scopeSelect.value = "SHOP";
      scopeSelect.dispatchEvent(new bridge.client.dom.window.Event("change", { bubbles: true }));
      bridge.routeClientMessages();
      expect(matrixPager.textContent).toContain("1-50 of 10000");
      scopeSelect.value = "";
      scopeSelect.dispatchEvent(new bridge.client.dom.window.Event("change", { bubbles: true }));
      bridge.routeClientMessages();
      expect(matrixPager.textContent).toContain("1-50 of 30000");

      matrixPager.querySelectorAll("button")[1]?.click();
      bridge.routeClientMessages();
      expect(matrixPager.textContent).toContain("51-100 of 30000");
      const rows = doc.getElementById("page-size-select") as HTMLSelectElement;
      rows.value = "25";
      rows.dispatchEvent(new bridge.client.dom.window.Event("change", { bubbles: true }));
      bridge.routeClientMessages();
      expect(matrixPager.textContent).toContain("1-25 of 30000");

      matrixPager.querySelectorAll("button")[1]?.click();
      bridge.routeClientMessages();
      expect(matrixPager.textContent).toContain("26-50 of 30000");
      const headerSearch = doc.getElementById("search") as HTMLInputElement;
      headerSearch.value = "SHOP-10000";
      headerSearch.dispatchEvent(new bridge.client.dom.window.Event("input", { bubbles: true }));
      bridge.routeClientMessages();
      expect(matrixPager.textContent).toContain("1-1 of 1");
      expect(doc.getElementById("matrix-rows")?.textContent).toContain("SHOP-10000");
      bridge.client.dom.window.close();
    } finally {
      await metadata.dispose();
    }
  });

  it("executes the bundled browser IIFE in JSDOM", async () => {
    const client = await rig();
    expect(client.posted).toContainEqual({ version: 1, session: "local", revision: 0, surface: "shell", body: { type: "ready" } });
    client.send("shell", { type: "activate", tab: "mapping" });
    client.send("board", boardRender());
    expect(client.dom.window.document.querySelector("#scenario-cards .title")?.textContent).toBe("Login");
    expect(client.dom.window.document.getElementById("pane-mapping")?.hidden).toBe(false);
  });

  // The key has always been painted as a link, so it acts like one. Clicking it must not double as a
  // click on the card underneath, which is where selection and drag live.
  it("opens a test card's key in the tracker without touching that card's selection", async () => {
    const client = await rig();
    client.send("shell", { type: "activate", tab: "mapping" });
    client.send("board", mappedRender());
    const doc = client.dom.window.document;
    const box = doc.querySelector<HTMLInputElement>('input[aria-label="Select test CALC-2"]')!;
    const key = [...doc.querySelectorAll<HTMLButtonElement>("#mapped-cards .key-link")]
      .find((button) => button.textContent === "CALC-2")!;

    expect(key.title).toBe("Open CALC-2 in the tracker.");
    key.dispatchEvent(new client.dom.window.MouseEvent("click", { bubbles: true }));

    expect(clientBodies(client, "board")).toEqual([{ type: "open", key: "CALC-2" }]);
    expect(box.checked).toBe(false);
  });

  it("gives every available card key the same tracker control", async () => {
    const client = await rig();
    client.send("shell", { type: "activate", tab: "mapping" });
    client.send("board", boardRender());
    const key = client.dom.window.document.querySelector<HTMLButtonElement>("#available-cards .key-link")!;

    key.dispatchEvent(new client.dom.window.MouseEvent("click", { bubbles: true }));

    expect(clientBodies(client, "board")).toEqual([{ type: "open", key: "CALC-1" }]);
  });

  it("dispatches each shared Mapping action from both test toolbars", async () => {
    const client = await rig();
    const disabled = mappingActionRender();
    client.send("board", disabled);

    const expected = [
      ["create-test-set", disabled.testSetVerb],
      ["add-to-test-set", disabled.addToTestSetVerb],
      ["create-test-plan", disabled.testPlanVerb],
      ["add-to-test-plan", disabled.addToTestPlanVerb],
    ] as const;
    for (const section of ["available", "mapped"]) {
      for (const [id, verb] of expected) {
        const button = client.dom.window.document.getElementById(`${section}-${id}`) as HTMLButtonElement;
        expect(button.getAttribute("aria-label")).toBe(verb.label);
        expect(button.nextElementSibling?.textContent).toBe(`${verb.label}. ${verb.hint}`);
        expect(button.disabled).toBe(!verb.enabled);
        if (!verb.enabled) {button.click();}
      }
    }
    expect(clientBodies(client, "board")).toEqual([]);

    client.send("board", boardRender());
    const actions = [...client.dom.window.document.querySelectorAll<HTMLButtonElement>('[data-mapping-action]')];
    expect(actions).toHaveLength(8);
    for (const action of actions) {action.click();}

    const messages = clientBodies(client, "board");
    for (const type of ["createTestSet", "addToTestSet", "createTestPlan", "addToTestPlan"]) {
      expect(messages.filter((message) => message.type === type)).toHaveLength(2);
    }
    expect(client.dom.window.document.getElementById("run-selected")).toBeNull();
  });

  it("carries one scoped Available and Mapped selection through both Mapping toolbars", async () => {
    const model: BoardViewModel = {
      scenarios: [],
      available: [{ key: "CALC-1", project: "CALC", pills: [], links: [] }],
      mapped: [{
        key: "CALC-2",
        project: "CALC",
        pills: ["1 scenario"],
        links: [{ name: "Mapped login", location: "features/login.feature:3", unlinkId: "scenario-1" }],
      }],
      matrix: [],
      availableEmptyText: "No unmapped tests in the last sync.",
      completeProjects: ["CALC"],
    };
    const calls: Array<{ action: string; keys: readonly string[] }> = [];
    const bridge = await bridgeBoardSurface(model, (action, surface) => {
      calls.push({ action, keys: surface.selectedTests() });
    });
    const select = (key: string): void => {
      const box = bridge.client.dom.window.document.querySelector<HTMLInputElement>(`input[aria-label="Select test ${key}"]`)!;
      box.checked = true;
      box.dispatchEvent(new bridge.client.dom.window.Event("change", { bubbles: true }));
      bridge.routeClientMessages();
    };

    select("CALC-1");
    select("CALC-2");
    expect(bridge.surface.selectedTests()).toEqual(["CALC-1", "CALC-2"]);

    const actions = ["create-test-set", "add-to-test-set", "create-test-plan", "add-to-test-plan"] as const;
    for (const section of ["available", "mapped"]) {
      for (const action of actions) {
        const button = bridge.client.dom.window.document.getElementById(`${section}-${action}`) as HTMLButtonElement;
        expect(button.disabled).toBe(false);
        button.click();
        bridge.routeClientMessages();
      }
    }

    expect(calls.map((call) => call.action)).toEqual([
      "createTestSet", "addToTestSet", "createTestPlan", "addToTestPlan",
      "createTestSet", "addToTestSet", "createTestPlan", "addToTestPlan",
    ]);
    expect(calls.every((call) => JSON.stringify(call.keys) === JSON.stringify(["CALC-1", "CALC-2"]))).toBe(true);
  });

  it("checks a whole test list from its select-all box, then paints the mixed state back", async () => {
    const model: BoardViewModel = {
      scenarios: [],
      available: [
        { key: "CALC-1", project: "CALC", pills: [], links: [] },
        { key: "CALC-2", project: "CALC", pills: [], links: [] },
      ],
      mapped: [{
        key: "CALC-3",
        project: "CALC",
        pills: ["1 scenario"],
        links: [{ name: "Mapped login", location: "features/login.feature:3", unlinkId: "scenario-1" }],
      }],
      matrix: [],
      availableEmptyText: "No unmapped tests in the last sync.",
      completeProjects: ["CALC"],
    };
    const calls: Array<{ action: string; keys: readonly string[] }> = [];
    const bridge = await bridgeBoardSurface(model, (action, surface) => {
      calls.push({ action, keys: surface.selectedTests() });
    });
    const doc = bridge.client.dom.window.document;
    const selectAll = doc.getElementById("available-select-all") as HTMLInputElement;
    // The mixed state is a property, not an attribute, so it is read back off the element itself.
    const boxState = (id: string): { checked: boolean; indeterminate: boolean } => {
      const box = doc.getElementById(id) as HTMLInputElement;
      return { checked: box.checked, indeterminate: box.indeterminate };
    };
    const cardChecks = (section: string): boolean[] =>
      [...doc.querySelectorAll<HTMLInputElement>(`#${section}-cards input[type="checkbox"]`)].map((box) => box.checked);
    const click = (element: HTMLElement): void => {
      element.click();
      bridge.routeClientMessages();
    };

    click(selectAll);

    expect(bridge.surface.selectedTests()).toEqual(["CALC-1", "CALC-2"]);
    expect(cardChecks("available")).toEqual([true, true]);
    expect(cardChecks("mapped")).toEqual([false]);
    expect(boxState("available-select-all")).toEqual({ checked: true, indeterminate: false });
    expect(boxState("mapped-select-all")).toEqual({ checked: false, indeterminate: false });

    click(doc.getElementById("mapped-create-test-set")!);
    expect(calls).toEqual([{ action: "createTestSet", keys: ["CALC-1", "CALC-2"] }]);

    const card = doc.querySelector<HTMLInputElement>('input[aria-label="Select test CALC-2"]')!;
    card.checked = false;
    card.dispatchEvent(new bridge.client.dom.window.Event("change", { bubbles: true }));
    bridge.routeClientMessages();
    expect(boxState("available-select-all")).toEqual({ checked: false, indeterminate: true });

    click(selectAll);
    expect(bridge.surface.selectedTests()).toEqual(["CALC-1", "CALC-2"]);
    expect(boxState("available-select-all")).toEqual({ checked: true, indeterminate: false });

    click(selectAll);
    expect(bridge.surface.selectedTests()).toEqual([]);
    expect(cardChecks("available")).toEqual([false, false]);
    expect(boxState("available-select-all")).toEqual({ checked: false, indeterminate: false });

    click(doc.getElementById("mapped-select-all")!);
    expect(bridge.surface.selectedTests()).toEqual(["CALC-3"]);
    expect(cardChecks("mapped")).toEqual([true]);
    expect(boxState("available-select-all")).toEqual({ checked: false, indeterminate: false });

    // A list its search emptied has nothing to select, so its box goes dead instead of posting an intent
    // over no cards and ticking itself back off on the answer.
    const search = doc.getElementById("available-search") as HTMLInputElement;
    search.value = "nothing matches";
    search.dispatchEvent(new bridge.client.dom.window.Event("input", { bubbles: true }));
    bridge.routeClientMessages();
    const posts = clientBodies(bridge.client, "board").length;

    click(selectAll);

    expect(selectAll.disabled).toBe(true);
    expect(clientBodies(bridge.client, "board")).toHaveLength(posts);
    expect(bridge.surface.selectedTests()).toEqual(["CALC-3"]);
    await expectNoSeriousViolations(bridge.client.dom);
  });

  it("offers a keyboard link from a named scenario after the host selects a test", async () => {
    const model: BoardViewModel = {
      scenarios: [{ name: "Login", location: "features/login.feature:3", dropId: "scenario-1", pills: [], reqKeys: [] }],
      available: [{ key: "CALC-1", project: "CALC", pills: [], links: [] }],
      mapped: [], matrix: [], completeProjects: ["CALC"], availableEmptyText: "No unmapped tests",
    };
    const bridge = await bridgeBoardSurface(model, () => undefined);
    const doc = bridge.client.dom.window.document;
    doc.querySelector<HTMLInputElement>('input[aria-label="Select test CALC-1"]')!.click();
    bridge.routeClientMessages();
    expect(bridge.surface.selectedTests()).toEqual(["CALC-1"]);
    const button = [...doc.querySelectorAll<HTMLButtonElement>("#scenario-cards button")]
      .find(item => item.textContent === "Link to selected test")!;
    expect(doc.getElementById("scenario-cards")?.textContent).toContain("Login");
    button.click();
    expect(clientBodies(bridge.client, "board").at(-1)).toEqual({ type: "drop", scenario: "scenario-1", key: "CALC-1" });
    bridge.client.dom.window.close();
  });

  it("preserves a focused column search draft across a host repaint", async () => {
    const client = await rig();
    const doc = client.dom.window.document;
    const initial = boardRender();
    client.send("shell", { type: "activate", tab: "mapping" });
    client.send("board", initial);
    const search = doc.getElementById("available-search") as HTMLInputElement;
    search.focus();
    expect(doc.activeElement).toBe(search);
    search.value = "Pay by c";
    search.dispatchEvent(new client.dom.window.Event("input", { bubbles: true }));
    expect(clientBodies(client, "board").at(-1)).toEqual({ type: "columnSearch", section: "available", value: "Pay by c" });
    const refreshed = { ...initial, sections: { ...initial.sections, available: { ...initial.sections.available, query: "Pay" } } };
    client.send("board", refreshed);
    expect(search.value).toBe("Pay by c");
    expect(doc.activeElement).toBe(search);
    search.blur();
    client.send("board", refreshed);
    expect(search.value).toBe("Pay");
    client.dom.window.close();
  });

  it("ignores malformed, foreign and out-of-order host envelopes before dispatch", async () => {
    const client = await rig();
    const valid = { version: 1, session: "local", revision: 2, surface: "board", body: boardRender() };
    client.sendRaw({ ...valid, version: 2 });
    client.sendRaw({ ...valid, session: "foreign" });
    client.sendRaw({ ...valid, body: { type: "render" } });
    client.sendRaw(valid);
    client.sendRaw({ ...valid, revision: 1, body: { ...boardRender(), scenarios: [] } });
    expect(client.dom.window.document.querySelectorAll("#scenario-cards .card")).toHaveLength(1);
  });

  it("supports roving tabs, keyboard and drag linking, and focus restoration", async () => {
    const client = await rig();
    client.send("shell", { type: "activate", tab: "mapping" });
    client.send("board", boardRender());
    const matrix = client.dom.window.document.getElementById("tab-matrix") as HTMLButtonElement;
    matrix.dispatchEvent(new client.dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
    expect(clientBodies(client, "shell")).toContainEqual({ type: "tab", tab: "executions" });
    expect(client.dom.window.document.activeElement?.id).toBe("tab-executions");

    client.send("board", boardRender(true));
    const keyboardLink = [...client.dom.window.document.querySelectorAll<HTMLButtonElement>("#pane-mapping .pill-button")]
      .find((button) => button.textContent?.startsWith("Link"));
    keyboardLink?.click();
    expect(clientBodies(client, "board")).toContainEqual({ type: "drop", scenario: "scenario-1", key: "CALC-1" });

    const scenario = client.dom.window.document.querySelector<HTMLInputElement>('[data-focus-key="scenario:scenario-1"]')!;
    scenario.focus();
    client.send("board", boardRender(true));
    expect(client.dom.window.document.activeElement?.getAttribute("data-focus-key")).toBe("scenario:scenario-1");

    const linkBeforeRemoval = client.dom.window.document.querySelector<HTMLButtonElement>('[data-focus-fallback="scenario:scenario-1"]')!;
    linkBeforeRemoval.focus();
    client.send("board", boardRender(false));
    expect(client.dom.window.document.activeElement?.getAttribute("data-focus-key")).toBe("scenario:scenario-1");

    client.send("board", boardRender(true));

    const cards = client.dom.window.document.querySelectorAll<HTMLElement>("#pane-mapping .card");
    cards[0]!.dispatchEvent(new client.dom.window.Event("dragstart", { bubbles: true }));
    cards[1]!.dispatchEvent(new client.dom.window.Event("drop", { bubbles: true, cancelable: true }));
    expect(clientBodies(client, "board").at(-1)).toEqual({ type: "drop", scenario: "scenario-1", key: "CALC-1" });
    await expectNoSeriousViolations(client.dom);
  });

  it("restores a deterministic mapping focus target after unlink, sync, and paginator repaints", async () => {
    const client = await rig();
    client.send("shell", { type: "activate", tab: "mapping" });
    client.send("board", mappedRender());

    const unlink = client.dom.window.document.querySelector<HTMLButtonElement>('[data-focus-key="unlink:scenario-1:CALC-2"]')!;
    unlink.focus();
    client.send("board", mappedRender(false));
    expect(client.dom.window.document.activeElement?.getAttribute("data-focus-key")).toBe("test:CALC-2");

    const base = boardRender();
    const emptyAvailable = {
      ...base,
      available: [],
      sections: { ...base.sections, available: { ...base.sections.available, total: 0, filtered: 0, pageCount: 0 } },
    };
    client.send("board", emptyAvailable);
    const sync = client.dom.window.document.querySelector<HTMLButtonElement>('[data-focus-key="sync"]')!;
    sync.focus();
    client.send("board", { ...emptyAvailable, syncVerb: { label: "Sync", enabled: false, hint: "A mutation is active." } });
    expect(client.dom.window.document.activeElement?.getAttribute("data-focus-key")).toBe("page-size");

    const paged = {
      ...base,
      sections: { ...base.sections, untraced: { ...base.sections.untraced, total: 2, filtered: 2, pageCount: 2 } },
    };
    client.send("board", paged);
    const next = client.dom.window.document.querySelector<HTMLButtonElement>('[data-focus-key="page:untraced:next"]')!;
    next.focus();
    client.send("board", {
      ...paged,
      sections: { ...paged.sections, untraced: { ...paged.sections.untraced, page: 1 } },
    });
    expect(client.dom.window.document.activeElement?.getAttribute("data-focus-key")).toBe("untraced-search");
    expect(client.dom.window.document.activeElement).not.toBe(client.dom.window.document.body);
  });

  it("links a dragged test to a named scenario and clears invalid drag targets", async () => {
    const client = await rig();
    const doc = client.dom.window.document;
    client.send("shell", { type: "activate", tab: "mapping" });
    const render = boardRender();
    client.send("board", { ...render, scenarios: [{ ...render.scenarios[0]!, pills: ["@smoke"] }] });
    const scenario = doc.querySelector<HTMLElement>("#scenario-cards .card")!;
    const test = doc.querySelector<HTMLElement>("#available-cards .card")!;
    const transfer = { effectAllowed: "none", dropEffect: "none" };
    const drag = (element: HTMLElement, type: string): Event => {
      const event = new client.dom.window.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: transfer });
      element.dispatchEvent(event);
      return event;
    };
    expect(scenario.textContent).toContain("Login");
    expect(scenario.querySelector(".pill")?.textContent).toBe("@smoke");
    expect(drag(scenario, "drop").defaultPrevented).toBe(false);
    drag(test, "dragstart");
    expect(transfer.effectAllowed).toBe("link");
    expect(drag(test, "dragover").defaultPrevented).toBe(false);
    expect(drag(scenario, "dragover").defaultPrevented).toBe(true);
    expect(transfer.dropEffect).toBe("link");
    expect(scenario.classList.contains("drop-target")).toBe(true);
    drag(scenario, "dragleave");
    expect(scenario.classList.contains("drop-target")).toBe(false);
    drag(scenario, "dragover");
    drag(scenario, "drop");
    expect(clientBodies(client, "board").at(-1)).toEqual({ type: "drop", scenario: "scenario-1", key: "CALC-1" });
    drag(test, "dragstart");
    drag(scenario, "dragover");
    drag(test, "dragend");
    expect(doc.querySelector(".drop-target")).toBeNull();
    expect(drag(scenario, "drop").defaultPrevented).toBe(false);
    scenario.dispatchEvent(new client.dom.window.Event("dragstart", { bubbles: true }));
    const reverse = new client.dom.window.Event("dragover", { bubbles: true, cancelable: true });
    test.dispatchEvent(reverse);
    expect(reverse.defaultPrevented).toBe(true);
    expect(test.classList.contains("drop-target")).toBe(true);
    test.dispatchEvent(new client.dom.window.Event("drop", { bubbles: true, cancelable: true }));
    expect(clientBodies(client, "board").at(-1)).toEqual({ type: "drop", scenario: "scenario-1", key: "CALC-1" });
    client.send("board", { type: "syncProgress", text: "Loading CALC tests" });
    expect(doc.getElementById("sync-strip")?.hidden).toBe(false);
    expect(doc.getElementById("sync-strip-text")?.textContent).toBe("Loading CALC tests");
    client.send("board", { type: "syncProgress", text: "" });
    expect(doc.getElementById("sync-strip")?.hidden).toBe(true);
    client.dom.window.close();
  });

  it("restores matrix and execution groups, pages older activity, and keeps filter expansion temporary", async () => {
    const state = { matrixOpen: ["features/checkout.feature", 7], executionsCollapsed: ["CALC-1", false], executionsShown: 50 };
    const client = await rig(state);
    const doc = client.dom.window.document;
    const activity = EXECUTIONS.find((row) => row.kind === "group")!;
    const executions: Extract<BoardHostMessage, { type: "render" }>["executions"] = [
      ...Array.from({ length: 60 }, (_, index) => ({ ...activity, key: `CALC-${index + 1}`, keyLabel: `CALC-${index + 1}`, summary: `Checkout batch ${index + 1}` })),
      { kind: "unknown", key: "", keyLabel: "Unresolved import", summary: "Target not named", action: "Imported", resultsImported: "1", passRate: "1/1 passed", publishedAt: "2026-07-22", activityCount: 1 },
    ];
    const row = { requirement: "", test: "CALC-1", scenario: "Checkout as guest", tag: "", result: "Passed", file: "features/checkout.feature", projects: ["CALC"] };
    const render: Extract<BoardHostMessage, { type: "render" }> = {
      ...boardRender(), executions,
      matrix: [{ file: "features/checkout.feature", count: 1, rows: [row] }, { file: "", count: 1, rows: [{ ...row, file: "", scenario: "" }] }],
      matrixPage: { filtered: 2, page: 0, pageSize: 25, pageCount: 1 },
    };
    client.send("board", render);
    client.send("shell", { type: "activate", tab: "matrix" });
    expect(doc.getElementById("matrix-rows")?.textContent).toContain("Checkout as guest");
    expect(doc.getElementById("matrix-rows")?.textContent).toContain("Available tests");
    expect(doc.querySelector("#matrix-rows .hole")).not.toBeNull();
    doc.querySelector<HTMLButtonElement>("#matrix-rows .group-toggle")!.click();
    expect(doc.getElementById("matrix-rows")?.textContent).not.toContain("Checkout as guest");
    expect(state.matrixOpen).toEqual([]);

    client.send("shell", { type: "activate", tab: "executions" });
    const firstToggle = (): HTMLButtonElement => doc.querySelector<HTMLButtonElement>("#executions-rows .execution-toggle")!;
    expect(firstToggle().getAttribute("aria-expanded")).toBe("false");
    firstToggle().click();
    expect(state.executionsCollapsed).toEqual([]);
    firstToggle().click();
    expect(state.executionsCollapsed).toEqual(["CALC-1"]);
    expect(doc.getElementById("executions-rows")?.textContent).not.toContain("Checkout batch 60");
    doc.querySelector<HTMLButtonElement>("#executions-rows .older-cell button")!.click();
    expect(doc.getElementById("executions-rows")?.textContent).toContain("Checkout batch 60");
    expect(doc.getElementById("executions-rows")?.textContent).toContain("Unresolved import");
    expect(doc.querySelector("#executions-rows .older-cell")).toBeNull();
    expect(state.executionsShown).toBe(100);
    doc.querySelector<HTMLAnchorElement>("#executions-rows .link")!.click();
    expect(clientBodies(client, "board").at(-1)).toEqual({ type: "open", key: "CALC-1" });

    client.send("board", { ...render, filtering: true });
    expect(firstToggle().getAttribute("aria-expanded")).toBe("true");
    firstToggle().click();
    doc.querySelector<HTMLButtonElement>("#matrix-rows .group-toggle")!.click();
    expect(state.executionsCollapsed).toEqual(["CALC-1"]);
    expect(state.matrixOpen).toEqual([]);
    client.send("board", render);
    expect(firstToggle().getAttribute("aria-expanded")).toBe("false");
    client.send("board", { ...render, filtering: true, executions: [] });
    expect(doc.getElementById("executions-empty")?.textContent).toBe("No executions match this filter.");
    client.dom.window.close();
  });

  it("moves through visible coverage tabs by click, Home, End, and arrow keys", async () => {
    const client = await rig();
    const doc = client.dom.window.document;
    client.send("shell", { type: "activate", tab: "mapping" });
    const key = (id: string, value: string): void => {
      doc.getElementById(id)!.dispatchEvent(new client.dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
    };
    doc.getElementById("tab-matrix")!.click();
    expect(clientBodies(client, "shell").at(-1)).toEqual({ type: "tab", tab: "matrix" });
    key("tab-matrix", "Home");
    expect(doc.activeElement?.id).toBe("tab-mapping");
    key("tab-mapping", "End");
    expect(doc.activeElement?.id).toBe("tab-publish");
    key("tab-publish", "ArrowLeft");
    expect(doc.activeElement?.id).toBe("tab-executions");
    key("tab-executions", "ArrowRight");
    expect(doc.activeElement?.id).toBe("tab-publish");
    const posted = client.posted.length;
    key("tab-publish", "Enter");
    expect(client.posted).toHaveLength(posted);
    client.send("shell", { type: "linkTab", visible: true });
    key("tab-publish", "End");
    expect(doc.activeElement?.id).toBe("tab-link");
    client.dom.window.close();
  });

  it("keeps Sync persistent and restores collapsed Mapping sections with live counts and focus", async () => {
    const client = await rig();
    client.send("shell", { type: "activate", tab: "mapping" });
    client.send("board", boardRender());
    const available = client.dom.window.document.getElementById("available-toggle") as HTMLButtonElement;
    available.focus();
    available.click();

    expect(available.getAttribute("aria-expanded")).toBe("false");
    expect(client.dom.window.document.getElementById("available-content")?.hidden).toBe(true);
    expect(client.dom.window.document.activeElement).toBe(available);
    expect(client.state["mappingCollapsed"]).toEqual(["available"]);

    const changed = boardRender();
    client.send("board", {
      ...changed,
      sections: { ...changed.sections, available: { ...changed.sections.available, total: 7 } },
    });
    expect(client.dom.window.document.getElementById("available-count")?.textContent).toBe("(7)");
    const syncButtons = (): boolean[] => ["sync-now", "sync-scope"]
      .map((id) => (client.dom.window.document.getElementById(id) as HTMLButtonElement).disabled);
    // Hover text for both toolbar verbs, through every render. A native title would go quiet exactly when
    // the button is disabled, which is when the hint has the most to say, so both carry a tooltip span.
    const syncHovers = (): string[] => ["sync-now-tooltip", "sync-scope-tooltip"]
      .map((id) => client.dom.window.document.getElementById(id)?.textContent ?? "");
    const syncLabels = (): string[] => ["sync-now", "sync-scope"]
      .map((id) => client.dom.window.document.getElementById(id)?.textContent ?? "");
    // The host resolves a standing SHOP plus a View project of PAY into one list; the button says so.
    client.send("board", { ...changed, syncVerb: { label: "Sync", enabled: true, hint: "Syncs PAY, SHOP." } });
    expect(syncButtons()).toEqual([false, false]);
    expect(syncHovers()).toEqual(["Syncs PAY, SHOP.", PICKER_HINT]);
    expect(syncLabels()).toEqual(["Sync", "Select projects..."]);

    client.send("board", { ...changed, syncVerb: { label: "Sync", enabled: true, hint: "No projects in scope yet. Tag scenarios or select projects to sync." } });
    expect(syncHovers()).toEqual(["No projects in scope yet. Tag scenarios or select projects to sync.", PICKER_HINT]);

    // Both toolbar verbs are the host's to decide, so a sync in progress arrives as two disabled verbs
    // rather than the client inferring the second from the first, and an open picker says so on hover.
    client.send("board", {
      ...changed,
      syncVerb: { label: "Syncing", enabled: false, hint: "A traceability sync is in progress." },
      syncScopeVerb: { label: "Select projects...", enabled: false, hint: "The project picker is already open." },
    });
    expect(syncButtons()).toEqual([true, true]);
    expect(syncHovers()).toEqual(["A traceability sync is in progress.", "The project picker is already open."]);
    expect(syncHovers().every((text) => text.length > 0)).toBe(true);

    // A verb that arrives without words still leaves both buttons named.
    client.send("board", {
      ...changed,
      syncVerb: { label: "", enabled: true, hint: "" },
      syncScopeVerb: { label: "", enabled: true, hint: "" },
    });
    expect(syncLabels()).toEqual(["Sync", "Select projects..."]);
    expect(syncHovers()).toEqual(["Sync", "Select projects..."]);
    await expectNoSeriousViolations(client.dom);

    const restored = await rig(client.state);
    expect(restored.dom.window.document.getElementById("available-toggle")?.getAttribute("aria-expanded")).toBe("false");
    expect(restored.dom.window.document.getElementById("available-content")?.hidden).toBe(true);
    expect(restored.dom.window.document.getElementById("mapped-toggle")?.getAttribute("aria-expanded")).toBe("true");
    restored.send("shell", { type: "activate", tab: "mapping" });
    const restoredToggle = restored.dom.window.document.getElementById("available-toggle") as HTMLButtonElement;
    restoredToggle.focus();
    restoredToggle.click();
    expect(restoredToggle.getAttribute("aria-expanded")).toBe("true");
    expect(restored.dom.window.document.getElementById("available-content")?.hidden).toBe(false);
    expect(restored.state["mappingCollapsed"]).toEqual([]);
    expect(restored.dom.window.document.activeElement).toBe(restoredToggle);
  });

  it("implements combobox navigation and keyboard confirmation", async () => {
    const client = await rig();
    client.send("shell", { type: "linkTab", visible: true, title: "Link test" });
    client.send("shell", { type: "activate", tab: "link" });
    client.send("link", { type: "reset", title: "Link test", searchPlaceholder: "Search tests" });
    client.send("link", { type: "rows", rows: [{ id: "CALC-1", key: "CALC-1", summary: "Login", kind: "test" }] });
    const search = client.dom.window.document.getElementById("link-search") as HTMLInputElement;
    search.dispatchEvent(new client.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    search.dispatchEvent(new client.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(search.getAttribute("aria-expanded")).toBe("true");
    expect(search.getAttribute("aria-activedescendant")).toBe("link-option-0");
    expect(clientBodies(client, "link")).toContainEqual({ type: "confirm", id: "CALC-1" });
    await expectNoSeriousViolations(client.dom);
  });

  it("keeps link keyboard handling inside the combobox so linked-row buttons keep Enter", async () => {
    const client = await rig();
    client.send("shell", { type: "linkTab", visible: true, title: "Link test" });
    client.send("shell", { type: "activate", tab: "link" });
    client.send("link", { type: "reset", title: "Link test", searchPlaceholder: "Search tests" });
    client.send("link", { type: "rows", rows: [{ id: "CALC-1", key: "CALC-1", kind: "test" }] });
    client.send("link", { type: "linked", rows: [{ key: "CALC-2", summary: "Already linked" }] });
    const open = [...client.dom.window.document.querySelectorAll<HTMLButtonElement>("#link-linked button")]
      .find((button) => button.textContent === "Open in Jira")!;
    open.focus();
    open.dispatchEvent(new client.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    open.click();

    expect(clientBodies(client, "link")).toContainEqual({ type: "openLinked", key: "CALC-2" });
    expect(clientBodies(client, "link").filter((message) => message.type === "confirm")).toEqual([]);
  });

  it("keeps the highlighted link choice through appended results and skips hints when choices disappear", async () => {
    const client = await rig();
    const doc = client.dom.window.document;
    client.send("shell", { type: "linkTab", visible: true, title: "Link checkout" });
    client.send("shell", { type: "activate", tab: "link" });
    client.send("link", { type: "reset", title: "Link checkout", searchPlaceholder: "Search tests" });
    const hint = { id: "hint", key: "Choose a test or create one", kind: "hint" } as const;
    const checkout = { id: "CALC-7", key: "CALC-7", summary: "Checkout", kind: "test" } as const;
    const create = { id: "create", key: "Create checkout test", kind: "create" } as const;
    const search = doc.getElementById("link-search") as HTMLInputElement;
    client.send("link", { type: "rows", rows: [hint, checkout, create] });
    expect(search.getAttribute("aria-activedescendant")).toBe("link-option-1");
    doc.getElementById("link-option-2")!.dispatchEvent(new client.dom.window.MouseEvent("mousemove", { bubbles: true }));
    doc.getElementById("link-option-2")!.dispatchEvent(new client.dom.window.MouseEvent("mousemove", { bubbles: true }));
    client.send("link", { type: "rows", rows: [hint, checkout, create, { id: "CALC-8", key: "CALC-8", kind: "test" }] });
    expect(doc.querySelector('#link-results [aria-selected="true"]')?.textContent).toBe("Create checkout test");
    search.dispatchEvent(new client.dom.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(doc.querySelector('#link-results [aria-selected="true"]')?.textContent).toBe("CALC-7Checkout");
    const postedBeforeTab = client.posted.length;
    const tab = new client.dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
    search.dispatchEvent(tab);
    expect(tab.defaultPrevented).toBe(false);
    expect(client.posted).toHaveLength(postedBeforeTab);
    expect(search.getAttribute("aria-activedescendant")).toBe("link-option-1");
    doc.getElementById("link-option-2")!.dispatchEvent(new client.dom.window.MouseEvent("mousemove", { bubbles: true }));
    search.dispatchEvent(new client.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(clientBodies(client, "link").at(-1)).toEqual({ type: "confirm", id: "create" });

    client.send("link", { type: "rows", rows: [hint, checkout, { id: "CALC-8", key: "CALC-8", kind: "test" }] });
    expect(doc.querySelector('#link-results [aria-selected="true"]')?.textContent).toBe("CALC-8");
    doc.getElementById("link-option-1")!.click();
    expect(clientBodies(client, "link").at(-1)).toEqual({ type: "confirm", id: "CALC-7" });
    client.send("link", { type: "rows", rows: [hint] });
    const confirmations = clientBodies(client, "link").filter((message) => message.type === "confirm").length;
    search.dispatchEvent(new client.dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    search.dispatchEvent(new client.dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    expect(search.getAttribute("aria-expanded")).toBe("false");
    expect(search.hasAttribute("aria-activedescendant")).toBe(false);
    expect(clientBodies(client, "link").filter((message) => message.type === "confirm")).toHaveLength(confirmations);
    client.dom.window.close();
  });

  it("shows missing linked tests, routes unlink and search, and ignores keys when the link pane is hidden", async () => {
    const client = await rig();
    const doc = client.dom.window.document;
    client.send("shell", { type: "linkTab", visible: true, title: "Link checkout" });
    client.send("shell", { type: "activate", tab: "link" });
    client.send("link", { type: "reset", title: "Link checkout", searchPlaceholder: "Search tests" });
    client.send("link", { type: "linked", rows: [{ key: "CALC-9", remoteMissing: true }, { key: "CALC-10" }] });
    expect(doc.getElementById("link-linked")?.textContent).toContain("CALC-9⚠ not found on remote");
    const unlink = [...doc.querySelectorAll<HTMLButtonElement>("#link-linked button")].find((button) => button.textContent === "Unlink")!;
    unlink.click();
    expect(clientBodies(client, "link").at(-1)).toEqual({ type: "unlink", key: "CALC-9" });
    const search = doc.getElementById("link-search") as HTMLInputElement;
    search.value = "checkout";
    search.dispatchEvent(new client.dom.window.Event("input", { bubbles: true }));
    expect(clientBodies(client, "link").at(-1)).toEqual({ type: "search", value: "checkout" });
    client.send("link", { type: "busy", busy: true });
    expect(doc.getElementById("link-busy")?.hidden).toBe(false);
    client.send("link", { type: "busy", busy: false });
    expect(doc.getElementById("link-busy")?.hidden).toBe(true);
    search.dispatchEvent(new client.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(clientBodies(client, "link").at(-1)).toEqual({ type: "cancel" });
    client.send("shell", { type: "activate", tab: "mapping" });
    const before = client.posted.length;
    search.dispatchEvent(new client.dom.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
    expect(client.posted).toHaveLength(before);
    client.dom.window.close();
  });

  it("merges remote project choices with known keys and retires chosen or dismissed publish searches", async () => {
    const client = await rig();
    vi.useFakeTimers();
    try {
      const doc = client.dom.window.document;
      client.send("shell", { type: "activate", tab: "publish" });
      client.send("publish", { type: "model", model: { ...publishModel, jiraSearchAvailable: true, knownProjectKeys: ["CALC", "CARDS", "PAY"] } });
      const project = doc.getElementById("project") as HTMLInputElement;
      project.focus();
      expect(doc.getElementById("project-results")?.textContent).toContain("PAY");
      project.value = "C";
      project.dispatchEvent(new client.dom.window.Event("input", { bubbles: true }));
      project.value = "CA";
      project.dispatchEvent(new client.dom.window.Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(399);
      expect(clientBodies(client, "publish").filter((message) => message.type === "search")).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      const search = clientBodies(client, "publish").filter((message) => message.type === "search" && "token" in message).at(-1)!;
      expect(search).toMatchObject({ type: "search", kind: "project", query: "CA" });
      client.send("publish", { type: "search-result", kind: "project", token: search.token, items: [{ key: "CALC", label: "CALC: Checkout project" }] });
      expect([...doc.querySelectorAll("#project-results li")].map((row) => row.textContent)).toEqual(["CALC: Checkout project", "CARDS"]);
      doc.querySelector("#project-results li")!.dispatchEvent(new client.dom.window.MouseEvent("mousedown", { bubbles: true }));
      expect(project.value).toBe("CALC");
      client.send("publish", { type: "search-result", kind: "project", token: search.token, items: [{ key: "STALE", label: "Stale project" }] });
      expect(doc.getElementById("project-results")?.textContent).toBe("");
      project.focus();
      project.dispatchEvent(new client.dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      expect(doc.getElementById("project-results")?.textContent).toBe("");
      project.dispatchEvent(new client.dom.window.Event("focus"));
      project.blur();
      expect(doc.getElementById("project-results")?.textContent).toBe("");

      const plan = doc.getElementById("plan") as HTMLInputElement;
      plan.value = "CALC";
      plan.dispatchEvent(new client.dom.window.Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(400);
      const planSearch = clientBodies(client, "publish").filter((message) => message.type === "search" && "token" in message).at(-1)!;
      expect(planSearch).toMatchObject({ kind: "test-plan", query: "CALC" });
      client.send("publish", { type: "search-result", kind: "test-plan", token: planSearch.token, items: [], error: "Jira unavailable" });
      expect(doc.getElementById("plan-results")?.textContent).toBe("Search failed: Jira unavailable");
      client.send("publish", { type: "search-result", kind: "test-plan", token: planSearch.token, items: [{ key: "CALC-42", label: "Checkout plan" }] });
      doc.querySelector("#plan-results li")!.dispatchEvent(new client.dom.window.MouseEvent("mousedown", { bubbles: true }));
      expect(plan.value).toBe("CALC-42");
    } finally {
      client.dom.window.close();
      vi.useRealTimers();
    }
  });

  it("validates an append execution and confirms its selected remote target", async () => {
    const client = await rig();
    vi.useFakeTimers();
    try {
      const doc = client.dom.window.document;
      client.send("shell", { type: "activate", tab: "publish" });
      client.send("publish", { type: "model", model: { ...publishModel, jiraSearchAvailable: true } });
      doc.querySelector<HTMLInputElement>('input[name="publish-mode"][value="append"]')!.click();
      expect(doc.getElementById("create-fields")?.hidden).toBe(true);
      expect(doc.getElementById("append-fields")?.hidden).toBe(false);
      doc.getElementById("publish")!.click();
      const execution = doc.getElementById("execution") as HTMLInputElement;
      expect(execution.getAttribute("aria-invalid")).toBe("true");
      expect(doc.activeElement).toBe(execution);
      execution.value = "CALC";
      execution.dispatchEvent(new client.dom.window.Event("input", { bubbles: true }));
      await vi.advanceTimersByTimeAsync(400);
      const search = clientBodies(client, "publish").filter((message) => message.type === "search" && "token" in message).at(-1)!;
      expect(search).toMatchObject({ kind: "execution", query: "CALC" });
      client.send("publish", { type: "search-result", kind: "execution", token: search.token, items: [{ key: "CALC-21", label: "Checkout execution" }] });
      doc.querySelector("#exec-results li")!.dispatchEvent(new client.dom.window.MouseEvent("mousedown", { bubbles: true }));
      expect(execution.value).toBe("CALC-21");
      doc.getElementById("publish")!.click();
      expect(clientBodies(client, "publish").at(-1)).toEqual({ type: "confirm", runId: "run-1", request: { mode: "append", executionKey: "CALC-21" }, attachments: [] });
    } finally {
      client.dom.window.close();
      vi.useRealTimers();
    }
  });

  it("distinguishes published and uncertain runs while confirming scoped creation fields", async () => {
    const client = await rig();
    const doc = client.dom.window.document;
    const base = { ...publishModel.runs[0]!, project: { value: "CALC", fromDerivation: false, fromScope: true }, defaultSummary: "Checkout results", prefillPlanKey: "CALC-42" };
    const runs = [
      { ...base, id: "append", label: "Appended checkout", republish: { target: "CALC-21", publishedAt: 1, mode: "append" as const } },
      { ...base, id: "create", label: "Created checkout", republish: { target: "CALC-22", publishedAt: 1, mode: "create-new" as const } },
      { ...base, id: "uncertain", label: "Uncertain checkout", republish: { target: "CALC-23", publishedAt: 1, outcomeUnknown: true, operationId: "checkout-import" } },
      { ...base, id: "legacy", label: "Historical checkout", republish: { target: "CALC-24", publishedAt: 1 } },
    ];
    client.send("shell", { type: "activate", tab: "publish" });
    client.send("publish", { type: "model", model: { ...publishModel, runs, selectedRunId: "evicted" } });
    expect(doc.getElementById("banners")?.textContent).toContain("Already published to CALC-21");
    expect(doc.getElementById("banners")?.textContent).toContain("(appended)");
    chooseRun(client, "create");
    expect(doc.getElementById("banners")?.textContent).toContain("(new execution)");
    chooseRun(client, "uncertain");
    expect(doc.getElementById("banners")?.textContent).toContain("possibly succeeded");
    expect(doc.getElementById("banners")?.textContent).toContain("correlation checkout-import");
    chooseRun(client, "legacy");
    expect(doc.getElementById("banners")?.textContent).toContain("Already published to CALC-24");
    expect(doc.getElementById("banners")?.textContent).not.toContain("()");
    expect(doc.getElementById("project-hint")?.textContent).toBe("from the board's project scope");
    expect(doc.getElementById("project-hint")?.hidden).toBe(false);
    (doc.getElementById("environments") as HTMLInputElement).value = " qa, , staging ";
    doc.getElementById("publish")!.click();
    expect(clientBodies(client, "publish").at(-1)).toEqual({
      type: "confirm", runId: "legacy",
      request: { mode: "create-new", project: "CALC", summary: "Checkout results", testPlanKey: "CALC-42", environments: ["qa", "staging"] },
      attachments: [],
    });
    client.dom.window.close();
  });

  it("deduplicates browsed attachments, names their sizes, and excludes over-limit or unchecked files", async () => {
    const client = await rig();
    const doc = client.dom.window.document;
    const tiny = { path: "/ws/results.json", name: "results.json", size: 12 };
    const model: PublishDialogModel = {
      ...publishModel,
      runs: [{ ...publishModel.runs[0]!, project: { value: "CALC", fromDerivation: true }, defaultSummary: "Checkout evidence" }],
      attachments: {
        available: true, uploadLimitBytes: 1024 * 1024, evidenceStream: "issue",
        suggestions: [tiny, { path: "/ws/trace.zip", name: "trace.zip", size: 4096 }, { path: "/ws/large.zip", name: "large.zip", size: 2 * 1024 * 1024 }, tiny],
      },
    };
    client.send("shell", { type: "activate", tab: "publish" });
    client.send("publish", { type: "model", model });
    expect(doc.querySelectorAll(".attach-row")).toHaveLength(3);
    expect(doc.getElementById("attach-list")?.textContent).toContain("12 B");
    expect(doc.getElementById("attach-list")?.textContent).toContain("4 KB");
    expect(doc.getElementById("attach-list")?.textContent).toContain("2.0 MBover limit");
    expect(doc.getElementById("attach-hint")?.textContent).toContain("Per-test evidence uploads to the execution's Jira issue");
    expect(doc.querySelector<HTMLInputElement>('[data-path="/ws/large.zip"]')?.disabled).toBe(true);
    doc.getElementById("browse")!.click();
    expect(clientBodies(client, "publish").at(-1)).toEqual({ type: "browse" });
    client.send("publish", { type: "browse-result", items: [tiny, { path: "/ws/browser.zip", name: "browser.zip", size: 64 }] });
    expect(doc.querySelectorAll(".attach-row")).toHaveLength(4);
    doc.querySelector<HTMLInputElement>('[data-path="/ws/trace.zip"]')!.click();
    doc.getElementById("publish")!.click();
    expect(clientBodies(client, "publish").at(-1)).toMatchObject({ type: "confirm", attachments: ["/ws/results.json", "/ws/browser.zip"] });
    client.send("publish", { type: "model", model: { ...model, attachments: { ...model.attachments, evidenceStream: "both" } } });
    expect(doc.getElementById("attach-hint")?.textContent).toContain("result payload and the Jira issue");
    client.dom.window.close();
  });

  it("keeps an empty publish list and an active import distinct while runs arrive or are evicted", async () => {
    const client = await rig();
    const doc = client.dom.window.document;
    client.send("shell", { type: "activate", tab: "publish" });
    client.send("publish", { type: "model", model: { ...publishModel, runs: [], selectedRunId: "" } });
    expect(doc.getElementById("publish-empty")?.hidden).toBe(false);
    client.send("publish", { type: "runs", runs: publishModel.runs, selectedRunId: "run-1" });
    expect(doc.getElementById("publish-form")?.hidden).toBe(false);
    client.send("publish", { type: "publish-busy", busy: true });
    client.send("publish", { type: "runs", runs: [], selectedRunId: "" });
    expect(doc.getElementById("publish-busy")?.hidden).toBe(false);
    client.send("publish", { type: "publish-busy", busy: false });
    expect(doc.getElementById("publish-empty")?.hidden).toBe(false);
    client.send("publish", { type: "retry", runs: publishModel.runs, selectedRunId: "run-1" });
    expect(doc.getElementById("publish-form")?.hidden).toBe(false);
    client.send("publish", { type: "retry", runs: [], selectedRunId: "" });
    expect(doc.getElementById("publish-empty")?.hidden).toBe(false);
    client.send("publish", { type: "settled" });
    client.send("publish", { type: "runs", runs: publishModel.runs, selectedRunId: "run-1" });
    client.send("publish", { type: "browse-result", items: [{ path: "/ws/late.zip", name: "late.zip", size: 1 }] });
    client.send("publish", { type: "pending-result", runId: "run-1", remaining: 1 });
    client.send("publish", { type: "attachment-error", text: "Late upload failure" });
    expect(doc.getElementById("publish-idle")?.hidden).toBe(false);
    expect(doc.getElementById("attach-list")?.textContent).toBe("");
    expect(doc.getElementById("attach-hint")?.textContent).not.toContain("Late upload failure");
    client.dom.window.close();
  });

  it("announces publish state and focuses the first invalid field", async () => {
    const client = await rig();
    client.send("shell", { type: "activate", tab: "publish" });
    client.send("publish", { type: "model", model: publishModel });
    (client.dom.window.document.getElementById("publish") as HTMLButtonElement).click();
    const project = client.dom.window.document.getElementById("project") as HTMLInputElement;
    expect(project.getAttribute("aria-invalid")).toBe("true");
    expect(client.dom.window.document.activeElement).toBe(project);
    expect(client.dom.window.document.getElementById("err-project")?.textContent).toContain("project key");
    project.value = "CALC";
    (client.dom.window.document.getElementById("publish") as HTMLButtonElement).click();
    const summary = client.dom.window.document.getElementById("summary") as HTMLInputElement;
    expect(project.getAttribute("aria-invalid")).toBe("false");
    expect(summary.getAttribute("aria-invalid")).toBe("true");
    expect(client.dom.window.document.activeElement).toBe(summary);
    await expectNoSeriousViolations(client.dom);
  });

  it("labels attachment choices and waits for the authoritative pending-upload acknowledgement", async () => {
    const client = await rig();
    const model: PublishDialogModel = {
      ...publishModel,
      runs: [{ ...publishModel.runs[0]!, pendingAttachments: { target: "CALC-9", count: 2 } }],
      attachments: {
        available: true,
        suggestions: [{ path: "/ws/trace.zip", name: "trace.zip", size: 100 }],
        uploadLimitBytes: 1024,
        evidenceStream: "evidence",
      },
    };
    client.send("shell", { type: "activate", tab: "publish" });
    client.send("publish", { type: "model", model });

    const attachment = client.dom.window.document.querySelector<HTMLInputElement>('.attach-check')!;
    expect(attachment.getAttribute("aria-label")).toBe("Attach trace.zip");
    const pending = [...client.dom.window.document.querySelectorAll<HTMLButtonElement>("#banners button")]
      .find((button) => button.textContent === "Attach pending files")!;
    pending.click();
    pending.click();
    expect(clientBodies(client, "publish").filter((message) => message.type === "attachPending")).toHaveLength(2);
    expect(pending.disabled).toBe(false);
    client.send("publish", { type: "pending-busy", runId: "run-1", busy: true });
    expect(client.dom.window.document.querySelector<HTMLButtonElement>("#banners button")?.disabled).toBe(true);
    client.send("publish", { type: "pending-busy", runId: "run-1", busy: false });
    expect(client.dom.window.document.querySelector<HTMLButtonElement>("#banners button")?.disabled).toBe(false);
    client.send("publish", { type: "pending-result", runId: "run-1", remaining: 1 });
    expect(client.dom.window.document.getElementById("banners")?.textContent).toContain("1 attachment file");
    client.send("publish", { type: "pending-result", runId: "run-1", remaining: 0 });
    expect(client.dom.window.document.querySelector("#banners button")).toBeNull();
    await expectNoSeriousViolations(client.dom);
  });

  it("keeps ordinary publish input and local project choices usable without Jira search", async () => {
    const client = await rig();
    vi.useFakeTimers();
    try {
      const doc = client.dom.window.document;
      client.send("shell", { type: "activate", tab: "publish" });
      client.send("publish", { type: "model", model: { ...publishModel, jiraSearchAvailable: false, knownProjectKeys: ["CALC"] } });
      doc.querySelector<HTMLInputElement>('input[name="publish-mode"][value="append"]')!.click();
      expect(doc.getElementById("append-fields")?.hidden).toBe(false);
      const execution = doc.getElementById("execution") as HTMLInputElement;
      execution.value = "CALC-21";
      execution.dispatchEvent(new client.dom.window.Event("input", { bubbles: true }));
      expect(execution.value).toBe("CALC-21");
      doc.querySelector<HTMLInputElement>('input[name="publish-mode"][value="create-new"]')!.click();
      expect(doc.getElementById("create-fields")?.hidden).toBe(false);
      for (const id of ["plan", "project"]) {
        const input = doc.getElementById(id) as HTMLInputElement;
        input.value = "CA";
        input.dispatchEvent(new client.dom.window.Event("input", { bubbles: true }));
      }
      expect(doc.getElementById("project-results")?.textContent).toBe("CALC");
      const tab = new client.dom.window.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true });
      doc.getElementById("project")!.dispatchEvent(tab);
      expect(tab.defaultPrevented).toBe(false);
      expect(doc.getElementById("project-results")?.textContent).toBe("CALC");
      await vi.advanceTimersByTimeAsync(400);
      expect(clientBodies(client, "publish").filter(message => message.type === "search")).toEqual([]);
    } finally {
      client.dom.window.close();
      vi.useRealTimers();
    }
  });

  it("retires run A after success or failure while run B is selected", async () => {
    const success = await rig();
    const model = pendingPublishModel();
    success.send("publish", { type: "model", model });
    success.dom.window.document.querySelector<HTMLButtonElement>("#banners button")!.click();
    success.send("publish", { type: "pending-busy", runId: "run-a", busy: true });
    chooseRun(success, "run-b");
    success.send("publish", { type: "pending-result", runId: "run-a", remaining: 1 });
    success.send("publish", { type: "pending-busy", runId: "run-a", busy: false });
    chooseRun(success, "run-a");
    expect(success.dom.window.document.getElementById("banners")?.textContent).toContain("1 attachment file");
    expect(success.dom.window.document.querySelector<HTMLButtonElement>("#banners button")?.disabled).toBe(false);

    const failure = await rig();
    failure.send("publish", { type: "model", model: pendingPublishModel() });
    failure.dom.window.document.querySelector<HTMLButtonElement>("#banners button")!.click();
    failure.send("publish", { type: "pending-busy", runId: "run-a", busy: true });
    chooseRun(failure, "run-b");
    failure.send("publish", { type: "attachment-error", text: "Attaching pending files failed: upload failed" });
    failure.send("publish", { type: "pending-busy", runId: "run-a", busy: false });
    chooseRun(failure, "run-a");
    expect(failure.dom.window.document.querySelector<HTMLButtonElement>("#banners button")?.disabled).toBe(false);
    expect(failure.dom.window.document.getElementById("attach-hint")?.textContent).toContain("upload failed");
  });

  it("preserves genuine busy runs through retry and reconciles them after settled or rejection", async () => {
    const client = await rig();
    const model = pendingPublishModel();
    client.send("publish", { type: "model", model });
    client.dom.window.document.querySelector<HTMLButtonElement>("#banners button")!.click();
    client.send("publish", { type: "pending-busy", runId: "run-a", busy: true });
    client.send("publish", { type: "retry", runs: model.runs, selectedRunId: "run-b" });
    chooseRun(client, "run-a");
    expect(client.dom.window.document.querySelector<HTMLButtonElement>("#banners button")?.disabled).toBe(true);

    client.send("publish", { type: "settled" });
    client.send("publish", { type: "pending-busy", runId: "run-a", busy: false });
    client.send("publish", { type: "model", model });
    expect(client.dom.window.document.querySelector<HTMLButtonElement>("#banners button")?.disabled).toBe(false);

    client.dom.window.document.querySelector<HTMLButtonElement>("#banners button")!.click();
    client.send("publish", { type: "pending-busy", runId: "run-a", busy: false });
    expect(client.dom.window.document.querySelector<HTMLButtonElement>("#banners button")?.disabled).toBe(false);
  });

  it("retires only the named run while another run is genuinely uploading", async () => {
    const client = await rig();
    client.send("publish", { type: "model", model: pendingPublishModel() });
    client.dom.window.document.querySelector<HTMLButtonElement>("#banners button")!.click();
    client.send("publish", { type: "pending-busy", runId: "run-a", busy: true });
    chooseRun(client, "run-b");
    client.dom.window.document.querySelector<HTMLButtonElement>("#banners button")!.click();
    client.send("publish", { type: "pending-busy", runId: "run-b", busy: true });

    client.send("publish", { type: "pending-busy", runId: "run-a", busy: false });

    expect(client.dom.window.document.querySelector<HTMLButtonElement>("#banners button")?.disabled).toBe(true);
    client.send("publish", { type: "pending-busy", runId: "run-b", busy: false });
    expect(client.dom.window.document.querySelector<HTMLButtonElement>("#banners button")?.disabled).toBe(false);
  });

  it("shows usable feedback for a 65th selected attachment instead of posting or staying busy", async () => {
    const client = await rig();
    const suggestions = Array.from({ length: 64 }, (_, index) => ({
      path: `/ws/file-${index}.zip`, name: `file-${index}.zip`, size: 100,
    }));
    client.send("publish", {
      type: "model",
      model: {
        ...publishModel,
        runs: [{ ...publishModel.runs[0]!, project: { value: "CALC", fromDerivation: true }, defaultSummary: "Nightly" }],
        attachments: { available: true, suggestions, uploadLimitBytes: 1024, evidenceStream: "evidence" },
      },
    });
    const extra = client.dom.window.document.createElement("input");
    extra.type = "checkbox";
    extra.checked = true;
    extra.className = "attach-check";
    extra.dataset["path"] = "/ws/file-64.zip";
    client.dom.window.document.getElementById("attach-list")!.appendChild(extra);

    (client.dom.window.document.getElementById("publish") as HTMLButtonElement).click();

    expect(clientBodies(client, "publish").filter((message) => message.type === "confirm")).toEqual([]);
    expect(client.dom.window.document.getElementById("attach-hint")?.textContent).toBe("Choose at most 64 attachments.");
    expect(client.dom.window.document.getElementById("publish-busy")?.hidden).toBe(true);
  });

  it("keeps the 64 offered attachments when a later picker response exceeds the limit", async () => {
    const client = await rig();
    const suggestions = Array.from({ length: 64 }, (_, index) => ({
      path: `/ws/file-${index}.zip`, name: `file-${index}.zip`, size: 100,
    }));
    client.send("publish", { type: "model", model: {
      ...publishModel,
      runs: [{ ...publishModel.runs[0]!, project: { value: "CALC", fromDerivation: true }, defaultSummary: "Checkout evidence" }],
      attachments: { ...publishModel.attachments, available: true, uploadLimitBytes: 1024, suggestions },
    } });
    client.send("publish", { type: "browse-result", items: [{ path: "/ws/overflow.zip", name: "overflow.zip", size: 10 }] });
    expect(client.dom.window.document.querySelectorAll(".attach-row")).toHaveLength(64);
    expect(client.dom.window.document.getElementById("attach-list")?.textContent).not.toContain("overflow.zip");
    expect(client.dom.window.document.getElementById("attach-hint")?.textContent).toBe("Choose at most 64 attachments.");
    client.dom.window.document.getElementById("publish")!.click();
    expect(clientBodies(client, "publish").at(-1)).toMatchObject({ type: "confirm", attachments: suggestions.map(file => file.path) });
    client.dom.window.close();
  });

  it("ignores pending-upload events for evicted runs and preserves the selected run banner", async () => {
    const client = await rig();
    const doc = client.dom.window.document;
    client.send("publish", { type: "model", model: pendingPublishModel() });
    const banner = doc.getElementById("banners")!.textContent;
    client.send("publish", { type: "pending-busy", runId: "evicted", busy: true });
    client.send("publish", { type: "pending-result", runId: "evicted", remaining: 1 });
    expect(doc.getElementById("banners")!.textContent).toBe(banner);
    client.send("publish", { type: "pending-result", runId: "run-b", remaining: 0 });
    expect(doc.getElementById("banners")!.textContent).toBe(banner);
    chooseRun(client, "run-b");
    expect(doc.getElementById("banners")?.textContent).not.toContain("attachment files waiting");
    expect(doc.querySelector("#banners button")).toBeNull();
    client.dom.window.close();
  });

  it("clears a debounced search after cancel is acknowledged so no late remote work or UI update starts", async () => {
    const client = await rig();
    client.send("publish", { type: "model", model: { ...publishModel, jiraSearchAvailable: true } });
    const execution = client.dom.window.document.getElementById("execution") as HTMLInputElement;
    execution.value = "CALC";
    execution.dispatchEvent(new client.dom.window.Event("input", { bubbles: true }));
    (client.dom.window.document.getElementById("cancel") as HTMLButtonElement).click();
    client.send("publish", { type: "settled" });

    await new Promise((resolve) => setTimeout(resolve, 450));

    expect(clientBodies(client, "publish").filter((message) => message.type === "search")).toEqual([]);
    client.send("publish", { type: "search-result", token: 1, kind: "execution", items: [{ key: "CALC-1", label: "Late" }] });
    expect(client.dom.window.document.getElementById("exec-results")?.textContent).toBe("");
  });
});
