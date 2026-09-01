import { describe, it, expect, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import { BoardPanel } from "../../traceability/board-panel";
import { BoardSectionMeta } from "../../traceability/board-data";
import { mappingPageSizeStore } from "../../traceability/mapping-page-size";
import { Logger, LogLevel } from "../../utils/logger";

import * as board from "./helpers/board-panel-driver";
import type { RenderMessage } from "./helpers/board-panel-driver";

const { MODEL, LISTS, fakeScope, memento, PAGE_SIZE_KEY, manyScenarios, posted, receive, isRender, lastRender, lastActivate, openReady, win } = board;

afterEach(() => win.__resetWebviewPanels());

describe("BoardPanel", () => {
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

  it("filters both buckets on a search message via the vscode-free filter", async () => {
    const { panel } = await openReady();

    await receive(panel, { surface: "board", type: "search", value: "cart.feature" });

    const render = lastRender(panel)!;
    expect(render.scenarios.map((s) => s.name)).toEqual(["Checkout"]);
    expect(render.available).toEqual([]);
    expect(render.mapped).toEqual([]);
  });

  it("routes a drop to applyDrop with the normalized scenario and key", async () => {
    const applyDrop = vi.fn(() => Promise.resolve());
    const { panel } = await openReady({ applyDrop });

    await receive(panel, { surface: "board", type: "drop", scenario: "features/login.feature:5", key: "PAY-9" });

    expect(applyDrop).toHaveBeenCalledWith("features/login.feature:5", "PAY-9");
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
    expect(lastRender(panel)?.syncVerb).toMatchObject({ enabled: false, label: "Sync" });
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

    expect(lastRender(panel)?.syncVerb).toMatchObject({ enabled: true, label: "Sync" });
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

  it("marks a render as filtering only while a query is active, so a filtered-empty group keeps its Sync off", async () => {
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

  it("keeps the query across a search after a tab switch", async () => {
    const { panel } = await openReady();

    await receive(panel, { type: "tab", tab: "executions" });
    await receive(panel, { surface: "board", type: "search", value: "CALC" });

    expect(lastActivate(panel)).toBe("executions");
    expect(lastRender(panel)!.mapped.map((t) => t.key)).toEqual(["CALC-1"]);
  });

  it("opens on the persisted selection and clears it back to All Projects when the selector is set to All", async () => {
    const { panel } = await openReady({ projectScope: fakeScope("CALC") });
    expect(lastRender(panel)!).toMatchObject({ project: "CALC", scoped: true });
    expect(lastRender(panel)!.available).toEqual([]);

    await receive(panel, { surface: "board", type: "scope", project: "" });

    expect(lastRender(panel)!).toMatchObject({ project: "", scoped: false });
    expect(lastRender(panel)!.available.map((t) => t.key)).toEqual(["PAY-9"]);
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


});
