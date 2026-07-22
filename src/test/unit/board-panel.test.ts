import { describe, it, expect, afterEach } from "vitest";
import * as vscode from "vscode";
import { BoardPanel, BoardPanelDeps } from "../../traceability/board-panel";
import { BoardViewModel } from "../../traceability/board-data";

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
}

const win = vscode.window as unknown as {
  __webviewPanels: StubPanel[];
  __resetWebviewPanels: () => void;
};

afterEach(() => win.__resetWebviewPanels());

const MODEL: BoardViewModel = {
  scenarios: [
    { name: "Log in", location: "features/login.feature:5", pills: ["no tag"], reqKeys: [] },
    { name: "Checkout", location: "features/cart.feature:12", pills: ["no tag"], reqKeys: ["REQ-7"] },
  ],
  tests: [
    { key: "CALC-1", summary: "Add two numbers", pills: ["1 scenario"] },
    { key: "PAY-9", pills: ["orphan"] },
  ],
};

function deps(over: Partial<BoardPanelDeps> = {}): BoardPanelDeps {
  return {
    providerLabel: "Xray",
    buildModel: () => MODEL,
    onDidChange: new vscode.EventEmitter<void>().event,
    ...over,
  };
}

const lastRender = (panel: StubPanel): OutgoingMessage | undefined =>
  [...panel.webview.__posted].reverse().find((m) => m.type === "render");

describe("BoardPanel", () => {
  it("renders the shell — title, tabs, the drag-to-link gutter, the provider label, and both placeholders", () => {
    BoardPanel.open(deps());
    const panel = win.__webviewPanels[0]!;

    expect(panel.title).toBe("Coverage Board");
    expect(panel.webview.html).toContain("Coverage Board");
    expect(panel.webview.html).toContain("Mapping");
    expect(panel.webview.html).toContain("Matrix");
    expect(panel.webview.html).toContain("Executions");
    expect(panel.webview.html).toContain("Filter by key, tag, file");
    expect(panel.webview.html).toContain("drag to link");
    expect(panel.webview.html).toContain("Xray tests");
    expect(panel.webview.html).toContain("coming in the next slice");
    expect(panel.webview.html).toContain("design pending review");
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
  });

  it("filters both buckets on a search message via the vscode-free filter", async () => {
    BoardPanel.open(deps());
    const panel = win.__webviewPanels[0]!;

    await panel.__receive({ type: "search", value: "cart.feature" });

    const render = lastRender(panel)!;
    expect(render.scenarios.map((s) => s.name)).toEqual(["Checkout"]);
    expect(render.tests).toEqual([]);
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

    current = { scenarios: [], tests: [{ key: "NEW-1", pills: ["orphan"] }] };
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
