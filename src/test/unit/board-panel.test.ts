import { describe, it, expect, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import { BoardPanel, BoardPanelDeps } from "../../traceability/board-panel";
import { BoardViewModel, ExecutionRow } from "../../traceability/board-data";

// The panel drives the real `vscode.window.createWebviewPanel` stub: `__receive` delivers an inbound
// webview message, `webview.__posted` records outbound ones, `__revealCount` counts reveals, and
// `dispose()` fires the onDidDispose seam — the same rig the link-picker-panel tests use. The webview
// JS carries no decision logic (search/tab/render all round-trip through the host), so it isn't run.
interface StubPanel {
  title: string;
  webview: { html: string; __posted: OutgoingMessage[] };
  __revealCount: number;
  dispose: () => void;
  __receive: (message: unknown) => Promise<void>;
}

interface OutgoingMessage {
  type: "render";
  activeTab: string;
  scenarios: Array<{ name: string }>;
  tests: Array<{ key: string }>;
  matrix: Array<{ requirement: string; test: string; scenario: string; tag: string; result: string }>;
  executions: Array<{ key: string; summary: string }>;
}

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
  tests: [
    { key: "CALC-1", summary: "Add two numbers", pills: ["1 scenario"] },
    { key: "PAY-9", pills: ["orphan"] },
  ],
  matrix: [
    { requirement: "REQ-7", test: "CALC-1", scenario: "Checkout", tag: "@TEST_CALC-1", result: "passed" },
    { requirement: "", test: "PAY-9", scenario: "", tag: "", result: "no coverage" },
  ],
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
    openExecution: () => undefined,
    ...over,
  };
}

const lastRender = (panel: StubPanel): OutgoingMessage | undefined =>
  [...panel.webview.__posted].reverse().find((m) => m.type === "render");

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
    expect(panel.webview.html).toContain("Drag a scenario from the left onto a test on the right to link them.");
    expect(panel.webview.html).toContain("Xray tests");
    expect(panel.webview.html).toContain("Requirement");
    expect(panel.webview.html).toContain("Xray test");
    expect(panel.webview.html).toContain("Tag in file");
    expect(panel.webview.html).toContain("Last result");
    expect(panel.webview.html).toContain("Pass rate");
    expect(panel.webview.html).toContain("Publishes from this workspace appear here.");
  });

  it("reveals the existing panel instead of opening a second (singleton surface)", () => {
    BoardPanel.open(deps());
    BoardPanel.open(deps());

    expect(win.__webviewPanels).toHaveLength(1);
    expect(win.__webviewPanels[0]!.__revealCount).toBe(1);
  });

  it("posts both buckets on the Mapping tab once the webview signals ready", async () => {
    BoardPanel.open(deps());
    const panel = win.__webviewPanels[0]!;

    await panel.__receive({ type: "ready" });

    const render = lastRender(panel)!;
    expect(render.activeTab).toBe("mapping");
    expect(render.scenarios.map((s) => s.name)).toEqual(["Log in", "Checkout"]);
    expect(render.tests.map((t) => t.key)).toEqual(["CALC-1", "PAY-9"]);
    expect(render.matrix.map((r) => r.test)).toEqual(["CALC-1", "PAY-9"]);
  });

  it("posts the executions rows from the ledger on render", async () => {
    BoardPanel.open(deps());
    const panel = win.__webviewPanels[0]!;

    await panel.__receive({ type: "ready" });

    expect(lastRender(panel)!.executions.map((e) => e.key)).toEqual(["XNP-1", "PAY-9"]);
  });

  it("posts an empty executions list when the ledger is empty", async () => {
    BoardPanel.open(deps({ buildExecutions: () => [] }));
    const panel = win.__webviewPanels[0]!;

    await panel.__receive({ type: "ready" });

    expect(lastRender(panel)!.executions).toEqual([]);
  });

  it("filters the executions rows on key and summary", async () => {
    BoardPanel.open(deps());
    const panel = win.__webviewPanels[0]!;

    await panel.__receive({ type: "search", value: "payments" });

    expect(lastRender(panel)!.executions.map((e) => e.key)).toEqual(["PAY-9"]);
  });

  it("routes an open message to openExecution with the row key", async () => {
    const openExecution = vi.fn();
    BoardPanel.open(deps({ openExecution }));
    const panel = win.__webviewPanels[0]!;

    await panel.__receive({ type: "open", key: "XNP-1" });

    expect(openExecution).toHaveBeenCalledWith("XNP-1");
  });

  it("filters both buckets on a search message via the vscode-free filter", async () => {
    BoardPanel.open(deps());
    const panel = win.__webviewPanels[0]!;

    await panel.__receive({ type: "search", value: "cart.feature" });

    const render = lastRender(panel)!;
    expect(render.scenarios.map((s) => s.name)).toEqual(["Checkout"]);
    expect(render.tests).toEqual([]);
  });

  it("filters the matrix rows alongside the cards", async () => {
    BoardPanel.open(deps());
    const panel = win.__webviewPanels[0]!;

    await panel.__receive({ type: "search", value: "PAY" });

    const render = lastRender(panel)!;
    expect(render.matrix.map((r) => r.test)).toEqual(["PAY-9"]);
    expect(render.tests.map((t) => t.key)).toEqual(["PAY-9"]);
  });

  it("routes a drop to applyDrop with the normalized scenario and key", async () => {
    const applyDrop = vi.fn(() => Promise.resolve());
    BoardPanel.open(deps({ applyDrop }));
    const panel = win.__webviewPanels[0]!;

    await panel.__receive({ type: "drop", scenario: "features/login.feature:5", key: "PAY-9" });

    expect(applyDrop).toHaveBeenCalledWith("features/login.feature:5", "PAY-9");
  });

  it("posts no render on a drop — the snapshot rebuild drives the next render, so a stale drop leaves the board untouched", async () => {
    const applyDrop = vi.fn(() => Promise.resolve());
    BoardPanel.open(deps({ applyDrop }));
    const panel = win.__webviewPanels[0]!;
    await panel.__receive({ type: "ready" });

    const before = panel.webview.__posted.length;
    await panel.__receive({ type: "drop", scenario: "gone:1", key: "GONE-1" });

    expect(applyDrop).toHaveBeenCalledOnce();
    expect(panel.webview.__posted).toHaveLength(before);
  });

  it("switches the active tab on a tab message", async () => {
    BoardPanel.open(deps());
    const panel = win.__webviewPanels[0]!;

    await panel.__receive({ type: "tab", tab: "matrix" });

    expect(lastRender(panel)!.activeTab).toBe("matrix");
  });

  it("preserves the active tab and query across a search after a tab switch", async () => {
    BoardPanel.open(deps());
    const panel = win.__webviewPanels[0]!;

    await panel.__receive({ type: "tab", tab: "executions" });
    await panel.__receive({ type: "search", value: "CALC" });

    const render = lastRender(panel)!;
    expect(render.activeTab).toBe("executions");
    expect(render.tests.map((t) => t.key)).toEqual(["CALC-1"]);
  });

  it("rebuilds the model and re-renders on a snapshot-change event", async () => {
    let current = MODEL;
    const changes = new vscode.EventEmitter<void>();
    BoardPanel.open(deps({ buildModel: () => current, onDidChange: changes.event }));
    const panel = win.__webviewPanels[0]!;
    await panel.__receive({ type: "ready" });

    current = { scenarios: [], tests: [{ key: "NEW-1", pills: ["orphan"] }], matrix: [] };
    changes.fire();

    expect(lastRender(panel)!.tests.map((t) => t.key)).toEqual(["NEW-1"]);
  });

  it("clears the singleton on dispose and stops posting; dispose is idempotent", async () => {
    const instance = BoardPanel.open(deps());
    const panel = win.__webviewPanels[0]!;

    instance.dispose();
    const posted = panel.webview.__posted.length;
    await panel.__receive({ type: "search", value: "x" });

    expect(panel.webview.__posted).toHaveLength(posted);
    expect(() => instance.dispose()).not.toThrow();
    // A fresh open now creates a new panel rather than revealing the disposed one.
    BoardPanel.open(deps());
    expect(win.__webviewPanels).toHaveLength(2);
  });
});
