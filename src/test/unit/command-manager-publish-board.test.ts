import * as fs from "node:fs";
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
import { BoardPanel, BoardPanelDeps } from "../../traceability/board-panel";
import type { TraceabilitySubsystem } from "../../traceability/traceability-subsystem";
import { NO_MAPPING_PAGE_SIZE } from "../../traceability/mapping-page-size";
import { NO_PROJECT_SCOPE, ProjectScopeStore, projectScopeStore } from "../../traceability/project-scope";
import {
  ArtifactCaptureTarget,
  RunArtifactStore,
} from "../../traceability/run-artifact-store";
import { PublishLedger } from "../../traceability/publish-ledger";
import { AttachmentSpool } from "../../traceability/attachment-spool";
import type { TraceabilitySnapshot, TraceLink } from "../../traceability/traceability-model";
import type { ScenarioRef } from "../../traceability/scenario-ref";
import type { PreflightChoice } from "../../traceability/preflight-flow";
import { OutcomeUnknownRecoveryPersistenceError, PublishAttachmentsModel } from "../../traceability/publish-flow";
import { makeContext, memento, writeTempFeature } from "./helpers/command-manager-harness";
import { RemoteOutcomeUnknownError, WorkspaceTrust } from "../../core/workspace-trust";



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
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue(" @smoke and not @wip ");

    await commands.runAndPublishFeature({ fsPath: "/ws/a.feature" });
    await commands.runAndPublishFolder({ fsPath: "/ws/features" });
    await commands.runAndPublishByTagExpression();

    expect(run.mock.calls).toEqual([
      [{ kind: "feature", filePath: "/ws/a.feature" }, "explorer", expect.anything()],
      [{ kind: "folder", folderPath: "/ws/features" }, "explorer", expect.anything()],
      [{ kind: "tag-expression", expression: " @smoke and not @wip " }, "palette", expect.anything()],
    ]);
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

  it("guides the user and opens nothing when the panel is disabled (no live model)", () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const mgr = CommandManager.create(makeContext());
    mgr.setTraceabilitySubsystem(fakeSubsystem(false));
    openBoard(mgr);
    expect(win.__webviewPanels).toHaveLength(0);
    expect(String(info.mock.calls[0]?.[0])).toContain("Enable the Traceability panel");
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

  function connectedSubsystem(
    catalogueProjects: string[] = [],
    scope: ProjectScopeStore = NO_PROJECT_SCOPE,
    publish: () => Promise<unknown> = () =>
      Promise.resolve({ ref: { kind: "execution", key: "XNP-1" }, imported: 1, warnings: [] })
  ): TraceabilitySubsystem {
    const adapter = {
      id: "xray",
      label: "Xray",
      keyGrammar: { testPrefix: "TEST_", reqPrefix: "REQ_", projectOf: (k: string) => k.split("-")[0] },
      browseUrl: () => undefined,
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
    } = {}
  ): Promise<{ tabs: Array<string | undefined>; rebuilds: number }> {
    let rebuilds = 0;
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(makeContext({ runArtifactStore: store }));
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

    const promise = commands.runPublish();
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

  // A failed import keeps the dialog on the run the user picked, so the flow ends only once they answer
  // the retry; cancelling it settles the tab with nothing rebuilt.
  it("neither rebuilds nor switches tabs when the publish fails", async () => {
    const { tabs, rebuilds } = await publishOnce([CONFIRM, { type: "cancel" }], {
      publish: () => Promise.reject(new Error("HTTP 400")),
    });

    expect(rebuilds).toBe(0);
    expect(tabs).not.toContain("executions");
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

  it("keeps a recovery persistence failure visibly outcome unknown", () => {
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const logger = Logger.create();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const mgr = CommandManager.create(makeContext({ logger }));
    const combined = new OutcomeUnknownRecoveryPersistenceError(
      new RemoteOutcomeUnknownError("Publishing results", "publish-unknown"),
      new Error("disk full")
    );

    (
      publishCommands(mgr) as unknown as {
        reportPublishFailure(error: unknown): void;
      }
    ).reportPublishFailure(combined);

    const message = String(warning.mock.calls.at(-1)?.[0]);
    expect(message).toContain("Publish outcome unknown");
    expect(message).toContain("possibly succeeded");
    expect(message).toContain("publish-unknown");
    expect(message).toContain("local recovery record could not be saved");
    expect(warn).toHaveBeenCalledWith(
      "Publish outcome unknown; local recovery record was not saved",
      { operationId: "publish-unknown", persistenceCause: "disk full" }
    );
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
});

