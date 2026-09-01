import { describe, it, expect, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import { BoardPanel } from "../../traceability/board-panel";
import { NO_PROJECT_SCOPE, ProjectScopeStore } from "../../traceability/project-scope";

import * as board from "./helpers/board-panel-driver";

const { MODEL, PROJECTS, fakeScope, manyScenarios, deps, receive, lastRender, matrixTests, openReady, connectBrowserClient, win } = board;

afterEach(() => win.__resetWebviewPanels());

describe("BoardPanel", () => {
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

  it("routes an open message to openIssue with the row key", async () => {
    const openIssue = vi.fn();
    const { panel } = await openReady({ openIssue });

    await receive(panel, { surface: "board", type: "open", key: "XNP-1" });

    expect(openIssue).toHaveBeenCalledWith("XNP-1");
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

  it("opens the sync scope picker from the button next to Sync", async () => {
    const selectSyncProjects = vi.fn();
    BoardPanel.open(deps({ selectSyncProjects }));
    const panel = win.__webviewPanels[0]!;
    const client = await connectBrowserClient(panel);

    client.dom.window.document.querySelector<HTMLButtonElement>("#sync-scope")!.click();
    await client.flushInbound();

    expect(selectSyncProjects).toHaveBeenCalledOnce();
  });

  it("keeps the scope picker shut while a sync, then a mutation, owns the board", async () => {
    const selectSyncProjects = vi.fn();
    let syncing = true;
    const { panel } = await openReady({
      selectSyncProjects,
      syncActive: () => syncing,
      mutationActive: () => !syncing,
    });

    await receive(panel, { surface: "board", type: "selectSyncProjects" });
    syncing = false;
    await receive(panel, { surface: "board", type: "selectSyncProjects" });

    expect(selectSyncProjects).not.toHaveBeenCalled();
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

  it("keeps the selection across a scope change, since scenario cards are never scoped away", async () => {
    const { panel } = await openReady();
    await receive(panel, { surface: "board", type: "select", target: "scenario", id: "id-checkout", on: true });

    await receive(panel, { surface: "board", type: "scope", project: "PAY" });

    const render = lastRender(panel)!;
    expect(render.scoped).toBe(true);
    expect(render.scenarios.filter((s) => s.selected).map((s) => s.name)).toEqual(["Checkout"]);
    expect(render.createVerb).toMatchObject({ enabled: true, label: "Create 1 test in PAY" });
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

});
