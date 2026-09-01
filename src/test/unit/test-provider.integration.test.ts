/**
 * Integration tests for the discover → run → status seam, exercised through the REAL provider,
 * parser, organization, and command builder; only the shell (Playwright invocation) and file
 * discovery are faked. This is the layer unit tests couldn't reach: it catches report→tree
 * mapping regressions (a passing scenario showing as skipped, outline examples not mapping, and
 * out-of-scope features running the wrong file).
 */
import { fakeMemento, makeFixture, reportJson } from "./helpers/test-provider-fixture";
import type { Fixture } from "./helpers/test-provider-fixture";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "../__mocks__/vscode";
import { PlaywrightBddTestProvider } from "../../test-providers/playwright-bdd-test-provider";
import { TestExecutor, ShellRunner } from "../../core/test-executor";
import { CommandBuilder } from "../../core/command-builder";
import { PlaywrightJsonParser } from "../../utils/playwright-json-parser";
import { FeatureParser } from "../../parsers/feature-parser";
import { TestOrganizationManager } from "../../core/test-organization";
import { ExtensionConfig } from "../../core/extension-config";
import { Logger } from "../../utils/logger";
import { PlaywrightBddExtensionContext } from "../../types";
import { BreakpointMirror } from "../../core/breakpoint-mirror";
import { RunArtifactStore } from "../../traceability/run-artifact-store";
import type { ScenarioRef } from "../../traceability/scenario-ref";
import type {
  ExecutionDefinition,
  ExecutionGateway,
  ExecutionOptions,
  RunCompletion,
  RunIntent,
} from "../../core/run-contracts";
import { LegacyDirectExecutionGateway } from "../../core/execution-gateway";
import { ExecutionAdmissionBlockedError } from "../../core/execution-admission";
import { LegacyExecutionDiscovery } from "../../core/legacy-discovery";
import { LegacyArtifactGateway } from "../../ui/legacy-artifact-gateway";
import { WorkspaceTrust } from "../../core/workspace-trust";
import { FakeTestController, FakeTestItem } from "./helpers/fake-test-controller";
import { parseExecutableCommand } from "../../core/bounded-command-runner";

const EXECUTION_IDENTITY = { engine: "legacy-direct", schemaProfile: "legacy.v1" } as const;

function testGateway(
  execute: (intent: RunIntent, options?: ExecutionOptions) => Promise<RunCompletion>,
  cases: readonly ExecutionDefinition[] = []
): ExecutionGateway {
  return {
    running: false,
    diagnose: vi.fn(() => Promise.resolve([])),
    discover: vi.fn(() => Promise.resolve({ cases, diagnostics: [] })),
    prepare: vi.fn(async (intent) => ({ operationId: "provider-test", identity: EXECUTION_IDENTITY, intent })),
    run: vi.fn((prepared, options) => execute(prepared.intent, options)),
    debug: vi.fn((prepared, options) => execute(prepared.intent, options)),
    cancel: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(),
  };
}


function finishDebugSession(config: Record<string, unknown>): void {
  const session = { id: "debug-root", configuration: config };
  vscode.debug.__fireStart(session);
  vscode.debug.__fireTerminate(session);
}

describe("PlaywrightBddTestProvider: discover → run → status (integration)", () => {
  let fixture: Fixture;
  let origReadFile: typeof vscode.workspace.fs.readFile;

  beforeEach(() => {
    vscode.debug.__resetDebug();
    vscode.__resetFileWatchers();
    fixture = makeFixture();
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
      { uri: { fsPath: fixture.root } },
    ];
    origReadFile = vscode.workspace.fs.readFile;
    // The watcher path reads the touched file through the vscode fs seam.
    (vscode.workspace.fs as { readFile: unknown }).readFile = async (uri: { fsPath: string }): Promise<Uint8Array> =>
      new Uint8Array(fs.readFileSync(uri.fsPath));
  });

  afterEach(() => {
    (vscode.workspace.fs as { readFile: unknown }).readFile = origReadFile;
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
    try { fs.rmSync(fixture.root, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function buildProvider(
    shell: ShellRunner,
    executionGateway?: ExecutionGateway,
    runBddgen = false,
    artifactOwnership: readonly ScenarioRef[] = [],
    options: { testFilePattern?: () => string; localCapability?: () => boolean } = {}
  ): {
    provider: PlaywrightBddTestProvider;
    controller: FakeTestController;
    executor: TestExecutor;
    artifactStore: RunArtifactStore;
    gateway: ExecutionGateway;
    config: ExtensionConfig;
    discoveryManager: { discoverTestFiles: ReturnType<typeof vi.fn>; clearCache: ReturnType<typeof vi.fn> };
  } {
    const logger = Logger.create();
    const config = ExtensionConfig.create({
      get: <T>(key: string, defaultValue?: T): T | undefined => {
        if (key === "bddgenCommand" && !runBddgen) {return "" as T;}
        if (key === "testFilePattern" && options.testFilePattern) {return options.testFilePattern() as T;}
        return defaultValue;
      },
      update: (): Promise<void> => Promise.resolve(),
    } as unknown as import("vscode").WorkspaceConfiguration, false);
    const parser = PlaywrightJsonParser.create(logger);
    const commandBuilder = CommandBuilder.create(config, logger);
    const executor = TestExecutor.create(
      vscode.workspace as never,
      vscode.window as never,
      vscode.debug as never,
      config,
      logger,
      parser,
      shell,
      undefined,
      parseExecutableCommand
    );
    const discoveryManager = {
      discoverTestFiles: vi.fn().mockResolvedValue([fixture.featurePath]),
      clearCache: vi.fn(),
    };
    const artifactStore = new RunArtifactStore(fakeMemento(), logger);
    const featureParser = FeatureParser.create(logger);
    const workspaceTrust = new WorkspaceTrust(() => true);
    const gateway = executionGateway ?? new LegacyArtifactGateway(
      new LegacyDirectExecutionGateway(
        executor,
        featureParser,
        workspaceTrust,
        undefined,
        undefined,
        new LegacyExecutionDiscovery(discoveryManager as never, featureParser)
      ),
      artifactStore,
      logger,
      executor,
      () => artifactOwnership
    );
    const context: PlaywrightBddExtensionContext = {
      logger,
      config,
      testExecutor: executor,
      executionGateway: gateway,
      discoveryManager: discoveryManager as never,
      organizationManager: TestOrganizationManager.create(logger),
      featureParser,
      playwrightJsonParser: parser,
      commandBuilder,
      workspaceTrust,
      traceabilityAdapter: {} as PlaywrightBddExtensionContext["traceabilityAdapter"],
      runArtifactStore: artifactStore,
    };
    executor.setContext(context);

    const controller = new FakeTestController();
    const provider = PlaywrightBddTestProvider.create(
      controller as never,
      context,
      undefined,
      () => options.localCapability?.() ?? executionGateway === undefined
    );
    return { provider, controller, executor, artifactStore, gateway, discoveryManager, config };
  }

  async function runItem(controller: FakeTestController, item: FakeTestItem): Promise<void> {
    const runProfile = controller.profile("Run");
    if (!runProfile) {throw new Error("Run profile not registered");}
    await runProfile.runHandler(
      new vscode.TestRunRequest([item]),
      new vscode.CancellationTokenSource().token
    );
  }

  it("defers discovery until the Test Explorer resolves or refreshes", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { controller, discoveryManager } = buildProvider(shell);

    expect(discoveryManager.discoverTestFiles).not.toHaveBeenCalled();
    await controller.resolveHandler?.(undefined);
    expect(discoveryManager.discoverTestFiles).toHaveBeenCalledTimes(1);

    await controller.refreshHandler?.();
    expect(discoveryManager.discoverTestFiles).toHaveBeenCalledTimes(2);
  });

  it("admits a Test Explorer run by discovering when the tree has not resolved", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { controller, discoveryManager } = buildProvider(shell);

    await controller.profile("Run")!.runHandler(
      new vscode.TestRunRequest(),
      new vscode.CancellationTokenSource().token
    );

    expect(discoveryManager.discoverTestFiles).toHaveBeenCalledTimes(1);
  });

  it("retries a requested discovery after workspace trust is granted", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    let trusted = false;
    const gateway = testGateway(async () => ({
      identity: EXECUTION_IDENTITY, state: "complete", results: [], passed: 0, failed: 0, durationMs: 0, output: "",
    }), [{
      id: `${fixture.featurePath}:4`, name: "Passing scenario", source: { path: fixture.featurePath, line: 4 },
      suites: [{ name: "Sample feature", source: { path: fixture.featurePath, line: 1 } }], tags: [],
    }]);
    vi.mocked(gateway.diagnose).mockImplementation(() => Promise.resolve(trusted ? [] : [{
      code: "WORKSPACE_TRUST_REQUIRED", severity: "error", message: "Trust required", identity: EXECUTION_IDENTITY,
    }]));
    const { provider, controller } = buildProvider(shell, gateway);

    await controller.resolveHandler?.(undefined);
    expect(controller.find(fixture.featurePath)).toBeUndefined();
    vi.mocked(gateway.diagnose).mockClear();
    await Promise.all(Array.from({ length: 5 }, () =>
      vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath))
    ));
    expect(gateway.diagnose).not.toHaveBeenCalled();

    trusted = true;
    await provider.onWorkspaceTrustGranted();
    expect(gateway.diagnose).toHaveBeenCalledTimes(1);
    expect(controller.find(fixture.featurePath)).toBeTruthy();
  });

  it("does not dispatch a run when canonical discovery fails", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const gateway = testGateway(async () => ({
      identity: EXECUTION_IDENTITY, state: "complete", results: [], passed: 0, failed: 0, durationMs: 0, output: "",
    }));
    vi.mocked(gateway.diagnose).mockResolvedValue([{
      code: "WORKSPACE_TRUST_REQUIRED", severity: "error", message: "Trust required", identity: EXECUTION_IDENTITY,
    }]);
    const { controller } = buildProvider(shell, gateway);

    await controller.profile("Run")!.runHandler(
      new vscode.TestRunRequest(),
      new vscode.CancellationTokenSource().token
    );

    expect(gateway.prepare).not.toHaveBeenCalled();
    expect(gateway.run).not.toHaveBeenCalled();
  });

  it("tells the user how to recover when admission blocks discovery", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const blocked = new ExecutionAdmissionBlockedError({
      kind: "windows-tree",
      pid: 4242,
      survivors: [{ pid: 4242, creationDate: 1_000 }],
      failure: "the tree is still running",
      bootId: "win32:41",
    });
    const gateway = testGateway(() => Promise.reject(new Error("unused")));
    gateway.discover = vi.fn(() => Promise.reject(blocked));
    const shown: unknown[] = [];
    const original = vscode.window.showErrorMessage;
    (vscode.window as { showErrorMessage: unknown }).showErrorMessage = (message: unknown) => {
      shown.push(message);
      return Promise.resolve(undefined);
    };

    try {
      await buildProvider(shell, gateway).provider.discoverTests();
    } finally {
      (vscode.window as { showErrorMessage: unknown }).showErrorMessage = original;
    }

    expect(shown).toEqual([`${blocked.message} ${blocked.recovery}`]);
    expect(String(shown[0])).toContain("End the leftover processes in Task Manager");
  });

  it("marks a passing scenario PASSED in the tree (the report→item mapping holds)", async () => {
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      const out = reportJson(fixture, [{ title: "Passing scenario", line: 6, status: "passed" }]);
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], out);}
      return { success: true, output: "", error: "", returnCode: 0 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const leaf = controller.find(`${fixture.featurePath}:4`);
    expect(leaf, "scenario leaf should be discovered at its feature line").toBeTruthy();

    await runItem(controller, leaf!);
    const last = controller.runs.at(-1)!;
    expect(last.outcome.passed).toContain(`${fixture.featurePath}:4`);
    expect(last.outcome.skipped).not.toContain(`${fixture.featurePath}:4`);
  });

  it("explains a skip caused by bddgen's missing-step skip-scenario marker", async () => {
    // Regenerate the fixture spec with the scenario marked skipped, the shape bddgen writes
    // under missingSteps: "skip-scenario" when a step has no definition.
    fs.writeFileSync(
      fixture.genSpecPath,
      [
        "// Generated from: features/test.feature",
        "const bddFileData = [ // bdd-data-start",
        '  {"pwTestLine":6,"pickleLine":4,"skipped":true},',
        '  {"pwTestLine":18,"pickleLine":12},',
        '  {"pwTestLine":24,"pickleLine":13},',
        "]; // bdd-data-end",
      ].join("\n")
    );
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      const out = reportJson(fixture, [{ title: "Passing scenario", line: 6, status: "skipped" }]);
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], out);}
      return { success: true, output: "", error: "", returnCode: 0 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    await runItem(controller, controller.find(`${fixture.featurePath}:4`)!);

    const last = controller.runs.at(-1)!;
    expect(last.outcome.skipped).toContain(`${fixture.featurePath}:4`);
    expect(last.outcome.output.join("")).toContain(
      '"Passing scenario" was skipped by bddgen: a step has no matching definition.'
    );
  });

  it("stays quiet about a deliberate @skip skip", async () => {
    fs.writeFileSync(
      fixture.genSpecPath,
      [
        "// Generated from: features/test.feature",
        "const bddFileData = [ // bdd-data-start",
        '  {"pwTestLine":6,"pickleLine":4,"skipped":true,"tags":["@skip"]},',
        '  {"pwTestLine":18,"pickleLine":12},',
        '  {"pwTestLine":24,"pickleLine":13},',
        "]; // bdd-data-end",
      ].join("\n")
    );
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      const out = reportJson(fixture, [{ title: "Passing scenario", line: 6, status: "skipped" }]);
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], out);}
      return { success: true, output: "", error: "", returnCode: 0 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    await runItem(controller, controller.find(`${fixture.featurePath}:4`)!);

    const last = controller.runs.at(-1)!;
    expect(last.outcome.skipped).toContain(`${fixture.featurePath}:4`);
    expect(last.outcome.output.join("")).not.toContain("was skipped by bddgen");
  });

  it("restores a failed verdict with the retirement message and a request scoped to it", async () => {
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      const out = reportJson(fixture, [{ title: "Passing scenario", line: 6, status: "failed" }]);
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], out);}
      return { success: false, output: "", error: "1 test failed", returnCode: 1 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();
    await runItem(controller, controller.find(`${fixture.featurePath}:4`)!);

    const tagStrategy = provider.organizationManager.getAvailableStrategies()
      .find((s) => s.strategy.strategyType === "TagBasedOrganization")!.strategy;
    provider.organizationManager.setStrategy(tagStrategy);
    await provider.discoverTests();

    const restored = controller.runs.at(-1)!;
    expect(restored.outcome.failed).toEqual([
      {
        id: `${fixture.featurePath}:4`,
        message: expect.stringContaining("Re-run for details"),
      },
    ]);
    const request = restored.request as { include?: Array<{ id: string }> };
    expect(request.include?.map((item) => item.id)).toEqual([`${fixture.featurePath}:4`]);
  });

  it("does not restore a verdict retired by a skipped run", async () => {
    let reported: "passed" | "skipped" = "passed";
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      const out = reportJson(fixture, [{ title: "Passing scenario", line: 6, status: reported }]);
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], out);}
      return { success: true, output: "", error: "", returnCode: 0 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();
    await runItem(controller, controller.find(`${fixture.featurePath}:4`)!);
    reported = "skipped";
    await runItem(controller, controller.find(`${fixture.featurePath}:4`)!);

    const beforeSwitch = controller.runs.length;
    const tagStrategy = provider.organizationManager.getAvailableStrategies()
      .find((s) => s.strategy.strategyType === "TagBasedOrganization")!.strategy;
    provider.organizationManager.setStrategy(tagStrategy);
    await provider.discoverTests();

    // The skipped run retired the cached pass, so there is nothing left to restore.
    expect(controller.runs).toHaveLength(beforeSwitch);
  });

  it("debugTests applies the real status from the JSON report the debugged run wrote", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const leaf = controller.find(`${fixture.featurePath}:4`);
    const debugProfile = controller.profile("Debug");
    const pending = Promise.resolve(
      debugProfile!.runHandler(new vscode.TestRunRequest([leaf!]), new vscode.CancellationTokenSource().token)
    );

    await vi.waitFor(() => {
      expect(vscode.debug.__startDebuggingCalls).toHaveLength(1);
    });

    const config = vscode.debug.__startDebuggingCalls[0]!.config;
    const env = config["env"] as Record<string, string>;
    const reportPath = env["PLAYWRIGHT_JSON_OUTPUT_NAME"]!;
    expect(reportPath).toBeTruthy();
    // Simulate the debugged playwright process writing the file-based JSON report.
    fs.writeFileSync(
      reportPath,
      reportJson(fixture, [{ title: "Passing scenario", line: 6, status: "passed" }])
    );
    finishDebugSession(config);

    await pending;
    const run = controller.runs.at(-1)!;
    expect(run.outcome.passed).toContain(`${fixture.featurePath}:4`);
    expect(run.outcome.skipped).not.toContain(`${fixture.featurePath}:4`);
    expect(run.outcome.ended).toBe(true);
    expect(fs.existsSync(path.dirname(reportPath)), "tmp report directory should be deleted after the run").toBe(false);
  });

  it("debugTests seals partial when a nonempty report carries a global error", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { provider, controller, artifactStore } = buildProvider(shell);
    await provider.discoverTests();

    const leaf = controller.find(`${fixture.featurePath}:4`)!;
    const pending = Promise.resolve(
      controller.profile("Debug")!.runHandler(
        new vscode.TestRunRequest([leaf]),
        new vscode.CancellationTokenSource().token
      )
    );
    await vi.waitFor(() => expect(vscode.debug.__startDebuggingCalls).toHaveLength(1));

    const config = vscode.debug.__startDebuggingCalls[0]!.config;
    const reportPath = (config["env"] as Record<string, string>)["PLAYWRIGHT_JSON_OUTPUT_NAME"]!;
    const report = JSON.parse(
      reportJson(fixture, [{ title: "Passing scenario", line: 6, status: "passed" }])
    ) as Record<string, unknown>;
    report["errors"] = [{ message: "worker teardown failed" }];
    fs.writeFileSync(reportPath, JSON.stringify(report));
    finishDebugSession(config);

    await pending;

    expect(artifactStore.latest()?.state).toBe("partial");
    // The scenario itself reported passed; a run-level teardown error is not its failure.
    const run = controller.runs.at(-1)!;
    expect(run.outcome.passed).toContain(`${fixture.featurePath}:4`);
    expect(run.outcome.failed).toEqual([]);
    expect(run.outcome.output.join("")).toContain(
      "Playwright reported a global error: worker teardown failed"
    );
  });

  it("debugTests marks a missing final JSON report as an infrastructure failure", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const leaf = controller.find(`${fixture.featurePath}:4`);
    const debugProfile = controller.profile("Debug");
    const pending = Promise.resolve(
      debugProfile!.runHandler(new vscode.TestRunRequest([leaf!]), new vscode.CancellationTokenSource().token)
    );

    await vi.waitFor(() => {
      expect(vscode.debug.__startDebuggingCalls).toHaveLength(1);
    });

    const config = vscode.debug.__startDebuggingCalls[0]!.config;
    const reportPath = (config["env"] as Record<string, string>)["PLAYWRIGHT_JSON_OUTPUT_NAME"]!;
    finishDebugSession(config);

    await pending;
    const run = controller.runs.at(-1)!;
    expect(run.outcome.started).toContain(`${fixture.featurePath}:4`);
    expect(run.outcome.passed).toEqual([]);
    expect(run.outcome.failed).toEqual([{
      id: `${fixture.featurePath}:4`,
      message: "The debug session completed without a readable JSON report",
    }]);
    expect(run.outcome.skipped).toEqual([]);
    expect(run.outcome.ended).toBe(true);
    expect(fs.existsSync(path.dirname(reportPath))).toBe(false);
  });

  it("debugTests removes the report directory when VS Code declines the launch", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const startDebugging = vscode.debug.startDebugging;
    (vscode.debug as { startDebugging: typeof vscode.debug.startDebugging }).startDebugging = (folder, config) => {
      vscode.debug.__startDebuggingCalls.push({ folder, config: config as Record<string, unknown> });
      return Promise.resolve(false);
    };
    try {
      const { provider, controller } = buildProvider(shell);
      await provider.discoverTests();
      const leaf = controller.find(`${fixture.featurePath}:4`)!;

      await controller.profile("Debug")!.runHandler(
        new vscode.TestRunRequest([leaf]),
        new vscode.CancellationTokenSource().token
      );

      const config = vscode.debug.__startDebuggingCalls[0]!.config;
      const reportPath = (config["env"] as Record<string, string>)["PLAYWRIGHT_JSON_OUTPUT_NAME"]!;
      expect(fs.existsSync(path.dirname(reportPath))).toBe(false);
    } finally {
      (vscode.debug as { startDebugging: typeof vscode.debug.startDebugging }).startDebugging = startDebugging;
    }
  });

  it("debugTests removes an unparseable report after the session", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();
    const leaf = controller.find(`${fixture.featurePath}:4`)!;
    const pending = Promise.resolve(controller.profile("Debug")!.runHandler(
      new vscode.TestRunRequest([leaf]),
      new vscode.CancellationTokenSource().token
    ));

    await vi.waitFor(() => expect(vscode.debug.__startDebuggingCalls).toHaveLength(1));
    const config = vscode.debug.__startDebuggingCalls[0]!.config;
    const reportPath = (config["env"] as Record<string, string>)["PLAYWRIGHT_JSON_OUTPUT_NAME"]!;
    fs.writeFileSync(reportPath, "{broken");
    finishDebugSession(config);

    await pending;
    expect(fs.existsSync(path.dirname(reportPath))).toBe(false);
  });

  it("debugTests rolls a feature item up from the report's per-scenario statuses", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const featureItem = controller.find(fixture.featurePath);
    expect(featureItem, "feature item should be discovered").toBeTruthy();
    const debugProfile = controller.profile("Debug");
    const pending = Promise.resolve(
      debugProfile!.runHandler(new vscode.TestRunRequest([featureItem!]), new vscode.CancellationTokenSource().token)
    );

    await vi.waitFor(() => {
      expect(vscode.debug.__startDebuggingCalls).toHaveLength(1);
    });

    const config = vscode.debug.__startDebuggingCalls[0]!.config;
    const env = config["env"] as Record<string, string>;
    fs.writeFileSync(
      env["PLAYWRIGHT_JSON_OUTPUT_NAME"]!,
      reportJson(fixture, [
        { title: "Passing scenario", line: 6, status: "passed" },
        { title: "Example #1", line: 18, status: "passed" },
        { title: "Example #2", line: 24, status: "failed" },
      ])
    );
    finishDebugSession(config);

    await pending;
    const run = controller.runs.at(-1)!;
    expect(run.outcome.passed).toContain(`${fixture.featurePath}:4`);
    expect(run.outcome.passed).toContain(`${fixture.featurePath}:12`);
    expect(run.outcome.failed.map((f) => f.id)).toContain(`${fixture.featurePath}:13`);
    // Any failing scenario fails the feature item itself.
    expect(run.outcome.failed.map((f) => f.id)).toContain(fixture.featurePath);
  });

  it("debugTests wraps the session in a TestRun and ends it only when the session ends", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const leaf = controller.find(`${fixture.featurePath}:4`);
    expect(leaf, "scenario leaf should be discovered").toBeTruthy();
    const debugProfile = controller.profile("Debug");
    expect(debugProfile, "Debug profile should be registered").toBeTruthy();

    let handlerDone = false;
    const pending = Promise.resolve(
      debugProfile!.runHandler(new vscode.TestRunRequest([leaf!]), new vscode.CancellationTokenSource().token)
    ).then(() => { handlerDone = true; });

    await vi.waitFor(() => {
      expect(vscode.debug.__startDebuggingCalls).toHaveLength(1);
    });

    const run = controller.runs.at(-1)!;
    expect(run.outcome.started).toContain(`${fixture.featurePath}:4`);
    expect(run.outcome.ended).toBe(false);
    expect(handlerDone).toBe(false);

    const config = vscode.debug.__startDebuggingCalls[0]!.config;
    expect(typeof config[BreakpointMirror.SESSION_KEY]).toBe("string");
    finishDebugSession(config);

    await pending;
    expect(handlerDone).toBe(true);
    expect(run.outcome.ended).toBe(true);
  });

  it("fails closed when debug cancellation cannot confirm session termination", async () => {
    // No terminate event is ever fired, so cancellation cannot claim the debug process stopped.
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { provider, controller, artifactStore } = buildProvider(shell);
    await provider.discoverTests();

    const first = controller.find(`${fixture.featurePath}:4`)!;
    const second = controller.find(`${fixture.featurePath}:12`)!;
    const source = new vscode.CancellationTokenSource();
    const debugProfile = controller.profile("Debug")!;
    const pending = Promise.resolve(
      debugProfile.runHandler(new vscode.TestRunRequest([first, second]), source.token)
    );

    await vi.waitFor(() => {
      expect(vscode.debug.__startDebuggingCalls).toHaveLength(1);
    });
    const root = { id: "root", configuration: vscode.debug.__startDebuggingCalls[0]!.config };
    const reportPath = (root.configuration["env"] as Record<string, string>)["PLAYWRIGHT_JSON_OUTPUT_NAME"]!;
    vscode.debug.__fireStart(root);
    source.cancel();
    await pending;

    const run = controller.runs.at(-1)!;
    expect(run.outcome.ended).toBe(true);
    expect(run.outcome.skipped).toEqual([]);
    expect(run.outcome.failed).toEqual([
      { id: `${fixture.featurePath}:4`, message: expect.stringContaining("termination was not confirmed") },
      { id: `${fixture.featurePath}:12`, message: expect.stringContaining("termination was not confirmed") },
    ]);
    // The second item never launches a session of its own.
    expect(vscode.debug.__startDebuggingCalls).toHaveLength(1);
    expect(vscode.debug.__stopDebuggingCalls).toEqual([root]);
    expect(artifactStore.latest()?.state).toBe("partial");
    expect(fs.existsSync(path.dirname(reportPath))).toBe(false);
  });

  it("fails the feature parent when the run failed with no per-scenario results and no \"no tests found\"", async () => {
    // A bddgen/compile error can exit non-zero yet leave an empty report; no per-scenario results
    // for a genuine failure. Blanket-skipping would hide it, so applyResultsToChildren must fail the
    // parent (its scenarios, having no attributed result, stay skipped).
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {
        fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], JSON.stringify({ suites: [] }));
      }
      return { success: false, output: "", error: "TypeError: step threw while compiling specs", returnCode: 1 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const featureItem = controller.find(fixture.featurePath);
    expect(featureItem, "feature item should be discovered").toBeTruthy();
    await runItem(controller, featureItem!);

    const run = controller.runs.at(-1)!;
    expect(run.outcome.failed.map((f) => f.id)).toContain(fixture.featurePath);
    expect(run.outcome.skipped).not.toContain(fixture.featurePath);
    expect(run.outcome.skipped).toContain(`${fixture.featurePath}:4`);
  });

  it("leaves the feature parent skipped when the empty-result failure is a \"No tests found\" (out-of-scope) run", async () => {
    // Counter-case to the above: the same empty-report failure but Playwright explicitly found no
    // tests. outOfScopeWarning already explains this as skipped, so the parent must NOT fail.
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {
        fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], JSON.stringify({ suites: [] }));
      }
      return { success: false, output: "", error: "Error: No tests found", returnCode: 1 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const featureItem = controller.find(fixture.featurePath);
    expect(featureItem, "feature item should be discovered").toBeTruthy();
    await runItem(controller, featureItem!);

    const run = controller.runs.at(-1)!;
    expect(run.outcome.skipped).toContain(fixture.featurePath);
    expect(run.outcome.failed.map((f) => f.id)).not.toContain(fixture.featurePath);
  });

  it("debugTests marks every descendant of a debugged feature started", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const featureItem = controller.find(fixture.featurePath);
    expect(featureItem, "feature item should be discovered").toBeTruthy();
    const debugProfile = controller.profile("Debug");
    const pending = Promise.resolve(
      debugProfile!.runHandler(new vscode.TestRunRequest([featureItem!]), new vscode.CancellationTokenSource().token)
    );

    await vi.waitFor(() => {
      expect(vscode.debug.__startDebuggingCalls).toHaveLength(1);
    });

    // One debug command runs every descendant, so each is marked started, including the nested
    // outline example rows (:12, :13), which proves the recursion, not just the direct children.
    const run = controller.runs.at(-1)!;
    expect(run.outcome.started).toContain(`${fixture.featurePath}:4`);
    expect(run.outcome.started).toContain(`${fixture.featurePath}:12`);
    expect(run.outcome.started).toContain(`${fixture.featurePath}:13`);

    finishDebugSession(vscode.debug.__startDebuggingCalls[0]!.config);
    await pending;
  });


});
