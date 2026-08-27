/// <reference path="../../webview/client/globals.d.ts" />

import axe from "axe-core";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import type * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import { boardFragment } from "../../traceability/board-fragment";
import { BoardSurface, type BoardSurfaceDeps } from "../../traceability/board-surface";
import type { BoardViewModel } from "../../traceability/board-data";
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
    <header><h1>Coverage Board</h1><div class="tabs" role="tablist" aria-label="Coverage views">${tabHtml}</div><div class="scope"><select id="scope-select" aria-label="Project scope"></select></div><div class="search"><input id="search" aria-label="Filter coverage board"></div></header>
    <div id="sync-strip" role="status" aria-live="polite" hidden><span id="sync-strip-text"></span></div>
    <main>${boardFragment("Xray").paneHtml}<section id="pane-publish" class="pane" data-tab="publish" role="tabpanel" aria-labelledby="tab-publish" hidden>${PUBLISH_FRAGMENT.paneHtml}</section><section id="pane-link" class="pane" data-tab="link" role="tabpanel" aria-labelledby="tab-link" hidden>${LINK_FRAGMENT.paneHtml}</section></main>
  </body></html>`;
}

let bundledClient: Promise<string> | undefined;

function clientCode(): Promise<string> {
  bundledClient ??= build({
    entryPoints: ["src/webview/coverage-board.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
  }).then((output) => output.outputFiles[0]!.text);
  return bundledClient;
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
  dom.window.eval(await clientCode());
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
  onContainerAction: (action: "createTestSet" | "addToTestSet" | "createTestPlan" | "addToTestPlan", surface: BoardSurface) => void
): Promise<{ readonly client: ClientRig; readonly surface: BoardSurface; routeClientMessages(): void }> {
  const client = await rig();
  client.send("shell", { type: "activate", tab: "mapping" });
  let messageHandler = (_message: BoardClientMessage): void => undefined;
  const board = { surface: undefined as BoardSurface | undefined };
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
    applyDrop: () => Promise.resolve(),
    applyUnlink: () => Promise.resolve(),
    pushText: () => undefined,
    runSync: () => Promise.resolve(),
    selectSyncProjects: () => undefined,
    autoSync: () => Promise.resolve(),
    openExecution: () => undefined,
    bulkCreate: () => undefined,
    createTestSet: () => onContainerAction("createTestSet", board.surface!),
    addToTestSet: () => onContainerAction("addToTestSet", board.surface!),
    createTestPlan: () => onContainerAction("createTestPlan", board.surface!),
    addToTestPlan: () => onContainerAction("addToTestPlan", board.surface!),
    createTestExecution: () => undefined,
    knownProjects: () => ["CALC"],
    projectScope: { get: () => "CALC", set: () => undefined },
    mappingPageSize: { get: () => 50, set: () => undefined },
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

function boardRender(selected = false): Extract<BoardHostMessage, { type: "render" }> {
  const section = { total: 1, filtered: 1, page: 0, pageSize: 25, pageCount: 1, query: "", filtering: false, selection: "none" } as const;
  const verb = { label: "Action", enabled: true, hint: "" };
  return {
    type: "render",
    scenarios: [{ name: "Login", location: "features/login.feature:3", dropId: "scenario-1", pills: [], reqKeys: [], selected }],
    available: [{ key: "CALC-1", pills: [], links: [], selected }],
    mapped: [], sections: { untraced: section, available: section, mapped: { ...section, total: 0, filtered: 0, pageCount: 0 } },
    pageSize: 25, matrix: [], executions: [], availableEmptyText: "No tests",
    filtering: false, projects: ["CALC"], project: "CALC", scoped: true,
    createVerb: verb, syncVerb: { label: "Sync now", enabled: true, hint: "" }, untracedHelper: "", testSetVerb: verb, addToTestSetVerb: verb,
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
  it("executes the bundled browser IIFE in JSDOM", async () => {
    const client = await rig();
    expect(client.posted).toContainEqual({ version: 1, session: "local", revision: 0, surface: "shell", body: { type: "ready" } });
    client.send("shell", { type: "activate", tab: "mapping" });
    client.send("board", boardRender());
    expect(client.dom.window.document.querySelector("#scenario-cards .title")?.textContent).toBe("Login");
    expect(client.dom.window.document.getElementById("pane-mapping")?.hidden).toBe(false);
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
    client.send("board", { ...emptyAvailable, syncVerb: { label: "Sync now", enabled: false, hint: "A mutation is active." } });
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
    expect(syncButtons()).toEqual([false, false]);
    // Sync now and Sync scope share the host's admission, so a sync in progress takes both.
    client.send("board", { ...changed, syncVerb: { label: "Syncing", enabled: false, hint: "A traceability sync is in progress." } });
    expect(syncButtons()).toEqual([true, true]);
    await expectNoSeriousViolations(client.dom);

    const restored = await rig(client.state);
    expect(restored.dom.window.document.getElementById("available-toggle")?.getAttribute("aria-expanded")).toBe("false");
    expect(restored.dom.window.document.getElementById("available-content")?.hidden).toBe(true);
    expect(restored.dom.window.document.getElementById("mapped-toggle")?.getAttribute("aria-expanded")).toBe("true");
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
    await expectNoSeriousViolations(client.dom);
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
