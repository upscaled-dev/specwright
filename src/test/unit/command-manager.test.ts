import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import { CommandManager } from "../../commands/command-manager";
import { TraceabilityCommands } from "../../commands/traceability-commands";
import { TraceabilityLinkCommands } from "../../commands/traceability-link-commands";
import { TraceabilityPublishCommands } from "../../commands/traceability-publish-commands";
import { FeatureParser } from "../../parsers/feature-parser";
import type {
  ExecutionGateway,
  ExecutionOptions,
  RunCompletion,
  RunIntent,
} from "../../core/run-contracts";
import type { ClientRunIntent } from "../../ui/execution-client-context";
import { Logger } from "../../utils/logger";
import { ExtensionConfig } from "../../core/extension-config";
import { TestExecutor } from "../../core/test-executor";
import { ExternalRef, RunArtifact, SyncProgress, SyncScope, TraceabilityAdapter } from "../../traceability/contracts";
import { XrayAdapter } from "../../xray/xray-adapter";
import { XrayCredentialStore } from "../../xray/xray-credential-store";
import { InMemoryTraceabilityAdapter } from "../../traceability/in-memory-adapter";
import { BoardPanel, BoardPanelDeps } from "../../traceability/board-panel";
import type { TraceabilitySubsystem } from "../../traceability/traceability-subsystem";
import { NO_MAPPING_PAGE_SIZE } from "../../traceability/mapping-page-size";
import { NO_PROJECT_SCOPE, ProjectScopeStore, projectScopeStore } from "../../traceability/project-scope";
import {
  ArtifactCaptureTarget,
  RunArtifactStore,
  scopeArtifactDetails,
} from "../../traceability/run-artifact-store";
import { PublishLedger } from "../../traceability/publish-ledger";
import { AttachmentSpool } from "../../traceability/attachment-spool";
import { BoardViewModel, scenarioDropId } from "../../traceability/board-data";
import type { TraceabilitySnapshot, TraceLink } from "../../traceability/traceability-model";
import type { ScenarioRef } from "../../traceability/scenario-ref";
import type { PreflightChoice } from "../../traceability/preflight-flow";
import { OutcomeUnknownRecoveryPersistenceError, PublishAttachmentsModel } from "../../traceability/publish-flow";
import { applyWsEdit, EditEntry } from "./helpers/workspace-edit";
import { captureHandlers, fakeDoc, makeContext, memento, writeTempFeature } from "./helpers/command-manager-harness";
import {
  ExecutionFailure,
  LegacyDirectExecutionGateway,
} from "../../core/execution-gateway";
import { runOutputFromCompletion } from "../../ui/execution-adapter";
import { ExecutionAdmission } from "../../core/execution-admission";
import { trustedWorkspace } from "./helpers/test-workspace-trust";
import { RemoteOutcomeUnknownError, WorkspaceTrust } from "../../core/workspace-trust";

const EXECUTION_IDENTITY = { engine: "legacy-direct", schemaProfile: "legacy.v1" } as const;

function testGateway(
  execute: (intent: RunIntent, options?: ExecutionOptions) => Promise<RunCompletion>
): ExecutionGateway {
  return {
    running: false,
    diagnose: vi.fn(() => Promise.resolve([])),
    discover: vi.fn(() => Promise.resolve({ cases: [], diagnostics: [] })),
    prepare: vi.fn(async (intent) => ({
      operationId: "command-manager-test",
      identity: EXECUTION_IDENTITY,
      intent,
    })),
    run: vi.fn((prepared, options) => execute(prepared.intent, options)),
    debug: vi.fn((prepared, options) => execute(prepared.intent, options)),
    cancel: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(),
  };
}

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

function linkCommands(manager: CommandManager): TraceabilityLinkCommands {
  return (
    traceabilityCommands(manager) as unknown as {
      getLinkCommands: () => TraceabilityLinkCommands;
    }
  ).getLinkCommands();
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

describe("CommandManager scenario intents: one parse per invocation", () => {
  let tmpFiles: string[] = [];

  const OUTLINE = [
    "Feature: F",
    "",
    "  Scenario Outline: Adding",
    "    Given <x>",
    "",
    "    Examples:",
    "      | x |",
    "      | 1 |",
  ].join("\n");

  interface IntentSeam {
    runCommands: {
      scenarioIntent: (
        filePath: string,
        lineNumber: number | undefined,
        scenarioName: string | undefined,
        outlineName: string | undefined,
        mode: "run" | "debug",
        initiatedBy: string
      ) => ClientRunIntent;
    };
  }

  function seam(parser: FeatureParser): IntentSeam["runCommands"] {
    const mgr = CommandManager.create(makeContext({ featureParser: parser }));
    return (mgr as unknown as IntentSeam).runCommands;
  }

  beforeEach(() => {
    tmpFiles = [];
  });

  afterEach(() => {
    for (const f of tmpFiles) {
      try { fs.rmSync(path.dirname(f), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("parses the file once for two runs of the same unchanged file", () => {
    const filePath = writeTempFeature(OUTLINE);
    tmpFiles.push(filePath);
    const parser = FeatureParser.create(Logger.create());
    const parseSpy = vi.spyOn(parser, "parseFeatureContent");
    const runCommands = seam(parser);

    const first = runCommands.scenarioIntent(filePath, 8, "1: Adding - x: 1", undefined, "run", "palette");
    const second = runCommands.scenarioIntent(filePath, 8, "1: Adding - x: 1", undefined, "run", "palette");

    expect(first.selection).toEqual(second.selection);
    expect(first.selection).toMatchObject({
      kind: "scenario",
      scenario: { kind: "outline", outlineName: "Adding" },
    });
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it("re-parses when the file's mtimeMs changes", () => {
    const filePath = writeTempFeature(OUTLINE);
    tmpFiles.push(filePath);
    const parser = FeatureParser.create(Logger.create());
    const parseSpy = vi.spyOn(parser, "parseFeatureContent");
    const runCommands = seam(parser);

    runCommands.scenarioIntent(filePath, 8, "1: Adding - x: 1", undefined, "run", "palette");
    const futureMs = Date.now() + 5000;
    fs.utimesSync(filePath, new Date(futureMs), new Date(futureMs));
    runCommands.scenarioIntent(filePath, 8, "1: Adding - x: 1", undefined, "run", "palette");

    expect(parseSpy).toHaveBeenCalledTimes(2);
  });

  it("keeps an example row's own line and gives an outline header no line", () => {
    const filePath = writeTempFeature(OUTLINE);
    tmpFiles.push(filePath);
    const runCommands = seam(FeatureParser.create(Logger.create()));
    const outline = { filePath, name: "Adding", kind: "outline" as const, outlineName: "Adding" };

    const row = runCommands.scenarioIntent(filePath, 8, "1: Adding - x: 1", undefined, "run", "palette");
    const header = runCommands.scenarioIntent(filePath, undefined, "Adding", "Adding", "run", "palette");
    const declaration = runCommands.scenarioIntent(filePath, 3, "Adding", undefined, "run", "code-lens");

    expect(row.targets).toEqual([{ kind: "scenario", scenario: { ...outline, line: 8 } }]);
    expect(header.targets).toEqual([{ kind: "scenario", scenario: { ...outline, line: 0 } }]);
    expect(declaration.targets).toEqual(header.targets);
  });

  it("drops an unverified line when the file no longer parses but the name is known", () => {
    const runCommands = seam(FeatureParser.create(Logger.create()));

    const intent = runCommands.scenarioIntent(
      "/ws/gone.feature", 42, "Vanished", undefined, "run", "palette"
    );

    // Line 42 cannot be confirmed, and capture scoped to it would discard the run's own results.
    expect(intent.targets).toEqual([{
      kind: "scenario",
      scenario: { filePath: "/ws/gone.feature", line: 0, name: "Vanished", kind: "scenario" },
    }]);
  });

  it("refuses a nameless target the file does not contain instead of grepping the suite", () => {
    const filePath = writeTempFeature("Feature: F\n  Scenario: x\n");
    tmpFiles.push(filePath);
    const runCommands = seam(FeatureParser.create(Logger.create()));

    expect(() => runCommands.scenarioIntent(filePath, 99, undefined, undefined, "run", "palette"))
      .toThrow(`No scenario was found at ${filePath}:99`);
  });
});

describe("CommandManager run commands: single execution (no double-run)", () => {
  function makeExecutorSpy() {
    return {
      runScenario: vi.fn().mockResolvedValue(undefined),
      runScenarioWithOutput: vi.fn().mockResolvedValue({ success: true, output: "ok", duration: 1 }),
      runFeatureFile: vi.fn().mockResolvedValue(undefined),
      runFeatureFileWithOutput: vi.fn().mockResolvedValue({ success: true, output: "ok", duration: 1 }),
      runPathFilterWithOutput: vi.fn().mockResolvedValue({ success: true, output: "ok", duration: 1 }),
    };
  }

  type Handlers = {
    runScenario: (...a: unknown[]) => Promise<void>;
    runFeature: (...a: unknown[]) => Promise<void>;
    runScenarioWithContext: (...a: unknown[]) => Promise<void>;
    runFeatureWithContext: (...a: unknown[]) => Promise<void>;
  };

  const handlers = (manager: CommandManager): Handlers =>
    (manager as unknown as { runCommands: Handlers }).runCommands;

  it("runScenario executes only the captured (WithOutput) path once, never the terminal path", async () => {
    const exec = makeExecutorSpy();
    const mgr = CommandManager.create(makeContext({ testExecutor: exec as unknown as TestExecutor }));
    await handlers(mgr).runScenario("/abs/x.feature", 3, "S");
    expect(exec.runScenarioWithOutput).toHaveBeenCalledTimes(1);
    expect(exec.runScenario).not.toHaveBeenCalled();
  });

  it("runFeature executes only the captured (WithOutput) path once, never the terminal path", async () => {
    const exec = makeExecutorSpy();
    const mgr = CommandManager.create(makeContext({ testExecutor: exec as unknown as TestExecutor }));
    await handlers(mgr).runFeature("/abs/x.feature");
    expect(exec.runPathFilterWithOutput).toHaveBeenCalledTimes(1);
    expect(exec.runFeatureFile).not.toHaveBeenCalled();
  });

  it("routes Run All output through the shared Specwright output log", async () => {
    const logger = Logger.create();
    const info = vi.spyOn(logger, "info");
    const showOutput = vi.spyOn(logger, "showOutput");
    const exec = {
      ...makeExecutorSpy(),
      runSuiteWithOutput: vi.fn().mockResolvedValue({
        success: true,
        output: "runner output\n",
        duration: 1,
        scenarioDetails: [],
      }),
    };
    const registered = captureHandlers(makeContext({
      logger,
      testExecutor: exec as unknown as TestExecutor,
    }));

    await registered.get("playwrightBddRunner.runAllTests")!();

    expect(info).toHaveBeenCalledWith(expect.stringContaining("All tests output:\nrunner output"));
    expect(showOutput).toHaveBeenCalledOnce();
  });

  it("projects a partial gateway completion before reporting one command failure", async () => {
    const logger = Logger.create();
    const info = vi.spyOn(logger, "info");
    const showOutput = vi.spyOn(logger, "showOutput");
    const completion = {
      identity: EXECUTION_IDENTITY,
      state: "partial" as const,
      results: [{
        scenario: { filePath: "/abs/x.feature", line: 3, name: "S", kind: "scenario" as const },
        outcome: "passed" as const,
        durationMs: 7,
        attempts: 1,
        flaky: false,
      }],
      output: "completed before worker teardown\n",
      passed: 1,
      failed: 0,
      durationMs: 9,
      failure: "worker teardown failed",
    };
    const executionGateway = testGateway(
      vi.fn(() => Promise.reject(new ExecutionFailure(completion)))
    );
    const context = makeContext({ logger, executionGateway });
    const manager = CommandManager.create(context);
    const complete = vi.fn();
    const end = vi.fn();
    manager.setTestProvider({
      beginExternalRun: () => ({ progress: {}, complete, end }),
    });

    await expect(handlers(manager).runFeature("/abs/x.feature"))
      .rejects.toThrow("Test failed: worker teardown failed");

    const explorerProjection = runOutputFromCompletion(
      completion,
      context.playwrightJsonParser,
      "/abs"
    );
    expect(complete).toHaveBeenCalledWith(explorerProjection);
    expect(end).not.toHaveBeenCalled();
    expect(info).toHaveBeenCalledWith(expect.stringContaining(
      "Feature output:\ncompleted before worker teardown"
    ));
    expect(showOutput).toHaveBeenCalledOnce();
  });

  it("logs the retained output of a cancelled run so post-abort teardown text survives", async () => {
    const logger = Logger.create();
    const info = vi.spyOn(logger, "info");
    const showOutput = vi.spyOn(logger, "showOutput");
    const executionGateway = testGateway(vi.fn(() => Promise.resolve({
        identity: EXECUTION_IDENTITY,
        state: "cancelled" as const,
        results: [],
        output: "teardown after stop\n",
        passed: 0,
        failed: 0,
        durationMs: 4,
      })));
    const registered = captureHandlers(makeContext({ logger, executionGateway }));

    await registered.get("playwrightBddRunner.runAllTests")!();

    expect(info).toHaveBeenCalledWith("All tests cancelled", { duration: 4 });
    expect(info).toHaveBeenCalledWith(expect.stringContaining(
      "All tests output:\nteardown after stop"
    ));
    expect(showOutput).toHaveBeenCalledOnce();
  });

  it("captures every populated outline row from its declaration CodeLens", async () => {
    const content = [
      "Feature: Calculator",
      "",
      "Scenario Outline: Divide",
      "  Given <n>",
      "",
      "  Examples:",
      "    | n |",
      "    | 1 |",
      "    | 2 |",
    ].join("\n");
    const filePath = writeTempFeature(content);
    const parser = FeatureParser.create();
    const store = new RunArtifactStore(memento(), Logger.create());
    const details = [8, 9].map((lineNumber, index) => ({
      featurePath: filePath,
      lineNumber,
      scenarioName: `Example #${index + 1}`,
      outlineName: "Divide",
      status: "passed" as const,
    }));
    const runScenarioWithOutput = vi.fn((options: { artifactBatch?: number }, target: ArtifactCaptureTarget) => {
      store.contributeShard(options.artifactBatch!, {
        workingDir: path.dirname(filePath),
        command: "npx playwright test --grep Divide",
        success: true,
        exitCode: 0,
        details: scopeArtifactDetails(details, target, path.dirname(filePath)),
        workspaceRoot: path.dirname(filePath),
        invocation: target.scenario,
      });
      return Promise.resolve({ success: true, output: "", duration: 1, scenarioDetails: details });
    });
    const registerArtifactSink = vi.fn(() => ({ dispose: () => undefined }));
    const manager = CommandManager.create(makeContext({
      featureParser: parser,
      runArtifactStore: store,
      testExecutor: { runScenarioWithOutput, registerArtifactSink } as unknown as TestExecutor,
    }));
    const lens = parser.provideScenarioCodeLenses(content, filePath)
      .find((candidate) => candidate.command?.command === "playwrightBddRunner.runScenario" &&
        candidate.command.arguments?.[1] === 3)!;

    try {
      await handlers(manager).runScenario(...lens.command!.arguments!);
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }

    // A declaration line has no generated test behind it, so the run greps the outline title and
    // captures every row rather than trying to target line 3.
    expect(runScenarioWithOutput).toHaveBeenCalledWith(
      expect.not.objectContaining({ lineNumber: expect.anything() }),
      expect.objectContaining({
        scenario: expect.objectContaining({ kind: "outline", name: "Divide", line: 0 }),
        resultLines: [8, 9],
      })
    );
    expect(store.latest()?.selection).toEqual({
      kind: "scenario",
      scenario: {
        filePath,
        line: 0,
        name: "Divide",
        kind: "outline",
        outlineName: "Divide",
      },
    });
    expect(store.latest()?.results[0]?.iterations).toEqual([
      { name: "Example #1", outcome: "passed", durationMs: 0, attempts: 1 },
      { name: "Example #2", outcome: "passed", durationMs: 0, attempts: 1 },
    ]);
  });

  it("keeps an ordinary CodeLens outline run out of a separately mapped Examples block", async () => {
    const content = [
      "Feature: Calculator",
      "",
      "Scenario Outline: Divide",
      "  Given <n>",
      "",
      "  Examples: common",
      "    | n |",
      "    | 1 |",
      "",
      "  Examples: edge",
      "    | n |",
      "    | 0 |",
    ].join("\n");
    const filePath = writeTempFeature(content);
    const parser = FeatureParser.create();
    const store = new RunArtifactStore(memento(), Logger.create());
    const mappedBlock: ScenarioRef = {
      filePath,
      line: 10,
      name: "Divide · edge",
      kind: "examplesBlock",
      outlineName: "Divide",
      examplesBlockName: "edge",
    };
    const details = [8, 12].map((lineNumber) => ({
      featurePath: filePath,
      lineNumber,
      scenarioName: `Example #${lineNumber}`,
      outlineName: "Divide",
      status: "passed" as const,
    }));
    const runScenarioWithOutput = vi.fn((options: { artifactBatch?: number }, target: ArtifactCaptureTarget) => {
      store.contributeShard(options.artifactBatch!, {
        workingDir: path.dirname(filePath),
        command: "npx playwright test --grep Divide",
        success: true,
        exitCode: 0,
        details: scopeArtifactDetails(details, target, path.dirname(filePath)),
        workspaceRoot: path.dirname(filePath),
        invocation: target.scenario,
      });
      return Promise.resolve({ success: true, output: "", duration: 1, scenarioDetails: details });
    });
    const manager = CommandManager.create(makeContext({
      featureParser: parser,
      runArtifactStore: store,
      mappedScenarios: [mappedBlock],
      testExecutor: {
        runScenarioWithOutput,
        registerArtifactSink: vi.fn(() => ({ dispose: () => undefined })),
      } as unknown as TestExecutor,
    }));
    const lens = parser.provideScenarioCodeLenses(content, filePath)
      .find((candidate) => candidate.command?.command === "playwrightBddRunner.runScenario" &&
        candidate.command.arguments?.[1] === 3)!;

    try {
      await handlers(manager).runScenario(...lens.command!.arguments!);
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }

    expect(runScenarioWithOutput).toHaveBeenCalledOnce();
    expect(runScenarioWithOutput).toHaveBeenCalledWith(
      expect.objectContaining({ outlineName: "Divide" }),
      expect.objectContaining({ resultLines: [8] })
    );
    expect(store.latest()?.results[0]?.iterations).toEqual([
      { name: "Example #8", outcome: "passed", durationMs: 0, attempts: 1 },
    ]);
  });

  it("context-menu run commands execute only once each", async () => {
    const exec = makeExecutorSpy();
    const mgr = CommandManager.create(makeContext({ testExecutor: exec as unknown as TestExecutor }));
    await handlers(mgr).runScenarioWithContext("/abs/x.feature", 3, "S");
    await handlers(mgr).runFeatureWithContext("/abs/x.feature");
    expect(exec.runScenarioWithOutput).toHaveBeenCalledTimes(1);
    expect(exec.runPathFilterWithOutput).toHaveBeenCalledTimes(1);
    expect(exec.runScenario).not.toHaveBeenCalled();
    expect(exec.runFeatureFile).not.toHaveBeenCalled();
  });

  it("context-menu commands accept a vscode.Uri arg and pass its fsPath, not the Uri object", async () => {
    const exec = makeExecutorSpy();
    const mgr = CommandManager.create(makeContext({ testExecutor: exec as unknown as TestExecutor }));
    // VS Code invokes resource context-menu commands with a Uri (has .fsPath), not a string.
    const uri = { fsPath: "/abs/login.feature", scheme: "file" };
    await handlers(mgr).runFeatureWithContext(uri);
    expect(exec.runPathFilterWithOutput).toHaveBeenCalledWith(
      "/abs/login.feature",
      expect.any(AbortSignal),
      undefined,
      expect.anything(),
      undefined,
      undefined
    );
  });

  it("wires editor-run cancellation through the executor and its open TestRun session", async () => {
    const cancelled = { success: false, output: "", error: "Cancelled", duration: 1 };
    const runPathFilterWithOutput = vi.fn(async (_target: string, signal?: AbortSignal) => {
      await new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }));
      return cancelled;
    });
    const exec = {
      ...makeExecutorSpy(),
      runPathFilterWithOutput,
    };
    const complete = vi.fn();
    const end = vi.fn();
    const beginExternalRun = vi.fn(() => ({ progress: {}, complete, end }));
    const mgr = CommandManager.create(makeContext({ testExecutor: exec as unknown as TestExecutor }));
    mgr.setTestProvider({ beginExternalRun });
    const progressSpy = vi.spyOn(vscode.window, "withProgress").mockImplementation((
      _options,
      task
    ) => Promise.resolve(task(
      { report: () => undefined },
      {
        isCancellationRequested: false,
        onCancellationRequested: (listener) => {
          queueMicrotask(() => listener(undefined));
          return { dispose: () => undefined };
        },
      } as vscode.CancellationToken
    )));

    try {
      await handlers(mgr).runFeature("/abs/x.feature");
    } finally {
      progressSpy.mockRestore();
    }

    expect(beginExternalRun).toHaveBeenCalledWith("/abs/x.feature", undefined);
    expect(runPathFilterWithOutput).not.toHaveBeenCalled();
    expect(complete).toHaveBeenCalledWith(expect.objectContaining(cancelled));
    expect(end).not.toHaveBeenCalled();
  });
});

describe("scenario.outlineName: Map<test.id, Scenario> lookup model", () => {
  it("returns the parser's outlineName regardless of which organization tree the test item lives in", () => {
    const parser = FeatureParser.create();
    const content = [
      "Feature: F",
      "",
      "  @smoke",
      "  Scenario Outline: Adding",
      "    Given <x>",
      "",
      "    Examples:",
      "      | x |",
      "      | 1 |",
      "      | 2 |",
    ].join("\n");
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    const scenarios = parsed!.scenarios;
    expect(scenarios).toHaveLength(2);

    const scenarioByTestId = new Map<string, typeof scenarios[number]>();
    for (const s of scenarios) {
      s.filePath = "/abs/x.feature";
      scenarioByTestId.set(`${s.filePath}:${s.lineNumber}`, s);
    }

    const lookups = [
      `/abs/x.feature:${scenarios[0]!.lineNumber}`,
      `/abs/x.feature:${scenarios[1]!.lineNumber}`,
    ];
    for (const id of lookups) {
      const s = scenarioByTestId.get(id);
      expect(s?.isScenarioOutline ? s.outlineName : undefined).toBe("Adding");
    }
  });

  it("yields undefined outlineName for a non-outline scenario (so options.outlineName is omitted)", () => {
    const parser = FeatureParser.create();
    const content = [
      "Feature: F",
      "",
      "  Scenario: Plain",
      "    Given x",
    ].join("\n");
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    const s = parsed!.scenarios[0]!;
    expect(s.isScenarioOutline).toBe(false);
  });
});

describe("CommandManager palette run commands", () => {
  const window = vscode.window as unknown as { activeTextEditor: unknown };

  afterEach(() => {
    window.activeTextEditor = undefined;
    vi.restoreAllMocks();
  });

  it("resolves the active feature and cursor for zero-argument run and debug commands", async () => {
    const exec = {
      runScenarioWithOutput: vi.fn().mockResolvedValue({ success: true, output: "ok", duration: 1 }),
      runPathFilterWithOutput: vi.fn().mockResolvedValue({ success: true, output: "ok", duration: 1 }),
      debugScenarioWithOutput: vi.fn().mockResolvedValue({ success: true, output: "ok", duration: 1 }),
    };
    // A real file on disk: the intent parses it to resolve the exact scenario the cursor is in.
    const content = "Feature: Palette\n\nScenario: chosen\n  Given a step\n";
    const filePath = writeTempFeature(content);
    window.activeTextEditor = {
      document: fakeDoc(content, filePath),
      selection: { active: { line: 3 } },
    };
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("@smoke");
    const handlers = captureHandlers(makeContext({ testExecutor: exec as unknown as TestExecutor }));

    await handlers.get("playwrightBddRunner.runScenario")!();
    await handlers.get("playwrightBddRunner.debugScenario")!();
    await handlers.get("playwrightBddRunner.runFeatureFile")!();
    await handlers.get("playwrightBddRunner.runScenarioWithTags")!();
    await handlers.get("playwrightBddRunner.runFeatureFileWithTags")!();

    expect(exec.runScenarioWithOutput).toHaveBeenCalledTimes(2);
    expect(exec.runScenarioWithOutput.mock.calls.map(([options]) => options)).toEqual([
      expect.objectContaining({ filePath, lineNumber: 3, scenarioName: "chosen" }),
      expect.objectContaining({ filePath, lineNumber: 3, scenarioName: "chosen", tags: "@smoke" }),
    ]);
    expect(exec.debugScenarioWithOutput).toHaveBeenCalledWith(
      expect.objectContaining({ filePath, lineNumber: 3, scenarioName: "chosen" }),
      expect.anything()
    );
    expect(exec.runPathFilterWithOutput.mock.calls.map(([target, _signal, _batch, _progress, tags]) => ({ target, tags }))).toEqual([
      { target: filePath, tags: undefined },
      { target: filePath, tags: "@smoke" },
    ]);
    fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
  });

  it("keeps tagged scenario and feature runs intersected when routing through the gateway", async () => {
    const execute = vi.fn().mockResolvedValue({
      identity: EXECUTION_IDENTITY,
      state: "complete",
      results: [],
      passed: 0,
      failed: 0,
      durationMs: 1,
    });
    const exec = {
      runScenarioWithOutput: vi.fn(),
      runFeatureFileWithOutput: vi.fn(),
    };
    window.activeTextEditor = {
      document: fakeDoc("Feature: Palette\n\nScenario: chosen\n  Given a step\n"),
      selection: { active: { line: 3 } },
    };
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("@smoke and not @wip");
    const handlers = captureHandlers(makeContext({
      testExecutor: exec as unknown as TestExecutor,
      executionGateway: testGateway(execute),
    }));

    await handlers.get("playwrightBddRunner.runScenarioWithTags")!();
    await handlers.get("playwrightBddRunner.runFeatureFileWithTags")!();

    expect(execute.mock.calls.map(([intent]) => intent)).toEqual([
      expect.objectContaining({
        selection: expect.objectContaining({
          kind: "scenario",
          tagExpression: "@smoke and not @wip",
        }),
        targets: [expect.objectContaining({
          kind: "scenario",
          tagExpression: "@smoke and not @wip",
        })],
      }),
      expect.objectContaining({
        selection: {
          kind: "feature",
          filePath: "/ws/a.feature",
          tagExpression: "@smoke and not @wip",
        },
        targets: [{
          kind: "path",
          path: "/ws/a.feature",
          tagExpression: "@smoke and not @wip",
        }],
      }),
    ]);
    expect(execute.mock.calls.flatMap(([intent]) => intent.targets))
      .not.toContainEqual(expect.objectContaining({ kind: "tag-expression" }));
    expect(exec.runScenarioWithOutput).not.toHaveBeenCalled();
    expect(exec.runFeatureFileWithOutput).not.toHaveBeenCalled();
  });

  it("prompts for a tag expression when a CodeLens supplies only the feature path", async () => {
    const execute = vi.fn().mockResolvedValue({
      identity: EXECUTION_IDENTITY,
      state: "complete",
      results: [],
      passed: 0,
      failed: 0,
      durationMs: 1,
    });
    const input = vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("@smoke");
    const handlers = captureHandlers(makeContext({ executionGateway: testGateway(execute) }));

    await handlers.get("playwrightBddRunner.runFeatureFileWithTags")!("/ws/a.feature");

    expect(input).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toEqual({
      mode: "run",
      targets: [{ kind: "path", path: "/ws/a.feature", tagExpression: "@smoke" }],
    });

    input.mockClear();
    execute.mockClear();
    await handlers.get("playwrightBddRunner.runFeatureFileWithTags")!(
      "/ws/a.feature",
      "@critical"
    );
    expect(input).not.toHaveBeenCalled();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      targets: [{ kind: "path", path: "/ws/a.feature", tagExpression: "@critical" }],
    });
  });

  it("preserves admission recovery through a registered run command", async () => {
    const admission = new ExecutionAdmission();
    await admission.block({
      kind: "debug-session",
      failure: "the previous debug session did not terminate",
    });
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const context = makeContext();
    const execute = vi.spyOn(context.testExecutor, "runSuiteWithOutput");
    context.executionGateway = new LegacyDirectExecutionGateway(
      context.testExecutor,
      context.featureParser,
      context.workspaceTrust,
      admission
    );
    const handlers = captureHandlers(context);

    await handlers.get("playwrightBddRunner.runAllTests")!();

    expect(execute).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledOnce();
    const message = String(error.mock.calls[0]?.[0]);
    expect(message).toContain("the previous debug session did not terminate");
    expect(message).toContain("Restart the computer");
    expect(message).not.toContain("Failed to execute Run All Tests");
  });

  it("picks a discovered feature and scenario when no feature editor is active", async () => {
    const filePath = writeTempFeature("Feature: Palette\n\nScenario: picked\n  Given a step\n");
    const exec = {
      runScenarioWithOutput: vi.fn().mockResolvedValue({ success: true, output: "ok", duration: 1 }),
    };
    const discoveryManager = { discoverTestFiles: vi.fn().mockResolvedValue([filePath]) };
    vi.spyOn(vscode.window, "showQuickPick").mockImplementation((items) =>
      Promise.resolve((items as Array<unknown>)[0] as never)
    );
    const handlers = captureHandlers(makeContext({
      discoveryManager: discoveryManager as never,
      testExecutor: exec as unknown as TestExecutor,
    }));

    try {
      await handlers.get("playwrightBddRunner.runScenario")!();
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }

    expect(discoveryManager.discoverTestFiles).toHaveBeenCalledOnce();
    expect(exec.runScenarioWithOutput).toHaveBeenCalledWith(
      expect.objectContaining({ filePath, lineNumber: 3, scenarioName: "picked" }),
      expect.anything()
    );
  });

  it("treats target and tag prompt cancellation as a quiet no-op", async () => {
    const filePath = writeTempFeature("Feature: Palette\n\nScenario: picked\n  Given a step\n");
    const exec = {
      runScenarioWithOutput: vi.fn(),
      runFeatureFileWithOutput: vi.fn(),
    };
    const errors = vi.spyOn(vscode.window, "showErrorMessage");
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    const handlers = captureHandlers(makeContext({
      discoveryManager: { discoverTestFiles: vi.fn().mockResolvedValue([filePath]) } as never,
      testExecutor: exec as unknown as TestExecutor,
    }));

    try {
      await handlers.get("playwrightBddRunner.runScenario")!();

      window.activeTextEditor = {
        document: fakeDoc("Feature: Palette\n\nScenario: chosen\n  Given a step\n"),
        selection: { active: { line: 3 } },
      };
      vi.spyOn(vscode.window, "showInputBox").mockResolvedValue(undefined);
      await handlers.get("playwrightBddRunner.runFeatureFileWithTags")!();
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }

    expect(exec.runScenarioWithOutput).not.toHaveBeenCalled();
    expect(exec.runFeatureFileWithOutput).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("passes a palette outline target through to execution", async () => {
    const exec = {
      runScenarioWithOutput: vi.fn().mockResolvedValue({ success: true, output: "ok", duration: 1 }),
      debugScenarioWithOutput: vi.fn().mockResolvedValue({ success: true, output: "ok", duration: 1 }),
    };
    const feature = writeTempFeature([
      "Feature: Palette",
      "Scenario Outline: Divide",
      "  Given <n>",
      "  Examples:",
      "    | n |",
      "    | 1 |",
    ].join("\n"));
    window.activeTextEditor = {
      document: fakeDoc(fs.readFileSync(feature, "utf8"), feature),
      selection: { active: { line: 2 } },
    };
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("@smoke");
    const handlers = captureHandlers(makeContext({ testExecutor: exec as unknown as TestExecutor }));

    await handlers.get("playwrightBddRunner.runScenario")!();
    await handlers.get("playwrightBddRunner.debugScenario")!();
    await handlers.get("playwrightBddRunner.runScenarioWithTags")!();

    // Palette commands pass the outline declaration through to the shared execution boundary.
    expect(exec.runScenarioWithOutput.mock.calls.map(([options]) => options)).toEqual([
      expect.objectContaining({ outlineName: "Divide" }),
      expect.objectContaining({ outlineName: "Divide", tags: "@smoke" }),
    ]);
    expect(exec.runScenarioWithOutput.mock.calls.map(([options]) => options.lineNumber))
      .toEqual([undefined, undefined]);
    expect(exec.debugScenarioWithOutput).toHaveBeenCalledWith(
      expect.objectContaining({ outlineName: "Divide" }),
      expect.anything()
    );
    expect(exec.debugScenarioWithOutput.mock.calls[0]?.[0].lineNumber).toBeUndefined();
    fs.rmSync(path.dirname(feature), { recursive: true, force: true });
  });

  it("surfaces selected-file and empty-tag errors through the command handler", async () => {
    const exec = { runFeatureFileWithOutput: vi.fn() };
    const errors = vi.spyOn(vscode.window, "showErrorMessage");
    vi.spyOn(vscode.window, "showQuickPick").mockImplementation((items) =>
      Promise.resolve((items as Array<unknown>)[0] as never)
    );
    const handlers = captureHandlers(makeContext({
      discoveryManager: { discoverTestFiles: vi.fn().mockResolvedValue(["/ws/missing.feature"]) } as never,
      testExecutor: exec as unknown as TestExecutor,
    }));

    await handlers.get("playwrightBddRunner.runFeatureFile")!();

    window.activeTextEditor = {
      document: fakeDoc("Feature: Palette\nScenario: chosen\n"),
      selection: { active: { line: 1 } },
    };
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("  ");
    await handlers.get("playwrightBddRunner.runFeatureFileWithTags")!();

    expect(exec.runFeatureFileWithOutput).not.toHaveBeenCalled();
    expect(errors.mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining("Could not parse /ws/missing.feature"),
      expect.stringContaining("Tags are required"),
    ]);
  });
});

describe("CommandManager: StepDefinitionProvider caching", () => {
  type StepDefProviderAccess = { getStepDefinitionProvider: () => unknown };

  it("reuses a single provider across invocations (no per-call re-scan)", () => {
    const mgr = CommandManager.create(makeContext());
    const get = (): unknown => (mgr as unknown as StepDefProviderAccess).getStepDefinitionProvider();
    expect(get()).toBe(get());
  });

  it("rebuilds the provider after a configuration change", () => {
    const config = ExtensionConfig.create();
    const mgr = CommandManager.create(makeContext({ config }));
    const get = (): unknown => (mgr as unknown as StepDefProviderAccess).getStepDefinitionProvider();
    const first = get();
    config.reload();
    expect(get()).not.toBe(first);
  });
});

describe("CommandManager onboarding discovery ordering", () => {
  it("keeps the real discovery handler pending before diagnosis focuses Testing", async () => {
    const events: string[] = [];
    let finishDiscovery: (() => void) | undefined;
    const discovery = new Promise<void>((resolve) => {finishDiscovery = resolve;});
    const context = makeContext({
      executionGateway: testGateway(vi.fn(() => Promise.reject(new Error("not used")))),
    });
    const manager = CommandManager.create(context);
    manager.setUsageIndexHost({
      getUsageIndex: () => undefined as never,
      projectCapabilities: () => Promise.resolve({
        workspace: true,
        featureFiles: 1,
        stepDefinitions: 1,
        stepDefinitionPaths: ["steps/**/*.ts"],
      }),
    });
    manager.setTestProvider({
      discoverTests: () => {
        events.push("discovery:start");
        return discovery.then(() => {events.push("discovery:end");});
      },
    });
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue("Open Testing" as never);
    const registered = new Map<string, (...args: unknown[]) => Promise<void>>();
    vi.spyOn(vscode.commands, "registerCommand").mockImplementation((command, handler) => {
      registered.set(command, handler as (...args: unknown[]) => Promise<void>);
      return { dispose: () => {} };
    });
    vi.spyOn(vscode.commands, "executeCommand").mockImplementation((async (command: string) => {
      events.push(`execute:${command}`);
      return registered.get(command)?.();
    }) as typeof vscode.commands.executeCommand);
    manager.registerCommands({
      subscriptions: [],
      extensionUri: vscode.Uri.file("/extension"),
      globalStorageUri: vscode.Uri.file("/tmp/specwright-command-tests"),
    } as unknown as vscode.ExtensionContext);

    const diagnosis = registered.get("playwrightBddRunner.diagnoseWorkspace")!();
    await vi.waitFor(() => expect(events).toContain("discovery:start"));

    expect(events).not.toContain("execute:workbench.view.testing.focus");
    finishDiscovery?.();
    await diagnosis;
    expect(events).toEqual([
      "execute:playwrightBddRunner.discoverTests",
      "discovery:start",
      "discovery:end",
      "execute:workbench.view.testing.focus",
    ]);
  });
});

describe("command contributions ↔ handler registrations parity", () => {
  interface PackageJson {
    contributes: {
      commands: Array<{ command: string; title: string; category?: string; icon?: string }>;
      menus: Record<string, Array<{ command?: string; when?: string; submenu?: string; group?: string }>>;
      views: Record<string, Array<{ id: string; when?: string }>>;
      submenus: Array<{ id: string; label: string }>;
    };
  }
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf-8")
  ) as PackageJson;

  const paletteCommands = {
    visible: [
      "playwrightBddRunner.diagnoseWorkspace",
      "playwrightBddRunner.discoverTests",
      "playwrightBddRunner.runAllTests",
      "playwrightBddRunner.runScenario",
      "playwrightBddRunner.debugScenario",
      "playwrightBddRunner.runAllTestsParallel",
      "playwrightBddRunner.runFeatureFile",
      "playwrightBddRunner.runScenarioWithTags",
      "playwrightBddRunner.runFeatureFileWithTags",
      "playwrightBddRunner.setOrganizationStrategy",
      "playwrightBddRunner.setTagBasedOrganization",
      "playwrightBddRunner.setFileBasedOrganization",
      "playwrightBddRunner.setScenarioTypeOrganization",
      "playwrightBddRunner.setFlatOrganization",
      "playwrightBddRunner.setFeatureBasedOrganization",
      "playwrightBddRunner.debugOrganization",
      "playwrightBddRunner.showOutput",
      "playwrightBddRunner.openSupportSnapshot",
      "playwrightBddRunner.validateConfiguration",
      "playwrightBddRunner.generateStepDefinitions",
      "playwrightBddRunner.goToStepDefinition",
      "playwrightBddRunner.refreshStepsPanel",
      "playwrightBddRunner.exportSteps",
      "playwrightBddRunner.exportScenarios",
      "playwrightBddRunner.insertStep",
      "playwrightBddRunner.traceability.runAndPublishByTagExpression",
      "playwrightBddRunner.traceability.publishLastRun",
      "playwrightBddRunner.traceability.sync",
      "playwrightBddRunner.traceability.openBoard",
      "playwrightBddRunner.traceability.manageConnection",
      "playwrightBddRunner.traceability.showPanel",
      "playwrightBddRunner.traceability.connect",
      "playwrightBddRunner.traceability.disconnect",
      "playwrightBddRunner.traceability.testConnection",
      "playwrightBddRunner.traceability.toggleGrouping",
      "playwrightBddRunner.traceability.switchDefaultProject",
      "playwrightBddRunner.traceability.selectSyncProjects",
      "playwrightBddRunner.traceability.clearLocalRunHistory",
      "playwrightBddRunner.traceability.bulkCreateTests",
      "playwrightBddRunner.traceability.createTestSet",
      "playwrightBddRunner.traceability.createTestPlan",
      "playwrightBddRunner.traceability.createTestExecution",
    ],
    hidden: [
      "playwrightBddRunner.openTesting",
      "playwrightBddRunner.openSteps",
      "playwrightBddRunner.configureStepPaths",
      "playwrightBddRunner.refreshTests",
      "playwrightBddRunner.runScenarioWithContext",
      "playwrightBddRunner.debugScenarioWithContext",
      "playwrightBddRunner.runFeatureFileWithContext",
      "playwrightBddRunner.generateStepDefinitionForStep",
      "playwrightBddRunner.scaffoldStepFromPanel",
      "playwrightBddRunner.scaffoldFeatureFromPanel",
      "playwrightBddRunner.traceability.openIssue",
      "playwrightBddRunner.traceability.copyKey",
      "playwrightBddRunner.traceability.linkScenario",
      "playwrightBddRunner.traceability.runAndPublish",
      "playwrightBddRunner.traceability.runAndPublishFeature",
      "playwrightBddRunner.traceability.runAndPublishFolder",
      "playwrightBddRunner.traceability.hidePanel",
      "playwrightBddRunner.traceability.setupSaved",
      "playwrightBddRunner.traceability.runAndPublishAllMapped",
      "playwrightBddRunner.traceability.find",
    ],
  };

  function registeredCommandIds(): string[] {
    const registered: string[] = [];
    const commandsApi = vscode.commands as unknown as { registerCommand: unknown };
    const original = commandsApi.registerCommand;
    commandsApi.registerCommand = (cmd: string): { dispose: () => void } => {
      registered.push(cmd);
      return { dispose: () => {} };
    };
    try {
      const mgr = CommandManager.create(makeContext());
      mgr.registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext);
      mgr.dispose();
    } finally {
      commandsApi.registerCommand = original;
    }
    return registered;
  }

  // The board's webview serializer must stay out of the re-runnable path: the host refuses a second one
  // for the same view type, and registerCommands is re-run on purpose.
  it("survives a re-run of registerCommands once the board serializer is registered", () => {
    const subscriptions: Array<{ dispose: () => void }> = [];
    const context = { subscriptions } as unknown as vscode.ExtensionContext;
    const mgr = CommandManager.create(makeContext());

    mgr.registerCommands(context);
    mgr.registerBoardSerializer(context);

    expect(() => mgr.registerCommands(context)).not.toThrow();
    mgr.dispose();
    for (const subscription of subscriptions.splice(0)) {
      subscription.dispose();
    }
  });

  it("every contributed playwrightBddRunner command has a handler and vice versa", () => {
    const contributed = pkg.contributes.commands.map((c) => c.command).sort();
    const registered = registeredCommandIds().sort();
    expect(registered).toEqual(contributed);
  });

  it("groups the support snapshot command with Specwright in the Command Palette", () => {
    expect(pkg.contributes.commands.find(({ command }) => command === "playwrightBddRunner.openSupportSnapshot")?.category)
      .toBe("Specwright");
  });

  // A failure message names the registered title. A title the manifest never declares sends the user
  // looking for a command that appears nowhere in the UI.
  it("registers each command under the title the manifest declares", () => {
    const mgr = CommandManager.create(makeContext());
    try {
      mgr.registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext);
      const registered = [...mgr.registeredTitles].sort(([a], [b]) => a.localeCompare(b));
      const manifest = pkg.contributes.commands
        .map((c) => [c.command, c.title] as const)
        .sort(([a], [b]) => a.localeCompare(b));
      expect(registered).toEqual(manifest.map(([command, title]) => [command, title]));
    } finally {
      mgr.dispose();
    }
  });

  function effectiveVisibleCommands(): string[] {
    const palette = pkg.contributes.menus["commandPalette"]!;
    return pkg.contributes.commands
      .map((c) => c.command)
      .filter((command) => {
        const entries = palette.filter((entry) => entry.command === command);
        return entries.length === 0 || entries.some((entry) => entry.when !== "false");
      })
      .sort();
  }

  it("classifies every contributed command as palette-visible or explicitly hidden", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    const paletteIds = palette.flatMap((entry) => entry.command === undefined ? [] : [entry.command]);
    const contributed = pkg.contributes.commands.map((c) => c.command).sort();
    const classified = [...paletteCommands.visible, ...paletteCommands.hidden].sort();

    expect(new Set(paletteIds).size).toBe(paletteIds.length);
    expect(classified).toEqual(contributed);
    expect(effectiveVisibleCommands()).toEqual([...paletteCommands.visible].sort());
    for (const command of paletteCommands.hidden) {
      const entries = palette.filter((entry) => entry.command === command);
      expect(entries).toHaveLength(1);
      expect(entries.every((entry) => entry.when === "false")).toBe(true);
    }
  });

  it("keeps Discover Tests canonical and refreshTests as a hidden compatibility alias", async () => {
    const discoverTests = vi.fn().mockResolvedValue(undefined);
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const registration = vi.spyOn(vscode.commands, "registerCommand").mockImplementation(
      (command, handler) => {
        handlers.set(command, handler as (...args: unknown[]) => Promise<void>);
        return { dispose: () => {} };
      }
    );
    const manager = CommandManager.create(makeContext());
    manager.setTestProvider({ discoverTests });
    manager.registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    try {
      await handlers.get("playwrightBddRunner.discoverTests")!();
      await handlers.get("playwrightBddRunner.refreshTests")!();
    } finally {
      manager.dispose();
      registration.mockRestore();
    }

    expect(discoverTests).toHaveBeenCalledTimes(2);
    const palette = pkg.contributes.menus["commandPalette"]!;
    expect(palette.find((entry) =>
      entry.command === "playwrightBddRunner.refreshTests"
    )?.when).toBe("false");
    const nonPaletteRefresh = Object.entries(pkg.contributes.menus)
      .filter(([menu]) => menu !== "commandPalette")
      .flatMap(([, entries]) => entries)
      .filter((entry) => entry.command === "playwrightBddRunner.refreshTests");
    expect(nonPaletteRefresh).toEqual([]);
    expect(pkg.contributes.menus["testing/view/context"]).toBeUndefined();
  });

  it("scopes test grouping to this Testing controller", () => {
    expect(pkg.contributes.menus["testing/item/context"]).toEqual([{
      submenu: "playwrightBddRunner.organizationSubmenu",
      when: "controllerId == playwrightBddRunner",
      group: "playwrightBddRunner@1",
    }]);
  });

  it("uses the same concise test-grouping labels in commands, submenu, and Quick Pick", async () => {
    const commandIds = [
      "playwrightBddRunner.setTagBasedOrganization",
      "playwrightBddRunner.setFileBasedOrganization",
      "playwrightBddRunner.setScenarioTypeOrganization",
      "playwrightBddRunner.setFlatOrganization",
      "playwrightBddRunner.setFeatureBasedOrganization",
    ];
    expect(commandIds.map((id) =>
      pkg.contributes.commands.find(({ command }) => command === id)?.title
    )).toEqual(["Tags", "File", "Scenario type", "None", "Feature"]);
    expect(pkg.contributes.commands.find(({ command }) =>
      command === "playwrightBddRunner.setOrganizationStrategy"
    )?.title).toBe("Group tests by");
    expect(pkg.contributes.submenus.find(({ id }) =>
      id === "playwrightBddRunner.organizationSubmenu"
    )?.label).toBe("Group tests by");

    const quickPick = vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.setOrganizationStrategy")!();
    expect((quickPick.mock.calls[0]?.[0] as Array<{ label: string }>).map(({ label }) => label))
      .toEqual(["Tags", "File", "Scenario type", "None", "Feature"]);
    expect(quickPick.mock.calls[0]?.[1]).toMatchObject({ placeHolder: "Group tests by" });
    quickPick.mockRestore();
  });

  // The palette invokes with no arguments. A command that needs one belongs in the hidden list, so
  // every visible handler is run bare: it must reach the user (a message, a prompt, a run), never
  // fail for a missing argument and never return in silence.
  it("gives every palette-visible command an observable effect with no arguments", async () => {
    const logger = Logger.create();
    const showOutput = vi.spyOn(logger, "showOutput").mockImplementation(() => {});
    const execute = vi.fn().mockResolvedValue({
      state: "complete", results: [], output: "", passed: 0, failed: 0, durationMs: 1,
    });
    const errors = vi.spyOn(vscode.window, "showErrorMessage");
    const surfaced = [
      errors,
      vi.spyOn(vscode.window, "showInformationMessage"),
      vi.spyOn(vscode.window, "showWarningMessage"),
      vi.spyOn(vscode.window, "showQuickPick"),
      vi.spyOn(vscode.window, "showInputBox"),
    ];
    // The palette gates a few commands on an open .feature file; run the sweep in the context that
    // makes every visible command reachable.
    const editorHost = vscode.window as unknown as { activeTextEditor: unknown };
    editorHost.activeTextEditor = {
      document: fakeDoc("Feature: Palette\n\nScenario: chosen\n  Given a step\n"),
      selection: { active: { line: 2 } },
    };
    const handlers = captureHandlers(makeContext({
      logger,
      executionGateway: { execute } as never,
      testExecutor: { discoverFeatureFiles: vi.fn().mockResolvedValue([]) } as never,
    }));

    try {
      for (const command of effectiveVisibleCommands()) {
        const handler = handlers.get(command);
        expect(handler, `${command} has no registered handler`).toBeDefined();
        for (const spy of [...surfaced, execute, showOutput]) {spy.mockClear();}

        await handler!();

        const observed = [...surfaced, execute, showOutput].some((spy) => spy.mock.calls.length > 0);
        expect(observed, `${command} did nothing observable when invoked with no arguments`).toBe(true);
        expect(errors.mock.calls.map(([message]) => String(message)))
          .not.toContainEqual(expect.stringMatching(/is required/i));
      }
    } finally {
      // A failed assertion must not leak this editor into every later test in the file.
      editorHost.activeTextEditor = undefined;
    }
  });

  it("places run-and-publish on feature files and folders in the Explorer", () => {
    const explorer = pkg.contributes.menus["explorer/context"]!;
    expect(explorer.find((entry) =>
      entry.command === "playwrightBddRunner.traceability.runAndPublishFeature"
    )?.when).toContain("resourceExtname == .feature");
    expect(explorer.find((entry) =>
      entry.command === "playwrightBddRunner.traceability.runAndPublishFolder"
    )?.when).toContain("explorerResourceIsFolder");
  });

  it("places the Steps panel commands in the view menus, gated on the stepsExplorer view", () => {
    const viewTitle = pkg.contributes.menus["view/title"]!;
    const stepsTitle = viewTitle.filter((e) => e.when?.includes("stepsExplorer"));
    expect(stepsTitle.map((e) => e.command)).toEqual([
      "playwrightBddRunner.refreshStepsPanel",
      "playwrightBddRunner.exportSteps",
      "playwrightBddRunner.exportScenarios",
    ]);
    for (const entry of stepsTitle) {
      expect(entry.when).toBe("view == playwrightBddRunner.stepsExplorer");
    }
    expect(stepsTitle.map((entry) => entry.group)).toEqual([
      "navigation@1",
      "playwrightBddRunner@1",
      "playwrightBddRunner@2",
    ]);
    expect(pkg.contributes.views["specwright"]?.find((view) =>
      view.id === "playwrightBddRunner.stepsExplorer"
    )?.when).toBe("config.playwrightBddRunner.enableStepsPanel");

    const itemContext = pkg.contributes.menus["view/item/context"]!;
    const stepsItems = itemContext.filter((e) => e.when?.includes("stepsExplorer"));
    expect(stepsItems.map((e) => [e.command, e.when])).toEqual([
      ["playwrightBddRunner.insertStep", "view == playwrightBddRunner.stepsExplorer && viewItem == stepDefinition"],
      ["playwrightBddRunner.scaffoldStepFromPanel", "view == playwrightBddRunner.stepsExplorer && viewItem == unmatchedStep"],
      ["playwrightBddRunner.scaffoldFeatureFromPanel", "view == playwrightBddRunner.stepsExplorer && viewItem == unmatchedFile"],
    ]);
  });

  it("hides the tree-node scaffold wrappers from the command palette", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    for (const command of [
      "playwrightBddRunner.scaffoldStepFromPanel",
      "playwrightBddRunner.scaffoldFeatureFromPanel",
    ]) {
      expect(palette.find((e) => e.command === command)?.when).toBe("false");
    }
    for (const command of [
      "playwrightBddRunner.refreshStepsPanel",
      "playwrightBddRunner.exportSteps",
      "playwrightBddRunner.exportScenarios",
      "playwrightBddRunner.insertStep",
    ]) {
      expect(palette.find((e) => e.command === command)).toBeUndefined();
    }
  });

  it("moves traceability node commands into the webview and hides them from the palette", () => {
    const itemContext = pkg.contributes.menus["view/item/context"]!;
    const traceabilityItems = itemContext.filter((e) => e.when?.includes("traceabilityTestKey"));
    expect(traceabilityItems).toEqual([]);

    const palette = pkg.contributes.menus["commandPalette"]!;
    for (const command of ["playwrightBddRunner.traceability.openIssue", "playwrightBddRunner.traceability.copyKey"]) {
      expect(palette.find((e) => e.command === command)?.when).toBe("false");
    }
  });

  // Each of these acts on what the caller passed: a tree node, an Explorer resource. The palette
  // passes nothing, so a bare invocation would name nothing to run and report that it ran nothing.
  // The palette's own run-and-publish route is runAndPublishByTagExpression, which prompts;
  // runAndPublishAllMapped is the traceability view's title-bar button and is hidden here too.
  it("hides every argument-taking run-and-publish command from the palette", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    for (const command of [
      "playwrightBddRunner.traceability.runAndPublish",
      "playwrightBddRunner.traceability.runAndPublishFeature",
      "playwrightBddRunner.traceability.runAndPublishFolder",
    ]) {
      expect(palette.find((e) => e.command === command)?.when).toBe("false");
    }
  });

  it("leaves clear-run-history in the palette unconditionally (the stores fill with the panel off)", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    expect(palette.find((e) => e.command === "playwrightBddRunner.traceability.clearLocalRunHistory")).toBeUndefined();
  });

  it("puts connection management in the traceability overflow menu", () => {
    const viewTitle = pkg.contributes.menus["view/title"]!;
    const plug = viewTitle.find((e) => e.command === "playwrightBddRunner.traceability.manageConnection");
    expect(plug?.when).toBe("view == playwrightBddRunner.traceability");
    expect(plug?.group).toBe("playwrightBddRunner@4");
  });

  it("keeps Coverage Board, Sync, and Find as primary traceability title actions", () => {
    const viewTitle = pkg.contributes.menus["view/title"]!;
    const slots = viewTitle
      .filter((e) =>
        e.command?.startsWith("playwrightBddRunner.traceability.") &&
        e.group?.startsWith("navigation")
      )
      .map((e) => [e.command, e.group] as const);

    expect(slots).toEqual([
      ["playwrightBddRunner.traceability.sync", "navigation@2"],
      ["playwrightBddRunner.traceability.openBoard", "navigation@1"],
      ["playwrightBddRunner.traceability.find", "navigation@3"],
    ]);
    expect(viewTitle.find((entry) => entry.command === "playwrightBddRunner.traceability.find")?.when)
      .toBe("view == playwrightBddRunner.traceability");
    expect(pkg.contributes.commands.find((entry) => entry.command === "playwrightBddRunner.traceability.find"))
      .toMatchObject({ title: "Find in Traceability", icon: "$(search)" });
  });

  it("focuses Traceability before asking the webview to focus its filter", async () => {
    const execute = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    const focusFilter = vi.fn();
    try {
      const handlers = captureHandlers(makeContext(), (manager) => {
        manager.setTraceabilitySubsystem({ focusFilter } as unknown as TraceabilitySubsystem);
      });

      await handlers.get("playwrightBddRunner.traceability.find")!();

      expect(execute.mock.calls.map(([command]) => command)).toEqual(["playwrightBddRunner.traceability.focus"]);
      expect(focusFilter).toHaveBeenCalledOnce();
    } finally {
      execute.mockRestore();
    }
  });

  it("does not request filter focus when VS Code cannot focus the webview", async () => {
    const execute = vi.spyOn(vscode.commands, "executeCommand").mockRejectedValue(new Error("focus failed"));
    const focusFilter = vi.fn();
    try {
      const handlers = captureHandlers(makeContext(), (manager) => {
        manager.setTraceabilitySubsystem({ focusFilter } as unknown as TraceabilitySubsystem);
      });

      await handlers.get("playwrightBddRunner.traceability.find")!();

      expect(focusFilter).not.toHaveBeenCalled();
    } finally {
      execute.mockRestore();
    }
  });

  // Adjacent duplicates read as one button pressed twice, so the toolbar's glyphs must all differ.
  it("paints every title-bar button with a distinct icon", () => {
    const iconOf = (command: string): string | undefined =>
      pkg.contributes.commands.find((c) => c.command === command)?.icon;
    const icons = pkg.contributes.menus["view/title"]!
      .filter((e) => e.command?.startsWith("playwrightBddRunner.traceability."))
      .map((e) => iconOf(e.command!));

    expect(icons).toEqual(["$(list-tree)", "$(sync)", "$(play-circle)", "$(cloud-upload)", "$(plug)", "$(project)", "$(search)"]);
    expect(new Set(icons).size).toBe(icons.length);
  });

  // Every traceability command carries an icon now, so the ones VS Code paints (title bar, inline rows,
  // editor actions) never fall back to a blank slot.
  it("declares an icon for every traceability command", () => {
    const iconless = pkg.contributes.commands
      .filter((c) => c.command.startsWith("playwrightBddRunner.traceability.") && c.icon === undefined)
      .map((c) => c.command);

    expect(iconless).toEqual([]);
  });

  it("keeps switch-default-project out of native item menus", () => {
    const entries = pkg.contributes.menus["view/item/context"]!.filter(
      (e) =>
        e.command === "playwrightBddRunner.traceability.switchDefaultProject" &&
        e.when === "view == playwrightBddRunner.traceability && viewItem == traceabilityConnection"
    );

    expect(entries).toEqual([]);
  });
});

interface EnvHooks {
  __openExternalCalls: string[];
  __clipboardText: string;
  __resetEnv: () => void;
}

const envHooks = (vscode as unknown as { env: EnvHooks }).env;

function stubAdapter(resolve: (key: string) => string | undefined): TraceabilityAdapter {
  return {
    id: "xray",
    label: "Xray",
    keyGrammar: {
      testPrefix: "TEST_",
      reqPrefix: "REQ_",
      keyShape: /^[A-Z]+-\d+$/,
      canonicalizeKey: (key) => key.toUpperCase(),
    },
    browseUrl: (ref: ExternalRef) => resolve(ref.key),
  };
}

describe("traceability browse/copy command handlers", () => {
  beforeEach(() => envHooks.__resetEnv());

  async function openIssue(adapter: TraceabilityAdapter, arg: unknown): Promise<void> {
    const handlers = captureHandlers(makeContext({ traceabilityAdapter: adapter }));
    await handlers.get("playwrightBddRunner.traceability.openIssue")!(arg);
  }

  it("opens the browse URL the adapter resolves for the key", async () => {
    await openIssue(stubAdapter((key) => `https://acme.atlassian.net/browse/${key}`), { testKey: "CALC-1" });
    expect(envHooks.__openExternalCalls).toEqual(["https://acme.atlassian.net/browse/CALC-1"]);
  });

  it("warns and opens nothing when the adapter yields no browse URL", async () => {
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    await openIssue(stubAdapter(() => undefined), { testKey: "CALC-1" });
    expect(envHooks.__openExternalCalls).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("no-ops when the item carries no issue key", async () => {
    await openIssue(stubAdapter((key) => `https://acme.atlassian.net/browse/${key}`), { notAKey: true });
    expect(envHooks.__openExternalCalls).toEqual([]);
  });

  it("copies the issue key to the clipboard", async () => {
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.copyKey")!({ testKey: "CALC-1" });
    expect(envHooks.__clipboardText).toBe("CALC-1");
  });
});

describe("traceability hidePanel command handler", () => {
  interface Update {
    key: string;
    value: unknown;
    target: vscode.ConfigurationTarget;
  }

  function stubWorkspaceConfig(inspected: Record<string, unknown>): Update[] {
    const updates: Update[] = [];
    const wsConfig = {
      get: (): unknown => undefined,
      inspect: (): Record<string, unknown> => inspected,
      update: (key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void> => {
        updates.push({ key, value, target });
        return Promise.resolve();
      },
    } as unknown as vscode.WorkspaceConfiguration;
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(wsConfig);
    return updates;
  }

  afterEach(() => vi.restoreAllMocks());

  it("writes traceability.enablePanel=false to Global when it is not workspace-pinned", async () => {
    const updates = stubWorkspaceConfig({});
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.hidePanel")!();
    expect(updates).toEqual([
      { key: "traceability.enablePanel", value: false, target: vscode.ConfigurationTarget.Global },
    ]);
  });

  it("writes it back to the Workspace when the setting is pinned there", async () => {
    const updates = stubWorkspaceConfig({ workspaceValue: true });
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.hidePanel")!();
    expect(updates[0]?.target).toBe(vscode.ConfigurationTarget.Workspace);
  });
});

describe("traceability panel connection UX contributions", () => {
  interface PackageJson {
    contributes: {
      viewsWelcome: Array<{ view: string; when?: string; contents: string }>;
      menus: Record<string, Array<{ command?: string; when?: string }>>;
    };
  }
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf-8")
  ) as PackageJson;

  it("moves traceability welcome states into the webview", () => {
    const welcomes = pkg.contributes.viewsWelcome.filter(
      (w) => w.view === "playwrightBddRunner.traceability"
    );
    expect(welcomes).toEqual([]);
  });

  it("keeps the welcome-only hidePanel command out of the palette", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    expect(
      palette.find((e) => e.command === "playwrightBddRunner.traceability.hidePanel")?.when
    ).toBe("false");
  });

  it("offers a real discovery recovery action in the empty Testing view", () => {
    const welcome = pkg.contributes.viewsWelcome.find(
      (item) => item.view === "workbench.view.testing"
    );
    expect(welcome?.contents).toContain("command:playwrightBddRunner.discoverTests");
  });
});

describe("traceability linkScenario command", () => {
  afterEach(() => {
    win.__resetWebviewPanels();
    vi.restoreAllMocks();
  });

  const untracedNode = {
    kind: "untraced",
    item: { scenario: { filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" } },
  };

  // The command opens the board and begins a Link session on it; drive a link-tagged confirm on the
  // board panel, then await the handler so the tag-write side effect has run.
  async function confirmLink(pending: Promise<void>, id: string): Promise<void> {
    const panel = win.__webviewPanels.at(-1)!;
    if (panel.webview.__posted.length === 0) {
      await receiveBoard(panel, "shell", { type: "ready" });
    }
    await receiveBoard(panel, "link", { type: "search", value: id });
    const rows = boardPosts(panel).filter((message) => message.surface === "link" && message.type === "rows").at(-1)?.["rows"];
    expect(rows).toEqual(expect.arrayContaining([expect.objectContaining({ id })]));
    const current = (BoardPanel as unknown as { current?: { revision: number } }).current;
    expect(panel.webview.__posted.at(-1)?.revision).toBe(current?.revision);
    await receiveBoard(panel, "link", { type: "confirm", id });
    await pending;
  }

  async function syncedAdapter(): Promise<InMemoryTraceabilityAdapter> {
    const adapter = new InMemoryTraceabilityAdapter();
    adapter.seedCatalogue([{ key: "5", summary: "Five" }], []);
    await adapter.metadata.sync({ testKeys: ["5"] });
    return adapter;
  }

  it("prompts to connect/sync when the active adapter exposes no metadata capability", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.linkScenario")!(untracedNode);
    expect(String(info.mock.calls[0]?.[0])).toContain("Sync");
  });

  it("no-ops with guidance when invoked from the palette without a scenario row", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.linkScenario")!();
    expect(String(info.mock.calls[0]?.[0])).toContain("Traceability view");
  });

  it("informs the user when the snapshot has no synced tests instead of showing a blank picker", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const handlers = captureHandlers(makeContext({ traceabilityAdapter: new InMemoryTraceabilityAdapter() }));
    await handlers.get("playwrightBddRunner.traceability.linkScenario")!(untracedNode);
    expect(String(info.mock.calls[0]?.[0])).toContain("No synced tests");
  });

  it("inserts the grammar-built test tag above the untraced scenario via a WorkspaceEdit", async () => {
    const adapter = await syncedAdapter();
    const feature = "Feature: F\n\nScenario: A\n  Given x\n";
    const doc = {
      uri: vscode.Uri.file("/ws/a.feature"),
      getText: () => feature,
      save: () => Promise.resolve(true),
    };
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(doc as unknown as vscode.TextDocument);
    const applied: Array<{ __entries: Array<{ op: string; text: string }> }> = [];
    vi.spyOn(vscode.workspace, "applyEdit").mockImplementation((edit) => {
      applied.push(edit as unknown as { __entries: Array<{ op: string; text: string }> });
      return Promise.resolve(true);
    });

    const handlers = captureHandlers(makeContext({ traceabilityAdapter: adapter }));
    await confirmLink(handlers.get("playwrightBddRunner.traceability.linkScenario")!(untracedNode), "5");

    expect(applied).toHaveLength(1);
    expect(applied[0]!.__entries).toHaveLength(1);
    expect(applied[0]!.__entries[0]).toMatchObject({ op: "insert", text: "@TC-5\n" });
  });

  it("reports an error rather than a link when the workspace refuses the tag edit", async () => {
    const adapter = await syncedAdapter();
    const doc = {
      uri: vscode.Uri.file("/ws/a.feature"),
      getText: () => "Feature: F\n\nScenario: A\n  Given x\n",
      save: () => Promise.resolve(true),
    };
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(doc as unknown as vscode.TextDocument);
    vi.spyOn(vscode.workspace, "applyEdit").mockResolvedValue(false);
    const error = vi.spyOn(vscode.window, "showErrorMessage");

    const handlers = captureHandlers(makeContext({ traceabilityAdapter: adapter }));
    await confirmLink(handlers.get("playwrightBddRunner.traceability.linkScenario")!(untracedNode), "5");

    expect(error.mock.calls[0]?.[0]).toBe("Could not link 5: the feature file edit was not applied.");
  });

  it("opens the Coverage Board and reveals the contextual Link tab", async () => {
    const adapter = await syncedAdapter();
    const handlers = captureHandlers(makeContext({ traceabilityAdapter: adapter }));
    const pending = handlers.get("playwrightBddRunner.traceability.linkScenario")!(untracedNode);

    const board = win.__webviewPanels.at(-1)!;
    expect(board.title).toBe("Coverage Board");
    await receiveBoard(board, "shell", { type: "ready" });
    expect(boardPosts(board).find((m) => m.type === "linkTab" && m["visible"] === true)).toBeDefined();

    await confirmLink(pending, "5");
  });

  it("quietly forces a project sync after a newly created test is tagged", async () => {
    const changed = new vscode.EventEmitter<void>();
    const created = vi.fn(() => Promise.resolve({ key: "CALC-9", warnings: [] }));
    const merged: string[] = [];
    let finishMerge!: () => void;
    const pendingMerge = new Promise<void>((resolve) => {finishMerge = resolve;});
    const adapter = {
      id: "xray",
      label: "Xray",
      keyGrammar: {
        testPrefix: "TEST_",
        reqPrefix: "REQ_",
        keyShape: /^[A-Za-z][A-Za-z0-9_-]*-\d+$/,
        canonicalizeKey: (key: string) => key.toUpperCase(),
        projectOf: (key: string) => key.replace(/-\d+$/, ""),
      },
      browseUrl: () => undefined,
      metadata: {
        onDidChange: changed.event,
        snapshot: () => ({
          tests: new Map(), fetchedScopes: [], catalogueProjects: ["CALC"], completeProjects: ["CALC"],
          verifiedAbsentKeys: [], stale: false, errors: [], syncedAt: 1,
        }),
        sync: () => Promise.resolve(),
      },
      remoteSearch: {
        search: () => Promise.resolve({ tests: [], complete: true }),
        mergeKeys: (keys: readonly string[]) => {merged.push(...keys); return pendingMerge;},
      },
      testAuthoring: { createTest: created },
    } as TraceabilityAdapter;
    const scenario = untracedNode.item.scenario as ScenarioRef;
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(
      fakeDoc("Feature: F\n\nScenario: A\n  Given x\n")
    );
    vi.spyOn(vscode.workspace, "applyEdit").mockResolvedValue(true);
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("CALC" as never);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Create test" as never);

    const manager = CommandManager.create(makeContext({ traceabilityAdapter: adapter }));
    manager.setTraceabilitySubsystem({
      traceabilityPanelActive: true,
      connected: true,
      getActiveAdapter: () => adapter,
      getSnapshot: () => ({
        links: [], untraced: [{ scenario, reqKeys: [] }], orphans: [], stale: false,
        completeProjects: ["CALC"], errors: [],
      }),
      knownTestKeys: () => [],
      tagDerivedProjectKeys: () => [],
      projectScope: () => NO_PROJECT_SCOPE,
      mappingPageSize: () => NO_MAPPING_PAGE_SIZE,
      onDidChangeSnapshot: changed.event,
    } as unknown as TraceabilitySubsystem);
    const commands = traceabilityCommands(manager);
    const sync = vi.spyOn(commands, "syncTraceability").mockResolvedValue();

    await confirmLink(commands.linkScenario(untracedNode), " create");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(created).toHaveBeenCalledOnce();
    expect(merged).toEqual(["CALC-9"]);
    expect(sync).not.toHaveBeenCalled();

    finishMerge();
    await pendingMerge;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(sync).toHaveBeenCalledWith({ announce: false, explicitKey: "CALC", forceProject: true });
    changed.dispose();
  });

  async function reMap(feature: string): Promise<string> {
    const adapter = new InMemoryTraceabilityAdapter();
    adapter.seedCatalogue([{ key: "9", summary: "Nine" }], []);
    await adapter.metadata.sync({ testKeys: ["9"] });
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(fakeDoc(feature));
    const applied: EditEntry[][] = [];
    vi.spyOn(vscode.workspace, "applyEdit").mockImplementation((edit) => {
      applied.push((edit as unknown as { __entries: EditEntry[] }).__entries);
      return Promise.resolve(true);
    });
    const handlers = captureHandlers(makeContext({ traceabilityAdapter: adapter }));
    await confirmLink(
      handlers.get("playwrightBddRunner.traceability.linkScenario")!({
        kind: "link",
        link: { scenario: { filePath: "/ws/a.feature", line: 4, name: "A", kind: "scenario" } },
      }),
      "9"
    );
    expect(applied).toHaveLength(1);
    return applyWsEdit(feature, applied[0]!);
  }

  it("re-maps an already-linked LF document to the picked key, byte-exact", async () => {
    expect(await reMap("Feature: F\n\n@TC-5\nScenario: A\n  Given x\n")).toBe(
      "Feature: F\n\n@TC-9\nScenario: A\n  Given x\n"
    );
  });

  it("re-maps an already-linked CRLF document without a doubled carriage return", async () => {
    const out = await reMap("Feature: F\r\n\r\n@TC-5\r\nScenario: A\r\n  Given x\r\n");
    expect(out).toBe("Feature: F\r\n\r\n@TC-9\r\nScenario: A\r\n  Given x\r\n");
    expect(out).not.toContain("\r\r");
  });
});

describe("traceability linkScenario contributions", () => {
  interface Pkg {
    contributes: {
      commands: Array<{ command: string; category?: string }>;
      menus: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
    };
  }
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf-8")
  ) as Pkg;
  const CMD = "playwrightBddRunner.traceability.linkScenario";

  it("declares the command under the Specwright category", () => {
    expect(pkg.contributes.commands.find((c) => c.command === CMD)?.category).toBe("Specwright");
  });

  it("keeps link actions out of native item menus", () => {
    const items = pkg.contributes.menus["view/item/context"]!.filter((e) => e.command === CMD);
    expect(items).toEqual([]);
  });

  it("hides the node action from the palette", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    const entries = palette.filter((entry) => entry.command === CMD);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.when).toBe("false");
  });
});

describe("traceability sync command handler", () => {
  afterEach(() => {
    win.__resetWebviewPanels();
    vi.restoreAllMocks();
  });

  it("guides the user when no metadata capability is active", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.sync")!();
    expect(String(info.mock.calls[0]?.[0])).toContain("Connect");
  });

  // A subsystem whose adapter derives projects from its keys, with every seam the sync scope reads:
  // the tag-derived keys, the catalogue the last sync left, the provider directory, and the board's
  // stored project selection. Its sync commits like the real one (a fresh `syncedAt` per run) unless
  // `commits: false` reproduces a run that discarded its pages and left the snapshot untouched.
  function syncSubsystem(over: {
    sync?: (scope: SyncScope, signal?: AbortSignal, onProgress?: SyncProgress) => Promise<void>;
    snapshotErrors?: string[];
    tests?: Map<string, unknown>;
    catalogueProjects?: string[];
    tagDerived?: string[];
    testKeys?: string[];
    directory?: string[];
    scope?: ProjectScopeStore;
    completeProjects?: string[];
    commits?: boolean;
    connected?: boolean;
  } = {}): TraceabilitySubsystem {
    const run = over.sync ?? ((): Promise<void> => Promise.resolve());
    let syncedAt: number | undefined;
    const adapter = {
      keyGrammar: { testPrefix: "TEST_", projectOf: (k: string) => k.split("-")[0] },
      metadata: {
        sync: async (scope: SyncScope, signal?: AbortSignal, onProgress?: SyncProgress): Promise<void> => {
          await run(scope, signal, onProgress);
          if (over.commits !== false) {
            syncedAt = (syncedAt ?? 0) + 1;
          }
        },
        snapshot: () => ({
          tests: over.tests ?? new Map(),
          fetchedScopes: [],
          catalogueProjects: over.catalogueProjects ?? [],
          completeProjects: [],
          verifiedAbsentKeys: [],
          stale: false,
          errors: over.snapshotErrors ?? [],
          syncedAt,
        }),
      },
      ...(over.directory
        ? {
            projectDirectory: {
              cached: () => ({ projects: over.directory!.map((key) => ({ key, name: key })), truncated: false }),
              list: () => Promise.resolve({ projects: [], truncated: false }),
            },
          }
        : {}),
    };
    return {
      traceabilityPanelActive: true,
      connected: over.connected ?? true,
      getSnapshot: () => ({
        links: [],
        untraced: [],
        orphans: [],
        stale: false,
        completeProjects: over.completeProjects ?? ["CALC"],
        errors: [],
      }),
      getActiveAdapter: () => adapter,
      knownTestKeys: () => over.testKeys ?? [],
      tagDerivedProjectKeys: () => over.tagDerived ?? [],
      projectScope: () => over.scope ?? NO_PROJECT_SCOPE,
      mappingPageSize: () => NO_MAPPING_PAGE_SIZE,
      onDidChangeSnapshot: new vscode.EventEmitter<void>().event,
    } as unknown as TraceabilitySubsystem;
  }

  function managerFor(
    subsystem: TraceabilitySubsystem,
    settings: Record<string, unknown> = {},
    logger = Logger.create()
  ): CommandManager {
    const workspaceConfig = {
      get: (key: string, fallback: unknown) => (key in settings ? settings[key] : fallback),
    } as unknown as vscode.WorkspaceConfiguration;
    const mgr = CommandManager.create(
      makeContext({ config: ExtensionConfig.create(workspaceConfig, false), logger })
    );
    mgr.setTraceabilitySubsystem(subsystem);
    return mgr;
  }

  const runSyncOn = (mgr: CommandManager): Promise<void> =>
    traceabilityCommands(mgr).syncTraceability();

  // The board's two ways into the sync: the Sync button and the quiet per-project load.
  const boardLoads = (mgr: CommandManager): { runSync: () => Promise<void>; autoSync: (key: string) => Promise<void> } =>
    traceabilityBoardDeps(mgr);

  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("schedules one quiet direct sync for bounded reindex diagnostics and contains refresh failure", async () => {
    const logger = Logger.create();
    const commands = traceabilityCommands(managerFor(syncSubsystem({ catalogueProjects: ["CALC"] }), {}, logger));
    const sync = vi.spyOn(commands, "syncTraceability").mockImplementation(() => {
      throw new Error("refresh offline");
    });
    const logged = vi.spyOn(logger, "warn");
    const recover = commands as unknown as {
      scheduleProjectSync(project: string, diagnostics?: Iterable<string>): void;
    };

    recover.scheduleProjectSync("CALC", ["ordinary warning", "Project may need re-indexing", "reindexed"]);
    await flush();

    expect(sync).toHaveBeenCalledOnce();
    expect(sync).toHaveBeenCalledWith({ announce: false, explicitKey: "CALC", forceProject: true });
    expect(logged).toHaveBeenCalledWith(
      "Follow-up traceability sync failed",
      expect.objectContaining({ project: "CALC", error: "refresh offline" })
    );
  });

  it("does not schedule recovery for an ordinary provider warning", async () => {
    const commands = traceabilityCommands(managerFor(syncSubsystem()));
    const sync = vi.spyOn(commands, "syncTraceability").mockResolvedValue();
    (commands as unknown as { scheduleProjectSync(project: string, diagnostics?: Iterable<string>): void })
      .scheduleProjectSync("CALC", ["summary was trimmed"]);

    await flush();

    expect(sync).not.toHaveBeenCalled();
  });

  it("starts a successful create's project sync only after the authoring mutation owner has retired", async () => {
    const commands = traceabilityCommands(managerFor(syncSubsystem({ catalogueProjects: ["CALC"] })));
    const internals = commands as unknown as {
      operations: { mutationActive: boolean };
      scheduleProjectSync(project: string, diagnostics?: Iterable<string>): void;
      getAuthoringCommands(): { bulkCreateTests(): Promise<void> };
    };
    vi.spyOn(internals, "getAuthoringCommands").mockReturnValue({
      bulkCreateTests: async () => {
        internals.scheduleProjectSync("CALC");
      },
    });
    const activeWhenSyncStarts: boolean[] = [];
    const sync = vi.spyOn(commands, "syncTraceability").mockImplementation(() => {
      activeWhenSyncStarts.push(internals.operations.mutationActive);
      return Promise.resolve();
    });

    await commands.bulkCreateTests();
    await flush();

    expect(activeWhenSyncStarts).toEqual([false]);
    expect(sync).toHaveBeenCalledWith({ announce: false, explicitKey: "CALC", forceProject: true });
  });

  it("syncs with the workspace + configured project scope and surfaces snapshot errors as a toast", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const errorToast = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);

    await runSyncOn(managerFor(syncSubsystem({ sync, snapshotErrors: ["boom"], testKeys: ["CALC-1"] })));

    expect(sync).toHaveBeenCalledWith({ testKeys: ["CALC-1"], projectKeys: [] }, expect.anything(), expect.anything());
    expect(errorToast).toHaveBeenCalled();
  });

  it("scopes the sync to the tags and the already-synced catalogue, never the provider directory", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const subsystem = syncSubsystem({
      sync,
      testKeys: ["CALC-1"],
      tagDerived: ["CALC"],
      catalogueProjects: ["MATH"],
      directory: ["OPS"],
    });

    await runSyncOn(managerFor(subsystem));

    expect(sync).toHaveBeenCalledWith(
      { testKeys: ["CALC-1"], projectKeys: ["CALC", "MATH"] },
      expect.anything(),
      expect.anything()
    );
  });

  it("fetches the chosen projects and nothing else once the setting names the scope", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const subsystem = syncSubsystem({
      sync,
      testKeys: ["CALC-1"],
      tagDerived: ["CALC"],
      catalogueProjects: ["MATH"],
      directory: ["OPS"],
    });

    await runSyncOn(managerFor(subsystem, { "xray.syncProjectKeys": ["shop"] }));

    expect(sync).toHaveBeenCalledWith(
      { testKeys: ["CALC-1"], projectKeys: ["SHOP"] },
      expect.anything(),
      expect.anything()
    );
  });

  it("carries the default project key into the sync scope, so a create target is also a sync target", async () => {
    const sync = vi.fn(() => Promise.resolve());

    await runSyncOn(managerFor(syncSubsystem({ sync }), { "xray.defaultProjectKey": " pay " }));

    expect(sync).toHaveBeenCalledWith({ testKeys: [], projectKeys: ["PAY"] }, expect.anything(), expect.anything());
  });

  // One rule for every control: the standing scope plus the board's working project, named for that run.
  // The palette's Sync Traceability is not an exception, so a project the board is working in is never
  // reachable from the board and missing from the palette.
  it("unions the board's working project into the palette sync, alongside the standing scope", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const scope = projectScopeStore(memento(), () => undefined);
    scope.set("PAY");
    // The board really is working in PAY, so a scope without it cannot be a selection that never landed.
    expect(scope.get(["PAY", "OPS"])).toBe("PAY");

    await runSyncOn(managerFor(syncSubsystem({ sync, directory: ["PAY", "OPS"], scope, catalogueProjects: ["MATH"] })));

    expect(sync).toHaveBeenCalledWith({ testKeys: [], projectKeys: ["MATH", "PAY"] }, expect.anything(), expect.anything());
  });

  // A pinned list is the standing scope, and the working project rides alongside it for that run without
  // rewriting it. Both halves matter: dropping either strands one of the two controls.
  it("adds the working project to a pinned sync list for that run", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const scope = projectScopeStore(memento(), () => undefined);
    scope.set("PAY");
    const mgr = managerFor(
      syncSubsystem({ sync, directory: ["PAY", "OPS"], scope }),
      { "xray.syncProjectKeys": ["SHOP"] }
    );

    await boardLoads(mgr).runSync();

    expect(sync).toHaveBeenCalledWith({ testKeys: [], projectKeys: ["PAY", "SHOP"] }, expect.anything(), expect.anything());
  });

  it("names the working project once when a standing rung already holds it", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const scope = projectScopeStore(memento(), () => undefined);
    scope.set("MATH");
    const mgr = managerFor(syncSubsystem({ sync, scope, catalogueProjects: ["MATH"] }));

    await boardLoads(mgr).runSync();

    expect(sync).toHaveBeenCalledWith({ testKeys: [], projectKeys: ["MATH"] }, expect.anything(), expect.anything());
  });

  // A directory-only project sits on no rung, so once its quiet load fails the board can only get it
  // through Sync naming it. Without that the selection is stranded and the board never fills.
  it("names the board's working project on Sync, even after its quiet load failed", async () => {
    let failNext = true;
    const sync = vi.fn(() => {
      if (failNext) {
        failNext = false;
        return Promise.reject(new Error("the site is unreachable"));
      }
      return Promise.resolve();
    });
    const scope = projectScopeStore(memento(), () => undefined);
    scope.set("PAY");
    const mgr = managerFor(syncSubsystem({ sync, directory: ["PAY", "OPS"], scope }));

    await boardLoads(mgr).autoSync("PAY");
    await boardLoads(mgr).runSync();

    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync).toHaveBeenLastCalledWith({ testKeys: [], projectKeys: ["PAY"] }, expect.anything(), expect.anything());
  });

  it("coalesces concurrent invocations into a single in-flight run", async () => {
    let resolveSync!: () => void;
    const sync = vi.fn(() => new Promise<void>((resolve) => { resolveSync = resolve; }));
    const mgr = managerFor(syncSubsystem({ sync }));

    const first = runSyncOn(mgr);
    const second = runSyncOn(mgr);
    resolveSync();
    await Promise.all([first, second]);

    // The second invoke joined the in-flight run rather than starting a second sync.
    expect(sync).toHaveBeenCalledTimes(1);
  });

  // A project picked mid-run cannot be in the running scope, which was resolved before the pick, so it
  // is not allowed to join: it earns exactly one follow-up whose scope covers it.
  it("reruns once for a project picked while a sync is in flight, with the picked key in scope", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const resolvers: Array<() => void> = [];
    const sync = vi.fn((_scope: SyncScope) => new Promise<void>((resolve) => resolvers.push(resolve)));
    const mgr = managerFor(syncSubsystem({ sync }));
    const { autoSync } = boardLoads(mgr);

    const first = runSyncOn(mgr);
    void autoSync("PAY");
    void autoSync("PAY");
    expect(sync).toHaveBeenCalledTimes(1);

    resolvers[0]!();
    await first;
    await flush();

    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync.mock.calls[0]![0]).toEqual({ testKeys: [], projectKeys: [] });
    expect(sync.mock.calls[1]![0]).toEqual({ testKeys: [], projectKeys: ["PAY"] });

    // One slot, so the two picks produced one follow-up and that follow-up queues nothing further.
    resolvers[1]!();
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);
    // Only the run the user asked for spoke; the load it replayed stayed quiet.
    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith("Synced 0 remote tests.");
  });

  it("preserves every forced project behind an active sync despite later ordinary loads", async () => {
    const scopes: SyncScope[] = [];
    const resolvers: Array<() => void> = [];
    const sync = vi.fn((scope: SyncScope) => {
      scopes.push(scope);
      return new Promise<void>((resolve) => resolvers.push(resolve));
    });
    const mgr = managerFor(syncSubsystem({ sync }));
    const commands = traceabilityCommands(mgr);
    const recover = commands as unknown as {
      scheduleProjectSync(project: string, diagnostics?: Iterable<string>): void;
    };

    const initial = runSyncOn(mgr);
    recover.scheduleProjectSync("CALC", ["CALC needs reindexing"]);
    recover.scheduleProjectSync("PAY", ["PAY needs reindexing"]);
    void boardLoads(mgr).autoSync("CALC");
    void boardLoads(mgr).autoSync("PAY");
    await flush();
    expect(sync).toHaveBeenCalledOnce();

    resolvers[0]!();
    await initial;
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(2));
    resolvers[1]!();
    await vi.waitFor(() => expect(sync).toHaveBeenCalledTimes(3));
    resolvers[2]!();
    await flush();

    expect(scopes).toEqual([
      { testKeys: [], projectKeys: [] },
      { testKeys: [], projectKeys: ["CALC"] },
      { testKeys: [], projectKeys: ["PAY"] },
    ]);
  });

  // The gates belong to the moment the follow-up runs, not the moment it was queued: the run in flight
  // may well be the one that catalogues the picked project.
  it("re-checks the gates when it replays a queued pick, so nothing is fetched twice", async () => {
    const catalogueProjects: string[] = [];
    const resolvers: Array<() => void> = [];
    const sync = vi.fn((_scope: SyncScope) => new Promise<void>((resolve) => resolvers.push(resolve)));
    const mgr = managerFor(syncSubsystem({ sync, catalogueProjects }));

    const first = runSyncOn(mgr);
    void boardLoads(mgr).autoSync("PAY");
    catalogueProjects.push("PAY");
    resolvers[0]!();
    await first;
    await flush();

    expect(sync).toHaveBeenCalledOnce();
  });

  it("loads a project the catalogue has never held, quietly", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const mgr = managerFor(syncSubsystem({ sync, tagDerived: ["CALC"] }));

    await boardLoads(mgr).autoSync("PAY");

    expect(sync).toHaveBeenCalledWith({ testKeys: [], projectKeys: ["CALC", "PAY"] }, expect.anything(), expect.anything());
    expect(info).not.toHaveBeenCalled();
  });

  // A pinned list is the durable scope, not a cage: the project the board just opened is fetched for
  // this run, and nothing else joins it. Without that rung the load can never catalogue its project,
  // so the board would ask for it again on every repaint.
  it("loads a board's project under a pinned list without widening the pinned scope", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const mgr = managerFor(syncSubsystem({ sync, tagDerived: ["CALC"] }), {
      "xray.syncProjectKeys": ["SHOP"],
    });

    await boardLoads(mgr).autoSync("PAY");

    expect(sync).toHaveBeenCalledWith(
      { testKeys: [], projectKeys: ["PAY", "SHOP"] },
      expect.anything(),
      expect.anything()
    );
  });

  it("loads nothing for a project an earlier sync already catalogued", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const mgr = managerFor(syncSubsystem({ sync, catalogueProjects: ["PAY"] }));

    await boardLoads(mgr).autoSync("PAY");

    expect(sync).not.toHaveBeenCalled();
  });

  // A quiet load that fails is a log line, not a notification: nobody asked for it, and a stale
  // connection verdict would raise the same red toast on every board open.
  it("logs a quiet load's failure rather than raising a notification", async () => {
    const errorToast = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);
    const logger = Logger.create();
    const warn = vi.spyOn(logger, "warn");
    const mgr = managerFor(syncSubsystem({ snapshotErrors: ["boom"] }), {}, logger);

    await boardLoads(mgr).autoSync("PAY");

    expect(errorToast).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("A board load's sync failed", {
      error: "Sync completed with errors: see the output channel for details.",
    });
  });

  it("loads nothing while the tracker is not known to be reachable", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const mgr = managerFor(syncSubsystem({ sync, connected: false }));

    await boardLoads(mgr).autoSync("PAY");

    expect(sync).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("wires the board's Sync button to the serialized sync, so two clicks share one run", async () => {
    let resolveSync!: () => void;
    const sync = vi.fn(() => new Promise<void>((resolve) => { resolveSync = resolve; }));
    const mgr = managerFor(syncSubsystem({ sync }));
    const { runSync } = boardLoads(mgr);

    const first = runSync();
    const second = runSync();
    resolveSync();
    await Promise.all([first, second]);

    // Rewiring the button to the unserialized command path would start a second, overlapping sync.
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("wires the board's Select sync projects button to the same project picker the palette opens", async () => {
    const quickPick = vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    const mgr = managerFor(syncSubsystem({ tagDerived: ["CALC"] }));

    traceabilityBoardDeps(mgr).selectSyncProjects();
    await flush();

    expect(quickPick).toHaveBeenCalledWith(
      [expect.objectContaining({ label: "CALC" })],
      expect.objectContaining({ title: "Select Projects to Sync", canPickMany: true })
    );
  });

  it("reports a finished sync as an information toast, zero tests included", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");

    await runSyncOn(managerFor(syncSubsystem()));

    expect(info).toHaveBeenCalledWith("Synced 0 remote tests.");
  });

  it("reports a cancelled sync as information rather than an error", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const errorToast = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);
    // A token that is already cancelled aborts the run's signal the moment the task subscribes.
    vi.spyOn(vscode.window, "withProgress").mockImplementation((_opts, task) =>
      (task as (p: unknown, t: unknown) => Thenable<unknown>)(
        { report: () => {} },
        { isCancellationRequested: true, onCancellationRequested: (cb: () => void) => { cb(); return { dispose: () => {} }; } }
      )
    );

    await runSyncOn(managerFor(syncSubsystem()));

    expect(info).toHaveBeenCalledWith("Sync cancelled.");
    expect(errorToast).not.toHaveBeenCalled();
  });

  // The strip's whole lifecycle: the pages it counts, the handover to the repaint, and the clear that
  // keeps a failed run from stranding it.
  async function openBoardFor(mgr: CommandManager): Promise<StubBoardPanel> {
    traceabilityCommands(mgr).openBoard();
    const panel = win.__webviewPanels[0]!;
    await receiveBoard(panel, "shell", { type: "ready" });
    return panel;
  }

  const strips = (panel: StubBoardPanel): Array<string | undefined> =>
    boardPosts(panel).filter((m) => m.type === "syncProgress").map((m) => m["text"] as string | undefined);

  const reportingSync = (): ((scope: SyncScope, signal?: AbortSignal, onProgress?: SyncProgress) => Promise<void>) =>
    (_scope, _signal, onProgress) => {
      onProgress?.({ projectKey: "PAY", fetched: 100, total: 350 });
      return Promise.resolve();
    };

  it("counts a sync's pages onto the board's strip, then hands over to the repaint", async () => {
    const mgr = managerFor(syncSubsystem({ sync: reportingSync(), tagDerived: ["PAY"] }));
    const panel = await openBoardFor(mgr);

    await runSyncOn(mgr);

    expect(strips(panel)).toEqual(["Syncing PAY: 100 of 350 tests", "Rendering…"]);
  });

  it("clears the strip when the sync reports errors, so a failed run cannot strand it", async () => {
    vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);
    const mgr = managerFor(syncSubsystem({ sync: reportingSync(), tagDerived: ["PAY"], snapshotErrors: ["boom"] }));
    const panel = await openBoardFor(mgr);

    await runSyncOn(mgr);

    expect(strips(panel).at(-1)).toBe("");
  });

  it("posts only a clear when a sync reported no pages at all", async () => {
    const mgr = managerFor(syncSubsystem());
    const panel = await openBoardFor(mgr);

    await runSyncOn(mgr);

    expect(strips(panel)).toEqual([""]);
  });

  // A run that fetched pages and then discarded them (a credential change mid-sync) commits nothing and
  // fires no change event, so there is no repaint to hand over to.
  it("clears the strip when a run counted pages but committed nothing", async () => {
    const mgr = managerFor(syncSubsystem({ sync: reportingSync(), tagDerived: ["PAY"], commits: false }));
    const panel = await openBoardFor(mgr);

    await runSyncOn(mgr);

    expect(strips(panel).at(-1)).toBe("");
  });

  it("still counts a quiet load onto the strip, since that is all it says", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const mgr = managerFor(syncSubsystem({ sync: reportingSync() }));
    const panel = await openBoardFor(mgr);

    await boardLoads(mgr).autoSync("PAY");

    expect(strips(panel)).toEqual(["Syncing PAY: 100 of 350 tests", "Rendering…"]);
    expect(info).not.toHaveBeenCalled();
  });

  it("passes the resolved sync scope into the board model, so the empty available group says the right thing", () => {
    const built = (settings: Record<string, unknown>, tagDerived: string[] = []): BoardViewModel =>
      traceabilityBoardDeps(
        managerFor(syncSubsystem({ tagDerived, completeProjects: [] }), settings)
      ).buildModel();

    // Either half catches an inverted scope bit at the call site, since it flips both branches at once.
    expect(built({ "xray.syncProjectKeys": ["CALC"] })).toMatchObject({
      availableEmptyText: "No synced tests yet.",
    });
    // The setting is only one rung: a tag-derived project is scope enough for useful unsynced copy.
    expect(built({}, ["CALC"])).toMatchObject({ availableEmptyText: "No synced tests yet." });
    expect(built({})).toMatchObject({
      availableEmptyText: "Pick a project in the header to load its tests.",
    });
  });
});

describe("traceability sync contributions", () => {
  interface Pkg {
    contributes: {
      commands: Array<{ command: string; category?: string; icon?: string }>;
      menus: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
    };
  }
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf-8")
  ) as Pkg;
  const CMD = "playwrightBddRunner.traceability.sync";

  it("declares the sync command under the Specwright category with a sync icon", () => {
    const command = pkg.contributes.commands.find((c) => c.command === CMD);
    expect(command?.category).toBe("Specwright");
    expect(command?.icon).toBe("$(sync)");
  });

  it("gates the palette entry and the view-title button on the connected context key", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    expect(palette.find((e) => e.command === CMD)?.when).toBe("playwrightBddRunner.traceability.connected");

    const button = pkg.contributes.menus["view/title"]!.find((e) => e.command === CMD);
    expect(button?.when).toBe(
      "view == playwrightBddRunner.traceability && playwrightBddRunner.traceability.connected"
    );
  });
});

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

describe("traceability board drag-to-link drop handler", () => {
  afterEach(() => vi.restoreAllMocks());

  const A: ScenarioRef = { filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" };

  function dropSnapshot(): TraceabilitySnapshot {
    return {
      links: [],
      untraced: [{ scenario: A, reqKeys: [] }],
      orphans: [{ testKey: "5", meta: { key: "5" } }],
      stale: false,
      completeProjects: ["CALC"],
      errors: [],
    };
  }

  function harness(snapshot: TraceabilitySnapshot) {
    const adapter = new InMemoryTraceabilityAdapter();
    const doc = {
      uri: vscode.Uri.file("/ws/a.feature"),
      getText: () => "Feature: F\n\nScenario: A\n  Given x\n",
      save: () => Promise.resolve(true),
    };
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(doc as unknown as vscode.TextDocument);
    const applied: Array<{ __entries: Array<{ op: string; text: string }> }> = [];
    vi.spyOn(vscode.workspace, "applyEdit").mockImplementation((edit) => {
      applied.push(edit as unknown as { __entries: Array<{ op: string; text: string }> });
      return Promise.resolve(true);
    });
    const mgr = CommandManager.create(makeContext({ traceabilityAdapter: adapter }));
    const subsystem = {
      getActiveAdapter: () => adapter,
      getSnapshot: () => snapshot,
    } as unknown as TraceabilitySubsystem;
    mgr.setTraceabilitySubsystem(subsystem);
    return { mgr, applied };
  }

  const drop = (mgr: CommandManager, dropId: string, key: string): Promise<void> =>
    linkCommands(mgr).applyBoardDrop(dropId, key);

  it("writes the tag via a single WorkspaceEdit inserting the grammar-built tag", async () => {
    const { mgr, applied } = harness(dropSnapshot());
    await drop(mgr, scenarioDropId(A), "5");
    expect(applied).toHaveLength(1);
    expect(applied[0]!.__entries).toHaveLength(1);
    expect(applied[0]!.__entries[0]).toMatchObject({ op: "insert", text: "@TC-5\n" });
  });

  it("routes through the shared applyTagInsert rather than duplicating the insert", async () => {
    const { mgr, applied } = harness(dropSnapshot());
    const insert = vi.spyOn(
      linkCommands(mgr) as unknown as { applyTagInsert: (...a: unknown[]) => Promise<unknown> },
      "applyTagInsert"
    );
    await drop(mgr, scenarioDropId(A), "5");
    expect(insert).toHaveBeenCalledOnce();
    expect(insert.mock.calls[0]![0]).toMatchObject({ filePath: "/ws/a.feature", line: 3 });
    expect(insert.mock.calls[0]![1]).toBe("5");
    expect(applied).toHaveLength(1);
  });

  it("rejects a stale drop with a toast and no edit when the scenario is gone from the snapshot", async () => {
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { mgr, applied } = harness(dropSnapshot());
    await drop(mgr, scenarioDropId({ ...A, line: 999 }), "5");
    expect(applied).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("rejects a drop naming a key the snapshot no longer knows", async () => {
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { mgr, applied } = harness(dropSnapshot());
    await drop(mgr, scenarioDropId(A), "NOPE-1");
    expect(applied).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("surfaces a failed write as an error toast without crashing", async () => {
    const adapter = new InMemoryTraceabilityAdapter();
    const doc = {
      uri: vscode.Uri.file("/ws/a.feature"),
      getText: () => "Feature: F\n\nScenario: A\n  Given x\n",
      save: () => Promise.resolve(true),
    };
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(doc as unknown as vscode.TextDocument);
    vi.spyOn(vscode.workspace, "applyEdit").mockRejectedValue(new Error("disk full"));
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const mgr = CommandManager.create(makeContext({ traceabilityAdapter: adapter }));
    mgr.setTraceabilitySubsystem({
      getActiveAdapter: () => adapter,
      getSnapshot: () => dropSnapshot(),
    } as unknown as TraceabilitySubsystem);

    await expect(drop(mgr, scenarioDropId(A), "5")).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
  });

  it("surfaces a refused write, which resolves rather than throwing, as an error toast", async () => {
    const { mgr } = harness(dropSnapshot());
    vi.spyOn(vscode.workspace, "applyEdit").mockResolvedValue(false);
    const error = vi.spyOn(vscode.window, "showErrorMessage");

    await drop(mgr, scenarioDropId(A), "5");

    expect(error.mock.calls[0]?.[0]).toBe("Could not link 5: the feature file edit was not applied");
  });
});

describe("traceability board unlink handler", () => {
  afterEach(() => vi.restoreAllMocks());

  const SOURCE = "Feature: F\n\n@TC-1 @TC-2\nScenario: A\n  Given x\n";
  const A: ScenarioRef = { filePath: "/ws/a.feature", line: 4, name: "A", kind: "scenario" };

  function unlinkSnapshot(): TraceabilitySnapshot {
    return {
      links: [
        { testKey: "1", scenario: A, reqKeys: [] },
        { testKey: "2", scenario: A, reqKeys: [] },
      ],
      untraced: [],
      orphans: [],
      stale: false,
      completeProjects: ["CALC"],
      errors: [],
    };
  }

  function harness(snapshot: TraceabilitySnapshot) {
    const adapter = new InMemoryTraceabilityAdapter();
    const lines = SOURCE.split("\n");
    const doc = {
      uri: vscode.Uri.file("/ws/a.feature"),
      eol: vscode.EndOfLine.LF,
      getText: () => SOURCE,
      lineAt: (n: number) => ({ text: lines[n] ?? "", rangeIncludingLineBreak: new vscode.Range(n, 0, n + 1, 0) }),
      save: () => Promise.resolve(true),
    };
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(doc as unknown as vscode.TextDocument);
    const applied: Array<{ __entries: Array<{ op: string; text: string }> }> = [];
    vi.spyOn(vscode.workspace, "applyEdit").mockImplementation((edit) => {
      applied.push(edit as unknown as { __entries: Array<{ op: string; text: string }> });
      return Promise.resolve(true);
    });
    const mgr = CommandManager.create(makeContext({ traceabilityAdapter: adapter }));
    mgr.setTraceabilitySubsystem({
      getActiveAdapter: () => adapter,
      getSnapshot: () => snapshot,
    } as unknown as TraceabilitySubsystem);
    return { mgr, applied };
  }

  const unlink = (mgr: CommandManager, dropId: string, key: string): Promise<void> =>
    linkCommands(mgr).applyBoardUnlink(dropId, key);

  it("routes a valid pair through applyTagRemove with the exact ref and key", async () => {
    const { mgr } = harness(unlinkSnapshot());
    const remove = vi.spyOn(
      linkCommands(mgr) as unknown as { applyTagRemove: (...a: unknown[]) => Promise<unknown> },
      "applyTagRemove"
    );
    await unlink(mgr, scenarioDropId(A), "1");
    expect(remove).toHaveBeenCalledOnce();
    expect(remove.mock.calls[0]![0]).toMatchObject({ filePath: "/ws/a.feature", line: 4 });
    expect(remove.mock.calls[0]![1]).toBe("1");
  });

  it("removes only the named key from a two-link scenario, leaving the other tag", async () => {
    const { mgr, applied } = harness(unlinkSnapshot());
    await unlink(mgr, scenarioDropId(A), "1");
    expect(applied).toHaveLength(1);
    expect(applied[0]!.__entries).toHaveLength(1);
    expect(applied[0]!.__entries[0]).toMatchObject({ op: "replace", text: "@TC-2" });
  });

  it("rejects a stale pair with a toast and no edit when no live link matches", async () => {
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { mgr, applied } = harness(unlinkSnapshot());
    await unlink(mgr, scenarioDropId({ ...A, line: 999 }), "1");
    expect(applied).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("traceability bulkCreateTests wiring", () => {
  afterEach(() => {
    win.__resetWebviewPanels();
    vi.restoreAllMocks();
  });

  const A: ScenarioRef = { filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" };

  function subsystemWithAuthoring(): TraceabilitySubsystem {
    return {
      traceabilityPanelActive: true,
      getSnapshot: () => ({ links: [], untraced: [{ scenario: A, reqKeys: [] }], orphans: [], stale: false, completeProjects: ["CALC"], errors: [] }),
      getActiveAdapter: () => ({
        label: "Xray",
        keyGrammar: { testPrefix: "TEST_", projectOf: (key: string) => key.split("-")[0] },
        testAuthoring: { createTest: () => Promise.resolve({ key: "CALC-1", warnings: [] }) },
      }),
      tagDerivedProjectKeys: () => [],
      projectScope: () => NO_PROJECT_SCOPE,
      mappingPageSize: () => NO_MAPPING_PAGE_SIZE,
      onDidChangeSnapshot: new vscode.EventEmitter<void>().event,
    } as unknown as TraceabilitySubsystem;
  }

  // The command reads its selection off the open board, so drive one check through the panel.
  async function selectOnBoard(mgr: CommandManager): Promise<void> {
    BoardPanel.open(traceabilityBoardDeps(mgr));
    const panel = win.__webviewPanels[0]!;
    await receiveBoard(panel, "shell", { type: "ready" });
    await receiveBoard(panel, "board", { type: "select", target: "scenario", id: scenarioDropId(A), on: true });
  }

  it("reads an unconfigured site as not connected instead of letting the credential lookup reject", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const mgr = CommandManager.create(makeContext());
    mgr.setTraceabilitySubsystem(subsystemWithAuthoring());
    // The real store throws on a site that normalizes empty, which is exactly the default config here.
    mgr.setCredentialStore(
      new XrayCredentialStore(
        {
          get: () => Promise.resolve(undefined),
          store: () => Promise.resolve(),
          delete: () => Promise.resolve(),
        } as unknown as vscode.SecretStorage,
        trustedWorkspace()
      )
    );
    await selectOnBoard(mgr);

    const run = (
      traceabilityCommands(mgr) as unknown as {
        getAuthoringCommands: () => { bulkCreateTests: () => Promise<void> };
      }
    ).getAuthoringCommands();

    await expect(run.bulkCreateTests()).resolves.toBeUndefined();
    expect(String(info.mock.calls.at(-1)?.[0])).toContain("Connect to your test tracker");
  });
});

// The board is rebuilt from settings, so a settings edit only reaches an open one through a rebuild.
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
