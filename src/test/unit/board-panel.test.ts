import { describe, it, expect, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import { BoardPanel, BoardPanelDeps } from "../../traceability/board-panel";
import { BoardViewModel, ExecutionRow } from "../../traceability/board-data";
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
  dispose: () => void;
  __receive: (message: unknown) => Promise<void>;
}

interface RenderMessage {
  surface: "board";
  type: "render";
  scenarios: Array<{ name: string }>;
  available: Array<{ key: string; links: Array<{ name: string; location: string; unlinkId: string }> }>;
  mapped: Array<{ key: string; links: Array<{ name: string; location: string; unlinkId: string }> }>;
  matrix: Array<{ requirement: string; test: string; scenario: string; tag: string; result: string }>;
  executions: Array<{ key: string; summary: string }>;
  availableEmptyText: string;
  offerSync: boolean;
  filtering: boolean;
}
interface ActivateMessage {
  type: "activate";
  tab: string;
}
type Posted = RenderMessage | ActivateMessage | { type: string; [key: string]: unknown };

const win = vscode.window as unknown as {
  __webviewPanels: StubPanel[];
  __resetWebviewPanels: () => void;
};

afterEach(() => win.__resetWebviewPanels());

const MODEL: BoardViewModel = {
  scenarios: [
    { name: "Log in", location: "features/login.feature:5", dropId: "id-login", pills: ["no tag"], reqKeys: [] },
    { name: "Checkout", location: "features/cart.feature:12", dropId: "id-checkout", pills: ["no tag"], reqKeys: ["REQ-7"] },
  ],
  available: [{ key: "PAY-9", pills: [], links: [] }],
  mapped: [
    {
      key: "CALC-1",
      summary: "Add two numbers",
      pills: ["1 scenario"],
      links: [{ name: "Add two numbers", location: "features/calc.feature:3", unlinkId: "id-add" }],
    },
  ],
  matrix: [
    { requirement: "REQ-7", test: "CALC-1", scenario: "Checkout", tag: "@TEST_CALC-1", result: "passed" },
    { requirement: "", test: "PAY-9", scenario: "", tag: "", result: "no coverage" },
  ],
  availableEmptyText: "No unmapped tests in the last sync.",
  offerSync: false,
};

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
    runSync: () => Promise.resolve(),
    openExecution: () => undefined,
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

describe("BoardPanel", () => {
  it("renders the shell — title, tabs, the drag-to-link gutter, the provider label, the matrix header, and the executions table", () => {
    BoardPanel.open(deps());
    const panel = win.__webviewPanels[0]!;

    expect(panel.title).toBe("Coverage Board");
    expect(panel.webview.html).toContain("Coverage Board");
    expect(panel.webview.html).toContain("Mapping");
    expect(panel.webview.html).toContain("Matrix");
    expect(panel.webview.html).toContain("Executions");
    expect(panel.webview.html).toContain("Filter by key, tag, file");
    expect(panel.webview.html).toContain("drag to link");
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

  it("carries no Mapped tree markup and no drag-to-unlink drop zone", () => {
    BoardPanel.open(deps());
    const html = win.__webviewPanels[0]!.webview.html;
    expect(html).not.toContain("mapped-groups");
    expect(html).not.toContain("unlink-ready");
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
      attachments: { available: false, suggestions: [], uploadLimitBytes: 0, evidenceStream: "evidence" },
    });
    await panel.__receive({ type: "tab", tab: "publish" });

    expect(startPublish).not.toHaveBeenCalled();
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

  it("posts no render on a drop — the snapshot rebuild drives the next render, so a stale drop leaves the board untouched", async () => {
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
