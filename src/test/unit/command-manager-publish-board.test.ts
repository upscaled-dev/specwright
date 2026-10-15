import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
import * as vscode from "vscode";
import { CommandManager } from "../../commands/command-manager";
import { TraceabilityCommands } from "../../commands/traceability-commands";
import { TraceabilityPublishCommands } from "../../commands/traceability-publish-commands";
import type {
  ExecutionGateway,
} from "../../core/run-contracts";
import { Logger } from "../../utils/logger";
import { ExtensionConfig } from "../../core/extension-config";
import { TestExecutor } from "../../core/test-executor";
import { RunArtifact, TraceabilityAdapter } from "../../traceability/contracts";
import { XrayAdapter } from "../../xray/xray-adapter";
import { XrayImportError } from "../../xray/execution-importers";
import { BoardPanel, BoardPanelDeps } from "../../traceability/board-panel";
import type { TraceabilitySubsystem } from "../../traceability/traceability-subsystem";
import { NO_MAPPING_PAGE_SIZE } from "../../traceability/mapping-page-size";
import { NO_PROJECT_SCOPE, ProjectScopeStore, projectScopeStore } from "../../traceability/project-scope";
import {
  ArtifactCaptureTarget,
  RunArtifactStore,
} from "../../traceability/run-artifact-store";
import { PublishLedger, PublishLedgerPersistenceError } from "../../traceability/publish-ledger";
import { AttachmentSpool } from "../../traceability/attachment-spool";
import type { TraceabilitySnapshot, TraceLink } from "../../traceability/traceability-model";
import type { ScenarioRef } from "../../traceability/scenario-ref";
import type { PreflightChoice } from "../../traceability/preflight-flow";
import { OutcomeUnknownRecoveryPersistenceError, PublishAttachmentsModel } from "../../traceability/publish-flow";
import { makeContext, memento, writeTempFeature } from "./helpers/command-manager-harness";
import { RemoteOutcomeUnknownError, WorkspaceTrust } from "../../core/workspace-trust";
import { createXrayAdapterFactory } from "../../xray/xray-adapter-factory";
import { makeFeatureStepResolver } from "../../xray/feature-step-resolver";
import { connectBrowserClient, type StubPanel } from "./helpers/board-panel-driver";
import { connected, configWith, mapCredentialStore } from "./helpers/xray-setup-driver";
import { trustedWorkspace } from "./helpers/test-workspace-trust";



// The webview-panel stub the board opens onto: `__posted` records what the host sent, `__receive`
// delivers an inbound message, and the reset disposes every panel between tests.
interface StubBoardPanel {
  title: string;
  webview: {
    html: string;
    __posted: Array<{ session: string; revision: number; surface: string; body: { type: string; [key: string]: unknown } }>;
  };
  __revealCount: number;
  dispose: () => void;
  __receive: (message: unknown) => Promise<void>;
}
const win = vscode.window as unknown as {
  __webviewPanels: StubBoardPanel[];
  __resetWebviewPanels: () => void;
};

function traceabilityCommands(manager: CommandManager): TraceabilityCommands {
  return (manager as unknown as { traceabilityCommands: TraceabilityCommands })
    .traceabilityCommands;
}


function publishCommands(manager: CommandManager): TraceabilityPublishCommands {
  return (
    traceabilityCommands(manager) as unknown as {
      getPublishCommands: () => TraceabilityPublishCommands;
    }
  ).getPublishCommands();
}

function traceabilityBoardDeps(manager: CommandManager): BoardPanelDeps {
  return (
    traceabilityCommands(manager) as unknown as {
      boardDeps: () => BoardPanelDeps;
    }
  ).boardDeps();
}

function boardPosts(panel: StubBoardPanel): Array<{ surface: string; type: string; [key: string]: unknown }> {
  return panel.webview.__posted.map((message) => ({ surface: message.surface, ...message.body }));
}

function receiveBoard(
  panel: StubBoardPanel,
  surface: string,
  body: { type: string; [key: string]: unknown }
): Promise<void> {
  const session = panel.webview.html.match(/data-session="([^"]+)"/)?.[1] ?? "";
  const revision = body.type === "ready" ? 0 : (panel.webview.__posted.at(-1)?.revision ?? 0);
  return panel.__receive({ version: 1, session, revision, surface, body });
}

describe("traceability run-and-publish entry points", () => {
  afterEach(() => {
    win.__resetWebviewPanels();
    vi.restoreAllMocks();
  });

  it("maps Explorer resources and preserves the entered tag expression unchanged", async () => {
    const manager = CommandManager.create(makeContext());
    const commands = traceabilityCommands(manager);
    const run = vi.spyOn(publishCommands(manager), "runAndPublishSelection")
      .mockResolvedValue(undefined);
    vi.spyOn(vscode.window, "showInputBox").mockImplementation(async (options) => {
      expect(await options?.validateInput?.("   ")).toBe("A tag expression is required.");
      expect(await options?.validateInput?.(" @smoke and not @wip ")).toBeUndefined();
      return " @smoke and not @wip ";
    });

    await commands.runAndPublishFeature({ fsPath: "/ws/a.feature" });
    await commands.runAndPublishFolder({ fsPath: "/ws/features" });
    await commands.runAndPublishByTagExpression();

    expect(run.mock.calls).toEqual([
      [{ kind: "feature", filePath: "/ws/a.feature" }, "explorer", expect.anything()],
      [{ kind: "folder", folderPath: "/ws/features" }, "explorer", expect.anything()],
      [{ kind: "tag-expression", expression: " @smoke and not @wip " }, "palette", expect.anything()],
    ]);
  });

  it("does not start an Explorer batch when no feature or folder resource is supplied", async () => {
    const manager = CommandManager.create(makeContext());
    const commands = traceabilityCommands(manager);
    const run = vi.spyOn(publishCommands(manager), "runAndPublishSelection")
      .mockResolvedValue(undefined);

    await commands.runAndPublishFeature();
    await commands.runAndPublishFolder({});

    expect(run).not.toHaveBeenCalled();
  });

  it("treats a cancelled tag prompt as a quiet no-op", async () => {
    const manager = CommandManager.create(makeContext());
    manager.setTraceabilitySubsystem({
      traceabilityPanelActive: true,
      getActiveAdapter: () => undefined,
      getSnapshot: () => undefined,
      tagDerivedProjectKeys: () => [],
      projectScope: () => NO_PROJECT_SCOPE,
      mappingPageSize: () => NO_MAPPING_PAGE_SIZE,
      onDidChangeSnapshot: new vscode.EventEmitter<void>().event,
    } as unknown as TraceabilitySubsystem);
    BoardPanel.open(traceabilityBoardDeps(manager));
    const panel = win.__webviewPanels[0]!;
    await receiveBoard(panel, "shell", { type: "ready" });
    const commands = traceabilityCommands(manager);
    const run = vi.spyOn(publishCommands(manager), "runAndPublishSelection")
      .mockResolvedValue(undefined);
    vi.spyOn(vscode.window, "showInputBox").mockImplementation(() => {
      const render = boardPosts(panel).filter((message) => message.type === "render").at(-1)!;
      expect((render["syncVerb"] as { enabled: boolean }).enabled).toBe(false);
      return Promise.resolve(undefined);
    });

    await commands.runAndPublishByTagExpression();

    expect(run).not.toHaveBeenCalled();
    const settled = boardPosts(panel).filter((message) => message.type === "render").at(-1)!;
    expect((settled["syncVerb"] as { enabled: boolean }).enabled).toBe(true);
  });
});

describe("traceability runAndPublish: preflight batch flow", () => {
  afterEach(() => vi.restoreAllMocks());

  const A: ScenarioRef = { filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" };
  const B: ScenarioRef = { filePath: "/ws/a.feature", line: 8, name: "B", kind: "scenario" };
  const READY_LINK: TraceLink = { testKey: "CALC-1", scenario: A, reqKeys: [], meta: { key: "CALC-1", testType: { name: "Cucumber", kind: "Gherkin" } } };
  const READY_B_LINK: TraceLink = { testKey: "CALC-2", scenario: B, reqKeys: [], meta: { key: "CALC-2", testType: { name: "Cucumber", kind: "Gherkin" } } };
  const FLAGGED_LINK: TraceLink = { testKey: "CALC-2", scenario: B, reqKeys: [], remoteMissing: true };

  function snapshot(links: TraceLink[]): TraceabilitySnapshot {
    return { links, untraced: [], orphans: [], stale: false, completeProjects: ["CALC"], errors: [] };
  }

  function harness(
    links: TraceLink[],
    scope?: ProjectScopeStore,
    executionGateway?: ExecutionGateway
  ) {
    const store = new RunArtifactStore(memento(), Logger.create());
    const runScenarioWithOutput = vi.fn((_options: unknown, _target?: ArtifactCaptureTarget) =>
      Promise.resolve({ success: true, output: "", error: "", duration: 1 })
    );
    const executor = {
      runScenarioWithOutput,
      runPathFilterWithOutput: vi.fn(),
      runAllTestsWithTagsOutput: vi.fn(),
      registerArtifactSink: vi.fn(() => ({ dispose: () => undefined })),
    };
    const config = ExtensionConfig.create();
    const mgr = CommandManager.create(makeContext({
      testExecutor: executor as unknown as TestExecutor,
      runArtifactStore: store,
      mappedScenarios: links.map((entry) => entry.scenario),
      ...(executionGateway ? { executionGateway } : {}),
    }));
    const subsystem = {
      getSnapshot: () => snapshot(links),
      getActiveAdapter: () => new XrayAdapter(config),
      rebuildNow: () => Promise.resolve(),
      projectScope: () => scope ?? NO_PROJECT_SCOPE,
      tagDerivedProjectKeys: () => [],
    } as unknown as TraceabilitySubsystem;
    mgr.setTraceabilitySubsystem(subsystem);
    return { mgr, store, runScenarioWithOutput };
  }

  function pickBy(predicate: (c: PreflightChoice) => boolean): void {
    vi.spyOn(vscode.window, "showQuickPick").mockImplementation((items) => {
      const rows = items as unknown as Array<{ choice?: PreflightChoice }>;
      const picked = rows.find((r) => r.choice !== undefined && predicate(r.choice));
      return Promise.resolve(picked as unknown as vscode.QuickPickItem | undefined);
    });
  }

  it("guides both tree and board batch actions while traceability has not synced", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const mgr = CommandManager.create(makeContext());

    await publishCommands(mgr).runAndPublish({ kind: "all-mapped" });
    await publishCommands(mgr).runAndPublishSelection({ kind: "all-mapped" });

    expect(info.mock.calls.map(([message]) => message)).toEqual([
      "Enable and sync the Traceability panel before running a batch.",
      "Enable and sync the Traceability panel before running a batch.",
    ]);
  });

  it("runs each mapped scenario in a tree multi-selection once", async () => {
    const { mgr, store, runScenarioWithOutput } = harness([READY_LINK, READY_B_LINK]);
    const first = { kind: "link", link: READY_LINK };
    const second = { kind: "link", link: READY_B_LINK };
    const untraced = {
      kind: "untraced",
      item: { scenario: { ...B, line: 12, name: "Untraced" } },
    };

    await traceabilityCommands(mgr).runAndPublish(
      first,
      [first, { kind: "testKey", testKey: "CALC-1" }, untraced, second, first, second]
    );

    expect(runScenarioWithOutput).toHaveBeenCalledTimes(2);
    expect(runScenarioWithOutput.mock.calls.map(([options]) =>
      (options as { scenarioName?: string }).scenarioName
    )).toEqual(["A", "B"]);
    expect(runScenarioWithOutput.mock.calls.map(([, target]) => target)).toEqual([
      { scenario: A, resultLines: [3] },
      { scenario: B, resultLines: [8] },
    ]);
    expect(store.latest()?.selection).toEqual({ kind: "multi-select", scenarios: [A, B] });
  });

  it("reports an untraced-only tree selection without opening a run", async () => {
    const { mgr, store, runScenarioWithOutput } = harness([]);
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const untraced = { kind: "untraced", item: { scenario: A } };

    await traceabilityCommands(mgr).runAndPublish(untraced, [untraced]);

    expect(runScenarioWithOutput).not.toHaveBeenCalled();
    expect(store.latest()).toBeUndefined();
    expect(info).toHaveBeenCalledWith("1 untraced scenario was skipped.");
    expect(info).toHaveBeenCalledWith("No mapped scenarios were selected. Nothing was run.");
  });

  it("reports an organization selection whose sealed refs no longer map, sealing no run", async () => {
    const { mgr, store, runScenarioWithOutput } = harness([READY_LINK]);
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const removed: ScenarioRef = { filePath: "/ws/removed.feature", line: 2, name: "Removed", kind: "scenario" };

    await traceabilityCommands(mgr).runAndPublish({
      kind: "organizationRun",
      selection: { kind: "test-set", testSetKey: "SHOP-301", scenarios: [removed] },
    });

    expect(runScenarioWithOutput).not.toHaveBeenCalled();
    expect(store.latest()).toBeUndefined();
    expect(info).toHaveBeenCalledWith("This selection has no scenarios mapped in this workspace. Nothing was run.");
  });

  it("keeps a single selected tree row on the single-scenario path", async () => {
    const { mgr, store, runScenarioWithOutput } = harness([READY_LINK]);
    const node = { kind: "link", link: READY_LINK };

    await traceabilityCommands(mgr).runAndPublish(node, [node, { kind: "section" }]);

    expect(runScenarioWithOutput).toHaveBeenCalledOnce();
    expect(store.latest()?.selection).toEqual({ kind: "scenario", scenario: A });
  });

  it("captures disjoint rows for a selected outline and two Examples blocks", async () => {
    const filePath = writeTempFeature([
      "Feature: Calculator",
      "",
      "@TEST_CALC-1",
      "Scenario Outline: Divide",
      "  Given <n>",
      "",
      "  Examples: common",
      "    | n |",
      "    | 1 |",
      "",
      "  @TEST_CALC-2",
      "  Examples: edge cases",
      "    | n |",
      "    | 0 |",
      "    | 2 |",
      "",
      "  @TEST_CALC-3",
      "  Examples: edge cases",
      "    | n |",
      "    | -1 |",
    ].join("\n"));
    const outline: ScenarioRef = {
      filePath,
      line: 4,
      name: "Divide",
      kind: "outline",
      outlineName: "Divide",
    };
    const block: ScenarioRef = {
      filePath,
      line: 12,
      name: "Divide · edge cases",
      kind: "examplesBlock",
      outlineName: "Divide",
      examplesBlockName: "edge cases",
    };
    const siblingBlock: ScenarioRef = {
      filePath,
      line: 18,
      name: "Divide · edge cases",
      kind: "examplesBlock",
      outlineName: "Divide",
      examplesBlockName: "edge cases",
    };
    const outlineLink: TraceLink = { ...READY_LINK, scenario: outline };
    const blockLink: TraceLink = { ...READY_B_LINK, scenario: block };
    const siblingLink: TraceLink = {
      ...READY_LINK,
      testKey: "CALC-3",
      scenario: siblingBlock,
      meta: { key: "CALC-3", testType: { name: "Cucumber", kind: "Gherkin" } },
    };
    const { mgr, runScenarioWithOutput } = harness([outlineLink, blockLink, siblingLink]);
    const first = { kind: "link", link: outlineLink };
    const second = { kind: "link", link: blockLink };
    const third = { kind: "link", link: siblingLink };

    try {
      await traceabilityCommands(mgr).runAndPublish(first, [first, second, third]);
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }

    expect(runScenarioWithOutput.mock.calls.map(([, target]) => target)).toEqual([
      { scenario: outline, resultLines: [9] },
      { scenario: block, resultLines: [14] },
      { scenario: block, resultLines: [15] },
      { scenario: siblingBlock, resultLines: [20] },
    ]);
  });

  it("resolves all-mapped, classifies, and runs each exact ref on local-only", async () => {
    const { mgr, store, runScenarioWithOutput } = harness([READY_LINK, FLAGGED_LINK]);
    pickBy((c) => c.kind === "run" && c.outcome === "local-only");
    await publishCommands(mgr).runAndPublishSelection({ kind: "all-mapped" });
    expect(runScenarioWithOutput.mock.calls.map(([options]) =>
      (options as { scenarioName?: string }).scenarioName
    )).toEqual(["A", "B"]);
    expect(store.latest()?.preflight).toEqual([
      { scenario: B, testKey: "CALC-2", state: "invalid-key", outcome: "local-only" },
    ]);
  });

  it("drops the flagged exact invocation and records its exclusion", async () => {
    const { mgr, store, runScenarioWithOutput } = harness([READY_LINK, FLAGGED_LINK]);
    pickBy((c) => c.kind === "run" && c.outcome === "exclude");
    await publishCommands(mgr).runAndPublishSelection({ kind: "all-mapped" });
    expect(runScenarioWithOutput).toHaveBeenCalledOnce();
    expect((runScenarioWithOutput.mock.calls[0]![0] as { scenarioName?: string }).scenarioName)
      .toBe("A");
    expect(store.latest()?.preflight).toEqual([
      { scenario: B, testKey: "CALC-2", state: "invalid-key", outcome: "exclude" },
    ]);
  });

  // The board shows one project at a time. Running "all mapped" from its title bar has to mean all
  // mapped in what the board is showing, or it runs (and publishes) every other project too.
  it("runs the all-mapped button inside the board's project scope", async () => {
    const payLink: TraceLink = {
      testKey: "PAY-9",
      scenario: B,
      reqKeys: [],
      meta: { key: "PAY-9", testType: { name: "Cucumber", kind: "Gherkin" } },
    };
    const { mgr, store, runScenarioWithOutput } = harness([READY_LINK, payLink], {
      get: () => "CALC",
      set: () => undefined,
    });

    await traceabilityCommands(mgr).runAndPublishAllMapped();

    expect(runScenarioWithOutput).toHaveBeenCalledOnce();
    expect((runScenarioWithOutput.mock.calls[0]![0] as { scenarioName?: string }).scenarioName)
      .toBe("A");
    expect(store.latest()?.selection).toEqual({ kind: "all-mapped", project: "CALC" });
  });

  it("runs every mapped project when the board is scoped to All Projects", async () => {
    const payLink: TraceLink = {
      testKey: "PAY-9",
      scenario: B,
      reqKeys: [],
      meta: { key: "PAY-9", testType: { name: "Cucumber", kind: "Gherkin" } },
    };
    const { mgr, store, runScenarioWithOutput } = harness([READY_LINK, payLink]);

    await traceabilityCommands(mgr).runAndPublishAllMapped();

    expect(runScenarioWithOutput.mock.calls.map(([options]) =>
      (options as { scenarioName?: string }).scenarioName
    )).toEqual(["A", "B"]);
    expect(store.latest()?.selection).toEqual({ kind: "all-mapped" });
  });

  it("runs nothing and seals nothing when the preflight is cancelled", async () => {
    const { mgr, store, runScenarioWithOutput } = harness([READY_LINK, FLAGGED_LINK]);
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    await publishCommands(mgr).runAndPublishSelection({ kind: "all-mapped" });
    expect(runScenarioWithOutput).not.toHaveBeenCalled();
    expect(store.latest()).toBeUndefined();
    expect(String(info.mock.calls.at(-1)?.[0])).toContain("cancelled");
  });

  it("runs directly with no quick-pick when every scenario is ready", async () => {
    const { mgr, store, runScenarioWithOutput } = harness([READY_LINK]);
    const quickPick = vi.spyOn(vscode.window, "showQuickPick");
    await publishCommands(mgr).runAndPublishSelection({ kind: "all-mapped" });
    expect(quickPick).not.toHaveBeenCalled();
    expect(runScenarioWithOutput).toHaveBeenCalledOnce();
    expect((runScenarioWithOutput.mock.calls[0]![0] as { scenarioName?: string }).scenarioName)
      .toBe("A");
    expect(store.latest()?.preflight).toEqual([]);
  });

  it("wires the progress cancel token to the abort controller and seals cancelled", async () => {
    const { mgr, store, runScenarioWithOutput } = harness([READY_LINK]);
    // A cancelled progress token fires immediately; the batch must abort before dispatching and seal
    // the artifact `cancelled`.
    vi.spyOn(vscode.window, "withProgress").mockImplementation((_opts, task) =>
      (task as (p: unknown, t: unknown) => Thenable<unknown>)(
        { report: () => {} },
        { isCancellationRequested: true, onCancellationRequested: (cb: () => void) => { cb(); return { dispose: () => {} }; } }
      )
    );
    await publishCommands(mgr).runAndPublishSelection({ kind: "all-mapped" });
    expect(runScenarioWithOutput).not.toHaveBeenCalled();
    expect(store.latest()?.state).toBe("cancelled");
  });
});

describe("traceability openBoard command handler", () => {
  afterEach(() => {
    win.__resetWebviewPanels();
    vi.restoreAllMocks();
  });

  function fakeSubsystem(
    panelActive = true,
    catalogueProjects: string[] = [],
    derivesProjects = true,
    ladder: { tagDerived?: string[]; directory?: string[] } = {}
  ): TraceabilitySubsystem {
    const directory = ladder.directory;
    return {
      traceabilityPanelActive: panelActive,
      getSnapshot: () => ({ links: [], untraced: [], orphans: [], stale: false, completeProjects: ["CALC"], errors: [] }),
      getActiveAdapter: () => ({
        label: "Xray",
        keyGrammar: { testPrefix: "TEST_", ...(derivesProjects ? { projectOf: (k: string) => k.split("-")[0] } : {}) },
        metadata: { snapshot: () => ({ catalogueProjects }) },
        ...(directory
          ? {
              projectDirectory: {
                cached: () => ({ projects: directory.map((key) => ({ key, name: key })), truncated: false }),
                list: () => Promise.resolve({ projects: [], truncated: false }),
              },
            }
          : {}),
      }),
      tagDerivedProjectKeys: () => ladder.tagDerived ?? [],
      projectScope: () => NO_PROJECT_SCOPE,
      mappingPageSize: () => NO_MAPPING_PAGE_SIZE,
      onDidChangeSnapshot: new vscode.EventEmitter<void>().event,
    } as unknown as TraceabilitySubsystem;
  }

  const boardDeps = (mgr: CommandManager): { knownProjects: () => readonly string[]; projectScope: ProjectScopeStore } =>
    traceabilityBoardDeps(mgr);

  const openBoard = (mgr: CommandManager): void =>
    traceabilityCommands(mgr).openBoard();

  it("opens the Coverage Board webview when the panel is active", () => {
    const mgr = CommandManager.create(makeContext());
    mgr.setTraceabilitySubsystem(fakeSubsystem());
    openBoard(mgr);
    expect(win.__webviewPanels).toHaveLength(1);
    expect(win.__webviewPanels[0]!.title).toBe("Coverage Board");
  });

  it("reveals the existing board instead of opening a second (singleton surface)", () => {
    const mgr = CommandManager.create(makeContext());
    mgr.setTraceabilitySubsystem(fakeSubsystem());
    openBoard(mgr);
    openBoard(mgr);
    expect(win.__webviewPanels).toHaveLength(1);
    expect(win.__webviewPanels[0]!.__revealCount).toBe(1);
  });

  it("guides the user and opens nothing when the traceability subsystem is not wired", () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const mgr = CommandManager.create(makeContext());
    openBoard(mgr);
    expect(win.__webviewPanels).toHaveLength(0);
    expect(String(info.mock.calls[0]?.[0])).toContain("Coverage Board");
  });

  it("seeds the board's scope selector from the sync config, the catalogue snapshot and the default key", async () => {
    const workspaceConfig = {
      get: (key: string, fallback: unknown) => {
        if (key === "xray.syncProjectKeys") { return ["calc", "shop"]; }
        return key === "xray.defaultProjectKey" ? " pay " : fallback;
      },
    } as unknown as vscode.WorkspaceConfiguration;
    const mgr = CommandManager.create(makeContext({ config: ExtensionConfig.create(workspaceConfig, false) }));
    mgr.setTraceabilitySubsystem(fakeSubsystem(true, ["SHOP", "MATH"]));

    openBoard(mgr);
    const panel = win.__webviewPanels[0]!;
    await receiveBoard(panel, "shell", { type: "ready" });

    const render = boardPosts(panel).find((m) => m.surface === "board" && m.type === "render");
    expect(render?.["projects"]).toEqual(["CALC", "MATH", "PAY", "SHOP"]);
  });

  it("offers every project the connection can reach, plus the keys the workspace's own tags name", async () => {
    const mgr = CommandManager.create(makeContext());
    mgr.setTraceabilitySubsystem(fakeSubsystem(true, [], true, { tagDerived: ["CALC"], directory: ["OPS", "pay"] }));

    openBoard(mgr);
    const panel = win.__webviewPanels[0]!;
    await receiveBoard(panel, "shell", { type: "ready" });

    const render = boardPosts(panel).find((m) => m.surface === "board" && m.type === "render");
    expect(render?.["projects"]).toEqual(["CALC", "OPS", "PAY"]);
  });

  it("offers the tag-derived keys alone when the connection enumerates no projects", () => {
    const mgr = CommandManager.create(makeContext());
    mgr.setTraceabilitySubsystem(fakeSubsystem(true, [], true, { tagDerived: ["calc"] }));

    expect(boardDeps(mgr).knownProjects()).toEqual(["CALC"]);
  });

  it("offers no scope options when the provider's grammar derives no project, since nothing could match", () => {
    const workspaceConfig = {
      get: (key: string, fallback: unknown) => (key === "xray.syncProjectKeys" ? ["CALC"] : fallback),
    } as unknown as vscode.WorkspaceConfiguration;
    const mgr = CommandManager.create(makeContext({ config: ExtensionConfig.create(workspaceConfig, false) }));
    mgr.setTraceabilitySubsystem(fakeSubsystem(true, ["SHOP"], false));

    expect(boardDeps(mgr).knownProjects()).toEqual([]);
  });

  it("hands the board the null scope store and no options when no subsystem is wired", () => {
    const deps = boardDeps(CommandManager.create(makeContext()));

    expect(deps.projectScope).toBe(NO_PROJECT_SCOPE);
    expect(deps.knownProjects()).toEqual([]);
  });

  // A board button has nowhere to return a failure to, so the log is the whole report: the message names
  // the button that started the work and the payload carries the reason.
  it("logs a rejected board mutation under the button that started it", async () => {
    const logger = Logger.create();
    const warn = vi.spyOn(logger, "warn");
    const mgr = CommandManager.create(makeContext({ logger }));
    mgr.setTraceabilitySubsystem(fakeSubsystem());
    vi.spyOn(publishCommands(mgr), "runPublish").mockRejectedValue(new Error("HTTP 500"));

    traceabilityBoardDeps(mgr).startPublish();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(warn).toHaveBeenCalledWith("Publish from the board tab failed", { error: "HTTP 500" });
  });

  it("guides the user and opens nothing when the panel is disabled (no live model)", () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const mgr = CommandManager.create(makeContext());
    mgr.setTraceabilitySubsystem(fakeSubsystem(false));
    openBoard(mgr);
    expect(win.__webviewPanels).toHaveLength(0);
    expect(String(info.mock.calls[0]?.[0])).toContain("Enable the Traceability panel");
  });

  it("pins picker checks through reload, syncs only them, and renders their catalogue in the bundled board", async () => {
    let configuredKeys: string[] | undefined;
    const workspaceConfig = {
      get: <T>(key: string, fallback?: T): T | undefined => key === "xray.syncProjectKeys"
        ? (configuredKeys as T | undefined) ?? fallback
        : key === "xray.siteUrl"
          ? "acme.atlassian.net" as T
          : key === "xray.defaultProjectKey"
            ? "MATH" as T
            : fallback,
      inspect: (key: string) => configuredKeys === undefined || key !== "xray.syncProjectKeys"
        ? { key }
        : { key, workspaceValue: configuredKeys },
      update: (key: string, value: unknown): Promise<void> => {
        if (key === "xray.syncProjectKeys") {configuredKeys = value as string[];}
        return Promise.resolve();
      },
    } as unknown as vscode.WorkspaceConfiguration;
    const context = makeContext({ config: ExtensionConfig.create(workspaceConfig, false) });
    const { store: credentials } = mapCredentialStore();
    await credentials.setCredentials("acme.atlassian.net", "client", "secret");
    await credentials.setJiraCredentials("acme.atlassian.net", "qa@example.com", "jira-token");
    const adapter = createXrayAdapterFactory(
      credentials,
      () => Promise.resolve(connected("acme.atlassian.net")),
      memento(),
      { resolveSteps: () => undefined, workspaceRootFor: () => undefined },
      trustedWorkspace()
    ).create({ config: context.config, logger: context.logger });
    const queries: string[] = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url.endsWith("/authenticate")) {return new Response(JSON.stringify("test-jwt"));}
      if (url.includes("/rest/api/3/project/search")) {
        return new Response(JSON.stringify({ values: [{ key: "APEX", name: "Apex" }], isLast: true }));
      }
      if (url.endsWith("/graphql")) {
        const { query } = JSON.parse(String(init.body)) as { query: string };
        queries.push(query);
        const selected = query.includes("CALC");
        const data = query.includes("getTestSets")
          ? { getTestSets: { total: 0, results: [] } }
          : { getTests: { total: 1, results: [{
            issueId: "42",
            jira: selected
              ? { key: "CALC-42", summary: "Selected remote test" }
              : { key: "APEX-1", summary: "Previously synced test" },
            testType: { name: "Cucumber", kind: "Gherkin" },
          }] } };
        return new Response(JSON.stringify({ data }));
      }
      throw new Error(`Unexpected remote request: ${url}`);
    });
    await adapter.metadata!.sync({ projectKeys: ["APEX"] });
    expect(adapter.metadata!.snapshot().tests.has("CALC-42")).toBe(false);
    queries.length = 0;
    let viewedProject: string | undefined = "APEX";
    const scope: ProjectScopeStore = {
      get: (known) => viewedProject !== undefined && known.includes(viewedProject) ? viewedProject : undefined,
      set: (project) => {viewedProject = project;},
    };
    const snapshot = (): TraceabilitySnapshot => {
      const remote = adapter.metadata!.snapshot();
      return {
        links: [],
        untraced: [],
        orphans: [...remote.tests.values()].map((meta) => ({ testKey: meta.key, meta })),
        stale: remote.stale,
        completeProjects: [...remote.completeProjects],
        errors: [...remote.errors],
      };
    };
    const subsystem = (): TraceabilitySubsystem => ({
      traceabilityPanelActive: true,
      connected: true,
      getActiveAdapter: () => adapter,
      getSnapshot: snapshot,
      knownTestKeys: () => ["SHOP-9"],
      tagDerivedProjectKeys: () => ["CALC", "SHOP"],
      projectScope: () => scope,
      mappingPageSize: () => NO_MAPPING_PAGE_SIZE,
      onDidChangeSnapshot: adapter.metadata!.onDidChange,
    } as unknown as TraceabilitySubsystem);
    const pickerManager = CommandManager.create(context);
    pickerManager.setTraceabilitySubsystem(subsystem());
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(workspaceConfig);
    vi.spyOn(vscode.window, "showQuickPick").mockImplementation((items) => Promise.resolve(
      (items as readonly { label: string }[]).filter((item) => item.label === "CALC") as never
    ));

    try {
      await traceabilityCommands(pickerManager).selectSyncProjects();
      expect(configuredKeys).toEqual(["CALC"]);

      const reloaded = CommandManager.create({
        ...context,
        config: ExtensionConfig.create(workspaceConfig, false),
      });
      reloaded.setTraceabilitySubsystem(subsystem());
      await traceabilityCommands(reloaded).syncTraceability();

      expect(queries.some((query) => query.includes("CALC"))).toBe(true);
      expect(queries.some((query) => query.includes("SHOP") || query.includes("MATH") || query.includes("APEX"))).toBe(false);

      vi.spyOn(vscode.window, "showQuickPick").mockResolvedValueOnce([] as never);
      await traceabilityCommands(reloaded).selectSyncProjects();
      expect(configuredKeys).toEqual([]);
      const emptyScope = CommandManager.create({
        ...context,
        config: ExtensionConfig.create(workspaceConfig, false),
      });
      emptyScope.setTraceabilitySubsystem(subsystem());
      const beforeEmptySync = queries.length;
      const info = vi.spyOn(vscode.window, "showInformationMessage");
      await traceabilityCommands(emptyScope).syncTraceability();
      expect(queries).toHaveLength(beforeEmptySync);
      expect(info).toHaveBeenLastCalledWith("No projects or tagged tests are selected to sync.");

      scope.set(undefined);
      openBoard(reloaded);
      const panel = win.__webviewPanels[0]!;
      const browser = await connectBrowserClient(panel as unknown as StubPanel);
      await browser.flushInbound();
      await browser.pumpHost();
      expect(browser.dom.window.document.body.textContent).toContain("Selected remote test");
      browser.dom.window.close();
    } finally {
      win.__resetWebviewPanels();
      await adapter.dispose?.();
      credentials.dispose();
      vi.unstubAllGlobals();
    }
  });

});

describe("traceability publishLastRun: Publish tab", () => {
  const win = vscode.window as unknown as {
    __webviewPanels: Array<{
      title: string;
      webview: {
        html: string;
        __posted: Array<{
          session: string;
          revision: number;
          surface: string;
          body: { type: string; tab?: string; [key: string]: unknown };
        }>;
      };
      __receive: (message: unknown) => Promise<void>;
      dispose: () => void;
    }>;
    __resetWebviewPanels: () => void;
  };
  type PublishPanel = (typeof win.__webviewPanels)[number];
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
  const posts = (panel: PublishPanel, type: string, surface?: string): Array<{ type: string; tab?: string; [key: string]: unknown }> =>
    panel.webview.__posted
      .filter((message) => message.body.type === type && (surface === undefined || message.surface === surface))
      .map((message) => message.body);
  const receive = (panel: PublishPanel, message: { type: string; surface?: string; [key: string]: unknown }): Promise<void> => {
    const session = panel.webview.html.match(/data-session="([^"]+)"/)?.[1] ?? "";
    const surface = message.surface ?? "shell";
    const { surface: _surface, ...body } = message;
    const revision = body.type === "ready" ? 0 : (panel.webview.__posted.at(-1)?.revision ?? 0);
    return panel.__receive({ version: 1, session, revision, surface, body });
  };

  afterEach(() => {
    win.__resetWebviewPanels();
    vi.restoreAllMocks();
  });

  function publishableArtifact(): RunArtifact {
    return {
      id: "run-1",
      createdAt: Date.UTC(2026, 6, 22, 9, 0, 0),
      results: [
        {
          scenario: { filePath: "/ws/a.feature", line: 3, name: "a", kind: "scenario" },
          testKey: "CALC-1",
          outcome: "passed",
          durationMs: 10,
          attempts: 1,
          flaky: false,
          evidenceRefs: [],
        },
      ],
      shards: [],
      selection: { kind: "all-mapped" },
      preflight: [],
      state: "complete",
    };
  }

  function scopedTo(project: string): ProjectScopeStore {
    const scope = projectScopeStore(memento(), () => undefined);
    scope.set(project);
    return scope;
  }

  it.each([false, true])("publishes to a verified Test Plan through the bundled form (correct missing key: %s)", async (correctMissingKey) => {
    const featurePath = writeTempFeature("Feature: Checkout\n\nScenario: Publish mapped checkout\n  Given a completed checkout\n");
    const context = makeContext({ config: configWith({ "xray.siteUrl": "acme.atlassian.net" }) });
    const store = new RunArtifactStore(memento(), context.logger);
    const run = publishableArtifact();
    store.append({
      ...run,
      results: [{ ...run.results[0]!, scenario: { filePath: featurePath, line: 3, name: "Publish mapped checkout", kind: "scenario" } }],
    });
    const { store: credentials } = mapCredentialStore();
    await credentials.setCredentials("acme.atlassian.net", "client", "secret");
    const adapter = createXrayAdapterFactory(
      credentials,
      () => Promise.resolve(connected("acme.atlassian.net")),
      memento(),
      { resolveSteps: makeFeatureStepResolver(context.featureParser), workspaceRootFor: () => path.dirname(featurePath) },
      trustedWorkspace()
    ).create({ config: context.config, logger: context.logger });
    const queries: string[] = [];
    const imports: Array<{ info: string; results: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url.endsWith("/authenticate")) {return new Response(JSON.stringify("test-jwt"));}
      if (url.endsWith("/graphql")) {
        const { query } = JSON.parse(String(init.body)) as { query: string };
        queries.push(query);
        return new Response(JSON.stringify({ data: { getTestPlans: { results: query.includes("PLAN-42")
          ? [{ issueId: "2042", jira: { key: "PLAN-42" } }]
          : [] } } }));
      }
      if (url.endsWith("/import/execution/cucumber/multipart")) {
        const parts = init.body as FormData;
        imports.push({
          info: await (parts.get("info") as Blob).text(),
          results: await (parts.get("results") as Blob).text(),
        });
        return new Response(JSON.stringify({ key: "CALC-100", id: "2100" }));
      }
      throw new Error(`Unexpected remote request: ${url}`);
    });
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const info = vi.spyOn(vscode.window, "showInformationMessage")
      .mockResolvedValue("Open in Jira" as never);
    const opened = vi.spyOn(vscode.env, "openExternal");
    const manager = CommandManager.create({ ...context, runArtifactStore: store });
    manager.setCredentialStore(credentials);
    manager.setTraceabilitySubsystem({
      ...connectedSubsystem(),
      getActiveAdapter: () => adapter,
      rebuildNow: () => Promise.resolve(),
    } as unknown as TraceabilitySubsystem);
    const operation = publishCommands(manager).runPublish();
    try {
      await vi.waitFor(() => expect(win.__webviewPanels).toHaveLength(1));
      const panel = win.__webviewPanels[0]!;
      const browser = await connectBrowserClient(panel as unknown as StubPanel);
      await vi.waitFor(() => expect(posts(panel, "model", "publish")).toHaveLength(1));
      await browser.pumpHost();
      const document = browser.dom.window.document;
      const plan = document.getElementById("plan") as unknown as { value: string; disabled: boolean };
      const summary = document.getElementById("summary") as unknown as { value: string };
      const publish = document.getElementById("publish") as unknown as { click(): void };
      expect(document.getElementById("subtitle")?.textContent).toContain("1 passed");
      summary.value = "Checkout results for the plan";
      plan.value = correctMissingKey ? "PLAN-999" : " plan-42 ";
      publish.click();
      await browser.flushInbound();
      if (correctMissingKey) {
        await vi.waitFor(() => expect(posts(panel, "retry", "publish")).toHaveLength(1));
        await browser.pumpHost();
        expect(error).toHaveBeenCalledWith(expect.stringContaining("No accessible Test Plan found for PLAN-999"));
        expect(imports).toEqual([]);
        expect(document.getElementById("publish-form")?.hidden).toBe(false);
        expect(document.getElementById("publish-busy")?.hidden).toBe(true);
        expect(plan.disabled).toBe(false);
        expect(plan.value).toBe("PLAN-999");
        expect(summary.value).toBe("Checkout results for the plan");
        plan.value = "plan-42";
        publish.click();
        await browser.flushInbound();
      }
      await operation;
      await browser.pumpHost();
      expect(imports).toHaveLength(1);
      expect(JSON.parse(imports[0]!.info)).toMatchObject({
        fields: { project: { key: "CALC" }, summary: "Checkout results for the plan" },
        xrayFields: { testPlanKey: "PLAN-42" },
      });
      expect(imports[0]!.results).toContain("Publish mapped checkout");
      expect(imports[0]!.results).toContain("@TEST_CALC-1");
      expect(queries).toHaveLength(correctMissingKey ? 2 : 1);
      expect(queries.every((query) => query.includes("getTestPlans(") && query.includes("limit: 1"))).toBe(true);
      expect(info).toHaveBeenCalledWith(expect.stringContaining("CALC-100"), "Open in Jira");
      await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
      expect(opened.mock.calls[0]![0].toString()).toBe("https://acme.atlassian.net/browse/CALC-100");
      expect(document.querySelector('[data-tab="executions"][role="tab"]')?.getAttribute("aria-selected")).toBe("true");
      browser.dom.window.close();
    } finally {
      win.__resetWebviewPanels();
      await operation;
      await adapter.dispose?.();
      credentials.dispose();
      vi.unstubAllGlobals();
    }
  });

  it.each([
    { failedUploads: 0, retriesAccepted: 0, attempts: 1, pending: 0, openInJira: false, extraFile: false },
    { failedUploads: 1, retriesAccepted: 1, attempts: 2, pending: 0, openInJira: false, extraFile: false },
    { failedUploads: 2, retriesAccepted: 2, attempts: 3, pending: 0, openInJira: false, extraFile: false },
    { failedUploads: 2, retriesAccepted: 1, attempts: 2, pending: 1, openInJira: false, extraFile: false },
    { failedUploads: 1, retriesAccepted: 0, attempts: 1, pending: 1, openInJira: true, extraFile: false },
    { failedUploads: 1, retriesAccepted: 0, attempts: 2, pending: 1, openInJira: false, extraFile: true },
  ])("carries Browse files into Jira with $retriesAccepted accepted retries, $pending pending files, and open $openInJira", async ({ failedUploads, retriesAccepted, attempts, pending, openInJira, extraFile }) => {
    const fixture = writeTempFeature("Feature: Evidence\nScenario: publishes\n  Given evidence\n");
    const chosen = path.join(path.dirname(fixture), "browser-evidence.json");
    fs.writeFileSync(chosen, '{"passed":true}');
    const second = path.join(path.dirname(fixture), "second-evidence.txt");
    if (extraFile) {fs.writeFileSync(second, "extra evidence");}
    const chosenFiles = extraFile ? [chosen, second] : [chosen];
    const { store: credentials } = mapCredentialStore();
    await credentials.setJiraCredentials("acme.atlassian.net", "qa@example.com", "jira-token");
    const picked = vi.spyOn(vscode.window, "showOpenDialog")
      .mockResolvedValue(chosenFiles.map((file) => vscode.Uri.file(file)));
    const spoolRoot = path.join(path.dirname(fixture), "storage");
    const noFollowFlag = process.platform === "win32"
      ? fs.constants.UV_FS_O_FILEMAP
      : fs.constants.O_NOFOLLOW;
    const supportedSpool = new AttachmentSpool(
      spoolRoot, Logger.create(), Date.now, { noFollowFlag }
    );
    const realSeal = AttachmentSpool.prototype.seal;
    const realRead = AttachmentSpool.prototype.read;
    const seal = vi.spyOn(AttachmentSpool.prototype, "seal")
      .mockImplementation((paths) => realSeal.call(supportedSpool, paths));
    vi.spyOn(AttachmentSpool.prototype, "read")
      .mockImplementation((snapshot) => realRead.call(supportedSpool, snapshot));
    const ledger = new PublishLedger(memento(), Logger.create());
    const publish = vi.fn().mockResolvedValue({
      ref: { kind: "execution", key: "XNP-1" }, imported: 1, warnings: [],
    });
    const uploads: Array<{ url: string; name: string; contents: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      if (url.endsWith("/attachment/meta")) {
        return new Response(JSON.stringify({ enabled: true, uploadLimit: 1024 }));
      }
      if (url.endsWith("/issue/XNP-1/attachments")) {
        const file = (init.body as FormData).get("file") as File;
        uploads.push({ url, name: file.name, contents: await file.text() });
        if (uploads.length <= failedUploads) {
          return new Response("Attachment rejected", { status: 400 });
        }
        return new Response(JSON.stringify([{ id: "attachment-1" }]));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const context = makeContext({
      runArtifactStore: store,
      config: configWith({ "xray.siteUrl": "acme.atlassian.net" }),
      attachmentSpoolRoot: spoolRoot,
    });
    const manager = CommandManager.create(context);
    manager.setCredentialStore(credentials);
    manager.setPublishLedger(ledger);
    manager.setTraceabilitySubsystem({
      ...connectedSubsystem([], NO_PROJECT_SCOPE, publish,
        openInJira ? "https://acme.atlassian.net/browse/XNP-1" : undefined),
      rebuildNow: () => Promise.resolve(),
    } as TraceabilitySubsystem);
    const operation = publishCommands(manager).runPublish();

    try {
      await vi.waitFor(() => expect(win.__webviewPanels).toHaveLength(1));
      const panel = win.__webviewPanels[0]!;
      const received = vi.spyOn(panel, "__receive");
      const browser = await connectBrowserClient(panel as unknown as StubPanel);
      await vi.waitFor(() => expect(posts(panel, "model", "publish")).toHaveLength(1));
      await browser.pumpHost();
      const document = browser.dom.window.document;
      expect(document.getElementById("browse")?.hidden).toBe(false);

      document.getElementById("browse")!.click();
      await browser.flushInbound();
      expect(picked).toHaveBeenCalledWith({ canSelectMany: true, openLabel: "Attach" });
      await browser.pumpHost();
      expect(document.getElementById("attach-list")?.textContent).toContain("browser-evidence.json");
      expect(document.getElementById("attach-list")?.textContent).toContain("15 B");

      (document.getElementById("project") as HTMLInputElement).value = "CALC";
      (document.getElementById("summary") as HTMLInputElement).value = "Evidence run";
      const warning = vi.spyOn(vscode.window, "showWarningMessage");
      const opened = vi.spyOn(vscode.env, "openExternal");
      for (let attempt = 0; attempt < retriesAccepted; attempt += 1) {
        warning.mockResolvedValueOnce("Retry" as never);
      }
      if (openInJira) {warning.mockResolvedValueOnce("Open in Jira" as never);}
      document.getElementById("publish")!.click();
      await browser.flushInbound();
      await operation;
      if (failedUploads > 0) {
        await vi.waitFor(() => expect(uploads).toHaveLength(attempts));
        expect(warning).toHaveBeenCalledWith(
          expect.stringContaining(extraFile
            ? "1 file attached · 1 attachment failed"
            : "1 attachment failed"), "Retry",
          ...(openInJira ? ["Open in Jira"] : [])
        );
      }
      if (openInJira) {
        await vi.waitFor(() => expect(opened).toHaveBeenCalledOnce());
        expect(opened.mock.calls[0]?.[0].toString()).toBe("https://acme.atlassian.net/browse/XNP-1");
      }

      expect(received).toHaveBeenCalledWith(expect.objectContaining({
        surface: "publish",
        body: expect.objectContaining({ type: "confirm", attachments: chosenFiles }),
      }));
      expect(seal).toHaveBeenCalledWith(chosenFiles);
      expect(uploads).toEqual(Array.from({ length: attempts }, (_, index) => ({
        url: "https://acme.atlassian.net/rest/api/3/issue/XNP-1/attachments",
        name: extraFile && index === 1 ? "second-evidence.txt" : "browser-evidence.json",
        contents: extraFile && index === 1 ? "extra evidence" : '{"passed":true}',
      })));
      expect(publish).toHaveBeenCalledOnce();
      expect(ledger.find("run-1", "acme.atlassian.net")?.pendingAttachments).toEqual(pending === 0
        ? []
        : [expect.objectContaining({ name: "browser-evidence.json", size: 15 })]);
      browser.dom.window.close();
    } finally {
      win.__resetWebviewPanels();
      credentials.dispose();
      vi.unstubAllGlobals();
      fs.rmSync(path.dirname(fixture), { recursive: true, force: true });
    }
  });

  it("uses a tracker search suggestion as the plan key in the confirmed publish request", async () => {
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const { store: credentials } = mapCredentialStore();
    await credentials.setJiraCredentials("acme.atlassian.net", "qa@example.com", "jira-token");
    vi.stubGlobal("fetch", async (url: string) => {
      if (url.endsWith("/attachment/meta")) {
        return new Response(JSON.stringify({ enabled: false }));
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    const subsystem = connectedSubsystem();
    const publishing = subsystem.getActiveAdapter()!.resultPublishing!;
    const search = vi.spyOn(publishing, "searchTargets").mockResolvedValue([{
      id: "2042",
      label: "PLAN-42 · Checkout release",
      ref: { key: "PLAN-42" },
    }]);
    const publish = vi.spyOn(publishing, "publish").mockResolvedValue({
      ref: { kind: "execution", key: "XNP-9" }, imported: 1, warnings: [],
    });
    const manager = CommandManager.create(makeContext({
      runArtifactStore: store,
      config: configWith({ "xray.siteUrl": "acme.atlassian.net" }),
    }));
    manager.setCredentialStore(credentials);
    manager.setTraceabilitySubsystem({
      ...subsystem,
      rebuildNow: () => Promise.resolve(),
    } as TraceabilitySubsystem);
    const operation = publishCommands(manager).runPublish();

    try {
      await vi.waitFor(() => expect(win.__webviewPanels).toHaveLength(1));
      const panel = win.__webviewPanels[0]!;
      const browser = await connectBrowserClient(panel as unknown as StubPanel);
      await vi.waitFor(() => expect(posts(panel, "model", "publish")).toHaveLength(1));
      await browser.pumpHost();
      const document = browser.dom.window.document;
      const plan = document.getElementById("plan") as HTMLInputElement;
      plan.value = "PLAN";
      plan.dispatchEvent(new browser.dom.window.Event("input", { bubbles: true }));
      await vi.waitFor(() => expect(search).toHaveBeenCalledWith("test-plan", "PLAN", expect.anything()));
      await browser.pumpHost();
      const suggestion = document.querySelector("#plan-results li");
      expect(suggestion?.textContent).toBe("PLAN-42 · Checkout release");
      suggestion!.dispatchEvent(new browser.dom.window.MouseEvent("mousedown", { bubbles: true }));
      expect(plan.value).toBe("PLAN-42");

      (document.getElementById("project") as HTMLInputElement).value = "CALC";
      (document.getElementById("summary") as HTMLInputElement).value = "Checkout release results";
      document.getElementById("publish")!.click();
      await browser.flushInbound();
      await operation;

      expect(publish).toHaveBeenCalledWith(
        expect.objectContaining({ id: "run-1" }),
        expect.objectContaining({ testPlanKey: "PLAN-42", summary: "Checkout release results" }),
        expect.anything()
      );
      browser.dom.window.close();
    } finally {
      win.__resetWebviewPanels();
      await operation;
      credentials.dispose();
      vi.unstubAllGlobals();
    }
  });

  function connectedSubsystem(
    catalogueProjects: string[] = [],
    scope: ProjectScopeStore = NO_PROJECT_SCOPE,
    publish: () => Promise<unknown> = () =>
      Promise.resolve({ ref: { kind: "execution", key: "XNP-1" }, imported: 1, warnings: [] }),
    browseUrl?: string
  ): TraceabilitySubsystem {
    const adapter = {
      id: "xray",
      label: "Xray",
      keyGrammar: { testPrefix: "TEST_", reqPrefix: "REQ_", projectOf: (k: string) => k.split("-")[0] },
      browseUrl: () => browseUrl,
      metadata: { snapshot: () => ({ catalogueProjects }) },
      resultPublishing: {
        searchTargets: () => Promise.resolve([]),
        publish,
      },
    } as unknown as TraceabilityAdapter;
    return {
      traceabilityPanelActive: true,
      getActiveAdapter: () => adapter,
      getSnapshot: () => undefined,
      tagDerivedProjectKeys: () => [],
      projectScope: () => scope,
      mappingPageSize: () => NO_MAPPING_PAGE_SIZE,
      onDidChangeSnapshot: new vscode.EventEmitter<void>().event,
    } as unknown as TraceabilitySubsystem;
  }

  it("opens the board and presents the run model on the Publish tab", async () => {
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(makeContext({ runArtifactStore: store }));
    mgr.setTraceabilitySubsystem(connectedSubsystem());

    const promise = publishCommands(mgr).runPublish();
    await flush();

    const panel = win.__webviewPanels[0]!;
    expect(panel.title).toBe("Coverage Board");
    await receive(panel, { type: "ready" });
    expect(posts(panel, "model", "publish")[0]).toBeDefined();

    // Cancel resolves the present so the flow (and its finally) unwinds.
    await receive(panel, { surface: "publish", type: "cancel" });
    await promise;
  });

  it("shows discovered report bundles with real sizes in the Publish form", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specwright-report-suggestions-"));
    const report = path.join(root, "report.zip");
    fs.writeFileSync(report, "zip contents");
    const missing = path.join(root, "removed.zip");
    const findFiles = vi.spyOn(vscode.workspace, "findFiles").mockImplementation(async (glob) =>
      glob === "artifacts/*.zip"
        ? [vscode.Uri.file(report), vscode.Uri.file(missing)]
        : [vscode.Uri.file(report)]
    );
    const { store: credentials } = mapCredentialStore();
    await credentials.setJiraCredentials("acme.atlassian.net", "qa@example.com", "jira-token");
    vi.stubGlobal("fetch", async (url: string) => {
      expect(url).toBe("https://acme.atlassian.net/rest/api/3/attachment/meta");
      return new Response(JSON.stringify({ enabled: true, uploadLimit: 1024 }));
    });
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(makeContext({
      runArtifactStore: store,
      config: configWith({
        "xray.siteUrl": "acme.atlassian.net",
        "xray.reportGlob": ["artifacts/*.zip", "playwright-report/*.zip"],
        "xray.attachTo": "both",
      }),
    }));
    mgr.setCredentialStore(credentials);
    mgr.setTraceabilitySubsystem(connectedSubsystem());
    const operation = publishCommands(mgr).runPublish();

    try {
      await vi.waitFor(() => expect(win.__webviewPanels).toHaveLength(1));
      const panel = win.__webviewPanels[0]!;
      await receive(panel, { type: "ready" });
      await vi.waitFor(() => expect(posts(panel, "model", "publish")).toHaveLength(1));
      const model = posts(panel, "model", "publish")[0]?.["model"] as { attachments: PublishAttachmentsModel };
      expect(model.attachments).toMatchObject({
        available: true,
        uploadLimitBytes: 1024,
        evidenceStream: "both",
        suggestions: [{ path: report, name: "report.zip", size: 12 }],
      });
      expect(findFiles.mock.calls.map(([glob]) => glob)).toEqual(["artifacts/*.zip", "playwright-report/*.zip"]);
      await receive(panel, { surface: "publish", type: "cancel" });
      await operation;
    } finally {
      credentials.dispose();
      vi.unstubAllGlobals();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("explains missing Jira credentials in the Publish form without discovering report files", async () => {
    const findFiles = vi.spyOn(vscode.workspace, "findFiles");
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(makeContext({
      runArtifactStore: store,
      config: configWith({ "xray.reportGlob": ["artifacts/*.zip"] }),
    }));
    mgr.setTraceabilitySubsystem(connectedSubsystem());
    const operation = publishCommands(mgr).runPublish();

    await vi.waitFor(() => expect(win.__webviewPanels).toHaveLength(1));
    const panel = win.__webviewPanels[0]!;
    await receive(panel, { type: "ready" });
    await vi.waitFor(() => expect(posts(panel, "model", "publish")).toHaveLength(1));
    const model = posts(panel, "model", "publish")[0]?.["model"] as { attachments: PublishAttachmentsModel };
    expect(model.attachments).toMatchObject({
      available: false,
      reason: expect.stringContaining("Add Jira access"),
      suggestions: [],
    });
    expect(findFiles).not.toHaveBeenCalled();
    await receive(panel, { surface: "publish", type: "cancel" });
    await operation;
  });

  it("seeds the dialog's project keys from the sync config, the catalogue snapshot and the default key", async () => {
    const workspaceConfig = {
      get: (key: string, fallback: unknown) => {
        if (key === "xray.syncProjectKeys") { return ["calc", "shop"]; }
        return key === "xray.defaultProjectKey" ? " pay " : fallback;
      },
    } as unknown as vscode.WorkspaceConfiguration;
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(
      makeContext({ runArtifactStore: store, config: ExtensionConfig.create(workspaceConfig, false) })
    );
    mgr.setTraceabilitySubsystem(connectedSubsystem(["SHOP", "MATH"]));

    const promise = publishCommands(mgr).runPublish();
    await flush();
    const panel = win.__webviewPanels[0]!;
    await receive(panel, { type: "ready" });

    const model = posts(panel, "model", "publish")[0] as unknown as {
      model: { knownProjectKeys: string[] };
    };
    expect(model.model.knownProjectKeys).toEqual(["CALC", "MATH", "PAY", "SHOP"]);

    await receive(panel, { surface: "publish", type: "cancel" });
    await promise;
  });

  // The run's only key is CALC-1, so a scope of SHOP is the sole source of a SHOP prefill and the
  // dropdown's CALC is the sole proof the derived key survived the override.
  const syncKeysConfig = (keys: string[]): ExtensionConfig =>
    ExtensionConfig.create(
      {
        get: (key: string, fallback: unknown) => (key === "xray.syncProjectKeys" ? keys : fallback),
      } as unknown as vscode.WorkspaceConfiguration,
      false
    );

  async function publishModel(mgr: CommandManager): Promise<{
    knownProjectKeys: string[];
    runs: Array<{ project: { value: string; fromDerivation: boolean; fromScope?: boolean } }>;
  }> {
    const promise = publishCommands(mgr).runPublish();
    await flush();
    const panel = win.__webviewPanels[0]!;
    await receive(panel, { type: "ready" });
    const posted = posts(panel, "model", "publish")[0] as unknown as {
      model: {
        knownProjectKeys: string[];
        runs: Array<{ project: { value: string; fromDerivation: boolean; fromScope?: boolean } }>;
      };
    };
    await receive(panel, { surface: "publish", type: "cancel" });
    await promise;
    return posted.model;
  }

  it("prefills the dialog from the board's persisted scope, keeping the derived key in the dropdown", async () => {
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(makeContext({ runArtifactStore: store, config: syncKeysConfig(["shop"]) }));
    mgr.setTraceabilitySubsystem(connectedSubsystem([], scopedTo("SHOP")));

    const model = await publishModel(mgr);

    expect(model.runs[0]!.project).toEqual({ value: "SHOP", fromDerivation: false, fromScope: true });
    expect(model.knownProjectKeys).toContain("CALC");
  });

  it("falls back to the derived prefill when the persisted scope is no longer a known project", async () => {
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(makeContext({ runArtifactStore: store, config: syncKeysConfig(["shop"]) }));
    mgr.setTraceabilitySubsystem(connectedSubsystem([], scopedTo("PAY")));

    const model = await publishModel(mgr);

    expect(model.runs[0]!.project).toEqual({ value: "CALC", fromDerivation: true });
  });

  it("leaves the prefill on the run's derived key when the board has no scope store", async () => {
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(makeContext({ runArtifactStore: store }));
    mgr.setTraceabilitySubsystem(connectedSubsystem());

    const model = await publishModel(mgr);

    expect(model.runs[0]!.project).toEqual({ value: "CALC", fromDerivation: true });
  });

  const CONFIRM = {
    type: "confirm",
    runId: "run-1",
    request: { mode: "create-new", project: "CALC", summary: "Nightly" },
    attachments: [] as string[],
  };

  it("admits one command-level publish across distinct entry points, then permits the next", async () => {
    let releaseImport: (() => void) | undefined;
    let imports = 0;
    const publish = vi.fn(() => {
      imports += 1;
      if (imports > 1) {
        return Promise.resolve({ ref: { kind: "execution" as const, key: "XNP-2" }, imported: 1, warnings: [] });
      }
      return new Promise<unknown>((resolve) => {
        releaseImport = () => resolve({ ref: { kind: "execution", key: "XNP-1" }, imported: 1, warnings: [] });
      });
    });
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(makeContext({ runArtifactStore: store }));
    mgr.setTraceabilitySubsystem(connectedSubsystem([], NO_PROJECT_SCOPE, publish));
    const commands = publishCommands(mgr);

    const first = commands.runPublish();
    await flush();
    const panel = win.__webviewPanels[0]!;
    await receive(panel, { type: "ready" });
    await vi.waitFor(() => {
      expect(posts(panel, "model", "publish")).toHaveLength(1);
    });
    const syncEnabled = (): boolean => (
      posts(panel, "render", "board").at(-1)?.["syncVerb"] as { enabled: boolean }
    ).enabled;
    expect(syncEnabled()).toBe(false);
    await receive(panel, { surface: "publish", ...CONFIRM });
    await vi.waitFor(() => expect(publish).toHaveBeenCalledOnce());
    expect(syncEnabled()).toBe(false);
    const modelCount = posts(panel, "model", "publish").length;

    const joined = commands.publishLastRun();
    expect(joined).toBe(first);
    await flush();
    expect(win.__webviewPanels).toHaveLength(1);
    expect(posts(panel, "model", "publish")).toHaveLength(modelCount);
    expect(publish).toHaveBeenCalledOnce();

    releaseImport!();
    await Promise.all([first, joined]);
    expect(syncEnabled()).toBe(true);

    const later = commands.publishLastRun();
    await vi.waitFor(() => {
      expect(posts(panel, "model", "publish")).toHaveLength(modelCount + 1);
    });
    await receive(panel, { surface: "publish", ...CONFIRM });
    await later;
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("keeps Sync disabled for the full admitted pending-attachment upload", async () => {
    let release!: () => void;
    const upload = new Promise<{ remaining: number }>((resolve) => {
      release = () => resolve({ remaining: 0 });
    });
    const mgr = CommandManager.create(makeContext());
    mgr.setTraceabilitySubsystem(connectedSubsystem());
    const commands = publishCommands(mgr);
    const attach = vi.spyOn(
      commands as unknown as {
        attachPendingForRun(runId: string, site: string): Promise<{ remaining: number }>;
      },
      "attachPendingForRun"
    ).mockReturnValue(upload);
    BoardPanel.open(traceabilityBoardDeps(mgr));
    const panel = win.__webviewPanels[0]!;
    await receive(panel, { type: "ready" });

    const pending = commands.publishDelegate().attachPending("run-1");
    const syncEnabled = (): boolean => (
      posts(panel, "render", "board").at(-1)?.["syncVerb"] as { enabled: boolean }
    ).enabled;
    expect(syncEnabled()).toBe(false);
    expect(attach).toHaveBeenCalledOnce();

    release();
    await pending;

    expect(syncEnabled()).toBe(true);
  });

  it("retires command-level admission after a failed publish is cancelled", async () => {
    let imports = 0;
    const publish = vi.fn(() => {
      imports += 1;
      return imports === 1
        ? Promise.reject(new Error("HTTP 400"))
        : Promise.resolve({ ref: { kind: "execution" as const, key: "XNP-2" }, imported: 1, warnings: [] });
    });
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(makeContext({ runArtifactStore: store }));
    mgr.setTraceabilitySubsystem(connectedSubsystem([], NO_PROJECT_SCOPE, publish));
    const commands = publishCommands(mgr);

    const failed = commands.runPublish();
    await flush();
    const panel = win.__webviewPanels[0]!;
    await receive(panel, { type: "ready" });
    await vi.waitFor(() => {
      expect(posts(panel, "model", "publish")).toHaveLength(1);
    });
    await receive(panel, { surface: "publish", ...CONFIRM });
    await vi.waitFor(() => {
      expect(posts(panel, "retry", "publish")).toHaveLength(1);
    });
    await receive(panel, { surface: "publish", type: "cancel" });
    await failed;

    const later = commands.publishLastRun();
    const modelCount = posts(panel, "model", "publish").length;
    await vi.waitFor(() => {
      expect(posts(panel, "model", "publish")).toHaveLength(modelCount + 1);
    });
    await receive(panel, { surface: "publish", ...CONFIRM });
    await later;
    expect(publish).toHaveBeenCalledTimes(2);
  });

  it("retires command-level admission when setup rejects", async () => {
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(makeContext({ runArtifactStore: store }));
    const connected = connectedSubsystem();
    const adapter = connected.getActiveAdapter();
    let rejectSetup = true;
    mgr.setTraceabilitySubsystem({
      ...connected,
      getActiveAdapter: () => {
        if (rejectSetup) {
          rejectSetup = false;
          throw new Error("adapter unavailable");
        }
        return adapter;
      },
    } as TraceabilitySubsystem);
    const commands = publishCommands(mgr);

    await expect(commands.runPublish()).rejects.toThrow("adapter unavailable");

    const later = commands.publishLastRun();
    await flush();
    const panel = win.__webviewPanels[0]!;
    await receive(panel, { type: "ready" });
    await vi.waitFor(() => expect(posts(panel, "model", "publish")).toHaveLength(1));
    await receive(panel, { surface: "publish", type: "cancel" });
    await expect(later).resolves.toBeUndefined();
  });

  // One publish driven to completion: open the dialog and answer it with each reply in turn (a failed
  // import leaves the dialog live on the picked run, so its retry takes an answer of its own), then report
  // the tabs the shell was told to activate and how many board rebuilds the flow forced.
  async function publishOnce(
    replies: Array<Record<string, unknown>>,
    over: {
      publish?: () => Promise<unknown>;
      rebuild?: () => Promise<void>;
      attachments?: PublishAttachmentsModel;
      ledger?: PublishLedger;
      signal?: AbortSignal;
    } = {}
  ): Promise<{ tabs: Array<string | undefined>; rebuilds: number }> {
    let rebuilds = 0;
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(makeContext({ runArtifactStore: store }));
    if (over.ledger) {mgr.setPublishLedger(over.ledger);}
    mgr.setTraceabilitySubsystem({
      ...connectedSubsystem([], NO_PROJECT_SCOPE, over.publish),
      rebuildNow: () => {
        rebuilds += 1;
        return over.rebuild?.() ?? Promise.resolve();
      },
    } as unknown as TraceabilitySubsystem);
    const commands = publishCommands(mgr);
    if (over.attachments !== undefined) {
      vi.spyOn(
        commands as unknown as { buildPublishAttachments: () => Promise<PublishAttachmentsModel> },
        "buildPublishAttachments"
      ).mockResolvedValue(over.attachments);
    }

    const promise = commands.runPublish(undefined, over.signal);
    await flush();
    const panel = win.__webviewPanels[0]!;
    await receive(panel, { type: "ready" });
    for (const reply of replies) {
      await receive(panel, { surface: "publish", type: String(reply["type"]), ...reply });
      await flush();
    }
    await expect(promise).resolves.toBeUndefined();
    return { tabs: posts(panel, "activate", "shell").map((message) => message.tab), rebuilds };
  }

  // The settle leaves the Publish tab on its idle hint, so a publish that landed has to hand the user the
  // row it just created: rebuild the board first, then bring the Executions tab forward.
  it("rebuilds the board and shows the Executions tab after a successful publish", async () => {
    const { tabs, rebuilds } = await publishOnce([CONFIRM]);

    expect(rebuilds).toBe(1);
    expect(tabs.at(-1)).toBe("executions");
  });

  // A partial upload still landed the import, so the row is real and the board must carry it. The tab
  // stays put: the warning toast owns the retry.
  it("rebuilds the board but stays off the Executions tab when attachments partly fail", async () => {
    const evidence = path.join("/tmp/specwright-command-tests", "evidence.png");
    vi.spyOn(AttachmentSpool.prototype, "seal").mockReturnValue([{
      ref: "00000001-0000-4000-8000-000000000000",
      name: "evidence.png",
      size: 8,
      sha256: "a".repeat(64),
      createdAt: 1,
    }]);
    const { tabs, rebuilds } = await publishOnce([{ ...CONFIRM, attachments: [evidence] }], {
      attachments: {
        available: true,
        suggestions: [{ path: evidence, name: "evidence.png", size: 8 }],
        uploadLimitBytes: 1_024,
        evidenceStream: "evidence",
      },
    });

    expect(rebuilds).toBe(1);
    expect(tabs).not.toContain("executions");
  });

  it("records a pending attachment when cancellation follows a landed import", async () => {
    const evidence = path.join("/tmp/specwright-command-tests", "evidence.png");
    const snapshot = {
      ref: "00000001-0000-4000-8000-000000000000",
      name: "evidence.png", size: 8, sha256: "a".repeat(64), createdAt: 1,
    };
    vi.spyOn(AttachmentSpool.prototype, "seal").mockReturnValue([snapshot]);
    const signal = new AbortController();
    const ledger = new PublishLedger(memento(), Logger.create());
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const publish = vi.fn(async () => {
      signal.abort(new Error("The board closed after import"));
      return { ref: { kind: "execution" as const, key: "XNP-1" }, imported: 1, warnings: [] };
    });

    await publishOnce([{ ...CONFIRM, attachments: [evidence] }], {
      signal: signal.signal, ledger, publish,
      attachments: {
        available: true,
        suggestions: [{ path: evidence, name: "evidence.png", size: 8 }],
        uploadLimitBytes: 1_024,
        evidenceStream: "evidence",
      },
    });

    expect(publish).toHaveBeenCalledOnce();
    expect(ledger.find("run-1", "")?.pendingAttachments).toEqual([snapshot]);
    expect(info.mock.calls.map((call) => String(call[0])).join("\n"))
      .toContain("Publish cancelled · 1 attachment pending");
  });

  // A failed import keeps the dialog on the run the user picked, so the flow ends only once they answer
  // the retry; cancelling it settles the tab with nothing rebuilt.
  it("neither rebuilds nor switches tabs when the publish fails", async () => {
    const { tabs, rebuilds } = await publishOnce([CONFIRM, { type: "cancel" }], {
      publish: () => Promise.reject(new Error("HTTP 400")),
    });

    expect(rebuilds).toBe(0);
    expect(tabs).not.toContain("executions");
  });

  it.each([
    { status: 400, detail: "Project CALC is not permitted", toast: "Publish failed: Project CALC is not permitted" },
    { status: 503, detail: undefined, toast: "Publish failed: HTTP 503" },
  ])("shows the tracker import error without claiming a published run (HTTP $status)", async ({ status, detail, toast }) => {
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const { rebuilds } = await publishOnce([CONFIRM, { type: "cancel" }], {
      publish: () => Promise.reject(new XrayImportError(status, detail)),
    });

    expect(error).toHaveBeenCalledWith(toast);
    expect(rebuilds).toBe(0);
  });

  it("shows a rejection from an unexpected tracker integration as a publish failure", async () => {
    const error = vi.spyOn(vscode.window, "showErrorMessage");

    const { rebuilds } = await publishOnce([CONFIRM, { type: "cancel" }], {
      publish: () => Promise.reject("tracker gateway unavailable"),
    });

    expect(error).toHaveBeenCalledWith("Publish failed: tracker gateway unavailable");
    expect(rebuilds).toBe(0);
  });

  it("warns that the remote result may have landed when its recovery record cannot be saved", async () => {
    const ledger = new PublishLedger(memento(), Logger.create());
    const record = vi.spyOn(ledger, "record")
      .mockRejectedValue(new PublishLedgerPersistenceError(new Error("disk full")));
    const publish = vi.fn().mockResolvedValue({
      ref: { kind: "execution", key: "XNP-1" }, imported: 1, warnings: [],
    });
    const error = vi.spyOn(vscode.window, "showErrorMessage");

    await publishOnce([CONFIRM], { ledger, publish });

    expect(publish).toHaveBeenCalledOnce();
    expect(record).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Results may have been published, but recovery state was not saved"));
    expect(error.mock.calls.at(-1)?.[0]).toContain("disk full");
  });

  it("keeps the published execution on the ledger when issue evidence cannot be sealed", async () => {
    const ledger = new PublishLedger(memento(), Logger.create());
    const publish = vi.fn().mockResolvedValue({
      ref: { kind: "execution", key: "XNP-1" }, imported: 1, warnings: [],
      issueEvidenceFiles: ["/ws/missing-evidence.json"],
    });
    const error = vi.spyOn(vscode.window, "showErrorMessage");

    await publishOnce([CONFIRM], { ledger, publish });

    expect(publish).toHaveBeenCalledOnce();
    expect(ledger.find("run-1", "")?.executionRef).toBe("XNP-1");
    expect(error).toHaveBeenCalledWith(expect.stringContaining("Results were published to XNP-1, but local attachment sealing failed"));
  });

  it("publishes the picked run again on the retry that follows a failure", async () => {
    let attempts = 0;
    const { tabs, rebuilds } = await publishOnce([CONFIRM, CONFIRM], {
      publish: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("HTTP 400"))
          : Promise.resolve({ ref: { kind: "execution", key: "XNP-1" }, imported: 1, warnings: [] });
      },
    });

    expect(attempts).toBe(2);
    expect(rebuilds).toBe(1);
    expect(tabs.at(-1)).toBe("executions");
  });

  it("reports an ambiguous mutation as outcome unknown, never as publish failed", async () => {
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    const error = vi.spyOn(vscode.window, "showErrorMessage");

    await publishOnce([CONFIRM], {
      publish: () => Promise.reject(new RemoteOutcomeUnknownError("Publishing results", "publish-unknown")),
    });

    expect(String(warning.mock.calls.at(-1)?.[0])).toContain("Publish outcome unknown");
    expect(error.mock.calls.flat().map(String).join("\n")).not.toContain("Publish failed");
  });

  it("keeps a recovery persistence failure visibly outcome unknown", async () => {
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const combined = new OutcomeUnknownRecoveryPersistenceError(
      new RemoteOutcomeUnknownError("Publishing results", "publish-unknown"),
      new Error("disk full")
    );

    await publishOnce([CONFIRM, { type: "cancel" }], { publish: () => Promise.reject(combined) });

    const message = String(warning.mock.calls.at(-1)?.[0]);
    expect(message).toContain("Publish outcome unknown");
    expect(message).toContain("possibly succeeded");
    expect(message).toContain("publish-unknown");
    expect(message).toContain("local recovery record could not be saved");
    expect(error).not.toHaveBeenCalled();
  });

  it("neither rebuilds nor switches tabs on cancel, routing back to the Mapping tab", async () => {
    const { tabs, rebuilds } = await publishOnce([{ type: "cancel" }]);

    expect(rebuilds).toBe(0);
    expect(tabs.at(-1)).toBe("mapping");
  });

  // A repaint that faulted has no new row on it, so the user is left on the Publish tab with the toast
  // rather than in front of an Executions table that is missing what they just published.
  it("stays off the Executions tab when the board rebuild fails", async () => {
    const { tabs, rebuilds } = await publishOnce([CONFIRM], {
      rebuild: () => Promise.reject(new Error("discovery down")),
    });

    expect(rebuilds).toBe(1);
    expect(tabs).not.toContain("executions");
  });

  // Closing the board is the publish's cancellation: the controller it opened with aborts, the import
  // that was in flight comes back rejected, and the flow says cancelled rather than raising a failure.
  it("cancels an in-flight publish when the board closes, reporting cancellation not a failure", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(makeContext({ runArtifactStore: store }));
    mgr.setTraceabilitySubsystem(
      connectedSubsystem([], NO_PROJECT_SCOPE, () => {
        win.__webviewPanels[0]!.dispose();
        return Promise.reject(new Error("The operation was aborted"));
      })
    );

    const promise = publishCommands(mgr).runPublish();
    await flush();
    const panel = win.__webviewPanels[0]!;
    await receive(panel, { type: "ready" });
    await receive(panel, { surface: "publish", ...CONFIRM });
    await promise;

    expect(info.mock.calls.map((call) => String(call[0]))).toContain("Publish cancelled.");
    expect(error).not.toHaveBeenCalled();
  });

  it("does not start a publish when the command signal is already cancelled", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const publish = vi.fn().mockResolvedValue({
      ref: { kind: "execution", key: "XNP-1" }, imported: 1, warnings: [],
    });
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(makeContext({ runArtifactStore: store }));
    mgr.setTraceabilitySubsystem(connectedSubsystem([], NO_PROJECT_SCOPE, publish));
    const signal = new AbortController();
    signal.abort();

    const operation = publishCommands(mgr).runPublish(undefined, signal.signal);
    await vi.waitFor(() => expect(win.__webviewPanels).toHaveLength(1));
    const panel = win.__webviewPanels[0]!;
    await receive(panel, { type: "ready" });
    await vi.waitFor(() => expect(posts(panel, "model", "publish")).toHaveLength(1));
    await receive(panel, { surface: "publish", ...CONFIRM });
    await operation;

    expect(publish).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith("Publish cancelled.");
  });

  it("guides the user and opens no board when no publishing capability is connected", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const mgr = CommandManager.create(makeContext());
    await publishCommands(mgr).runPublish();
    expect(win.__webviewPanels).toHaveLength(0);
    expect(String(info.mock.calls[0]?.[0])).toContain("Connect");
  });

  it("shows the no-runs toast without opening the board when nothing is publishable", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const store = { list: () => [] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(makeContext({ runArtifactStore: store }));
    mgr.setTraceabilitySubsystem(connectedSubsystem());

    await publishCommands(mgr).runPublish();

    expect(win.__webviewPanels).toHaveLength(0);
    expect(String(info.mock.calls[0]?.[0])).toContain("No local runs to publish");
  });
});

describe("traceability coverage board contributions", () => {
  interface Pkg {
    contributes: {
      commands: Array<{ command: string; category?: string; icon?: string }>;
      menus: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
    };
  }
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf-8")
  ) as Pkg;
  const CMD = "playwrightBddRunner.traceability.openBoard";

  it("declares the open-board command with a project-board icon under Specwright", () => {
    const command = pkg.contributes.commands.find((c) => c.command === CMD);
    expect(command?.category).toBe("Specwright");
    expect(command?.icon).toBe("$(project)");
  });

  it("slots an ungated open-board button right after sync in the traceability title bar", () => {
    const button = pkg.contributes.menus["view/title"]!.find((e) => e.command === CMD);
    expect(button?.when).toBe("view == playwrightBddRunner.traceability");
    expect(button?.group).toBe("navigation@1");
  });

  it("gates the palette entry on the traceability panel being enabled", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    expect(palette.find((e) => e.command === CMD)?.when).toBe(
      "playwrightBddRunner.traceability.enabled"
    );
  });
});

describe("board refresh on a settings change", () => {
  const registered: Array<{ dispose: () => void }> = [];

  afterEach(() => {
    // The host allows one serializer per view type, so each wiring retires with its test.
    for (const subscription of registered.splice(0)) {
      subscription.dispose();
    }
    win.__resetWebviewPanels();
    vi.restoreAllMocks();
  });

  // A config whose xray.syncProjectKeys the test can move under an open board, which is what a settings
  // edit does.
  function movingConfig(keys: () => string[]): ExtensionConfig {
    return ExtensionConfig.create(
      {
        get: (key: string, fallback: unknown) => (key === "xray.syncProjectKeys" ? keys() : fallback),
      } as unknown as vscode.WorkspaceConfiguration,
      false
    );
  }

  function boardSubsystem(scope: ProjectScopeStore, onRebuild: () => void): TraceabilitySubsystem {
    return {
      traceabilityPanelActive: true,
      getActiveAdapter: () => ({
        label: "Xray",
        keyGrammar: { testPrefix: "TEST_", reqPrefix: "REQ_", projectOf: (k: string) => k.split("-")[0] },
      }),
      getSnapshot: () => undefined,
      tagDerivedProjectKeys: () => [],
      projectScope: () => scope,
      mappingPageSize: () => NO_MAPPING_PAGE_SIZE,
      onDidChangeSnapshot: new vscode.EventEmitter<void>().event,
      // Stands in for the debounced, serialized rebuild the real subsystem runs.
      scheduleRebuild: onRebuild,
    } as unknown as TraceabilitySubsystem;
  }

  // Wire the board the way activation does, with the config listener captured so a test can fire it.
  function wireBoard(
    subsystem: TraceabilitySubsystem,
    config?: ExtensionConfig
  ): { openBoard: () => void; fire: (...changed: string[]) => void } {
    let listener: ((event: vscode.ConfigurationChangeEvent) => void) | undefined;
    vi.spyOn(vscode.workspace, "onDidChangeConfiguration").mockImplementation((handler) => {
      listener = handler as (event: vscode.ConfigurationChangeEvent) => void;
      return { dispose: () => undefined };
    });
    const mgr = CommandManager.create(makeContext(config ? { config } : undefined));
    mgr.setTraceabilitySubsystem(subsystem);
    mgr.registerBoardSerializer({ subscriptions: registered } as unknown as vscode.ExtensionContext);
    return {
      openBoard: () => traceabilityCommands(mgr).openBoard(),
      fire: (...changed: string[]) => listener?.({ affectsConfiguration: (key: string) => changed.includes(key) }),
    };
  }

  it("requests a rebuild when a setting the board renders changes", () => {
    const rebuild = vi.fn();
    const { openBoard, fire } = wireBoard(boardSubsystem(NO_PROJECT_SCOPE, rebuild));
    openBoard();

    fire("playwrightBddRunner.xray.syncProjectKeys");

    expect(rebuild).toHaveBeenCalledOnce();
  });

  it("ignores config noise, so an unrelated edit cannot thrash the board", () => {
    const rebuild = vi.fn();
    const { openBoard, fire } = wireBoard(boardSubsystem(NO_PROJECT_SCOPE, rebuild));
    openBoard();

    fire("playwrightBddRunner.playwrightCommand");
    fire("editor.fontSize");

    expect(rebuild).not.toHaveBeenCalled();
  });

  // A board opened later builds itself from the settings as they stand, so rebuilding for one that is not
  // on screen is work nobody would see.
  it("asks for no rebuild while no board is open", () => {
    const rebuild = vi.fn();
    const { fire } = wireBoard(boardSubsystem(NO_PROJECT_SCOPE, rebuild));

    fire("playwrightBddRunner.xray.syncProjectKeys");

    expect(rebuild).not.toHaveBeenCalled();
  });

  // The whole seam end to end: a settings edit reaches the board only through the rebuild it asks for, and
  // what the board then paints is the REAL scope store's coercion against the universe those settings
  // build. The store coerces, it never erases, so putting the project back restores the selection.
  it("coerces a scope whose project left the settings, and restores it when the setting comes back", async () => {
    let keys = ["calc", "pay"];
    const scope = projectScopeStore(memento(), () => undefined);
    scope.set("PAY");
    const snapshotChanged = new vscode.EventEmitter<void>();
    const subsystem = {
      ...boardSubsystem(scope, () => snapshotChanged.fire()),
      onDidChangeSnapshot: snapshotChanged.event,
    } as unknown as TraceabilitySubsystem;
    const { openBoard, fire } = wireBoard(subsystem, movingConfig(() => keys));
    openBoard();
    const panel = win.__webviewPanels[0]!;
    await receiveBoard(panel, "shell", { type: "ready" });
    const rendered = (): unknown => [...boardPosts(panel)].reverse().find((m) => m.type === "render");
    expect(rendered()).toMatchObject({ project: "PAY", scoped: true, projects: ["CALC", "PAY"] });

    keys = ["calc"];
    fire("playwrightBddRunner.xray.syncProjectKeys");
    expect(rendered()).toMatchObject({ project: "", scoped: false, projects: ["CALC"] });

    keys = ["calc", "pay"];
    fire("playwrightBddRunner.xray.syncProjectKeys");

    expect(rendered()).toMatchObject({ project: "PAY", scoped: true });
  });
});

describe("traceability clearLocalRunHistory", () => {
  afterEach(() => vi.restoreAllMocks());

  const SITE = "acme.atlassian.net";

  async function harness(runs = 2, ledgerEntries = 1) {
    const store = new RunArtifactStore(memento(), Logger.create());
    for (let i = 0; i < runs; i += 1) {
      store.append({ id: `run-${i}`, createdAt: i, results: [], shards: [], selection: { kind: "all-mapped" }, preflight: [], state: "complete" });
    }
    const ledger = new PublishLedger(memento(), Logger.create());
    for (let i = 0; i < ledgerEntries; i += 1) {
      await ledger.record({ artifactId: `run-${i}`, executionRef: `XNP-${i}`, site: SITE, account: "id", publishedAt: i, pendingAttachments: [] });
    }
    const rebuildNow = vi.fn(() => Promise.resolve());
    const mgr = CommandManager.create(makeContext({ runArtifactStore: store }));
    mgr.setPublishLedger(ledger);
    mgr.setTraceabilitySubsystem({ rebuildNow } as unknown as TraceabilitySubsystem);
    return { mgr, store, ledger, rebuildNow };
  }

  const clear = (mgr: CommandManager): Promise<void> =>
    publishCommands(mgr).clearLocalRunHistory();

  it("clears nothing when the confirm is dismissed", async () => {
    const { mgr, store, ledger } = await harness();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined as never);
    await clear(mgr);
    expect(store.list()).toHaveLength(2);
    expect(ledger.entriesForSite(SITE)).toHaveLength(1);
  });

  it("asks once, with the consequences in the modal detail and both clear actions", async () => {
    const { mgr } = await harness();
    const warn = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined as never);
    await clear(mgr);
    expect(warn).toHaveBeenCalledWith(
      "Clear this workspace's local run history?",
      {
        modal: true,
        detail: expect.stringContaining("forfeits those warnings for past executions"),
      },
      "Clear runs",
      "Clear runs and ledger"
    );
  });

  it("wipes the runs only on Clear runs, keeping the ledger's republish warnings", async () => {
    const { mgr, store, ledger, rebuildNow } = await harness();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Clear runs" as never);
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    await clear(mgr);
    expect(store.list()).toEqual([]);
    expect(ledger.entriesForSite(SITE)).toHaveLength(1);
    expect(info).toHaveBeenCalledWith("Cleared 2 local runs.");
    // The board repaints off the subsystem's snapshot-change event, which this rebuild fires.
    expect(rebuildNow).toHaveBeenCalledOnce();
  });

  it("wipes both stores on Clear runs and ledger", async () => {
    const { mgr, store, ledger } = await harness();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Clear runs and ledger" as never);
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    await clear(mgr);
    expect(store.list()).toEqual([]);
    expect(ledger.entriesForSite(SITE)).toEqual([]);
    expect(info).toHaveBeenCalledWith("Cleared 2 local runs and 1 ledger entry.");
  });

  it("names the ledger alone when there were no local runs to clear", async () => {
    const { mgr, ledger, rebuildNow } = await harness(0, 1);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Clear runs and ledger" as never);
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    await clear(mgr);
    expect(ledger.entriesForSite(SITE)).toEqual([]);
    expect(info).toHaveBeenCalledWith("Cleared 1 ledger entry.");
    expect(rebuildNow).toHaveBeenCalledOnce();
  });

  it("reports an already-empty history and skips the board refresh", async () => {
    const { mgr, rebuildNow } = await harness(0, 0);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Clear runs and ledger" as never);
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    await clear(mgr);
    expect(info).toHaveBeenCalledWith("Local run history is already empty.");
    expect(rebuildNow).not.toHaveBeenCalled();
  });

  it("reports the clear even when the board refresh fails", async () => {
    const { mgr, store } = await harness();
    mgr.setTraceabilitySubsystem({
      rebuildNow: () => Promise.reject(new Error("discovery down")),
    } as unknown as TraceabilitySubsystem);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Clear runs" as never);
    const info = vi.spyOn(vscode.window, "showInformationMessage");

    await expect(clear(mgr)).resolves.toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(info).toHaveBeenCalledWith("Cleared 2 local runs.");
  });
});

// An older ledger entry can carry a blank reference (a publish whose import response named no execution),
// and a POST to /issue//attachments can only 404, so both replay paths refuse it and say why.
describe("traceability pending attachments against a reference the response never named", () => {
  afterEach(() => vi.restoreAllMocks());

  const SITE = "acme.atlassian.net";

  async function harness(): Promise<{ mgr: CommandManager; ledger: PublishLedger }> {
    const ledger = new PublishLedger(memento(), Logger.create());
    await ledger.record({
      artifactId: "run-1",
      executionRef: "",
      site: SITE,
      account: "id",
      publishedAt: 1,
      pendingAttachments: ["/ws/report.zip"] as never,
    });
    const mgr = CommandManager.create(makeContext());
    mgr.setPublishLedger(ledger);
    return { mgr, ledger };
  }

  it("leaves the banner's files pending and warns instead of uploading", async () => {
    const { mgr, ledger } = await harness();
    const warn = vi.spyOn(vscode.window, "showWarningMessage");

    const result = await (
      publishCommands(mgr) as unknown as {
        attachPendingForRun: (id: string, site: string) => Promise<{ remaining: number }>;
      }
    ).attachPendingForRun("run-1", SITE);

    expect(result).toEqual({ remaining: 1 });
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain("an execution with no key");
    expect(ledger.find("run-1", SITE)?.pendingAttachments).toEqual(["/ws/report.zip"]);
  });

  it("refuses the toast Retry the same way, leaving the ledger untouched", async () => {
    const { mgr, ledger } = await harness();
    const warn = vi.spyOn(vscode.window, "showWarningMessage");

    await (
      publishCommands(mgr) as unknown as {
        retryAttachments: (id: string, site: string, key: string, files: readonly string[]) => Promise<void>;
      }
    ).retryAttachments("run-1", SITE, "", ["/ws/report.zip"]);

    expect(String(warn.mock.calls.at(-1)?.[0])).toContain("an execution with no key");
    expect(ledger.find("run-1", SITE)?.pendingAttachments).toEqual(["/ws/report.zip"]);
  });

  it("offers the trust action when a pending-attachment webview retry is blocked", async () => {
    const site = "";
    const ledger = new PublishLedger(memento(), Logger.create());
    await ledger.record({
      artifactId: "run-1",
      executionRef: "XNP-9",
      site,
      account: "id",
      publishedAt: 1,
      pendingAttachments: ["/ws/report.zip"] as never,
    });
    const mgr = CommandManager.create(makeContext({
      workspaceTrust: new WorkspaceTrust(() => false),
    }));
    mgr.setPublishLedger(ledger);
    vi.spyOn(vscode.window, "showWarningMessage")
      .mockResolvedValue("Manage Workspace Trust" as never);
    const manage = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);

    const result = await publishCommands(mgr).publishDelegate().attachPending("run-1");

    expect(result).toEqual({ remaining: 1 });
    expect(manage).toHaveBeenCalledWith("workbench.trust.manage");
    expect(ledger.find("run-1", site)?.pendingAttachments).toEqual(["/ws/report.zip"]);
  });

  it("keeps a refused upload pending, then replays the sealed bytes without republishing results", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "specwright-pending-upload-"));
    const evidence = path.join(root, "evidence.json");
    fs.writeFileSync(evidence, '{"passed":true}');
    const spoolRoot = path.join(root, "storage");
    const supportedSpool = new AttachmentSpool(spoolRoot, Logger.create(), Date.now, {
      noFollowFlag: process.platform === "win32" ? fs.constants.UV_FS_O_FILEMAP : fs.constants.O_NOFOLLOW,
    });
    const [snapshot] = supportedSpool.seal([evidence]);
    const realRead = AttachmentSpool.prototype.read;
    vi.spyOn(AttachmentSpool.prototype, "read")
      .mockImplementation((file) => realRead.call(supportedSpool, file));
    const ledger = new PublishLedger(memento(), Logger.create());
    await ledger.record({
      artifactId: "run-1",
      executionRef: "XNP-9",
      site: SITE,
      account: "id",
      publishedAt: Date.now(),
      pendingAttachments: [snapshot!],
    });
    const { store: credentials } = mapCredentialStore();
    await credentials.setJiraCredentials(SITE, "qa@example.com", "jira-token");
    const uploads: Array<{ url: string; name: string; body: string }> = [];
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      const file = (init.body as FormData).get("file") as File;
      uploads.push({ url, name: file.name, body: await file.text() });
      return uploads.length === 1
        ? new Response("Attachment rejected", { status: 400 })
        : new Response(JSON.stringify([{ id: "attachment-9" }]));
    });
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const manager = CommandManager.create(makeContext({
      config: configWith({ "xray.siteUrl": SITE }),
      attachmentSpoolRoot: spoolRoot,
    }));
    manager.setCredentialStore(credentials);
    manager.setPublishLedger(ledger);

    try {
      const delegate = publishCommands(manager).publishDelegate();
      expect(await delegate.attachPending("run-1")).toEqual({ remaining: 1 });
      expect(ledger.find("run-1", SITE)?.pendingAttachments).toEqual([snapshot]);
      expect(warn).toHaveBeenCalledWith("XNP-9: 1 attachment(s) still failed.");

      expect(await delegate.attachPending("run-1")).toEqual({ remaining: 0 });
      expect(ledger.find("run-1", SITE)?.pendingAttachments).toEqual([]);
      expect(info).toHaveBeenCalledWith("XNP-9: 1 pending attachment(s) uploaded.");
      expect(uploads).toEqual([
        { url: `https://${SITE}/rest/api/3/issue/XNP-9/attachments`, name: "evidence.json", body: '{"passed":true}' },
        { url: `https://${SITE}/rest/api/3/issue/XNP-9/attachments`, name: "evidence.json", body: '{"passed":true}' },
      ]);
    } finally {
      credentials.dispose();
      vi.unstubAllGlobals();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("publish attachment picker", () => {
  afterEach(() => vi.restoreAllMocks());

  it("offers selected files with their real names and sizes, including files removed before selection returns", async () => {
    const existing = writeTempFeature("report body");
    const removed = path.join(path.dirname(existing), "removed.json");
    const picker = vi.spyOn(vscode.window, "showOpenDialog").mockResolvedValue([
      vscode.Uri.file(existing),
      vscode.Uri.file(removed),
    ]);
    const manager = CommandManager.create(makeContext());

    const files = await publishCommands(manager).publishDelegate().browseFiles();

    expect(picker).toHaveBeenCalledWith({ canSelectMany: true, openLabel: "Attach" });
    expect(files).toEqual([
      { path: existing, name: "tmp.feature", size: fs.statSync(existing).size },
      { path: removed, name: "removed.json", size: 0 },
    ]);
  });

  it("returns no attachments when the user dismisses the picker", async () => {
    vi.spyOn(vscode.window, "showOpenDialog").mockResolvedValue(undefined);
    const manager = CommandManager.create(makeContext());

    await expect(publishCommands(manager).publishDelegate().browseFiles()).resolves.toEqual([]);
  });
});

