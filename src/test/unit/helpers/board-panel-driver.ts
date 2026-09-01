import { build } from "esbuild";
import { JSDOM } from "jsdom";
import * as vscode from "vscode";
import type { Memento } from "vscode";
import { BoardPanel, BoardPanelDeps } from "../../../traceability/board-panel";
import { BoardSectionMeta, BoardViewModel, ExecutionRow } from "../../../traceability/board-data";
import { mappingPageSizeStore } from "../../../traceability/mapping-page-size";
import { ProjectScopeStore } from "../../../traceability/project-scope";
import { PublishDialogDelegate } from "../../../traceability/publish-dialog-panel";
import { Logger, LogLevel } from "../../../utils/logger";

export const noopDelegate: PublishDialogDelegate = {
  searchTargets: () => Promise.resolve([]),
  browseFiles: () => Promise.resolve([]),
  attachPending: () => Promise.resolve({ remaining: 0 }),
  onDidChangeRuns: new vscode.EventEmitter<void>().event,
  runOptions: () => [],
};

// The panel drives the real `vscode.window.createWebviewPanel` stub: `__receive` delivers an inbound
// webview message, `webview.__posted` records outbound ones, `__revealCount` counts reveals, and
// `dispose()` fires the onDidDispose seam. The shell routes tagged messages by `surface` and reserves
// the untagged `ready`/`tab`/`activate` shell types; outbound posts are held until the webview signals
// `ready`, then flushed in order. The webview JS carries no decision logic, so it isn't run.
export interface StubPanel {
  title: string;
  webview: { html: string; options: { enableScripts: boolean; localResourceRoots: vscode.Uri[] }; __posted: Array<{ session: string; revision: number; surface: string; body: Posted }> };
  __revealCount: number;
  __disposed: boolean;
  dispose: () => void;
  __receive: (message: unknown) => Promise<void>;
}

export interface RenderMessage {
  surface: "board";
  type: "render";
  scenarios: Array<{ name: string; dropId: string; selected: boolean }>;
  available: Array<{ key: string; selected: boolean; links: Array<{ name: string; location: string; unlinkId: string }> }>;
  mapped: Array<{ key: string; selected: boolean; links: Array<{ name: string; location: string; unlinkId: string }> }>;
  sections: { untraced: BoardSectionMeta; available: BoardSectionMeta; mapped: BoardSectionMeta };
  pageSize: number;
  matrix: Array<{ file: string; count: number; rows: Array<{ requirement: string; test: string; scenario: string; tag: string; result: string }> }>;
  executions: Array<{ key: string; summary: string }>;
  availableEmptyText: string;
  filtering: boolean;
  projects: string[];
  project: string;
  scoped: boolean;
  createVerb: Verb;
  syncVerb: Verb;
  untracedHelper: string;
  testSetVerb: Verb;
  addToTestSetVerb: Verb;
  testPlanVerb: Verb;
  addToTestPlanVerb: Verb;
  mappingHelper: string;
  executionVerb: Verb;
}
export interface Verb {
  label: string;
  enabled: boolean;
  hint: string;
}
export interface ActivateMessage {
  type: "activate";
  tab: string;
}
export type Posted = RenderMessage | ActivateMessage | { type: string; [key: string]: unknown };

export function posted(panel: StubPanel): Posted[] {
  return panel.webview.__posted.map((message) => message.surface === "shell"
    ? message.body
    : { ...message.body, surface: message.surface });
}

export function receive(panel: StubPanel, message: Posted & { surface?: string }): Promise<void> {
  const session = panel.webview.html.match(/data-session="([^"]+)"/)?.[1] ?? "";
  const surface = message.surface ?? "shell";
  const { surface: _surface, ...body } = message;
  const revision = body.type === "ready"
    ? 0
    : (panel.webview.__posted.at(-1)?.revision ?? 0);
  return panel.__receive({ version: 1, session, revision, surface, body });
}

export const win = vscode.window as unknown as {
  __webviewPanels: StubPanel[];
  __resetWebviewPanels: () => void;
  __webviewSerializers: Map<string, { deserializeWebviewPanel: (panel: StubPanel, state: unknown) => Promise<void> }>;
};

export const MODEL: BoardViewModel = {
  scenarios: [
    { name: "Log in", location: "features/login.feature:5", dropId: "id-login", pills: [], reqKeys: [] },
    { name: "Checkout", location: "features/cart.feature:12", dropId: "id-checkout", pills: [], reqKeys: ["REQ-7"] },
  ],
  available: [{ key: "PAY-9", project: "PAY", pills: [], links: [] }],
  mapped: [
    {
      key: "CALC-1",
      summary: "Add two numbers",
      project: "CALC",
      pills: ["1 scenario"],
      links: [{ name: "Add two numbers", location: "features/calc.feature:3", unlinkId: "id-add" }],
    },
  ],
  matrix: [
    {
      requirement: "REQ-7",
      test: "CALC-1",
      scenario: "Checkout",
      tag: "@TEST_CALC-1",
      result: "passed",
      file: "features/cart.feature",
      projects: ["CALC"],
    },
    { requirement: "", test: "PAY-9", scenario: "", tag: "", result: "no coverage", file: "", projects: ["PAY"] },
  ],
  availableEmptyText: "No unmapped tests in the last sync.",
  completeProjects: ["CALC", "PAY"],
};

// Three available tests in one project, two of them matching a "login" column search: enough for a
// select-all to cover part of a list, and for one page to hold less than the search leaves.
export const LISTS: BoardViewModel = {
  ...MODEL,
  available: [
    { key: "CALC-10", summary: "Login", project: "CALC", pills: [], links: [] },
    { key: "CALC-11", summary: "Login again", project: "CALC", pills: [], links: [] },
    { key: "CALC-12", summary: "Checkout", project: "CALC", pills: [], links: [] },
  ],
};

export const PROJECTS = ["CALC", "PAY"];

// The board's scope store, in memory: the same boundary coercion the memento-backed one does, so a key
// that has left the known list reads as All Projects without being erased.
export function fakeScope(initial?: string): ProjectScopeStore {
  const store: ProjectScopeStore & { value: string | undefined } = {
    value: initial,
    get: (known) => (store.value !== undefined && known.includes(store.value) ? store.value : undefined),
    set: (project) => {
      store.value = project;
    },
  };
  return store;
}

// workspaceState in memory, so the board runs the real page-size store instead of a second copy of its
// coercion, and a test can read back what a pageSize message persisted.
export function memento(): Memento & { values: Record<string, unknown> } {
  const store = {
    values: {} as Record<string, unknown>,
    get: <T>(key: string): T | undefined => store.values[key] as T | undefined,
    update: (key: string, value: unknown): Promise<void> => {
      store.values[key] = value;
      return Promise.resolve();
    },
    keys: () => Object.keys(store.values),
  };
  return store as unknown as Memento & { values: Record<string, unknown> };
}

export const PAGE_SIZE_KEY = "playwrightBddRunner.board.mappingPageSize";

// More untraced scenarios than one page holds, so a paginator has somewhere to go.
export function manyScenarios(count: number): BoardViewModel {
  return {
    ...MODEL,
    scenarios: Array.from({ length: count }, (_, index) => ({
      name: `Scenario ${index + 1}`,
      location: `features/many.feature:${index + 1}`,
      dropId: `id-${index + 1}`,
      pills: [],
      reqKeys: [],
    })),
  };
}

export const EXECUTIONS: ExecutionRow[] = [
  {
    kind: "group",
    key: "XNP-1",
    keyLabel: "XNP-1",
    summary: "Checkout suite",
    latestPublishedAt: "2026-07-22",
    activityCount: 1,
    activities: [
      { action: "Created", resultsImported: "6", passRate: "5/6 passed", publishedAt: "2026-07-22" },
    ],
  },
  {
    kind: "group",
    key: "PAY-9",
    keyLabel: "PAY-9",
    summary: "Payments",
    latestPublishedAt: "2026-07-20",
    activityCount: 2,
    activities: [
      { action: "Appended", resultsImported: "-", passRate: "-", publishedAt: "2026-07-20" },
      { action: "Created", resultsImported: "4", passRate: "4/4 passed", publishedAt: "2026-07-19" },
    ],
  },
];

export function deps(over: Partial<BoardPanelDeps> = {}): BoardPanelDeps {
  return {
    providerLabel: "Xray",
    logger: Logger.create(undefined, LogLevel.ERROR),
    webviewAssetRoot: vscode.Uri.file("/extension/dist"),
    buildModel: () => MODEL,
    buildExecutions: () => EXECUTIONS,
    onDidChange: new vscode.EventEmitter<void>().event,
    onDidChangeActivity: new vscode.EventEmitter<void>().event,
    mutationActive: () => false,
    syncActive: () => false,
    applyDrop: () => Promise.resolve(),
    applyUnlink: () => Promise.resolve(),
    pushText: () => undefined,
    runSync: () => Promise.resolve(),
    syncProjects: () => PROJECTS,
    selectSyncProjects: () => undefined,
    autoSync: () => Promise.resolve(),
    openIssue: () => undefined,
    bulkCreate: () => undefined,
    createTestSet: () => undefined,
    addToTestSet: () => undefined,
    createTestPlan: () => undefined,
    addToTestPlan: () => undefined,
    createTestExecution: () => undefined,
    knownProjects: () => PROJECTS,
    projectScope: fakeScope(),
    mappingPageSize: mappingPageSizeStore(memento(), () => undefined),
    publishDelegate: noopDelegate,
    startPublish: () => undefined,
    ...over,
  };
}

export const isRender = (m: Posted): m is RenderMessage => m.type === "render";
export const lastRender = (panel: StubPanel): RenderMessage | undefined =>
  [...posted(panel)].reverse().find(isRender);
export const lastActivate = (panel: StubPanel): string | undefined =>
  [...posted(panel)].reverse().find((m): m is ActivateMessage => m.type === "activate")?.tab;
// The matrix arrives folded by feature file, so a test about which rows survived a filter or a scope
// reads them back out of their groups.
export const matrixTests = (render: RenderMessage): string[] => render.matrix.flatMap((g) => g.rows).map((r) => r.test);

// Open the board and drive the webview `ready` handshake so the shell flushes its queued render and
// activation; subsequent posts then land immediately.
export async function openReady(over: Partial<BoardPanelDeps> = {}): Promise<{ instance: BoardPanel; panel: StubPanel }> {
  const instance = BoardPanel.open(deps(over));
  const panel = win.__webviewPanels[0]!;
  await receive(panel, { type: "ready" });
  return { instance, panel };
}

export let browserClientCode: Promise<string> | undefined;

export function bundledBrowserClient(): Promise<string> {
  browserClientCode ??= build({
    entryPoints: ["src/webview/coverage-board.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
  }).then((output) => output.outputFiles[0]!.text);
  return browserClientCode;
}

export async function connectBrowserClient(panel: StubPanel): Promise<{
  readonly dom: JSDOM;
  flushInbound(): Promise<void>;
  pumpHost(): Promise<void>;
}> {
  const dom = new JSDOM(panel.webview.html, { pretendToBeVisual: true, runScripts: "outside-only" });
  Object.defineProperty(dom.window.HTMLElement.prototype, "scrollIntoView", { configurable: true, value: () => undefined });
  let inbound = Promise.resolve();
  Object.defineProperty(dom.window, "acquireVsCodeApi", {
    value: () => ({
      postMessage: (message: unknown) => {inbound = inbound.then(() => panel.__receive(message));},
      getState: () => ({}),
      setState: () => undefined,
    }),
  });
  dom.window.eval(await bundledBrowserClient());
  let delivered = 0;
  const flushInbound = async (): Promise<void> => {
    await inbound;
    await Promise.resolve();
  };
  const pumpHost = async (): Promise<void> => {
    await flushInbound();
    while (delivered < panel.webview.__posted.length) {
      const messages = panel.webview.__posted.slice(delivered);
      delivered = panel.webview.__posted.length;
      for (const message of messages) {
        dom.window.dispatchEvent(new dom.window.MessageEvent("message", { data: message }));
      }
      await flushInbound();
    }
  };
  await pumpHost();
  return { dom, flushInbound, pumpHost };
}

// A window reload's restored board tab: a bare panel of the board's view type handed to the registered
// serializer, which is all the host gives back.
export function restoreTab(build: () => BoardPanelDeps = () => deps()): StubPanel {
  const serializer = BoardPanel.registerSerializer(build);
  const restored = vscode.window.createWebviewPanel(
    "playwrightBddRunner.coverageBoard",
    "Coverage Board",
    vscode.ViewColumn.Beside,
    {}
  ) as unknown as StubPanel;
  void win.__webviewSerializers.get("playwrightBddRunner.coverageBoard")!.deserializeWebviewPanel(restored, undefined);
  // The host allows one serializer per view type, so this one retires with the revival it drove.
  serializer.dispose();
  return restored;
}
