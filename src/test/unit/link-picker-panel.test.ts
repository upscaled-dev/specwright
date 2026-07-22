import { describe, it, expect, afterEach } from "vitest";
import * as vscode from "vscode";
import { LinkPickerPanel } from "../../traceability/link-picker-panel";
import { LinkPickerRow } from "../../traceability/link-picker-flow";

// The panel drives the real `vscode.window.createWebviewPanel` stub: `__receive` delivers an inbound
// webview message, `webview.__posted` records outbound ones, and `dispose()` fires the onDidDispose
// seam — the same rig the publish-dialog-panel tests use. The webview JS itself is not exercised (it
// carries no decision logic; that all lives in runLinkPickerFlow).
interface StubPanel {
  webview: { html: string; __posted: unknown[] };
  dispose: () => void;
  __receive: (message: unknown) => Promise<void>;
}

const win = vscode.window as unknown as {
  __webviewPanels: StubPanel[];
  __resetWebviewPanels: () => void;
};

afterEach(() => win.__resetWebviewPanels());

const OPTS = { title: "Link scenario to Xray test", searchPlaceholder: "Search Xray tests" };
const ROW: LinkPickerRow = { id: "CALC-1", key: "CALC-1", summary: "Login", kind: "test" };

describe("LinkPickerPanel", () => {
  it("forwards search/confirm/cancel webview messages to the registered handlers", async () => {
    const ui = LinkPickerPanel.open(OPTS);
    const searches: string[] = [];
    const confirms: string[] = [];
    let cancels = 0;
    ui.onSearch((value) => searches.push(value));
    ui.onConfirm((id) => confirms.push(id));
    ui.onCancel(() => { cancels += 1; });
    const panel = win.__webviewPanels[0]!;

    await panel.__receive({ type: "search", value: "CAL" });
    await panel.__receive({ type: "confirm", id: "CALC-1" });

    expect(searches).toEqual(["CAL"]);
    expect(confirms).toEqual(["CALC-1"]);

    // A confirm settles the panel — a later cancel message is dropped.
    await panel.__receive({ type: "cancel" });
    expect(cancels).toBe(0);
  });

  it("posts row and busy updates to the webview", async () => {
    const ui = LinkPickerPanel.open(OPTS);
    ui.setRows([ROW]);
    ui.setBusy(true);
    const panel = win.__webviewPanels[0]!;

    expect(panel.webview.__posted).toContainEqual({ type: "rows", rows: [ROW] });
    expect(panel.webview.__posted).toContainEqual({ type: "busy", busy: true });
  });

  it("replays the last rows when the webview signals it is ready", async () => {
    const ui = LinkPickerPanel.open(OPTS);
    ui.setRows([ROW]);
    const panel = win.__webviewPanels[0]!;
    panel.webview.__posted.length = 0;

    await panel.__receive({ type: "ready" });

    expect(panel.webview.__posted).toContainEqual({ type: "rows", rows: [ROW] });
  });

  it("fires cancel when the panel is disposed (window closed)", async () => {
    const ui = LinkPickerPanel.open(OPTS);
    let cancels = 0;
    ui.onCancel(() => { cancels += 1; });

    win.__webviewPanels[0]!.dispose();

    expect(cancels).toBe(1);
  });

  it("drops webview messages after a terminal confirm (dispose-safety)", async () => {
    const ui = LinkPickerPanel.open(OPTS);
    const searches: string[] = [];
    ui.onSearch((value) => searches.push(value));
    ui.onConfirm(() => { /* settle */ });
    const panel = win.__webviewPanels[0]!;

    await panel.__receive({ type: "confirm", id: "CALC-1" });
    await panel.__receive({ type: "search", value: "late" });

    expect(searches).toEqual([]);
  });

  it("close() is idempotent and stops posting to the webview", async () => {
    const ui = LinkPickerPanel.open(OPTS);
    const panel = win.__webviewPanels[0]!;
    ui.setRows([ROW]);
    const count = panel.webview.__posted.length;

    ui.close();
    ui.setRows([ROW]);

    expect(panel.webview.__posted).toHaveLength(count);
    expect(() => ui.close()).not.toThrow();
  });

  it("renders the title, placeholder, and footer hint into the html", () => {
    LinkPickerPanel.open(OPTS);
    const panel = win.__webviewPanels[0]!;

    expect(panel.webview.html).toContain("Link scenario to Xray test");
    expect(panel.webview.html).toContain("Search Xray tests");
    expect(panel.webview.html).toContain("Enter to confirm");
    expect(panel.webview.html).toContain("Esc to cancel");
  });
});
