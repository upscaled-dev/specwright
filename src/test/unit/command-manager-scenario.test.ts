import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import { CommandManager } from "../../commands/command-manager";
import { FeatureParser } from "../../parsers/feature-parser";
import type {
  ExecutionGateway,
  ExecutionOptions,
  RunCompletion,
  RunIntent,
} from "../../core/run-contracts";
import type { ClientRunIntent } from "../../ui/execution-client-context";
import { Logger } from "../../utils/logger";
import { TestExecutor } from "../../core/test-executor";
import {
  ArtifactCaptureTarget,
  RunArtifactStore,
  scopeArtifactDetails,
} from "../../traceability/run-artifact-store";
import type { ScenarioRef } from "../../traceability/scenario-ref";
import { captureHandlers, fakeDoc, makeContext, memento, writeTempFeature } from "./helpers/command-manager-harness";
import {
  ExecutionFailure,
  LegacyDirectExecutionGateway,
} from "../../core/execution-gateway";
import { runOutputFromCompletion } from "../../ui/execution-adapter";
import { ExecutionAdmission } from "../../core/execution-admission";

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

