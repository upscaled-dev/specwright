import { describe, it, expect, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import { BoardPanel, BoardPanelDeps } from "../../traceability/board-panel";
import { BoardViewModel, ExecutionRow } from "../../traceability/board-data";
import { NO_PROJECT_SCOPE, ProjectScopeStore } from "../../traceability/project-scope";
import { PublishDialogDelegate } from "../../traceability/publish-dialog-panel";

const noopDelegate: PublishDialogDelegate = {
  searchTargets: () => Promise.resolve([]),
  browseFiles: () => Promise.resolve([]),
  attachPending: () => Promise.resolve({ remaining: 0 }),
};

// The panel drives the real `vscode.window.createWebviewPanel` stub: `__receive` delivers an inbound
// webview message, `webview.__posted` records outbound ones, `__revealCount` counts reveals, and
// `dispose()` fires the onDidDispose seam. The shell routes tagged messages by `surface` and reserves
// the untagged `ready`/`tab`/`activate` shell types; outbound posts are held until the webview signals
// `ready`, then flushed in order. The webview JS carries no decision logic, so it isn't run.
interface StubPanel {
  title: string;
  webview: { html: string; __posted: Posted[] };
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
  matrix: Array<{ requirement: string; test: string; scenario: string; tag: string; result: string }>;
  executions: Array<{ key: string; summary: string }>;
  availableEmptyText: string;
  offerSync: boolean;
  filtering: boolean;
  projects: string[];
  project: string;
  scoped: boolean;
  createVerb: Verb;
  testSetVerb: Verb;
  testPlanVerb: Verb;
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
    { requirement: "REQ-7", test: "CALC-1", scenario: "Checkout", tag: "@TEST_CALC-1", result: "passed", projects: ["CALC"] },
    { requirement: "", test: "PAY-9", scenario: "", tag: "", result: "no coverage", projects: ["PAY"] },
  ],
  availableEmptyText: "No unmapped tests in the last sync.",
  offerSync: false,
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

const EXECUTIONS: ExecutionRow[] = [
  { key: "XNP-1", summary: "Checkout suite", action: "Created", resultsImported: "6", passRate: "5/6 passed", publishedAt: "2026-07-22", timesFromHere: 1 },
  { key: "PAY-9", summary: "Payments", action: "Appended", resultsImported: "-", passRate: "-", publishedAt: "2026-07-20", timesFromHere: 2 },
];

function deps(over: Partial<BoardPanelDeps> = {}): BoardPanelDeps {
  return {
    providerLabel: "Xray",
    buildModel: () => MODEL,
    buildExecutions: () => EXECUTIONS,
    onDidChange: new vscode.EventEmitter<void>().event,
    applyDrop: () => Promise.resolve(),
    applyUnlink: () => Promise.resolve(),
    pushText: () => undefined,
    runSync: () => Promise.resolve(),
    autoSync: () => Promise.resolve(),
    openExecution: () => undefined,
    bulkCreate: () => undefined,
    createTestSet: () => undefined,
    createTestPlan: () => undefined,
    createTestExecution: () => undefined,
    knownProjects: () => PROJECTS,
    projectScope: fakeScope(),
    publishDelegate: noopDelegate,
    startPublish: () => undefined,
    ...over,
  };
}

const isRender = (m: Posted): m is RenderMessage => m.type === "render";
const lastRender = (panel: StubPanel): RenderMessage | undefined =>
  [...panel.webview.__posted].reverse().find(isRender);
const lastActivate = (panel: StubPanel): string | undefined =>
  [...panel.webview.__posted].reverse().find((m): m is ActivateMessage => m.type === "activate")?.tab;

// Open the board and drive the webview `ready` handshake so the shell flushes its queued render and
// activation; subsequent posts then land immediately.
async function openReady(over: Partial<BoardPanelDeps> = {}): Promise<{ instance: BoardPanel; panel: StubPanel }> {
  const instance = BoardPanel.open(deps(over));
  const panel = win.__webviewPanels[0]!;
  await panel.__receive({ type: "ready" });
  return { instance, panel };
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
    expect(panel.webview.html).toContain(
      "Drag a scenario from the left onto a test on the right to link them. An available test can also be dragged onto a scenario."
    );
    expect(panel.webview.html).toContain("Xray tests");
    expect(panel.webview.html).toContain("Requirement");
    expect(panel.webview.html).toContain("Xray test");
    expect(panel.webview.html).toContain("Tag in file");
    expect(panel.webview.html).toContain("Last result");
    expect(panel.webview.html).toContain("Pass rate");
    expect(panel.webview.html).toContain("Publishes from this workspace appear here.");
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
  });

  // Source-level only: the webview JS never runs here, so this pins that the strip ships above the panes
  // (so it shows on any tab) and that a render clears it, not that the rendered bar animates.
  it("carries the sync progress strip above the panes, cleared by every render", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;

    expect(html).toContain('id="sync-strip"');
    expect(html).toContain('id="sync-strip-text"');
    expect(html.indexOf('id="sync-strip"')).toBeLessThan(html.indexOf("<main>"));
    expect(html).toContain("renderSyncProgress('')");
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

  it("skins every board button with the one verb class, each inside a verbs row", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;

    expect(html.split('class="verb"').length - 1).toBe(4);
    expect(html).not.toContain('class="create-tests"');
    expect(html.split('<div class="verbs">').length - 1).toBe(3);
  });

  // Both card renderers skip the pills row when there is nothing to put in it, which is most scenario
  // cards now that the constant "no tag" pill is gone.
  it("paints a pills row only when a card has pills", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;

    expect(html.split("if (card.pills.length > 0)").length - 1).toBe(2);
  });

  it("acquires the vscode api exactly once (the router owns the single acquireVsCodeApi)", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;
    expect(html.split("acquireVsCodeApi()").length - 1).toBe(1);
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

    await panel.__receive({ type: "tab", tab: "publish" });

    expect(lastActivate(panel)).toBe("publish");
    expect(startPublish).toHaveBeenCalledOnce();
  });

  it("does not re-fire startPublish while a publish is already being presented", async () => {
    const startPublish = vi.fn();
    const { instance, panel } = await openReady({ startPublish });

    void instance.publish.present({
      title: "Publish run results",
      runs: [],
      selectedRunId: "",
      jiraSearchAvailable: false,
      knownProjectKeys: [],
      attachments: { available: false, suggestions: [], uploadLimitBytes: 0, evidenceStream: "evidence" },
    });
    await panel.__receive({ type: "tab", tab: "publish" });

    expect(startPublish).not.toHaveBeenCalled();
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

    await panel.__receive({ type: "ready" });

    expect(lastRender(panel)).toBeDefined();
    expect(panel.webview.__posted.filter(isRender)).toHaveLength(1);
    expect(panel.webview.__posted.filter((m) => m.type === "activate")).toHaveLength(1);
  });

  // VS Code rebuilds the webview's DOM on a window reload or a move between editor groups, and that
  // fresh document opens with every pane hidden and nothing painted in it.
  it("re-activates the current tab and re-renders from a fresh model when a rebuilt webview readies again", async () => {
    let current = MODEL;
    const { panel } = await openReady({ buildModel: () => current });
    await panel.__receive({ type: "tab", tab: "matrix" });
    current = { ...MODEL, available: [{ key: "NEW-1", pills: [], links: [] }] };
    const before = panel.webview.__posted.length;

    await panel.__receive({ type: "ready" });

    const rehydration = panel.webview.__posted.slice(before);
    expect(rehydration.filter((m): m is ActivateMessage => m.type === "activate").map((m) => m.tab)).toEqual(["matrix"]);
    expect(rehydration.filter(isRender)).toHaveLength(1);
    expect(lastRender(panel)!.available.map((t) => t.key)).toEqual(["NEW-1"]);
  });

  // The rebuilt document brings back an empty search box, so a query kept host-side would narrow the
  // board against a filter nothing on screen still shows.
  it("drops the search query when the webview comes back", async () => {
    const { panel } = await openReady();
    await panel.__receive({ surface: "board", type: "search", value: "cart.feature" });
    expect(lastRender(panel)!.scenarios.map((s) => s.name)).toEqual(["Checkout"]);

    await panel.__receive({ type: "ready" });

    expect(lastRender(panel)!.filtering).toBe(false);
    expect(lastRender(panel)!.scenarios.map((s) => s.name)).toEqual(["Log in", "Checkout"]);
  });

  it("re-posts the run of a publish still awaiting its answer when the webview comes back", async () => {
    const { instance, panel } = await openReady();
    void instance.publish.present({
      title: "Publish run results",
      runs: [],
      selectedRunId: "",
      jiraSearchAvailable: false,
      knownProjectKeys: [],
      attachments: { available: false, suggestions: [], uploadLimitBytes: 0, evidenceStream: "evidence" },
    });
    const before = panel.webview.__posted.length;

    await panel.__receive({ type: "ready" });

    expect(panel.webview.__posted.slice(before).filter((m) => m.type === "model")).toHaveLength(1);
  });

  it("repaints a live link session onto a rebuilt webview: its tab and everything it had on screen", async () => {
    const { instance, panel } = await openReady();
    const session = instance.link.begin({ title: "Link scenario", searchPlaceholder: "Search tests" });
    session.setRows([{ id: "CALC-1", key: "CALC-1", summary: "Add two numbers", kind: "test" }]);
    const before = panel.webview.__posted.length;

    await panel.__receive({ type: "ready" });

    const replay = panel.webview.__posted.slice(before);
    expect(replay).toContainEqual({ type: "linkTab", visible: true, title: "Link scenario" });
    expect(replay.filter((m) => m.type === "reset")).toHaveLength(1);
    expect(replay.filter((m) => m.type === "rows")).toHaveLength(1);
    expect(lastActivate(panel)).toBe("link");
  });

  it("posts no link paint on a re-hydration with no session live", async () => {
    const { panel } = await openReady();
    const before = panel.webview.__posted.length;

    await panel.__receive({ type: "ready" });

    expect(panel.webview.__posted.slice(before).filter((m) => m.type === "linkTab")).toEqual([]);
  });

  it("adopts a board tab a window reload restored, so it paints and activates like a fresh open", async () => {
    const restored = restoreTab();
    await restored.__receive({ type: "ready" });

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

  // The board and link fragments both declare a top-level `const search`; as sibling classic scripts that
  // is a parse error that kills the second, so each fragment is emitted in its own function scope.
  it("emits every fragment script inside its own scope", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;

    expect(html).toContain("const search = document.getElementById('search');");
    expect(html).toContain("const search = document.getElementById('link-search');");
    const bodies = [...html.matchAll(/<script nonce="[^"]+">([\s\S]*?)<\/script>/g)].map((m) => m[1]!.trim());
    expect(bodies.length).toBeGreaterThan(1);
    for (const body of bodies) {
      expect(body.startsWith("(function () {")).toBe(true);
      expect(body.endsWith("})();")).toBe(true);
    }
  });

  it("tags every board render with surface board and activates the Mapping tab on open", async () => {
    const { panel } = await openReady();

    const render = lastRender(panel)!;
    expect(render.surface).toBe("board");
    expect(lastActivate(panel)).toBe("mapping");
    expect(render.scenarios.map((s) => s.name)).toEqual(["Log in", "Checkout"]);
    expect(render.available.map((t) => t.key)).toEqual(["PAY-9"]);
    expect(render.mapped.map((t) => t.key)).toEqual(["CALC-1"]);
    expect(render.matrix.map((r) => r.test)).toEqual(["CALC-1", "PAY-9"]);
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

    await panel.__receive({ surface: "board", type: "search", value: "payments" });

    expect(lastRender(panel)!.executions.map((e) => e.key)).toEqual(["PAY-9"]);
  });

  it("routes an open message to openExecution with the row key", async () => {
    const openExecution = vi.fn();
    const { panel } = await openReady({ openExecution });

    await panel.__receive({ surface: "board", type: "open", key: "XNP-1" });

    expect(openExecution).toHaveBeenCalledWith("XNP-1");
  });

  it("filters both buckets on a search message via the vscode-free filter", async () => {
    const { panel } = await openReady();

    await panel.__receive({ surface: "board", type: "search", value: "cart.feature" });

    const render = lastRender(panel)!;
    expect(render.scenarios.map((s) => s.name)).toEqual(["Checkout"]);
    expect(render.available).toEqual([]);
    expect(render.mapped).toEqual([]);
  });

  it("filters the matrix rows alongside the cards", async () => {
    const { panel } = await openReady();

    await panel.__receive({ surface: "board", type: "search", value: "PAY" });

    const render = lastRender(panel)!;
    expect(render.matrix.map((r) => r.test)).toEqual(["PAY-9"]);
    expect(render.available.map((t) => t.key)).toEqual(["PAY-9"]);
    expect(render.mapped).toEqual([]);
  });

  it("routes a drop to applyDrop with the normalized scenario and key", async () => {
    const applyDrop = vi.fn(() => Promise.resolve());
    const { panel } = await openReady({ applyDrop });

    await panel.__receive({ surface: "board", type: "drop", scenario: "features/login.feature:5", key: "PAY-9" });

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

    await panel.__receive({ surface: "board", type: "scope", project: "PAY" });

    expect(order).toEqual(["set:PAY", "load:PAY"]);
    expect(lastRender(panel)!.project).toBe("PAY");
  });

  it("asks for no load when the selector goes back to All projects", async () => {
    const autoSync = vi.fn(() => Promise.resolve());
    const { panel } = await openReady({ autoSync, projectScope: fakeScope("PAY") });
    autoSync.mockClear();

    await panel.__receive({ surface: "board", type: "scope", project: "" });

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
    expect(panel.webview.__posted.at(-1)).toEqual({
      surface: "board",
      type: "syncProgress",
      text: "Syncing PAY: 100 of 350 tests",
    });

    BoardPanel.reportSyncProgress("");
    expect(panel.webview.__posted.at(-1)).toMatchObject({ type: "syncProgress", text: "" });

    instance.dispose();

    expect(() => BoardPanel.reportSyncProgress("Syncing PAY: 1 test")).not.toThrow();
  });

  it("routes a sync message to runSync so the empty available group can load tests", async () => {
    const runSync = vi.fn(() => Promise.resolve());
    const { panel } = await openReady({ runSync });

    await panel.__receive({ surface: "board", type: "sync" });

    expect(runSync).toHaveBeenCalledOnce();
  });

  it("repaints once a sync settles, even when it rejects, so the button never strands the group", async () => {
    const runSync = vi.fn(() => Promise.reject(new Error("offline")));
    const { panel } = await openReady({ runSync });
    const renders = (): number => panel.webview.__posted.filter(isRender).length;
    const before = renders();

    await panel.__receive({ surface: "board", type: "sync" });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(renders()).toBe(before + 1);
  });

  it("forwards the available group's empty state on every render", async () => {
    let current = MODEL;
    const changes = new vscode.EventEmitter<void>();
    const { panel } = await openReady({ buildModel: () => current, onDidChange: changes.event });
    expect(lastRender(panel)!).toMatchObject({ availableEmptyText: MODEL.availableEmptyText, offerSync: false });

    current = { ...MODEL, availableEmptyText: "No synced tests yet.", offerSync: true };
    changes.fire();

    expect(lastRender(panel)!).toMatchObject({ availableEmptyText: "No synced tests yet.", offerSync: true });
  });

  it("marks a render as filtering only while a query is active, so a filtered-empty group keeps its Sync now off", async () => {
    const { panel } = await openReady();
    expect(lastRender(panel)!.filtering).toBe(false);

    await panel.__receive({ surface: "board", type: "search", value: "cart.feature" });
    expect(lastRender(panel)!.filtering).toBe(true);

    await panel.__receive({ surface: "board", type: "search", value: "   " });

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

    await panel.__receive({ surface: "board", type: "unlink", scenario: "id-add", key: "CALC-1" });

    expect(applyUnlink).toHaveBeenCalledWith("id-add", "CALC-1");
  });

  it("routes a push message to pushText with the scenario id and key, without re-rendering", async () => {
    const pushText = vi.fn();
    const { panel } = await openReady({ pushText });
    const before = panel.webview.__posted.length;

    await panel.__receive({ surface: "board", type: "pushText", scenario: "id-add", key: "CALC-1" });

    expect(pushText).toHaveBeenCalledWith("id-add", "CALC-1");
    expect(panel.webview.__posted).toHaveLength(before);
  });

  // Source-level only: the webview JS is never executed here, so this pins that the row builder ships
  // both actions and an aria-label, not that a click on the rendered button does anything.
  it("carries a Push affordance alongside Unlink on every linked scenario row", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;

    expect(html).toContain("'pushText'");
    expect(html).toContain("'unlink'");
    expect(html).toContain("aria-label");
  });

  it("ignores a repeat unlink for a row already in flight, but not one for another key, and re-arms once it settles", async () => {
    const settlers: Array<() => void> = [];
    const applyUnlink = vi.fn(() => new Promise<void>((resolve) => settlers.push(resolve)));
    const { panel } = await openReady({ applyUnlink });
    const unlink = (key: string): Promise<void> => panel.__receive({ surface: "board", type: "unlink", scenario: "id-add", key });

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

    const before = panel.webview.__posted.length;
    await panel.__receive({ surface: "board", type: "drop", scenario: "gone:1", key: "GONE-1" });

    expect(applyDrop).toHaveBeenCalledOnce();
    expect(panel.webview.__posted).toHaveLength(before);
  });

  it("activates the tab the shell is told to switch to on a tab message", async () => {
    const { panel } = await openReady();

    await panel.__receive({ type: "tab", tab: "matrix" });

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

    await panel.__receive({ type: "tab", tab: "executions" });
    await panel.__receive({ surface: "board", type: "search", value: "CALC" });

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

    await panel.__receive({ surface: "board", type: "scope", project: "PAY" });

    const render = lastRender(panel)!;
    expect(render.project).toBe("PAY");
    expect(render.scoped).toBe(true);
    expect(render.available.map((t) => t.key)).toEqual(["PAY-9"]);
    expect(render.mapped).toEqual([]);
    expect(render.matrix.map((r) => r.test)).toEqual(["PAY-9"]);
    expect(render.scenarios.map((s) => s.name)).toEqual(["Log in", "Checkout"]);
    expect(render.executions.map((e) => e.key)).toEqual(["XNP-1", "PAY-9"]);
  });

  it("opens on the persisted selection and clears it back to All Projects when the selector is set to All", async () => {
    const { panel } = await openReady({ projectScope: fakeScope("CALC") });
    expect(lastRender(panel)!).toMatchObject({ project: "CALC", scoped: true });
    expect(lastRender(panel)!.available).toEqual([]);

    await panel.__receive({ surface: "board", type: "scope", project: "" });

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

    await panel.__receive({ surface: "board", type: "scope", project: "PAY" });

    expect(lastRender(panel)!).toMatchObject({ project: "", scoped: false });
    expect(lastRender(panel)!.mapped.map((t) => t.key)).toEqual(["CALC-1"]);
    expect(lastRender(panel)!.available.map((t) => t.key)).toEqual(["PAY-9"]);
  });

  it("keeps the search and the scope narrowing together", async () => {
    const { panel } = await openReady();

    await panel.__receive({ surface: "board", type: "scope", project: "CALC" });
    await panel.__receive({ surface: "board", type: "search", value: "PAY" });

    const render = lastRender(panel)!;
    expect(render.mapped).toEqual([]);
    expect(render.available).toEqual([]);
    expect(render).toMatchObject({ project: "CALC", scoped: true, filtering: true });
  });

  it("carries the Create tests button in the mapping pane, and opens with the verb disabled", async () => {
    const { panel } = await openReady();

    expect(panel.webview.html).toContain('id="create-tests"');
    expect(lastRender(panel)!.createVerb).toEqual({
      label: "Create tests",
      enabled: false,
      hint: "Pick a project in the header to create tests in.",
    });
  });

  it("marks a checked scenario card selected and clears it again on uncheck", async () => {
    const { panel } = await openReady();
    expect(lastRender(panel)!.scenarios.map((s) => s.selected)).toEqual([false, false]);

    await panel.__receive({ surface: "board", type: "select", target: "scenario", id: "id-login", on: true });
    expect(lastRender(panel)!.scenarios.filter((s) => s.selected).map((s) => s.name)).toEqual(["Log in"]);

    await panel.__receive({ surface: "board", type: "select", target: "scenario", id: "id-login", on: false });

    expect(lastRender(panel)!.scenarios.every((s) => !s.selected)).toBe(true);
  });

  it("keeps the selection across a scope change, since scenario cards are never scoped away", async () => {
    const { panel } = await openReady();
    await panel.__receive({ surface: "board", type: "select", target: "scenario", id: "id-checkout", on: true });

    await panel.__receive({ surface: "board", type: "scope", project: "PAY" });

    const render = lastRender(panel)!;
    expect(render.scoped).toBe(true);
    expect(render.scenarios.filter((s) => s.selected).map((s) => s.name)).toEqual(["Checkout"]);
    expect(render.createVerb).toMatchObject({ enabled: true, label: "Create 1 test in PAY" });
  });

  it("keeps a filtered-out card checked, so a search never silently unchecks it", async () => {
    const { panel } = await openReady();
    await panel.__receive({ surface: "board", type: "select", target: "scenario", id: "id-login", on: true });

    await panel.__receive({ surface: "board", type: "search", value: "cart.feature" });
    expect(lastRender(panel)!.scenarios.map((s) => s.name)).toEqual(["Checkout"]);

    await panel.__receive({ surface: "board", type: "search", value: "" });

    expect(lastRender(panel)!.scenarios.filter((s) => s.selected).map((s) => s.name)).toEqual(["Log in"]);
  });

  it("prunes a checked card the rebuild dropped, so a created-and-tagged scenario leaves the selection", async () => {
    let current = MODEL;
    const changes = new vscode.EventEmitter<void>();
    const { panel } = await openReady({ buildModel: () => current, onDidChange: changes.event });
    await panel.__receive({ surface: "board", type: "select", target: "scenario", id: "id-login", on: true });
    await panel.__receive({ surface: "board", type: "select", target: "scenario", id: "id-checkout", on: true });
    await panel.__receive({ surface: "board", type: "scope", project: "CALC" });
    expect(lastRender(panel)!.createVerb.label).toBe("Create 2 tests in CALC");

    current = { ...MODEL, scenarios: MODEL.scenarios.filter((card) => card.dropId !== "id-login") };
    changes.fire();

    const render = lastRender(panel)!;
    expect(render.scenarios.map((s) => s.name)).toEqual(["Checkout"]);
    expect(render.createVerb.label).toBe("Create 1 test in CALC");
  });

  it("disables the create verb with a pick-a-project hint under All Projects, even with cards checked", async () => {
    const { panel } = await openReady();

    await panel.__receive({ surface: "board", type: "select", target: "scenario", id: "id-login", on: true });

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
    await panel.__receive({ surface: "board", type: "select", target: "scenario", id: "id-login", on: true });
    const before = panel.webview.__posted.length;

    await panel.__receive({ surface: "board", type: "bulkCreate" });

    expect(bulkCreate).toHaveBeenCalledOnce();
    expect(panel.webview.__posted).toHaveLength(before);
  });

  it("carries the two container buttons in the test column, and opens with both verbs disabled", async () => {
    const { panel } = await openReady();

    expect(panel.webview.html).toContain('id="create-test-set"');
    expect(panel.webview.html).toContain('id="create-test-plan"');
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
  });

  // Source-level only: the webview JS is never executed here, so this pins that a test card's checkbox
  // is built with a label naming its key, not that checking the rendered box does anything.
  it("labels a test card's checkbox with the test key", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;

    expect(html).toContain("'Select test ' + card.key");
    expect(html).toContain("'Select scenario ' + card.name");
  });

  it("marks a checked test card selected in either group and clears it again on uncheck", async () => {
    const { panel } = await openReady();
    expect(lastRender(panel)!.available.map((t) => t.selected)).toEqual([false]);
    expect(lastRender(panel)!.mapped.map((t) => t.selected)).toEqual([false]);

    await panel.__receive({ surface: "board", type: "select", target: "test", id: "PAY-9", on: true });
    await panel.__receive({ surface: "board", type: "select", target: "test", id: "CALC-1", on: true });
    expect(lastRender(panel)!.available.map((t) => t.selected)).toEqual([true]);
    expect(lastRender(panel)!.mapped.map((t) => t.selected)).toEqual([true]);

    await panel.__receive({ surface: "board", type: "select", target: "test", id: "CALC-1", on: false });

    expect(lastRender(panel)!.available.map((t) => t.selected)).toEqual([true]);
    expect(lastRender(panel)!.mapped.map((t) => t.selected)).toEqual([false]);
  });

  it("keeps the two selections apart, so checking a test never touches the scenario verb", async () => {
    const { panel } = await openReady({ projectScope: fakeScope("CALC") });

    await panel.__receive({ surface: "board", type: "select", target: "test", id: "CALC-1", on: true });

    const render = lastRender(panel)!;
    expect(render.scenarios.every((s) => !s.selected)).toBe(true);
    expect(render.createVerb).toMatchObject({ label: "Create tests", enabled: false });
    expect(render.testSetVerb).toMatchObject({ label: "Create Test Set from 1 test", enabled: true });
    expect(BoardPanel.selectedScenarios()).toEqual([]);
    expect(BoardPanel.selectedTests()).toEqual(["CALC-1"]);
  });

  // A container holds what the checked boxes showed, so a test the new scope hides cannot ride along
  // invisibly in the confirm's count. Scenario cards are unscoped, so their selection is untouched by
  // the same move.
  it("drops a checked test the scope hides, while the scenario selection survives", async () => {
    const { panel } = await openReady({ projectScope: fakeScope("CALC") });
    await panel.__receive({ surface: "board", type: "select", target: "test", id: "CALC-1", on: true });
    await panel.__receive({ surface: "board", type: "select", target: "scenario", id: "id-checkout", on: true });
    expect(lastRender(panel)!.testSetVerb.label).toBe("Create Test Set from 1 test");

    await panel.__receive({ surface: "board", type: "scope", project: "PAY" });

    const render = lastRender(panel)!;
    expect(render.mapped).toEqual([]);
    expect(render.testSetVerb).toEqual({
      label: "Create Test Set",
      enabled: false,
      hint: "Check the tests you want in the Test Set.",
    });
    expect(render.testPlanVerb.enabled).toBe(false);
    expect(BoardPanel.selectedTests()).toEqual([]);
    expect(render.scenarios.filter((s) => s.selected).map((s) => s.name)).toEqual(["Checkout"]);
    expect(BoardPanel.selectedScenarios()).toEqual(["id-checkout"]);
  });

  it("prunes a checked test the rebuild dropped, counting only what the model still carries", async () => {
    let current = MODEL;
    const changes = new vscode.EventEmitter<void>();
    const { panel } = await openReady({ buildModel: () => current, onDidChange: changes.event });
    await panel.__receive({ surface: "board", type: "select", target: "test", id: "PAY-9", on: true });
    await panel.__receive({ surface: "board", type: "select", target: "test", id: "CALC-1", on: true });
    await panel.__receive({ surface: "board", type: "scope", project: "CALC" });
    expect(lastRender(panel)!.testSetVerb.label).toBe("Create Test Set from 1 test");

    current = { ...MODEL, mapped: [] };
    changes.fire();

    expect(lastRender(panel)!.testSetVerb).toMatchObject({ label: "Create Test Set", enabled: false });
    expect(BoardPanel.selectedTests()).toEqual([]);
  });

  it("keeps a checked test checked when only the search hides its card", async () => {
    const { panel } = await openReady({ projectScope: fakeScope("CALC") });
    await panel.__receive({ surface: "board", type: "select", target: "test", id: "CALC-1", on: true });

    await panel.__receive({ surface: "board", type: "search", value: "nothing matches this" });
    expect(lastRender(panel)!.mapped).toEqual([]);

    await panel.__receive({ surface: "board", type: "search", value: "" });

    expect(lastRender(panel)!.mapped.map((t) => t.selected)).toEqual([true]);
    expect(BoardPanel.selectedTests()).toEqual(["CALC-1"]);
  });

  it("disables both container verbs under a project with no test checked", async () => {
    const { panel } = await openReady({ projectScope: fakeScope("CALC") });

    expect(lastRender(panel)!.testSetVerb).toEqual({
      label: "Create Test Set",
      enabled: false,
      hint: "Check the tests you want in the Test Set.",
    });
    expect(lastRender(panel)!.testPlanVerb.hint).toBe("Check the tests you want in the Test Plan.");
  });

  it("disables both container verbs with a pick-a-project hint under All Projects, even with tests checked", async () => {
    const { panel } = await openReady();

    await panel.__receive({ surface: "board", type: "select", target: "test", id: "CALC-1", on: true });

    const render = lastRender(panel)!;
    expect(render.scoped).toBe(false);
    expect(render.testSetVerb).toMatchObject({ enabled: false, label: "Create Test Set" });
    expect(render.testPlanVerb.hint).toContain("Pick a project");
  });

  it("routes the two container buttons to their commands without re-rendering the board", async () => {
    const createTestSet = vi.fn();
    const createTestPlan = vi.fn();
    const { panel } = await openReady({ createTestSet, createTestPlan, projectScope: fakeScope("CALC") });
    await panel.__receive({ surface: "board", type: "select", target: "test", id: "CALC-1", on: true });
    const before = panel.webview.__posted.length;

    await panel.__receive({ surface: "board", type: "createTestSet" });
    await panel.__receive({ surface: "board", type: "createTestPlan" });

    expect(createTestSet).toHaveBeenCalledOnce();
    expect(createTestPlan).toHaveBeenCalledOnce();
    expect(panel.webview.__posted).toHaveLength(before);
  });

  // The router dispatches by message type, so an unrouted type must be a no-op rather than a throw out of
  // the message handler, and a prototype name must not resolve to something callable.
  it("ignores a message type it has no route for, repainting nothing", async () => {
    const bulkCreate = vi.fn();
    const { panel } = await openReady({ bulkCreate });
    const before = panel.webview.__posted.length;

    await panel.__receive({ surface: "board", type: "bogus" });
    await panel.__receive({ surface: "board", type: "toString" });
    await panel.__receive({ surface: "board", type: "constructor" });

    expect(panel.webview.__posted).toHaveLength(before);
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
    const before = panel.webview.__posted.length;

    await panel.__receive({ surface: "board", type: "createTestExecution" });

    expect(createTestExecution).toHaveBeenCalledOnce();
    expect(panel.webview.__posted).toHaveLength(before);
  });

  it("exposes the checked tests to the container commands, and nothing when no board is open", async () => {
    expect(BoardPanel.selectedTests()).toEqual([]);
    const { instance, panel } = await openReady();

    await panel.__receive({ surface: "board", type: "select", target: "test", id: "CALC-1", on: true });
    await panel.__receive({ surface: "board", type: "select", target: "test", id: "PAY-9", on: true });
    expect(BoardPanel.selectedTests()).toEqual(["CALC-1", "PAY-9"]);

    instance.dispose();

    expect(BoardPanel.selectedTests()).toEqual([]);
  });

  it("exposes the checked cards to the bulk-create command, and nothing when no board is open", async () => {
    expect(BoardPanel.selectedScenarios()).toEqual([]);
    const { instance, panel } = await openReady();

    await panel.__receive({ surface: "board", type: "select", target: "scenario", id: "id-checkout", on: true });
    await panel.__receive({ surface: "board", type: "select", target: "scenario", id: "id-login", on: true });
    expect(BoardPanel.selectedScenarios()).toEqual(["id-checkout", "id-login"]);

    instance.dispose();

    expect(BoardPanel.selectedScenarios()).toEqual([]);
  });

  it("clears the singleton on dispose and stops posting; dispose is idempotent", async () => {
    const { instance, panel } = await openReady();

    instance.dispose();
    const posted = panel.webview.__posted.length;
    await panel.__receive({ surface: "board", type: "search", value: "x" });

    expect(panel.webview.__posted).toHaveLength(posted);
    expect(() => instance.dispose()).not.toThrow();
    // A fresh open now creates a new panel rather than revealing the disposed one.
    BoardPanel.open(deps());
    expect(win.__webviewPanels).toHaveLength(2);
  });
});
