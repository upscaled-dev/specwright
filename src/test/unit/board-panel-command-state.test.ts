import { describe, it, expect, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import { BoardPanel } from "../../traceability/board-panel";
import { PublishDialogDelegate } from "../../traceability/publish-dialog-panel";
import type { PublishDialogModel, PublishRunOption } from "../../traceability/publish-flow";

import * as board from "./helpers/board-panel-driver";
import type { ActivateMessage } from "./helpers/board-panel-driver";

const { noopDelegate, MODEL, manyScenarios, deps, posted, receive, isRender, lastRender, lastActivate, matrixTests, openReady, connectBrowserClient, restoreTab, win } = board;

afterEach(() => win.__resetWebviewPanels());

describe("BoardPanel", () => {
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

  it("rebuilds the model and re-renders on a snapshot-change event", async () => {
    let current = MODEL;
    const changes = new vscode.EventEmitter<void>();
    const { panel } = await openReady({ buildModel: () => current, onDidChange: changes.event });

    current = { ...MODEL, available: [{ key: "NEW-1", pills: [], links: [] }], mapped: [], matrix: [] };
    changes.fire();

    expect(lastRender(panel)!.available.map((t) => t.key)).toEqual(["NEW-1"]);
    expect(lastRender(panel)!.mapped).toEqual([]);
  });

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
