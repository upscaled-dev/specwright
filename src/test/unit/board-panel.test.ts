import { describe, it, expect, afterEach, vi } from "vitest";
import { build } from "esbuild";
import { JSDOM } from "jsdom";
import * as vscode from "vscode";
import type { Memento } from "vscode";
import { affectsBoard, BoardPanel, BoardPanelDeps } from "../../traceability/board-panel";
import { BoardSectionMeta, BoardViewModel, ExecutionRow } from "../../traceability/board-data";
import { mappingPageSizeStore } from "../../traceability/mapping-page-size";
import { NO_PROJECT_SCOPE, ProjectScopeStore } from "../../traceability/project-scope";
import { PublishDialogDelegate } from "../../traceability/publish-dialog-panel";
import type { PublishDialogModel, PublishRunOption } from "../../traceability/publish-flow";
import { Logger, LogLevel } from "../../utils/logger";

const noopDelegate: PublishDialogDelegate = {
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
interface StubPanel {
  title: string;
  webview: { html: string; options: { enableScripts: boolean; localResourceRoots: vscode.Uri[] }; __posted: Array<{ session: string; revision: number; surface: string; body: Posted }> };
  __revealCount: number;
  __disposed: boolean;
  dispose: () => void;
  __receive: (message: unknown) => Promise<void>;
}

interface RenderMessage {
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
interface Verb {
  label: string;
  enabled: boolean;
  hint: string;
}
interface ActivateMessage {
  type: "activate";
  tab: string;
}
type Posted = RenderMessage | ActivateMessage | { type: string; [key: string]: unknown };

function posted(panel: StubPanel): Posted[] {
  return panel.webview.__posted.map((message) => message.surface === "shell"
    ? message.body
    : { ...message.body, surface: message.surface });
}

function receive(panel: StubPanel, message: Posted & { surface?: string }): Promise<void> {
  const session = panel.webview.html.match(/data-session="([^"]+)"/)?.[1] ?? "";
  const surface = message.surface ?? "shell";
  const { surface: _surface, ...body } = message;
  const revision = body.type === "ready"
    ? 0
    : (panel.webview.__posted.at(-1)?.revision ?? 0);
  return panel.__receive({ version: 1, session, revision, surface, body });
}

const win = vscode.window as unknown as {
  __webviewPanels: StubPanel[];
  __resetWebviewPanels: () => void;
  __webviewSerializers: Map<string, { deserializeWebviewPanel: (panel: StubPanel, state: unknown) => Promise<void> }>;
};

afterEach(() => win.__resetWebviewPanels());

const MODEL: BoardViewModel = {
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
const LISTS: BoardViewModel = {
  ...MODEL,
  available: [
    { key: "CALC-10", summary: "Login", project: "CALC", pills: [], links: [] },
    { key: "CALC-11", summary: "Login again", project: "CALC", pills: [], links: [] },
    { key: "CALC-12", summary: "Checkout", project: "CALC", pills: [], links: [] },
  ],
};

const PROJECTS = ["CALC", "PAY"];

// The board's scope store, in memory: the same boundary coercion the memento-backed one does, so a key
// that has left the known list reads as All Projects without being erased.
function fakeScope(initial?: string): ProjectScopeStore {
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
function memento(): Memento & { values: Record<string, unknown> } {
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

const PAGE_SIZE_KEY = "playwrightBddRunner.board.mappingPageSize";

// More untraced scenarios than one page holds, so a paginator has somewhere to go.
function manyScenarios(count: number): BoardViewModel {
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

const EXECUTIONS: ExecutionRow[] = [
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

function deps(over: Partial<BoardPanelDeps> = {}): BoardPanelDeps {
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
    autoSync: () => Promise.resolve(),
    openExecution: () => undefined,
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

const isRender = (m: Posted): m is RenderMessage => m.type === "render";
const lastRender = (panel: StubPanel): RenderMessage | undefined =>
  [...posted(panel)].reverse().find(isRender);
const lastActivate = (panel: StubPanel): string | undefined =>
  [...posted(panel)].reverse().find((m): m is ActivateMessage => m.type === "activate")?.tab;
// The matrix arrives folded by feature file, so a test about which rows survived a filter or a scope
// reads them back out of their groups.
const matrixTests = (render: RenderMessage): string[] => render.matrix.flatMap((g) => g.rows).map((r) => r.test);

// Open the board and drive the webview `ready` handshake so the shell flushes its queued render and
// activation; subsequent posts then land immediately.
async function openReady(over: Partial<BoardPanelDeps> = {}): Promise<{ instance: BoardPanel; panel: StubPanel }> {
  const instance = BoardPanel.open(deps(over));
  const panel = win.__webviewPanels[0]!;
  await receive(panel, { type: "ready" });
  return { instance, panel };
}

let browserClientCode: Promise<string> | undefined;

function bundledBrowserClient(): Promise<string> {
  browserClientCode ??= build({
    entryPoints: ["src/webview/coverage-board.ts"],
    bundle: true,
    platform: "browser",
    format: "iife",
    write: false,
  }).then((output) => output.outputFiles[0]!.text);
  return browserClientCode;
}

async function connectBrowserClient(panel: StubPanel): Promise<{
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
function restoreTab(build: () => BoardPanelDeps = () => deps()): StubPanel {
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

describe("BoardPanel", () => {
  it("renders the shell: title, tabs, the drag-to-link hint, the provider label, the matrix header, and the executions table", () => {
    BoardPanel.open(deps());
    const panel = win.__webviewPanels[0]!;

    expect(panel.title).toBe("Coverage Board");
    expect(panel.webview.html).toContain("Coverage Board");
    expect(panel.webview.html).toContain("Mapping");
    expect(panel.webview.html).toContain("Matrix");
    expect(panel.webview.html).toContain("Executions");
    expect(panel.webview.html).toContain("Filter by key, tag, file");
    expect(panel.webview.html).toContain("select one scenario and one test and use the visible Link button");
    expect(panel.webview.html).toContain("Xray tests");
    expect(panel.webview.html).toContain("Requirement");
    expect(panel.webview.html).toContain("Xray test");
    expect(panel.webview.html).toContain("Tag in file");
    expect(panel.webview.html).toContain("Last result");
    expect(panel.webview.html).toContain("Pass rate");
    expect(panel.webview.html).toContain("<th>Activity</th>");
    expect(panel.webview.html).toContain("Execution activity from this workspace appears here.");
  });

  it("splits the mapping pane's test column into an available group and a mapped group", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;

    expect(html).toContain("Available Xray tests");
    expect(html).toContain('id="available-count"');
    expect(html).toContain('id="available-cards"');
    expect(html).toContain("Mapped Xray tests");
    expect(html).toContain('id="mapped-count"');
    expect(html).toContain('id="mapped-cards"');
    expect(html).toContain('id="available-toggle"');
    expect(html).toContain('aria-controls="available-content"');
    expect(html).toContain('id="mapped-toggle"');
    expect(html).toContain('aria-controls="mapped-content"');
    expect(html.match(/id="sync-now"/g)).toHaveLength(1);
    expect(html).toContain("position: sticky");
    expect(html).toContain("background: var(--vscode-editor-background)");
  });

  // Source-level only: the webview JS never runs here, so this pins that the strip ships above the panes
  // (so it shows on any tab) and that a render clears it, not that the rendered bar animates.
  it("carries the sync progress strip above the panes, cleared by every render", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;

    expect(html).toContain('id="sync-strip"');
    expect(html).toContain('id="sync-strip-text"');
    expect(html.indexOf('id="sync-strip"')).toBeLessThan(html.indexOf("<main>"));
  });

  // The app frame: the document is a flex column whose only scrollers are the panes, and one global
  // [hidden] rule (with the !important a pane's own display: flex would otherwise beat) hides every
  // surface's collapsed parts. Source-level pins, since no unit rig lays the document out.
  it("frames the document so only the panes scroll, with one hidden rule for every surface", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;

    expect(html).toContain("html, body { height: 100%; }");
    expect(html).toContain("[hidden] { display: none !important; }");
    expect(html).toContain("main { flex: 1; min-height: 0;");
    expect(html).toContain(".pane { height: 100%; box-sizing: border-box; overflow-y: auto; }");
    expect(html).toContain(".board-pane { display: flex; flex-direction: column; }");
    // One left edge for the toolbar, the strip, and the panes.
    expect(html.split("1.1rem").length - 1).toBe(3);
    // The per-surface duplicates are gone, including the two the publish and link fragments carried.
    expect(html.split("[hidden] { display: none").length - 1).toBe(1);
  });

  // The two load-bearing pieces of the half-window layout: tracks that may compress below their content,
  // and the stacking breakpoint that turns the columns into one scrolling list.
  it("gives the mapping columns compressible tracks and a stacking breakpoint", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;

    expect(html).toContain("grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);");
    expect(html).toContain("@media (max-width: 540px)");
    expect(html).toContain("grid-template-columns: minmax(0, 1fr); grid-template-rows: auto;");
    expect(html).toContain(".board-pane .column { min-width: 0; min-height: 0; overflow-y: auto; }");
    // The table scroller owns the leftover height instead of guessing at the viewport.
    expect(html).toContain(".board-pane .matrix-scroll { flex: 1; min-height: 0; overflow: auto;");
    expect(html).not.toContain("100vh");
  });

  it("carries no Mapped tree markup, no drag-to-unlink drop zone, and no decorative gutter", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;
    expect(html).not.toContain("mapped-groups");
    expect(html).not.toContain("unlink-ready");
    // The gutter spent 88px on the word "drag to link"; the hint bar already says it.
    expect(html).not.toContain("gutter");
    expect(html).not.toContain("drag to link");
  });

  // Eleven verb buttons across two panes, nine compact Mapping actions plus text Sync and Execution verbs.
  it("skins every board button with the one verb class, each inside a verbs row", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;

    expect(html.split('class="verb"').length - 1).toBe(2);
    expect(html.split('class="verb icon-verb"').length - 1).toBe(9);
    expect(html).not.toContain('class="create-tests"');
    expect(html.split('<div class="verbs mapping-actions">').length - 1).toBe(3);
    expect(html.split('<div class="verbs">').length - 1).toBe(1);
  });

  // Source-level only: the webview JS never runs here. The shared section builder gives every card list
  // the same skeleton, so this pins the three per-column search boxes, the three paginators, the one
  // page-size dropdown, and the two decisions the frame owns: a count from the honest total, and a search
  // echo that only lands when the box is not focused so a repaint cannot jump a mid-type cursor.
  it("builds every mapping section with its own search box, paginator, and one shared page-size control", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;

    expect(html).toContain('id="scenario-search"');
    expect(html).toContain('id="available-search"');
    expect(html).toContain('id="mapped-search"');
    expect(html).toContain('id="scenario-paginator"');
    expect(html).toContain('id="available-paginator"');
    expect(html).toContain('id="mapped-paginator"');
    expect(html).toContain('id="page-size-select"');
    expect(html).toContain('<option value="25">25</option>');
    expect(html).toContain('<option value="50">50</option>');
    expect(html).toContain('<option value="100">100</option>');
  });

  it("loads one external client bundle and carries no executable inline script", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;
    expect(html.match(/<script\b/g)).toHaveLength(1);
    expect(html).toContain('src="file:///extension/dist/coverage-board.js"');
    expect(html).not.toContain("acquireVsCodeApi()");
    expect(html).not.toContain("unsafe-eval");
    expect(html).toContain('role="tablist" aria-label="Coverage views"');
    expect(html).toContain('id="scope-select" aria-label="Project scope"');
    expect(html).toContain('id="search" type="text" spellcheck="false" autocomplete="off" aria-label="Filter coverage board"');
    expect(win.__webviewPanels[0]!.webview.options.localResourceRoots.map((uri) => uri.toString())).toEqual([
      vscode.Uri.file("/extension/dist").toString(),
    ]);
  });

  it("carries the permanent Publish tab and its pane in the shell", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;
    expect(html).toContain('data-tab="publish"');
    expect(html).toContain('id="pane-publish"');
    expect(html).toContain(">Publish</button>");
  });


  it("fires startPublish when the Publish tab is activated with no publish underway", async () => {
    const startPublish = vi.fn();
    const { panel } = await openReady({ startPublish });

    await receive(panel, { type: "tab", tab: "publish" });

    expect(lastActivate(panel)).toBe("publish");
    expect(startPublish).toHaveBeenCalledOnce();
  });

  it("does not re-fire startPublish while a publish is already being presented", async () => {
    const startPublish = vi.fn();
    const { instance, panel } = await openReady({ startPublish });

    void instance.publish.beginFlow().present({
      title: "Publish run results",
      runs: [],
      selectedRunId: "",
      jiraSearchAvailable: false,
      knownProjectKeys: [],
      attachments: { available: false, suggestions: [], uploadLimitBytes: 0, evidenceStream: "evidence" },
    });
    await receive(panel, { type: "tab", tab: "publish" });

    expect(startPublish).not.toHaveBeenCalled();
  });

  it("does not restart a confirmed publish when the Publish tab is repeatedly reactivated", async () => {
    const model: PublishDialogModel = {
      title: "Publish run results",
      runs: [{
        id: "run-1",
        label: "run-1",
        subtitle: "1 mapped result",
        project: { value: "CALC", fromDerivation: true },
        defaultSummary: "Publish run-1",
      }],
      selectedRunId: "run-1",
      jiraSearchAvailable: false,
      knownProjectKeys: ["CALC"],
      attachments: { available: false, suggestions: [], uploadLimitBytes: 0, evidenceStream: "evidence" },
    };
    const current: { instance?: BoardPanel } = {};
    const startPublish = vi.fn(() => {
      const next = current.instance!.publish.beginFlow();
      void next.present(model);
    });
    const opened = await openReady({ startPublish });
    current.instance = opened.instance;
    const instance = opened.instance;
    const panel = opened.panel;
    const first = instance.publish.beginFlow();
    const confirmed = first.present(model);
    await receive(panel, {
      surface: "publish",
      type: "confirm",
      runId: "run-1",
      request: { mode: "append", executionKey: "XNP-1" },
      attachments: [],
    });
    await confirmed;

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await receive(panel, { type: "tab", tab: "mapping" });
      await receive(panel, { type: "tab", tab: "publish" });
    }

    expect(startPublish).not.toHaveBeenCalled();
    expect(posted(panel).filter((message) => message.type === "settled")).toHaveLength(0);
    expect(posted(panel).filter((message) => message.type === "publish-busy").at(-1)).toMatchObject({ busy: true });

    expect(first.markSettled()).toBe(true);
    await receive(panel, { type: "tab", tab: "publish" });
    await receive(panel, { type: "tab", tab: "publish" });

    expect(startPublish).toHaveBeenCalledOnce();
  });

  // The stub keeps whatever the host assigns, so this pins that both themes reach the tab. Resolving the
  // media Uris off the extension root is the command layer's job and is not exercised here.
  it("puts the light and dark tab icons on the panel when the host supplies them", () => {
    const tabIcon = {
      light: vscode.Uri.file("/ext/media/coverage-board-light.svg"),
      dark: vscode.Uri.file("/ext/media/coverage-board-dark.svg"),
    };

    BoardPanel.open(deps({ tabIcon }));

    expect((win.__webviewPanels[0] as unknown as { iconPath?: unknown }).iconPath).toEqual(tabIcon);
  });

  it("opens without a tab icon when the host has no extension root to resolve one from", () => {
    BoardPanel.open(deps());

    expect((win.__webviewPanels[0] as unknown as { iconPath?: unknown }).iconPath).toBeUndefined();
  });

  it("reveals the existing panel instead of opening a second (singleton surface)", () => {
    BoardPanel.open(deps());
    BoardPanel.open(deps());

    expect(win.__webviewPanels).toHaveLength(1);
    expect(win.__webviewPanels[0]!.__revealCount).toBe(1);
  });

  it("holds its render behind the ready gate, then flushes it once the webview signals ready", async () => {
    BoardPanel.open(deps());
    const panel = win.__webviewPanels[0]!;
    expect(lastRender(panel)).toBeUndefined();

    await receive(panel, { type: "ready" });

    expect(lastRender(panel)).toBeDefined();
    expect(posted(panel).filter(isRender)).toHaveLength(1);
    expect(posted(panel).filter((m) => m.type === "activate")).toHaveLength(1);
  });

  // VS Code rebuilds the webview's DOM on a window reload or a move between editor groups, and that
  // fresh document opens with every pane hidden and nothing painted in it.
  it("re-activates the current tab and re-renders from a fresh model when a rebuilt webview readies again", async () => {
    let current = MODEL;
    const { panel } = await openReady({ buildModel: () => current });
    await receive(panel, { type: "tab", tab: "matrix" });
    current = { ...MODEL, available: [{ key: "NEW-1", pills: [], links: [] }] };
    const before = posted(panel).length;

    await receive(panel, { type: "ready" });

    const rehydration = posted(panel).slice(before);
    expect(rehydration.filter((m): m is ActivateMessage => m.type === "activate").map((m) => m.tab)).toEqual(["matrix"]);
    expect(rehydration.filter(isRender)).toHaveLength(1);
    expect(lastRender(panel)!.available.map((t) => t.key)).toEqual(["NEW-1"]);
  });

  // The rebuilt document brings back an empty search box, so a query kept host-side would narrow the
  // board against a filter nothing on screen still shows.
  it("drops the search query when the webview comes back", async () => {
    const { panel } = await openReady();
    await receive(panel, { surface: "board", type: "search", value: "cart.feature" });
    expect(lastRender(panel)!.scenarios.map((s) => s.name)).toEqual(["Checkout"]);

    await receive(panel, { type: "ready" });

    expect(lastRender(panel)!.filtering).toBe(false);
    expect(lastRender(panel)!.scenarios.map((s) => s.name)).toEqual(["Log in", "Checkout"]);
  });

  it("re-posts the run of a publish still awaiting its answer when the webview comes back", async () => {
    const { instance, panel } = await openReady();
    void instance.publish.beginFlow().present({
      title: "Publish run results",
      runs: [],
      selectedRunId: "",
      jiraSearchAvailable: false,
      knownProjectKeys: [],
      attachments: { available: false, suggestions: [], uploadLimitBytes: 0, evidenceStream: "evidence" },
    });
    const before = posted(panel).length;

    await receive(panel, { type: "ready" });

    expect(posted(panel).slice(before).filter((m) => m.type === "model")).toHaveLength(1);
  });

  // The rebuilt document starts blank, so a section that throws on its replay must cost only its own pane.
  it("replays the other surfaces, and logs, when one section's rehydrate throws", async () => {
    const lines: string[] = [];
    const channel = { appendLine: (line: string) => lines.push(line), show: () => {}, clear: () => {}, dispose: () => {} };
    let broken = false;
    const { instance, panel } = await openReady({
      logger: Logger.create(channel as unknown as vscode.OutputChannel, LogLevel.WARN),
      buildModel: () => {
        if (broken) {
          throw new Error("snapshot gone");
        }
        return MODEL;
      },
    });
    void instance.publish.beginFlow().present({
      title: "Publish run results",
      runs: [],
      selectedRunId: "",
      jiraSearchAvailable: false,
      knownProjectKeys: [],
      attachments: { available: false, suggestions: [], uploadLimitBytes: 0, evidenceStream: "evidence" },
    });
    instance.link.begin({ title: "Link scenario", searchPlaceholder: "Search tests" });
    broken = true;
    const before = posted(panel).length;

    await receive(panel, { type: "ready" });

    const replay = posted(panel).slice(before);
    expect(replay.filter(isRender)).toEqual([]);
    expect(replay.filter((m) => m.type === "model")).toHaveLength(1);
    expect(replay.filter((m) => m.type === "reset")).toHaveLength(1);
    expect(lines.some((line) => line.includes("Repainting the board surface failed"))).toBe(true);
  });

  it("repaints a live link session onto a rebuilt webview: its tab and everything it had on screen", async () => {
    const { instance, panel } = await openReady();
    const session = instance.link.begin({ title: "Link scenario", searchPlaceholder: "Search tests" });
    session.setRows([{ id: "CALC-1", key: "CALC-1", summary: "Add two numbers", kind: "test" }]);
    const before = posted(panel).length;

    await receive(panel, { type: "ready" });

    const replay = posted(panel).slice(before);
    expect(replay).toContainEqual({ type: "linkTab", visible: true, title: "Link scenario" });
    expect(replay.filter((m) => m.type === "reset")).toHaveLength(1);
    expect(replay.filter((m) => m.type === "rows")).toHaveLength(1);
    expect(lastActivate(panel)).toBe("link");
  });

  it("posts no link paint on a re-hydration with no session live", async () => {
    const { panel } = await openReady();
    const before = posted(panel).length;

    await receive(panel, { type: "ready" });

    expect(posted(panel).slice(before).filter((m) => m.type === "linkTab")).toEqual([]);
  });

  it("adopts a board tab a window reload restored, so it paints and activates like a fresh open", async () => {
    const restored = restoreTab();
    await receive(restored, { type: "ready" });

    expect(restored.webview.html).toContain('id="pane-mapping"');
    expect(lastActivate(restored)).toBe("mapping");
    expect(lastRender(restored)!.scenarios.map((s) => s.name)).toEqual(["Log in", "Checkout"]);
  });

  it("drops a restored tab when a board is already open, revealing the live one instead", async () => {
    const { instance, panel } = await openReady();

    const restored = restoreTab();

    expect(restored.webview.html).toBe("");
    expect(restored.__disposed).toBe(true);
    expect(panel.__revealCount).toBe(1);
    expect(BoardPanel.open(deps())).toBe(instance);
  });

  // A half-wired revival would leave a tab nothing can ever paint, so the panel goes instead.
  it("drops a restored tab whose deps cannot be built, without failing the revival", () => {
    const restored = restoreTab(() => {
      throw new Error("no workspace");
    });

    expect(restored.__disposed).toBe(true);
    expect(BoardPanel.selectedTests()).toEqual([]);
  });

  it("tags every board render with surface board and activates the Mapping tab on open", async () => {
    const { panel } = await openReady();

    const render = lastRender(panel)!;
    expect(render.surface).toBe("board");
    expect(lastActivate(panel)).toBe("mapping");
    expect(render.scenarios.map((s) => s.name)).toEqual(["Log in", "Checkout"]);
    expect(render.available.map((t) => t.key)).toEqual(["PAY-9"]);
    expect(render.mapped.map((t) => t.key)).toEqual(["CALC-1"]);
    expect(matrixTests(render)).toEqual(["CALC-1", "PAY-9"]);
  });

  // Folded host-side so the webview can render a collapsed group as a header and nothing else, which is
  // what keeps a workspace of thousands of rows off the page until a file is opened.
  it("folds the matrix into one group per feature file, the rows with no file last", async () => {
    const { panel } = await openReady();

    expect(lastRender(panel)!.matrix).toEqual([
      { file: "features/cart.feature", count: 1, rows: [expect.objectContaining({ test: "CALC-1" })] },
      { file: "", count: 1, rows: [expect.objectContaining({ test: "PAY-9" })] },
    ]);
  });

  it("posts the executions rows from the ledger on render", async () => {
    const { panel } = await openReady();

    expect(lastRender(panel)!.executions.map((e) => e.key)).toEqual(["XNP-1", "PAY-9"]);
  });

  it("posts an empty executions list when the ledger is empty", async () => {
    const { panel } = await openReady({ buildExecutions: () => [] });

    expect(lastRender(panel)!.executions).toEqual([]);
  });

  it("filters the executions rows on key and summary", async () => {
    const { panel } = await openReady();

    await receive(panel, { surface: "board", type: "search", value: "payments" });

    expect(lastRender(panel)!.executions.map((e) => e.key)).toEqual(["PAY-9"]);
  });

  it("routes an open message to openExecution with the row key", async () => {
    const openExecution = vi.fn();
    const { panel } = await openReady({ openExecution });

    await receive(panel, { surface: "board", type: "open", key: "XNP-1" });

    expect(openExecution).toHaveBeenCalledWith("XNP-1");
  });

  it("filters both buckets on a search message via the vscode-free filter", async () => {
    const { panel } = await openReady();

    await receive(panel, { surface: "board", type: "search", value: "cart.feature" });

    const render = lastRender(panel)!;
    expect(render.scenarios.map((s) => s.name)).toEqual(["Checkout"]);
    expect(render.available).toEqual([]);
    expect(render.mapped).toEqual([]);
  });

  it("filters the matrix rows alongside the cards", async () => {
    const { panel } = await openReady();

    await receive(panel, { surface: "board", type: "search", value: "PAY" });

    const render = lastRender(panel)!;
    expect(matrixTests(render)).toEqual(["PAY-9"]);
    // The fold runs after the query, so the group whose only row the query dropped never reaches the
    // webview at all.
    expect(render.matrix.map((g) => g.file)).toEqual([""]);
    expect(render.available.map((t) => t.key)).toEqual(["PAY-9"]);
    expect(render.mapped).toEqual([]);
  });

  it("routes a drop to applyDrop with the normalized scenario and key", async () => {
    const applyDrop = vi.fn(() => Promise.resolve());
    const { panel } = await openReady({ applyDrop });

    await receive(panel, { surface: "board", type: "drop", scenario: "features/login.feature:5", key: "PAY-9" });

    expect(applyDrop).toHaveBeenCalledWith("features/login.feature:5", "PAY-9");
  });

  it("hands the picked project to the host's load, storing the selection first", async () => {
    const order: string[] = [];
    const stored = fakeScope();
    const projectScope: ProjectScopeStore = {
      get: (known) => stored.get(known),
      set: (project) => {
        order.push(`set:${String(project)}`);
        stored.set(project);
      },
    };
    const autoSync = vi.fn((project: string) => {
      order.push(`load:${project}`);
      return Promise.resolve();
    });
    const { panel } = await openReady({ autoSync, projectScope });

    await receive(panel, { surface: "board", type: "scope", project: "PAY" });

    expect(order).toEqual(["set:PAY", "load:PAY"]);
    expect(lastRender(panel)!.project).toBe("PAY");
  });

  it("asks for no load when the selector goes back to All projects", async () => {
    const autoSync = vi.fn(() => Promise.resolve());
    const { panel } = await openReady({ autoSync, projectScope: fakeScope("PAY") });
    autoSync.mockClear();

    await receive(panel, { surface: "board", type: "scope", project: "" });

    expect(autoSync).not.toHaveBeenCalled();
  });

  // Whether the load is worth running is the host's call: mapped cards come from local tags, so a board
  // that looks populated can still have nothing catalogued for that project.
  it("hands a stored project to the host's load on open, tag-derived cards or not", async () => {
    const autoSync = vi.fn(() => Promise.resolve());
    const runSync = vi.fn(() => Promise.resolve());

    await openReady({ autoSync, runSync, projectScope: fakeScope("CALC") });

    expect(autoSync).toHaveBeenCalledWith("CALC");
    expect(runSync).not.toHaveBeenCalled();
  });

  it("asks for no load on open under All projects, however empty the board is", async () => {
    const autoSync = vi.fn(() => Promise.resolve());

    await openReady({ autoSync, buildModel: () => ({ ...MODEL, available: [], mapped: [] }) });

    expect(autoSync).not.toHaveBeenCalled();
  });

  it("asks for no load for a selection the store no longer knows, matching what it paints", async () => {
    const autoSync = vi.fn(() => Promise.resolve());

    await openReady({ autoSync, projectScope: fakeScope("GONE") });

    expect(autoSync).not.toHaveBeenCalled();
  });

  it("posts the host's progress line to the strip and drops it once the board is gone", async () => {
    const { instance, panel } = await openReady();

    BoardPanel.reportSyncProgress("Syncing PAY: 100 of 350 tests");
    expect(posted(panel).at(-1)).toEqual({
      surface: "board",
      type: "syncProgress",
      text: "Syncing PAY: 100 of 350 tests",
    });

    BoardPanel.reportSyncProgress("");
    expect(posted(panel).at(-1)).toMatchObject({ type: "syncProgress", text: "" });

    instance.dispose();

    expect(() => BoardPanel.reportSyncProgress("Syncing PAY: 1 test")).not.toThrow();
  });

  it("routes a sync message to runSync so the empty available group can load tests", async () => {
    const runSync = vi.fn(() => Promise.resolve());
    const { panel } = await openReady({ runSync });

    await receive(panel, { surface: "board", type: "sync" });

    expect(runSync).toHaveBeenCalledOnce();
  });

  it("rejects a current sync action while a mutation owns the board", async () => {
    const runSync = vi.fn(() => Promise.resolve());
    const { panel } = await openReady({ runSync, mutationActive: () => true });

    await receive(panel, { surface: "board", type: "sync" });

    expect(runSync).not.toHaveBeenCalled();
    expect(lastRender(panel)?.syncVerb).toMatchObject({ enabled: false, label: "Sync now" });
  });

  it("paints an open board disabled during a mutation and re-enables from the activity event", async () => {
    let active = true;
    const activity = new vscode.EventEmitter<void>();
    const { panel } = await openReady({
      mutationActive: () => active,
      onDidChangeActivity: activity.event,
    });
    expect(lastRender(panel)?.syncVerb.enabled).toBe(false);

    active = false;
    activity.fire();

    expect(lastRender(panel)?.syncVerb).toMatchObject({ enabled: true, label: "Sync now" });
  });

  it("repaints once a sync settles, even when it rejects, so the button never strands the group", async () => {
    const runSync = vi.fn(() => Promise.reject(new Error("offline")));
    const { panel } = await openReady({ runSync });
    const renders = (): number => posted(panel).filter(isRender).length;
    const before = renders();

    await receive(panel, { surface: "board", type: "sync" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(renders()).toBe(before + 1);
  });

  it("keeps Sync present while the available group's rows and empty state change", async () => {
    let current = MODEL;
    const changes = new vscode.EventEmitter<void>();
    const { panel } = await openReady({ buildModel: () => current, onDidChange: changes.event });
    expect(lastRender(panel)!).toMatchObject({ availableEmptyText: MODEL.availableEmptyText });
    expect(panel.webview.html).toContain('id="sync-now"');

    current = { ...MODEL, availableEmptyText: "No synced tests yet." };
    changes.fire();

    expect(lastRender(panel)!).toMatchObject({ availableEmptyText: "No synced tests yet." });
    expect(panel.webview.html.match(/id="sync-now"/g)).toHaveLength(1);
  });

  it("marks a render as filtering only while a query is active, so a filtered-empty group keeps its Sync now off", async () => {
    const { panel } = await openReady();
    expect(lastRender(panel)!.filtering).toBe(false);

    await receive(panel, { surface: "board", type: "search", value: "cart.feature" });
    expect(lastRender(panel)!.filtering).toBe(true);

    await receive(panel, { surface: "board", type: "search", value: "   " });

    expect(lastRender(panel)!.filtering).toBe(false);
  });

  it("forwards each mapped test card's linked scenario rows on the initial render", async () => {
    const { panel } = await openReady();

    const render = lastRender(panel)!;
    expect(render.mapped[0]!.links).toEqual([
      { name: "Add two numbers", location: "features/calc.feature:3", unlinkId: "id-add" },
    ]);
    expect(render.available[0]!.links).toEqual([]);
  });

  it("routes an unlink message to applyUnlink with the scenario id and key", async () => {
    const applyUnlink = vi.fn(() => Promise.resolve());
    const { panel } = await openReady({ applyUnlink });

    await receive(panel, { surface: "board", type: "unlink", scenario: "id-add", key: "CALC-1" });

    expect(applyUnlink).toHaveBeenCalledWith("id-add", "CALC-1");
  });

  it("rejects malformed, stale, wrong-session, unknown and oversized messages before surface handlers", async () => {
    const applyDrop = vi.fn(() => Promise.resolve());
    const applyUnlink = vi.fn(() => Promise.resolve());
    const pushText = vi.fn();
    const { panel } = await openReady({ applyDrop, applyUnlink, pushText });
    const session = panel.webview.html.match(/data-session="([^"]+)"/)?.[1] ?? "";
    const revision = panel.webview.__posted.at(-1)!.revision;
    const messages = [
      { version: 2, session, revision, surface: "board", body: { type: "drop", scenario: "id-add", key: "CALC-1" } },
      { version: 1, session: "other", revision, surface: "board", body: { type: "unlink", scenario: "id-add", key: "CALC-1" } },
      { version: 1, session, revision: revision - 1, surface: "board", body: { type: "pushText", scenario: "id-add", key: "CALC-1" } },
      { version: 1, session, revision, surface: "board", body: { type: "select", target: "test", id: "x".repeat(513), on: true } },
      { version: 1, session, revision, surface: "other", body: { type: "drop", scenario: "id-add", key: "CALC-1" } },
      { version: 1, session, revision, surface: "board", body: { type: "unknown" } },
    ];
    for (const message of messages) {await panel.__receive(message);}
    expect(applyDrop).not.toHaveBeenCalled();
    expect(applyUnlink).not.toHaveBeenCalled();
    expect(pushText).not.toHaveBeenCalled();

    await panel.__receive({ version: 1, session, revision, surface: "board", body: { type: "drop", scenario: "id-add", key: "CALC-1" } });
    expect(applyDrop).toHaveBeenCalledWith("id-add", "CALC-1");
  });

  it("keeps stale publish intents actionable until the real routed host acknowledges a current revision", async () => {
    const runsChanged = new vscode.EventEmitter<void>();
    const run = (id: string, count: number): PublishRunOption => ({
      id,
      label: id,
      subtitle: `${count} pending`,
      project: { value: "CALC", fromDerivation: true },
      defaultSummary: `Publish ${id}`,
      pendingAttachments: { target: `CALC-${id}`, count },
    });
    const runs = [run("run-a", 2), run("run-b", 3)];
    let resolveUpload: (value: { remaining: number }) => void = () => undefined;
    const attachPending = vi.fn(() => new Promise<{ remaining: number }>((resolve) => {resolveUpload = resolve;}));
    const publishDelegate: PublishDialogDelegate = {
      ...noopDelegate,
      attachPending,
      onDidChangeRuns: runsChanged.event,
      runOptions: () => runs,
    };
    const model: PublishDialogModel = {
      title: "Publish run",
      runs,
      selectedRunId: "run-a",
      jiraSearchAvailable: false,
      knownProjectKeys: ["CALC"],
      attachments: { available: false, suggestions: [], uploadLimitBytes: 0, evidenceStream: "evidence" },
    };
    const instance = BoardPanel.open(deps({ publishDelegate }));
    const panel = win.__webviewPanels[0]!;
    const client = await connectBrowserClient(panel);
    let initialResolved = false;
    const flow = instance.publish.beginFlow();
    const initial = flow.present(model).then((result) => {
      initialResolved = true;
      return result;
    });
    await client.pumpHost();
    const refreshAheadOfClient = async (): Promise<void> => {
      runsChanged.fire();
      await new Promise((resolve) => setTimeout(resolve, 0));
    };
    const pendingButton = (): HTMLButtonElement => client.dom.window.document.querySelector<HTMLButtonElement>("#banners button")!;
    const chooseRun = async (id: string): Promise<void> => {
      const select = client.dom.window.document.getElementById("run-select") as HTMLSelectElement;
      select.value = id;
      select.dispatchEvent(new client.dom.window.Event("change", { bubbles: true }));
      await client.flushInbound();
    };

    await refreshAheadOfClient();
    pendingButton().click();
    await client.flushInbound();
    expect(attachPending).not.toHaveBeenCalled();
    expect(pendingButton().disabled).toBe(false);

    await client.pumpHost();
    pendingButton().click();
    pendingButton().click();
    await client.flushInbound();
    expect(attachPending).toHaveBeenCalledOnce();
    expect(pendingButton().disabled).toBe(false);
    await client.pumpHost();
    expect(pendingButton().disabled).toBe(true);

    await chooseRun("run-b");
    resolveUpload({ remaining: 1 });
    await new Promise((resolve) => setTimeout(resolve, 0));
    await client.pumpHost();
    await chooseRun("run-a");
    expect(pendingButton().disabled).toBe(false);
    expect(client.dom.window.document.getElementById("banners")?.textContent).toContain("1 attachment file");

    await refreshAheadOfClient();
    (client.dom.window.document.getElementById("publish") as HTMLButtonElement).click();
    await client.flushInbound();
    expect(initialResolved).toBe(false);
    expect(client.dom.window.document.getElementById("publish-busy")?.hidden).toBe(true);
    expect(client.dom.window.document.getElementById("publish-form")?.hidden).toBe(false);

    await client.pumpHost();
    (client.dom.window.document.getElementById("publish") as HTMLButtonElement).click();
    await client.flushInbound();
    expect(initialResolved).toBe(true);
    expect(client.dom.window.document.getElementById("publish-busy")?.hidden).toBe(true);
    await client.pumpHost();
    expect(client.dom.window.document.getElementById("publish-busy")?.hidden).toBe(false);
    await expect(initial).resolves.toMatchObject({ runId: "run-a" });

    let retryResolved = false;
    const retry = flow.presentRetry("run-a").then((result) => {
      retryResolved = true;
      return result;
    });
    await client.pumpHost();
    await refreshAheadOfClient();
    (client.dom.window.document.getElementById("cancel") as HTMLButtonElement).click();
    await client.flushInbound();
    expect(retryResolved).toBe(false);
    expect(client.dom.window.document.getElementById("publish-form")?.hidden).toBe(false);

    await client.pumpHost();
    (client.dom.window.document.getElementById("cancel") as HTMLButtonElement).click();
    await client.flushInbound();
    expect(retryResolved).toBe(true);
    expect(client.dom.window.document.getElementById("publish-form")?.hidden).toBe(false);
    await client.pumpHost();
    await expect(retry).resolves.toBeUndefined();
    expect(client.dom.window.document.getElementById("publish-idle")?.hidden).toBe(false);
    expect(client.dom.window.document.getElementById("publish-form")?.hidden).toBe(true);
    expect(attachPending).toHaveBeenCalledOnce();
    runsChanged.dispose();
  });

  it("routes a push message to pushText with the scenario id and key, without re-rendering", async () => {
    const pushText = vi.fn();
    const { panel } = await openReady({ pushText });
    const before = posted(panel).length;

    await receive(panel, { surface: "board", type: "pushText", scenario: "id-add", key: "CALC-1" });

    expect(pushText).toHaveBeenCalledWith("id-add", "CALC-1");
    expect(posted(panel)).toHaveLength(before);
  });

  it("ignores a repeat unlink for a row already in flight, but not one for another key, and re-arms once it settles", async () => {
    const settlers: Array<() => void> = [];
    const applyUnlink = vi.fn(() => new Promise<void>((resolve) => settlers.push(resolve)));
    const { panel } = await openReady({ applyUnlink });
    const unlink = (key: string): Promise<void> => receive(panel, { surface: "board", type: "unlink", scenario: "id-add", key });

    await unlink("CALC-1");
    await unlink("CALC-1");
    expect(applyUnlink).toHaveBeenCalledOnce();

    await unlink("CALC-2");
    expect(applyUnlink).toHaveBeenCalledTimes(2);

    for (const settle of settlers) {
      settle();
    }
    await new Promise((resolve) => setTimeout(resolve, 0));
    await unlink("CALC-1");

    expect(applyUnlink).toHaveBeenCalledTimes(3);
  });

  it("posts no render on a drop; the snapshot rebuild drives the next render, so a stale drop leaves the board untouched", async () => {
    const applyDrop = vi.fn(() => Promise.resolve());
    const { panel } = await openReady({ applyDrop });

    const before = posted(panel).length;
    await receive(panel, { surface: "board", type: "drop", scenario: "gone:1", key: "GONE-1" });

    expect(applyDrop).toHaveBeenCalledOnce();
    expect(posted(panel)).toHaveLength(before);
  });

  it("activates the tab the shell is told to switch to on a tab message", async () => {
    const { panel } = await openReady();

    await receive(panel, { type: "tab", tab: "matrix" });

    expect(lastActivate(panel)).toBe("matrix");
  });

  // The publish flow's way of landing the user on the row it just wrote.
  it("brings the Executions tab forward on showExecutions", async () => {
    const { instance, panel } = await openReady();

    instance.showExecutions();

    expect(lastActivate(panel)).toBe("executions");
  });

  it("keeps the query across a search after a tab switch", async () => {
    const { panel } = await openReady();

    await receive(panel, { type: "tab", tab: "executions" });
    await receive(panel, { surface: "board", type: "search", value: "CALC" });

    expect(lastActivate(panel)).toBe("executions");
    expect(lastRender(panel)!.mapped.map((t) => t.key)).toEqual(["CALC-1"]);
  });

  it("rebuilds the model and re-renders on a snapshot-change event", async () => {
    let current = MODEL;
    const changes = new vscode.EventEmitter<void>();
    const { panel } = await openReady({ buildModel: () => current, onDidChange: changes.event });

    current = { ...MODEL, available: [{ key: "NEW-1", pills: [], links: [] }], mapped: [], matrix: [] };
    changes.fire();

    expect(lastRender(panel)!.available.map((t) => t.key)).toEqual(["NEW-1"]);
    expect(lastRender(panel)!.mapped).toEqual([]);
  });

  it("carries the project scope selector in the shell header", () => {
    BoardPanel.open(deps());
    expect(win.__webviewPanels[0]!.webview.html).toContain('id="scope-select"');
  });

  it("posts the scope options, the selection, and the scoped flag, starting on All Projects", async () => {
    const { panel } = await openReady();

    const render = lastRender(panel)!;
    expect(render.projects).toEqual(["CALC", "PAY"]);
    expect(render.project).toBe("");
    expect(render.scoped).toBe(false);
    expect(render.available.map((t) => t.key)).toEqual(["PAY-9"]);
    expect(render.mapped.map((t) => t.key)).toEqual(["CALC-1"]);
  });

  it("narrows the tests and the matrix to the picked project, leaving the scenario cards and executions whole", async () => {
    const { panel } = await openReady();

    await receive(panel, { surface: "board", type: "scope", project: "PAY" });

    const render = lastRender(panel)!;
    expect(render.project).toBe("PAY");
    expect(render.scoped).toBe(true);
    expect(render.available.map((t) => t.key)).toEqual(["PAY-9"]);
    expect(render.mapped).toEqual([]);
    expect(matrixTests(render)).toEqual(["PAY-9"]);
    expect(render.scenarios.map((s) => s.name)).toEqual(["Log in", "Checkout"]);
    expect(render.executions.map((e) => e.key)).toEqual(["XNP-1", "PAY-9"]);
  });

  it("opens on the persisted selection and clears it back to All Projects when the selector is set to All", async () => {
    const { panel } = await openReady({ projectScope: fakeScope("CALC") });
    expect(lastRender(panel)!).toMatchObject({ project: "CALC", scoped: true });
    expect(lastRender(panel)!.available).toEqual([]);

    await receive(panel, { surface: "board", type: "scope", project: "" });

    expect(lastRender(panel)!).toMatchObject({ project: "", scoped: false });
    expect(lastRender(panel)!.available.map((t) => t.key)).toEqual(["PAY-9"]);
  });

  it("falls back to All Projects when a rebuild drops the selected project out of the known list", async () => {
    let projects = PROJECTS;
    const changes = new vscode.EventEmitter<void>();
    const { panel } = await openReady({
      projectScope: fakeScope("PAY"),
      knownProjects: () => projects,
      onDidChange: changes.event,
    });
    expect(lastRender(panel)!.project).toBe("PAY");

    projects = ["CALC"];
    changes.fire();

    expect(lastRender(panel)!).toMatchObject({ projects: ["CALC"], project: "", scoped: false });
    expect(lastRender(panel)!.mapped.map((t) => t.key)).toEqual(["CALC-1"]);
  });

  it("stays on All Projects under the null store, so a board with nowhere to persist cannot be scoped", async () => {
    const { panel } = await openReady({ projectScope: NO_PROJECT_SCOPE });

    await receive(panel, { surface: "board", type: "scope", project: "PAY" });

    expect(lastRender(panel)!).toMatchObject({ project: "", scoped: false });
    expect(lastRender(panel)!.mapped.map((t) => t.key)).toEqual(["CALC-1"]);
    expect(lastRender(panel)!.available.map((t) => t.key)).toEqual(["PAY-9"]);
  });

  it("keeps the search and the scope narrowing together", async () => {
    const { panel } = await openReady();

    await receive(panel, { surface: "board", type: "scope", project: "CALC" });
    await receive(panel, { surface: "board", type: "search", value: "PAY" });

    const render = lastRender(panel)!;
    expect(render.mapped).toEqual([]);
    expect(render.available).toEqual([]);
    expect(render).toMatchObject({ project: "CALC", scoped: true, filtering: true });
  });

  it("carries the compact Create tests action in the mapping pane, and opens with the verb disabled", async () => {
    const { panel } = await openReady();

    expect(panel.webview.html).toContain('id="create-tests"');
    expect(panel.webview.html).toContain('aria-describedby="create-tests-tooltip"');
    expect(panel.webview.html).toContain('id="create-tests-tooltip" class="icon-verb-tooltip-content" role="tooltip">Create tests</span>');
    expect(lastRender(panel)!.createVerb).toEqual({
      label: "Create tests",
      enabled: false,
      hint: "Pick a project in the header to create tests in.",
    });
  });

  it("supplies the shared Mapping action helper from the host selection state", async () => {
    const { panel } = await openReady({ projectScope: fakeScope("CALC") });

    expect(lastRender(panel)!).toMatchObject({
      untracedHelper: "Check the scenarios you want tests for.",
      mappingHelper: "Check tests in CALC.",
    });

    await receive(panel, { surface: "board", type: "select", target: "scenario", id: "id-login", on: true });
    expect(lastRender(panel)!.untracedHelper).toBe("Create 1 test in CALC");

    await receive(panel, { surface: "board", type: "select", target: "test", id: "CALC-1", on: true });
    expect(lastRender(panel)!).toMatchObject({
      mappingHelper: "1 test checked in CALC. Choose a Test Set or Test Plan action.",
    });
  });

  it("marks a checked scenario card selected and clears it again on uncheck", async () => {
    const { panel } = await openReady();
    expect(lastRender(panel)!.scenarios.map((s) => s.selected)).toEqual([false, false]);

    await receive(panel, { surface: "board", type: "select", target: "scenario", id: "id-login", on: true });
    expect(lastRender(panel)!.scenarios.filter((s) => s.selected).map((s) => s.name)).toEqual(["Log in"]);

    await receive(panel, { surface: "board", type: "select", target: "scenario", id: "id-login", on: false });

    expect(lastRender(panel)!.scenarios.every((s) => !s.selected)).toBe(true);
  });

  it("keeps the selection across a scope change, since scenario cards are never scoped away", async () => {
    const { panel } = await openReady();
    await receive(panel, { surface: "board", type: "select", target: "scenario", id: "id-checkout", on: true });

    await receive(panel, { surface: "board", type: "scope", project: "PAY" });

    const render = lastRender(panel)!;
    expect(render.scoped).toBe(true);
    expect(render.scenarios.filter((s) => s.selected).map((s) => s.name)).toEqual(["Checkout"]);
    expect(render.createVerb).toMatchObject({ enabled: true, label: "Create 1 test in PAY" });
  });

  it("keeps a filtered-out card checked, so a search never silently unchecks it", async () => {
    const { panel } = await openReady();
    await receive(panel, { surface: "board", type: "select", target: "scenario", id: "id-login", on: true });

    await receive(panel, { surface: "board", type: "search", value: "cart.feature" });
    expect(lastRender(panel)!.scenarios.map((s) => s.name)).toEqual(["Checkout"]);

    await receive(panel, { surface: "board", type: "search", value: "" });

    expect(lastRender(panel)!.scenarios.filter((s) => s.selected).map((s) => s.name)).toEqual(["Log in"]);
  });

  it("prunes a checked card the rebuild dropped, so a created-and-tagged scenario leaves the selection", async () => {
    let current = MODEL;
    const changes = new vscode.EventEmitter<void>();
    const { panel } = await openReady({ buildModel: () => current, onDidChange: changes.event });
    await receive(panel, { surface: "board", type: "select", target: "scenario", id: "id-login", on: true });
    await receive(panel, { surface: "board", type: "select", target: "scenario", id: "id-checkout", on: true });
    await receive(panel, { surface: "board", type: "scope", project: "CALC" });
    expect(lastRender(panel)!.createVerb.label).toBe("Create 2 tests in CALC");

    current = { ...MODEL, scenarios: MODEL.scenarios.filter((card) => card.dropId !== "id-login") };
    changes.fire();

    const render = lastRender(panel)!;
    expect(render.scenarios.map((s) => s.name)).toEqual(["Checkout"]);
    expect(render.createVerb.label).toBe("Create 1 test in CALC");
  });

  it("disables the create verb with a pick-a-project hint under All Projects, even with cards checked", async () => {
    const { panel } = await openReady();

    await receive(panel, { surface: "board", type: "select", target: "scenario", id: "id-login", on: true });

    const render = lastRender(panel)!;
    expect(render.scoped).toBe(false);
    expect(render.createVerb.enabled).toBe(false);
    expect(render.createVerb.hint).toContain("Pick a project");
  });

  it("disables the create verb under a project with nothing checked", async () => {
    const { panel } = await openReady({ projectScope: fakeScope("CALC") });

    expect(lastRender(panel)!.createVerb).toMatchObject({ label: "Create tests", enabled: false });
    expect(lastRender(panel)!.createVerb.hint).toContain("Check the scenarios");
  });

  it("routes the Create tests button to bulkCreate without re-rendering the board", async () => {
    const bulkCreate = vi.fn();
    const { panel } = await openReady({ bulkCreate, projectScope: fakeScope("CALC") });
    await receive(panel, { surface: "board", type: "select", target: "scenario", id: "id-login", on: true });
    const before = posted(panel).length;

    await receive(panel, { surface: "board", type: "bulkCreate" });

    expect(bulkCreate).toHaveBeenCalledOnce();
    expect(posted(panel)).toHaveLength(before);
  });

  it("carries matching compact Mapping actions with unique ids and semantic tooltips", async () => {
    const { panel } = await openReady();

    expect(panel.webview.html).toContain('id="create-tests"');
    for (const section of ["available", "mapped"]) {
      expect(panel.webview.html).toContain(`id="${section}-create-test-set"`);
      expect(panel.webview.html).toContain(`id="${section}-add-to-test-set"`);
      expect(panel.webview.html).toContain(`id="${section}-create-test-plan"`);
      expect(panel.webview.html).toContain(`id="${section}-add-to-test-plan"`);
    }
    expect(panel.webview.html).toContain('<input id="available-select-all" class="select-all" type="checkbox" disabled aria-label="Select all available Xray tests" aria-controls="available-cards">');
    expect(panel.webview.html).toContain('<input id="mapped-select-all" class="select-all" type="checkbox" disabled aria-label="Select all mapped Xray tests" aria-controls="mapped-cards">');
    expect(panel.webview.html).toContain(".board-pane .select-all { flex: none; align-self: center; }");
    expect(panel.webview.html).toContain('aria-label="Test Set actions"');
    expect(panel.webview.html).toContain('aria-label="Test Plan actions"');
    expect(panel.webview.html).toContain('class="mapping-action-controls"');
    expect(panel.webview.html).toContain('id="scenario-action-helper" class="mapping-action-helper"');
    expect(panel.webview.html).toContain('id="available-action-helper" class="mapping-action-helper" data-mapping-helper');
    expect(panel.webview.html).toContain('id="mapped-action-helper" class="mapping-action-helper" data-mapping-helper');
    expect(panel.webview.html).toContain('class="icon-verb-tooltip"><button id="available-create-test-set"');
    expect(panel.webview.html).toContain('aria-describedby="available-create-test-set-tooltip"');
    expect(panel.webview.html).toContain('id="available-create-test-set-tooltip" class="icon-verb-tooltip-content" role="tooltip">Create Test Set</span>');
    expect(panel.webview.html).toContain('class="verb icon-verb"');
    expect(panel.webview.html).toContain('<svg viewBox="0 0 17 16" aria-hidden="true"');
    expect(panel.webview.html).toContain('M4 7.5l1.6 1.6L8.5 6M13 9v5M10.5 11.5h5');
    expect(panel.webview.html).toContain(".board-pane .icon-verb:disabled { pointer-events: none; }");
    expect(panel.webview.html).toContain(".board-pane .icon-verb-tooltip:hover .icon-verb-tooltip-content, .board-pane .icon-verb-tooltip:focus-within .icon-verb-tooltip-content { visibility: visible; opacity: 1; }");
    expect(panel.webview.html).toContain(".board-pane .verbs { position: relative;");
    expect(panel.webview.html).toContain("top: calc(100% + 0.35rem); left: 0; box-sizing: border-box; width: max-content; max-width: min(100%, calc(100vw - 2rem));");
    expect(panel.webview.html).toContain(".board-pane .container-actions { flex-basis: 100%; }");
    expect(panel.webview.html).toContain(".board-pane .mapping-action-helper { flex: 1 1 10rem;");
    expect(panel.webview.html).toContain("overflow-wrap: anywhere;");
    expect(panel.webview.html).toContain(".board-pane .mapping-actions { flex-direction: column; align-items: stretch; }");
    expect(panel.webview.html).not.toContain('id="run-selected"');
    expect(panel.webview.html).not.toContain('Run and publish selected');
    expect(panel.webview.html).not.toContain('title="Create Test Set"');
    expect(lastRender(panel)!.testSetVerb).toEqual({
      label: "Create Test Set",
      enabled: false,
      hint: "Pick a project in the header to create a Test Set in.",
    });
    expect(lastRender(panel)!.testPlanVerb).toEqual({
      label: "Create Test Plan",
      enabled: false,
      hint: "Pick a project in the header to create a Test Plan in.",
    });
    expect(lastRender(panel)!.addToTestSetVerb).toEqual({
      label: "Add to existing Test Set",
      enabled: false,
      hint: "Pick a project in the header to choose a Test Set.",
    });
    expect(lastRender(panel)!.addToTestPlanVerb).toEqual({
      label: "Add to existing Test Plan",
      enabled: false,
      hint: "Pick a project in the header to choose a Test Plan.",
    });
  });

  it("shares checked-test enablement between available and mapped cards", async () => {
    const model = { ...MODEL, available: [{ ...MODEL.available[0]!, key: "CALC-2", project: "CALC" }] };
    const { panel } = await openReady({ buildModel: () => model, projectScope: fakeScope("CALC") });
    expect(lastRender(panel)!.available.map((t) => t.selected)).toEqual([false]);
    expect(lastRender(panel)!.mapped.map((t) => t.selected)).toEqual([false]);

    await receive(panel, { surface: "board", type: "select", target: "test", id: "CALC-2", on: true });
    expect(lastRender(panel)!.testSetVerb).toMatchObject({ enabled: true, label: "Create Test Set from 1 test" });
    await receive(panel, { surface: "board", type: "select", target: "test", id: "CALC-1", on: true });
    expect(lastRender(panel)!.available.map((t) => t.selected)).toEqual([true]);
    expect(lastRender(panel)!.mapped.map((t) => t.selected)).toEqual([true]);
    expect(lastRender(panel)!.addToTestPlanVerb).toMatchObject({ enabled: true, label: "Add to existing Test Plan with 2 tests" });

    await receive(panel, { surface: "board", type: "select", target: "test", id: "CALC-1", on: false });

    expect(lastRender(panel)!.available.map((t) => t.selected)).toEqual([true]);
    expect(lastRender(panel)!.mapped.map((t) => t.selected)).toEqual([false]);
  });

  it("keeps the two selections apart, so checking a test never touches the scenario verb", async () => {
    const { panel } = await openReady({ projectScope: fakeScope("CALC") });

    await receive(panel, { surface: "board", type: "select", target: "test", id: "CALC-1", on: true });

    const render = lastRender(panel)!;
    expect(render.scenarios.every((s) => !s.selected)).toBe(true);
    expect(render.createVerb).toMatchObject({ label: "Create tests", enabled: false });
    expect(render.testSetVerb).toMatchObject({ label: "Create Test Set from 1 test", enabled: true });
    expect(render.addToTestSetVerb).toMatchObject({ label: "Add to existing Test Set with 1 test", enabled: true });
    expect(BoardPanel.selectedScenarios()).toEqual([]);
    expect(BoardPanel.selectedTests()).toEqual(["CALC-1"]);
  });

  // A container holds what the checked boxes showed, so a test the new scope hides cannot ride along
  // invisibly in the confirm's count. Scenario cards are unscoped, so their selection is untouched by
  // the same move.
  it("drops a checked test the scope hides, while the scenario selection survives", async () => {
    const { panel } = await openReady({ projectScope: fakeScope("CALC") });
    await receive(panel, { surface: "board", type: "select", target: "test", id: "CALC-1", on: true });
    await receive(panel, { surface: "board", type: "select", target: "scenario", id: "id-checkout", on: true });
    expect(lastRender(panel)!.testSetVerb.label).toBe("Create Test Set from 1 test");

    await receive(panel, { surface: "board", type: "scope", project: "PAY" });

    const render = lastRender(panel)!;
    expect(render.mapped).toEqual([]);
    expect(render.testSetVerb).toEqual({
      label: "Create Test Set",
      enabled: false,
      hint: "Check the tests you want in the Test Set.",
    });
    expect(render.testPlanVerb.enabled).toBe(false);
    expect(render.addToTestPlanVerb.enabled).toBe(false);
    expect(BoardPanel.selectedTests()).toEqual([]);
    expect(render.scenarios.filter((s) => s.selected).map((s) => s.name)).toEqual(["Checkout"]);
    expect(BoardPanel.selectedScenarios()).toEqual(["id-checkout"]);
  });

  it("prunes a checked test the rebuild dropped, counting only what the model still carries", async () => {
    let current = MODEL;
    const changes = new vscode.EventEmitter<void>();
    const { panel } = await openReady({ buildModel: () => current, onDidChange: changes.event });
    await receive(panel, { surface: "board", type: "select", target: "test", id: "PAY-9", on: true });
    await receive(panel, { surface: "board", type: "select", target: "test", id: "CALC-1", on: true });
    await receive(panel, { surface: "board", type: "scope", project: "CALC" });
    expect(lastRender(panel)!.testSetVerb.label).toBe("Create Test Set from 1 test");

    current = { ...MODEL, mapped: [] };
    changes.fire();

    expect(lastRender(panel)!.testSetVerb).toMatchObject({ label: "Create Test Set", enabled: false });
    expect(BoardPanel.selectedTests()).toEqual([]);
  });

  it("keeps a checked test checked when only the search hides its card", async () => {
    const { panel } = await openReady({ projectScope: fakeScope("CALC") });
    await receive(panel, { surface: "board", type: "select", target: "test", id: "CALC-1", on: true });

    await receive(panel, { surface: "board", type: "search", value: "nothing matches this" });
    expect(lastRender(panel)!.mapped).toEqual([]);

    await receive(panel, { surface: "board", type: "search", value: "" });

    expect(lastRender(panel)!.mapped.map((t) => t.selected)).toEqual([true]);
    expect(BoardPanel.selectedTests()).toEqual(["CALC-1"]);
  });

  // The select-all covers the list's whole filtered set, so a row the paginator is not showing is checked
  // by the same click as the visible ones, and a test outside the list is left alone.
  it("checks every test the list's filter leaves, page or no page", async () => {
    const { panel } = await openReady({
      buildModel: () => LISTS,
      projectScope: fakeScope("CALC"),
      mappingPageSize: { get: () => 1, set: () => undefined },
    });
    await receive(panel, { surface: "board", type: "select", target: "test", id: "CALC-1", on: true });
    await receive(panel, { surface: "board", type: "columnSearch", section: "available", value: "login" });

    await receive(panel, { surface: "board", type: "select-scope", section: "available", on: true });

    expect(BoardPanel.selectedTests()).toEqual(["CALC-1", "CALC-10", "CALC-11"]);
    expect(lastRender(panel)!.available.map((t) => t.key)).toEqual(["CALC-10"]);
    expect(lastRender(panel)!.sections.available).toMatchObject({ filtered: 2, selection: "all" });
  });

  it("clears only what the list's filter leaves, so a checked test outside it survives", async () => {
    const { panel } = await openReady({ buildModel: () => LISTS, projectScope: fakeScope("CALC") });
    await receive(panel, { surface: "board", type: "select-scope", section: "available", on: true });
    expect(BoardPanel.selectedTests()).toEqual(["CALC-10", "CALC-11", "CALC-12"]);

    await receive(panel, { surface: "board", type: "columnSearch", section: "available", value: "login" });
    await receive(panel, { surface: "board", type: "select-scope", section: "available", on: false });

    expect(BoardPanel.selectedTests()).toEqual(["CALC-12"]);
    expect(lastRender(panel)!.sections.available).toMatchObject({ filtered: 2, selection: "none" });
  });

  it("reads each list's select-all state from that list's own filtered set", async () => {
    const { panel } = await openReady({ buildModel: () => LISTS, projectScope: fakeScope("CALC") });
    const sections = (): RenderMessage["sections"] => lastRender(panel)!.sections;
    expect(sections().available.selection).toBe("none");
    expect(sections().mapped.selection).toBe("none");

    await receive(panel, { surface: "board", type: "select", target: "test", id: "CALC-10", on: true });
    expect(sections().available.selection).toBe("some");

    await receive(panel, { surface: "board", type: "select-scope", section: "mapped", on: true });
    expect(sections().mapped.selection).toBe("all");
    expect(sections().available.selection).toBe("some");

    await receive(panel, { surface: "board", type: "columnSearch", section: "available", value: "CALC-10" });
    expect(sections().available).toMatchObject({ filtered: 1, selection: "all" });

    await receive(panel, { surface: "board", type: "columnSearch", section: "available", value: "nothing matches" });
    expect(sections().available).toMatchObject({ filtered: 0, selection: "none" });
  });

  it("disables both container verbs under a project with no test checked", async () => {
    const { panel } = await openReady({ projectScope: fakeScope("CALC") });

    expect(lastRender(panel)!.testSetVerb).toEqual({
      label: "Create Test Set",
      enabled: false,
      hint: "Check the tests you want in the Test Set.",
    });
    expect(lastRender(panel)!.testPlanVerb.hint).toBe("Check the tests you want in the Test Plan.");
    expect(lastRender(panel)!.addToTestSetVerb.hint).toBe("Check the tests you want to add to a Test Set.");
  });

  it("disables both container verbs with a pick-a-project hint under All Projects, even with tests checked", async () => {
    const { panel } = await openReady();

    await receive(panel, { surface: "board", type: "select", target: "test", id: "CALC-1", on: true });

    const render = lastRender(panel)!;
    expect(render.scoped).toBe(false);
    expect(render.testSetVerb).toMatchObject({ enabled: false, label: "Create Test Set" });
    expect(render.testPlanVerb.hint).toContain("Pick a project");
    expect(render.addToTestSetVerb.hint).toContain("Pick a project");
  });

  it("routes the four container buttons to their commands without re-rendering the board", async () => {
    const createTestSet = vi.fn();
    const addToTestSet = vi.fn();
    const createTestPlan = vi.fn();
    const addToTestPlan = vi.fn();
    const { panel } = await openReady({
      createTestSet,
      addToTestSet,
      createTestPlan,
      addToTestPlan,
      projectScope: fakeScope("CALC"),
    });
    await receive(panel, { surface: "board", type: "select", target: "test", id: "CALC-1", on: true });
    const before = posted(panel).length;

    await receive(panel, { surface: "board", type: "createTestSet" });
    await receive(panel, { surface: "board", type: "addToTestSet" });
    await receive(panel, { surface: "board", type: "createTestPlan" });
    await receive(panel, { surface: "board", type: "addToTestPlan" });

    expect(createTestSet).toHaveBeenCalledOnce();
    expect(addToTestSet).toHaveBeenCalledOnce();
    expect(createTestPlan).toHaveBeenCalledOnce();
    expect(addToTestPlan).toHaveBeenCalledOnce();
    expect(posted(panel)).toHaveLength(before);
  });

  // The router dispatches by message type, so an unrouted type must be a no-op rather than a throw out of
  // the message handler, and a prototype name must not resolve to something callable.
  it("ignores a message type it has no route for, repainting nothing", async () => {
    const bulkCreate = vi.fn();
    const { panel } = await openReady({ bulkCreate });
    const before = posted(panel).length;

    await receive(panel, { surface: "board", type: "bogus" });
    await receive(panel, { surface: "board", type: "toString" });
    await receive(panel, { surface: "board", type: "constructor" });

    expect(posted(panel)).toHaveLength(before);
    expect(bulkCreate).not.toHaveBeenCalled();
  });

  it("carries the Create Execution button on the Executions pane, disabled under All Projects", async () => {
    const { panel } = await openReady();

    expect(panel.webview.html).toContain('id="create-execution"');
    expect(lastRender(panel)!.executionVerb).toEqual({
      label: "Create Execution",
      enabled: false,
      hint: "Pick a project in the header to create an execution in.",
    });
  });

  // An empty execution needs no tests, so the scope is the whole of the verb's state: it is live with a
  // project picked and nothing checked anywhere.
  it("enables the execution verb on a scoped board with no selection at all", async () => {
    const { panel } = await openReady({ projectScope: fakeScope("PAY") });

    const render = lastRender(panel)!;
    expect(render.executionVerb).toEqual({
      label: "Create Execution in PAY",
      enabled: true,
      hint: "Creates an empty Test Execution in PAY for a later publish to append to.",
    });
    expect(render.testSetVerb.enabled).toBe(false);
    expect(BoardPanel.selectedTests()).toEqual([]);
  });

  it("routes the Create Execution button to its command without re-rendering the board", async () => {
    const createTestExecution = vi.fn();
    const { panel } = await openReady({ createTestExecution, projectScope: fakeScope("CALC") });
    const before = posted(panel).length;

    await receive(panel, { surface: "board", type: "createTestExecution" });

    expect(createTestExecution).toHaveBeenCalledOnce();
    expect(posted(panel)).toHaveLength(before);
  });

  it("exposes the checked tests to the container commands, and nothing when no board is open", async () => {
    expect(BoardPanel.selectedTests()).toEqual([]);
    const { instance, panel } = await openReady();

    await receive(panel, { surface: "board", type: "select", target: "test", id: "CALC-1", on: true });
    await receive(panel, { surface: "board", type: "select", target: "test", id: "PAY-9", on: true });
    expect(BoardPanel.selectedTests()).toEqual(["CALC-1", "PAY-9"]);

    instance.dispose();

    expect(BoardPanel.selectedTests()).toEqual([]);
  });

  it("exposes the checked cards to the bulk-create command, and nothing when no board is open", async () => {
    expect(BoardPanel.selectedScenarios()).toEqual([]);
    const { instance, panel } = await openReady();

    await receive(panel, { surface: "board", type: "select", target: "scenario", id: "id-checkout", on: true });
    await receive(panel, { surface: "board", type: "select", target: "scenario", id: "id-login", on: true });
    expect(BoardPanel.selectedScenarios()).toEqual(["id-checkout", "id-login"]);

    instance.dispose();

    expect(BoardPanel.selectedScenarios()).toEqual([]);
  });

  it("opens every mapping section on its first page at the stored size, with no column query", async () => {
    const { panel } = await openReady();

    const render = lastRender(panel)!;
    expect(render.pageSize).toBe(50);
    expect(render.sections).toEqual({
      untraced: { total: 2, filtered: 2, page: 0, pageCount: 1, pageSize: 50, filtering: false, query: "", selection: "none" },
      available: { total: 1, filtered: 1, page: 0, pageCount: 1, pageSize: 50, filtering: false, query: "", selection: "none" },
      mapped: { total: 1, filtered: 1, page: 0, pageCount: 1, pageSize: 50, filtering: false, query: "", selection: "none" },
    });
  });

  // The bug the per-column searches exist for: the header search hid the scenario the user was dragging
  // from while they hunted for its target.
  it("filters only the section a column search names, leaving the other two put", async () => {
    const { panel } = await openReady();

    await receive(panel, { surface: "board", type: "columnSearch", section: "untraced", value: "Log in" });

    const render = lastRender(panel)!;
    expect(render.scenarios.map((s) => s.name)).toEqual(["Log in"]);
    expect(render.available.map((t) => t.key)).toEqual(["PAY-9"]);
    expect(render.mapped.map((t) => t.key)).toEqual(["CALC-1"]);
    expect(render.filtering).toBe(false);
    expect(render.sections.untraced).toMatchObject({ total: 2, filtered: 1, filtering: true, query: "Log in" });
    expect(render.sections.available).toMatchObject({ total: 1, filtered: 1, filtering: false, query: "" });
    expect(render.sections.mapped).toMatchObject({ total: 1, filtered: 1, filtering: false, query: "" });
  });

  it("matches a test column on key or summary, each test group on its own query", async () => {
    const { panel } = await openReady();

    await receive(panel, { surface: "board", type: "columnSearch", section: "available", value: "pay-9" });
    await receive(panel, { surface: "board", type: "columnSearch", section: "mapped", value: "add two" });
    expect(lastRender(panel)!.available.map((t) => t.key)).toEqual(["PAY-9"]);
    expect(lastRender(panel)!.mapped.map((t) => t.key)).toEqual(["CALC-1"]);

    await receive(panel, { surface: "board", type: "columnSearch", section: "mapped", value: "PAY" });

    const render = lastRender(panel)!;
    expect(render.mapped).toEqual([]);
    expect(render.available.map((t) => t.key)).toEqual(["PAY-9"]);
    expect(render.sections.mapped).toMatchObject({ total: 1, filtered: 0, filtering: true, query: "PAY" });
  });

  it("composes the header search with a column search, counting a section before its own query", async () => {
    const { panel } = await openReady();

    await receive(panel, { surface: "board", type: "search", value: "Checkout" });

    const header = lastRender(panel)!;
    expect(header.sections.untraced).toMatchObject({ total: 1, filtered: 1, filtering: true, query: "" });
    expect(header.sections.available).toMatchObject({ total: 0, filtered: 0, filtering: true, query: "" });

    await receive(panel, { surface: "board", type: "columnSearch", section: "untraced", value: "Log in" });

    const both = lastRender(panel)!;
    expect(both.scenarios).toEqual([]);
    expect(both.sections.untraced).toMatchObject({ total: 1, filtered: 0, filtering: true, query: "Log in" });
  });

  it("steps a paginator from the host's own index and clamps it at both ends", async () => {
    const { panel } = await openReady({ buildModel: () => manyScenarios(60) });
    await receive(panel, { surface: "board", type: "pageSize", size: 25 });
    const untraced = (): BoardSectionMeta => lastRender(panel)!.sections.untraced;
    expect(untraced()).toMatchObject({ total: 60, filtered: 60, page: 0, pageCount: 3, pageSize: 25 });
    expect(lastRender(panel)!.scenarios).toHaveLength(25);

    await receive(panel, { surface: "board", type: "page", section: "untraced", step: "prev" });
    expect(untraced().page).toBe(0);

    await receive(panel, { surface: "board", type: "page", section: "untraced", step: "next" });
    expect(untraced().page).toBe(1);
    expect(lastRender(panel)!.scenarios[0]!.name).toBe("Scenario 26");

    await receive(panel, { surface: "board", type: "page", section: "untraced", step: "next" });
    await receive(panel, { surface: "board", type: "page", section: "untraced", step: "next" });
    expect(untraced().page).toBe(2);
    expect(lastRender(panel)!.scenarios).toHaveLength(10);

    await receive(panel, { surface: "board", type: "page", section: "untraced", step: "prev" });
    expect(untraced().page).toBe(1);
  });

  it("re-renders on every mapping control and moves only the section the message names", async () => {
    const { panel } = await openReady({ buildModel: () => manyScenarios(60) });
    await receive(panel, { surface: "board", type: "pageSize", size: 25 });
    const renders = (): number => posted(panel).filter(isRender).length;
    const before = renders();

    await receive(panel, { surface: "board", type: "columnSearch", section: "available", value: "PAY" });
    await receive(panel, { surface: "board", type: "page", section: "untraced", step: "next" });

    expect(renders()).toBe(before + 2);
    const render = lastRender(panel)!;
    expect(render.sections.untraced).toMatchObject({ page: 1, query: "" });
    expect(render.sections.available).toMatchObject({ page: 0, query: "PAY" });
    expect(render.sections.mapped).toMatchObject({ page: 0, query: "" });
  });

  it("persists a page-size change and sends every section back to its first page", async () => {
    const state = memento();
    const { panel } = await openReady({
      buildModel: () => manyScenarios(60),
      mappingPageSize: mappingPageSizeStore(state, () => undefined),
    });
    await receive(panel, { surface: "board", type: "pageSize", size: 25 });
    await receive(panel, { surface: "board", type: "page", section: "untraced", step: "next" });
    expect(lastRender(panel)!.sections.untraced.page).toBe(1);

    await receive(panel, { surface: "board", type: "pageSize", size: 100 });

    expect(state.values[PAGE_SIZE_KEY]).toBe(100);
    const render = lastRender(panel)!;
    expect(render.pageSize).toBe(100);
    expect(render.sections.untraced).toMatchObject({ page: 0, pageCount: 1, pageSize: 100 });
  });

  it("sends every paginator back to the first page on a global search or a scope change, but a column search resets only its own section", async () => {
    const { panel } = await openReady({ buildModel: () => manyScenarios(60) });
    await receive(panel, { surface: "board", type: "pageSize", size: 25 });
    const toSecondPage = async (): Promise<void> => {
      await receive(panel, { surface: "board", type: "page", section: "untraced", step: "next" });
      expect(lastRender(panel)!.sections.untraced.page).toBe(1);
    };

    await toSecondPage();
    await receive(panel, { surface: "board", type: "search", value: "many.feature" });
    expect(lastRender(panel)!.sections.untraced.page).toBe(0);

    await toSecondPage();
    await receive(panel, { surface: "board", type: "columnSearch", section: "mapped", value: "CALC" });
    expect(lastRender(panel)!.sections.untraced.page).toBe(1);

    await receive(panel, { surface: "board", type: "scope", project: "PAY" });
    expect(lastRender(panel)!.sections.untraced.page).toBe(0);
  });

  // A clamp that lived only in the render would put the board back on the page it could not reach as soon
  // as the section grew again.
  it("adopts the clamped page, so a section that shrinks and grows again stays where the clamp left it", async () => {
    let current = manyScenarios(60);
    const changes = new vscode.EventEmitter<void>();
    const { panel } = await openReady({ buildModel: () => current, onDidChange: changes.event });
    await receive(panel, { surface: "board", type: "pageSize", size: 25 });
    await receive(panel, { surface: "board", type: "page", section: "untraced", step: "next" });
    await receive(panel, { surface: "board", type: "page", section: "untraced", step: "next" });
    expect(lastRender(panel)!.sections.untraced.page).toBe(2);

    current = manyScenarios(30);
    changes.fire();
    expect(lastRender(panel)!.sections.untraced).toMatchObject({ page: 1, pageCount: 2 });

    current = manyScenarios(60);
    changes.fire();

    expect(lastRender(panel)!.sections.untraced).toMatchObject({ page: 1, pageCount: 3 });
  });

  // The rebuilt document brings back empty search boxes and every paginator on page 1; the page size is
  // the one piece of this state that persists.
  it("drops the column queries and the paginator positions when the webview comes back", async () => {
    const { panel } = await openReady({ buildModel: () => manyScenarios(60) });
    await receive(panel, { surface: "board", type: "pageSize", size: 25 });
    await receive(panel, { surface: "board", type: "columnSearch", section: "untraced", value: "Scenario" });
    await receive(panel, { surface: "board", type: "columnSearch", section: "mapped", value: "CALC" });
    await receive(panel, { surface: "board", type: "page", section: "untraced", step: "next" });
    expect(lastRender(panel)!.sections.untraced).toMatchObject({ page: 1, query: "Scenario" });

    await receive(panel, { type: "ready" });

    const render = lastRender(panel)!;
    expect(render.sections.untraced).toMatchObject({ page: 0, query: "", filtering: false });
    expect(render.sections.mapped).toMatchObject({ page: 0, query: "", filtering: false });
    expect(render.pageSize).toBe(25);
  });

  it("keeps a checked card checked off the page and behind a column search, counting it in the verb", async () => {
    const { panel } = await openReady({ buildModel: () => manyScenarios(60), projectScope: fakeScope("CALC") });
    await receive(panel, { surface: "board", type: "pageSize", size: 25 });
    await receive(panel, { surface: "board", type: "select", target: "scenario", id: "id-1", on: true });
    expect(lastRender(panel)!.scenarios.filter((s) => s.selected).map((s) => s.name)).toEqual(["Scenario 1"]);

    await receive(panel, { surface: "board", type: "page", section: "untraced", step: "next" });

    const offPage = lastRender(panel)!;
    expect(offPage.scenarios.every((s) => !s.selected)).toBe(true);
    expect(offPage.createVerb).toMatchObject({ enabled: true, label: "Create 1 test in CALC" });

    await receive(panel, { surface: "board", type: "columnSearch", section: "untraced", value: "Scenario 60" });

    expect(lastRender(panel)!.scenarios.map((s) => s.name)).toEqual(["Scenario 60"]);
    expect(lastRender(panel)!.createVerb.label).toBe("Create 1 test in CALC");
    expect(BoardPanel.selectedScenarios()).toEqual(["id-1"]);
  });

  it("clears the singleton on dispose and stops posting; dispose is idempotent", async () => {
    const { instance, panel } = await openReady();

    instance.dispose();
    const postedCount = posted(panel).length;
    await receive(panel, { surface: "board", type: "search", value: "x" });

    expect(posted(panel)).toHaveLength(postedCount);
    expect(() => instance.dispose()).not.toThrow();
    // A fresh open now creates a new panel rather than revealing the disposed one.
    BoardPanel.open(deps());
    expect(win.__webviewPanels).toHaveLength(2);
  });

  // The publish flow's cancellation seam: a close means stop, and a flow that finished first must stop
  // holding the panel, since the panel outlives every one of them.
  it("fires a dispose handler on close, drops it once its subscription is disposed, and carries none to a reopen", async () => {
    const fired: string[] = [];
    const { instance, panel } = await openReady();

    instance.onDidDispose(() => fired.push("kept"));
    instance.onDidDispose(() => fired.push("released")).dispose();
    panel.dispose();

    expect(fired).toEqual(["kept"]);

    BoardPanel.open(deps()).dispose();

    expect(fired).toEqual(["kept"]);
  });
});

// The board is rebuilt from settings, so it has to know which ones it renders: a rebuild per keystroke in
// an unrelated setting would thrash it.
describe("affectsBoard", () => {
  const event = (...changed: string[]): vscode.ConfigurationChangeEvent => ({
    affectsConfiguration: (key: string) => changed.includes(key),
  });

  it("claims the settings a board build reads: its project universe and its site", () => {
    expect(affectsBoard(event("playwrightBddRunner.xray.syncProjectKeys"))).toBe(true);
    expect(affectsBoard(event("playwrightBddRunner.xray.defaultProjectKey"))).toBe(true);
    expect(affectsBoard(event("playwrightBddRunner.xray.siteUrl"))).toBe(true);
  });

  // These are read when a publish runs, not when the board is built, so a rebuild would show nothing new.
  it("leaves the publish-time settings alone", () => {
    expect(affectsBoard(event("playwrightBddRunner.xray.executionIssueType"))).toBe(false);
    expect(affectsBoard(event("playwrightBddRunner.xray.reportGlob"))).toBe(false);
    expect(affectsBoard(event("playwrightBddRunner.xray.attachTo"))).toBe(false);
  });

  it("ignores config noise, including the rest of the extension's own namespace", () => {
    expect(affectsBoard(event())).toBe(false);
    expect(affectsBoard(event("editor.fontSize"))).toBe(false);
    expect(affectsBoard(event("playwrightBddRunner.playwrightCommand"))).toBe(false);
  });
});
