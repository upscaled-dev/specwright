/**
 * Integration tests for the discover → run → status seam, exercised through the REAL provider,
 * parser, organization, and command builder; only the shell (Playwright invocation) and file
 * discovery are faked. This is the layer unit tests couldn't reach: it catches report→tree
 * mapping regressions (a passing scenario showing as skipped, outline examples not mapping, and
 * out-of-scope features running the wrong file).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "../__mocks__/vscode";
import { PlaywrightBddTestProvider } from "../../test-providers/playwright-bdd-test-provider";
import { OUTLINE_ID_SEPARATOR } from "../../test-providers/constants";
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
  ExecutionEvent,
  ExecutionDefinition,
  ExecutionGateway,
  ExecutionOptions,
  RunCompletion,
  RunIntent,
} from "../../core/run-contracts";
import { LegacyDirectExecutionGateway } from "../../core/execution-gateway";
import { LegacyExecutionDiscovery } from "../../core/legacy-discovery";
import { LegacyArtifactGateway } from "../../ui/legacy-artifact-gateway";
import { executionClientContext } from "../../ui/execution-client-context";
import { WorkspaceTrust } from "../../core/workspace-trust";
import { FakeTestController, FakeTestItem } from "./helpers/fake-test-controller";
import { parseExecutableCommand } from "../../core/bounded-command-runner";
import {
  LIVE_REPORT_FILE_ENV,
  type LiveRunBeginRecord,
  type LiveTestEndRecord,
} from "../../core/live-reporter-protocol";

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

function fakeMemento(): import("vscode").Memento {
  const store = new Map<string, unknown>();
  return {
    keys: () => [...store.keys()],
    get: (key: string, def?: unknown) => (store.has(key) ? store.get(key) : def),
    update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
  } as unknown as import("vscode").Memento;
}

const FEATURE = [
  "@feature",
  "Feature: Sample feature",
  "",
  "  Scenario: Passing scenario", // line 4
  "    Given I am on the test page",
  "",
  "  Scenario Outline: Math", // line 7
  "    Given <a> plus <b>",
  "",
  "    Examples:",
  "      | a | b |",
  "      | 1 | 2 |", // line 12 (example #1)
  "      | 3 | 4 |", // line 13 (example #2)
].join("\n");

interface Fixture {
  root: string;
  featurePath: string;
  genSpecPath: string;
}

/** Build a temp project: source feature + generated spec carrying bddFileData. */
function makeFixture(): Fixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pbdd-int-"));
  const featurePath = path.join(root, "features", "test.feature");
  fs.mkdirSync(path.dirname(featurePath), { recursive: true });
  fs.writeFileSync(featurePath, FEATURE);

  const genSpecPath = path.join(root, ".features-gen", "features", "test.feature.spec.js");
  fs.mkdirSync(path.dirname(genSpecPath), { recursive: true });
  fs.writeFileSync(
    genSpecPath,
    [
      "// Generated from: features/test.feature",
      "const bddFileData = [ // bdd-data-start",
      '  {"pwTestLine":6,"pickleLine":4},', // Passing scenario  → feature line 4
      '  {"pwTestLine":18,"pickleLine":12},', // Example #1      → feature line 12
      '  {"pwTestLine":24,"pickleLine":13},', // Example #2      → feature line 13
      "]; // bdd-data-end",
    ].join("\n")
  );
  return { root, featurePath, genSpecPath };
}

/** A Playwright JSON report for the given specs, written by the fake shell to the report path. */
function reportJson(
  fixture: Fixture,
  specs: Array<{
    title: string;
    line: number;
    status: string;
    steps?: Array<{ title: string; duration: number }>;
  }>
): string {
  return JSON.stringify({
    config: {
      rootDir: path.join(fixture.root, ".features-gen"),
      configFile: path.join(fixture.root, "playwright.config.ts"),
    },
    suites: [{
      title: "Sample feature",
      specs: specs.map((s) => ({
        title: s.title,
        file: "features/test.feature.spec.js",
        line: s.line,
        tests: [{ results: [{ status: s.status, duration: 5, steps: s.steps ?? [] }] }],
      })),
    }],
  });
}

function passingLiveRecords(fixture: Fixture, total = 3): string {
  const begin: LiveRunBeginRecord = {
    kind: "run-begin",
    rootDir: path.dirname(fixture.genSpecPath),
    configFile: path.join(fixture.root, "playwright.config.ts"),
    total,
  };
  const result: LiveTestEndRecord = {
    kind: "test-end",
    file: fixture.genSpecPath,
    line: 6,
    title: "Passing scenario",
    titlePath: ["chromium", "test.feature.spec.js", "Sample feature", "Passing scenario"],
    status: "passed",
    durationMs: 5,
    retry: 0,
    retries: 0,
    expectedStatus: "passed",
    projectName: "chromium",
    completed: 1,
    total,
  };
  return `${JSON.stringify(begin)}\n${JSON.stringify(result)}\n`;
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

  it("does not admit a watcher-only partial tree before the first canonical run discovery", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { controller, discoveryManager } = buildProvider(shell);

    await vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath));
    expect(controller.items.size).toBe(0);
    expect(discoveryManager.discoverTestFiles).not.toHaveBeenCalled();

    await controller.profile("Run")!.runHandler(
      new vscode.TestRunRequest(),
      new vscode.CancellationTokenSource().token
    );
    expect(controller.find(`${fixture.featurePath}:4`)).toBeTruthy();
    expect(controller.find(`${fixture.featurePath}:12`)).toBeTruthy();
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

  it("writes one run summary for a multi-root selection", async () => {
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      const out = reportJson(fixture, [{ title: "Passing scenario", line: 6, status: "passed" }]);
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], out);}
      return { success: true, output: "", error: "", returnCode: 0 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();
    const first = controller.find(`${fixture.featurePath}:4`)!;
    const second = controller.find(`${fixture.featurePath}:12`)!;

    await controller.profile("Run")!.runHandler(
      new vscode.TestRunRequest([first, second]),
      new vscode.CancellationTokenSource().token
    );

    const summaries = controller.runs.at(-1)!.outcome.output
      .filter((text) => text.includes("1 scenario"));
    expect(summaries).toHaveLength(1);
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

  it("re-publishes cached statuses onto the rebuilt tree after a strategy switch", async () => {
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      const out = reportJson(fixture, [{ title: "Passing scenario", line: 6, status: "passed" }]);
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], out);}
      return { success: true, output: "", error: "", returnCode: 0 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();
    // An empty status cache publishes nothing: discovery alone opens no run.
    expect(controller.runs).toHaveLength(0);
    await runItem(controller, controller.find(`${fixture.featurePath}:4`)!);
    expect(controller.runs.at(-1)!.outcome.passed).toContain(`${fixture.featurePath}:4`);

    const beforeSwitch = controller.runs.length;
    const tagStrategy = provider.organizationManager.getAvailableStrategies()
      .find((s) => s.strategy.strategyType === "TagBasedOrganization")!.strategy;
    provider.organizationManager.setStrategy(tagStrategy);
    await provider.discoverTests();

    // The rebuild replaced every TestItem; exactly one synthetic run restores the known verdicts.
    expect(controller.runs).toHaveLength(beforeSwitch + 1);
    const restored = controller.runs.at(-1)!;
    expect(restored.outcome.passed).toContain(`${fixture.featurePath}:4`);
    expect(restored.outcome.ended).toBe(true);
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

  it("drops a changed file's cached verdicts before the watcher rebuild restores", async () => {
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      const out = reportJson(fixture, [{ title: "Passing scenario", line: 6, status: "passed" }]);
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], out);}
      return { success: true, output: "", error: "", returnCode: 0 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();
    await runItem(controller, controller.find(`${fixture.featurePath}:4`)!);
    const beforeEdit = controller.runs.length;

    await vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath));

    // The edit invalidated the file's verdicts, so the rebuild opens no restore run for them.
    expect(controller.runs).toHaveLength(beforeEdit);
  });

  it("routes a Test Explorer scenario through the gateway and projects its live result", async () => {
    const execute = vi.fn(async (_intent: RunIntent, options?: ExecutionOptions) => {
      const result = {
        scenario: {
          filePath: fixture.featurePath,
          line: 4,
          name: "Passing scenario",
          kind: "scenario" as const,
        },
        outcome: "passed" as const,
        durationMs: 5,
        attempts: 1,
        flaky: false,
        evidenceRefs: [],
      };
      options?.onEvent?.({ kind: "case-finished", result, completed: 1, total: 1 });
      return {
        identity: EXECUTION_IDENTITY,
        state: "complete" as const,
        results: [result],
        passed: 1,
        failed: 0,
        durationMs: 5,
        output: "",
      };
    });
    const discoveryCases = [{
      id: `${fixture.featurePath}:4`,
      name: "Passing scenario",
      source: { path: fixture.featurePath, line: 4 },
      suites: [{ name: "Sample feature", source: { path: fixture.featurePath, line: 1 } }],
      tags: [],
    }];
    const gateway = testGateway(execute, discoveryCases);
    const shell: ShellRunner = async () => ({
      success: true,
      output: "",
      error: "",
      returnCode: 0,
    });
    const { provider, controller } = buildProvider(shell, gateway);
    await provider.discoverTests();
    const leaf = controller.find(`${fixture.featurePath}:4`)!;

    await runItem(controller, leaf);

    const preparedIntent = vi.mocked(gateway.prepare).mock.calls[0]![0];
    expect(preparedIntent).toEqual(expect.objectContaining({
      mode: "run",
      targets: [expect.objectContaining({ kind: "scenario" })],
    }));
    expect(executionClientContext(preparedIntent)).toEqual(expect.objectContaining({
      selection: expect.objectContaining({ kind: "scenario" }),
      initiatedBy: "test-explorer",
    }));
    expect(execute).toHaveBeenCalledWith(
      preparedIntent,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
    expect(controller.runs.at(-1)!.outcome.passed).toContain(`${fixture.featurePath}:4`);
    expect(controller.runs.at(-1)!.outcome.ended).toBe(true);
  });

  it("publishes a scenario result before the Playwright process finishes", async () => {
    let releaseShell: (() => void) | undefined;
    let signalShellStarted: (() => void) | undefined;
    const shellStarted = new Promise<void>((resolve) => { signalShellStarted = resolve; });
    const shell: ShellRunner = (_cmd, _dir, env) => new Promise((resolve) => {
      const livePath = env?.[LIVE_REPORT_FILE_ENV];
      if (!livePath) {throw new Error("Live report path was not provided");}
      fs.appendFileSync(livePath, passingLiveRecords(fixture));
      releaseShell = () => {
        const reportPath = env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"];
        if (reportPath) {
          fs.writeFileSync(
            reportPath,
            reportJson(fixture, [{ title: "Passing scenario", line: 6, status: "passed" }])
          );
        }
        resolve({ success: true, output: "", error: "", returnCode: 0 });
      };
      signalShellStarted?.();
    });
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const feature = controller.find(fixture.featurePath)!;
    const pending = runItem(controller, feature);
    await shellStarted;
    const run = controller.runs.at(-1)!;
    await vi.waitFor(() =>
      expect(run.outcome.passed).toContain(`${fixture.featurePath}:4`)
    );

    expect(run.outcome.ended).toBe(false);
    expect(run.outcome.passed).not.toContain(fixture.featurePath);
    expect(run.outcome.output.join("")).toContain("[1 / 3] Passing scenario: passed");

    releaseShell?.();
    await pending;
    expect(run.outcome.ended).toBe(true);
    expect(run.outcome.passed).toContain(fixture.featurePath);
  });

  it("recovers a completed live case into one partial completion and artifact", async () => {
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      const reportPath = env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"];
      const livePath = env?.[LIVE_REPORT_FILE_ENV];
      if (reportPath && livePath) {
        fs.appendFileSync(livePath, passingLiveRecords(fixture, 1));
        fs.writeFileSync(reportPath, "{broken");
      }
      return { success: true, output: "", error: "", returnCode: 0 };
    };
    const { provider, controller, artifactStore, gateway } = buildProvider(shell);
    const events: ExecutionEvent[] = [];
    const subscription = gateway instanceof LegacyArtifactGateway
      ? gateway.onEvent((event) => events.push(event))
      : undefined;
    await provider.discoverTests();

    try {
      await runItem(controller, controller.find(fixture.featurePath)!);
    } finally {
      subscription?.dispose();
    }

    const caseEvents = events.filter((event) => event.kind === "case-finished");
    const finished = events.find((event) => event.kind === "finished");
    expect(caseEvents).toHaveLength(1);
    expect(finished).toMatchObject({
      kind: "finished",
      completion: {
        state: "partial",
        passed: 1,
        failed: 0,
        results: [expect.objectContaining({ outcome: "passed" })],
      },
    });
    const artifact = artifactStore.latest();
    expect(artifact).toMatchObject({
      state: "partial",
      results: [expect.objectContaining({ outcome: "passed" })],
    });
    expect(finished?.kind === "finished" && finished.completion.artifactId).toBe(artifact?.id);
    expect(caseEvents[0]?.kind === "case-finished" && caseEvents[0].result)
      .toEqual(finished?.kind === "finished" && finished.completion.results[0]);
    expect(finished?.kind === "finished" && finished.completion.results[0]?.scenario)
      .toEqual(artifact?.results[0]?.scenario);
  });

  it("keeps an editor-triggered TestRun open for live results and final reconciliation", async () => {
    const shell: ShellRunner = async () => ({
      success: true,
      output: "",
      error: "",
      returnCode: 0,
    });
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const session = provider.beginExternalRun(fixture.featurePath);
    const run = controller.runs.at(-1)!;
    expect(run.outcome.ended).toBe(false);
    expect(run.outcome.started).toEqual([fixture.featurePath]);

    const detail = {
      featurePath: fixture.featurePath,
      lineNumber: 4,
      scenarioName: "Passing scenario",
      status: "passed" as const,
      durationMs: 5,
    };
    session.progress.onTestEnd?.(detail, 1, 3);
    expect(run.outcome.passed).toContain(`${fixture.featurePath}:4`);
    expect(run.outcome.ended).toBe(false);

    session.complete({
      success: true,
      output: "",
      duration: 10,
      scenarioResults: { [`${fixture.featurePath}:4`]: "passed" },
      scenarioDetails: [detail],
    });
    expect(run.outcome.passed.filter((id) => id === `${fixture.featurePath}:4`)).toHaveLength(1);
    expect(run.outcome.passed).toContain(fixture.featurePath);
    expect(run.outcome.ended).toBe(true);
  });

  it("keeps an all-skipped live feature skipped when the final report is empty", async () => {
    const shell: ShellRunner = async () => ({
      success: true,
      output: "",
      error: "",
      returnCode: 0,
    });
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();
    const session = provider.beginExternalRun(fixture.featurePath);
    const run = controller.runs.at(-1)!;

    for (const [lineNumber, scenarioName, completed] of [
      [4, "Passing scenario", 1],
      [12, "Example #1", 2],
      [13, "Example #2", 3],
    ] as const) {
      session.progress.onTestEnd?.({
        featurePath: fixture.featurePath,
        lineNumber,
        scenarioName,
        status: "skipped",
      }, completed, 3);
    }

    session.complete({ success: true, output: "", duration: 10, scenarioResults: {} });

    expect(run.outcome.skipped).toContain(fixture.featurePath);
    expect(run.outcome.passed).not.toContain(fixture.featurePath);
    expect(run.outcome.failed).toEqual([]);
    expect(provider.getItemStatus(`${fixture.featurePath}:4`)).toBeUndefined();
  });

  it("uses an empty request instead of selecting the whole tree when an external target is undiscovered", () => {
    const shell: ShellRunner = async () => ({
      success: true,
      output: "",
      error: "",
      returnCode: 0,
    });
    const { provider, controller } = buildProvider(shell);

    const session = provider.beginExternalRun(fixture.featurePath);
    const request = controller.runs.at(-1)!.request as vscode.TestRunRequest;
    expect(request.include).toEqual([]);
    session.end();
  });

  it("does not overwrite a completed live scenario when the rest of the run is cancelled", async () => {
    const source = new vscode.CancellationTokenSource();
    const shell: ShellRunner = (_cmd, _dir, env, signal) => new Promise((resolve) => {
      const livePath = env?.[LIVE_REPORT_FILE_ENV];
      if (!livePath) {throw new Error("Live report path was not provided");}
      fs.appendFileSync(livePath, passingLiveRecords(fixture));
      signal?.addEventListener("abort", () => {
        resolve({ success: false, output: "", error: "Cancelled", returnCode: 130 });
      }, { once: true });
    });
    const { provider, controller, artifactStore, gateway } = buildProvider(shell);
    const events: ExecutionEvent[] = [];
    const subscription = gateway instanceof LegacyArtifactGateway
      ? gateway.onEvent((event) => events.push(event))
      : undefined;
    await provider.discoverTests();

    const feature = controller.find(fixture.featurePath)!;
    const runProfile = controller.profile("Run")!;
    const pending = runProfile.runHandler(new vscode.TestRunRequest([feature]), source.token);
    await vi.waitFor(() => expect(controller.runs).toHaveLength(1));
    const run = controller.runs.at(-1)!;
    await vi.waitFor(() =>
      expect(run.outcome.passed).toContain(`${fixture.featurePath}:4`)
    );

    source.cancel();
    try {
      await pending;
    } finally {
      subscription?.dispose();
    }
    expect(run.outcome.skipped).not.toContain(`${fixture.featurePath}:4`);
    expect(run.outcome.skipped).toContain(`${fixture.featurePath}:12`);
    expect(run.outcome.skipped).toContain(`${fixture.featurePath}:13`);
    expect(run.outcome.ended).toBe(true);
    expect(events.at(-1)).toMatchObject({
      kind: "finished",
      completion: {
        state: "cancelled",
        passed: 1,
        results: [expect.objectContaining({ outcome: "passed" })],
      },
    });
    expect(artifactStore.latest()).toMatchObject({
      state: "cancelled",
      results: [expect.objectContaining({ outcome: "passed" })],
    });
  });

  it("passes the parsed scenario duration to run.passed", async () => {
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      const out = reportJson(fixture, [{ title: "Passing scenario", line: 6, status: "passed" }]);
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], out);}
      return { success: true, output: "", error: "", returnCode: 0 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const leaf = controller.find(`${fixture.featurePath}:4`);
    await runItem(controller, leaf!);

    const run = controller.runs.at(-1)!;
    // reportJson stamps duration: 5 on each result; it must reach the VS Code run API.
    expect(run.outcome.durations[`${fixture.featurePath}:4`]).toBe(5);
  });

  it("cancelling mid-run skips the started and not-yet-run items, fails none, and fires no failure event", async () => {
    // Two top-level items. The first item's run cancels the token (user hits Stop); its process is
    // killed (exit 130) but must NOT paint the tree red (it's skipped), and the second, never-run
    // item is skipped too. No failure event reaches the status bar.
    const source = new vscode.CancellationTokenSource();
    let calls = 0;
    const shell: ShellRunner = async () => {
      calls += 1;
      if (calls === 1) {source.cancel();}
      return { success: false, output: "", error: "killed", returnCode: 130 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const first = controller.find(`${fixture.featurePath}:4`)!;
    const second = controller.find(`${fixture.featurePath}:12`)!;
    const runProfile = controller.profile("Run")!;
    await runProfile.runHandler(new vscode.TestRunRequest([first, second]), source.token);

    const run = controller.runs.at(-1)!;
    expect(run.outcome.skipped).toContain(`${fixture.featurePath}:4`);
    expect(run.outcome.skipped).toContain(`${fixture.featurePath}:12`);
    expect(run.outcome.failed).toEqual([]);
    expect(run.outcome.ended).toBe(true);
  });

  describe("run-artifact capture (wiring)", () => {
    it("a command-driven executor run during an open batch injects no shard into it", async () => {
      const shell: ShellRunner = async (_cmd, _dir, env) => {
        if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {
          fs.writeFileSync(
            env["PLAYWRIGHT_JSON_OUTPUT_NAME"],
            reportJson(fixture, [{ title: "Passing scenario", line: 6, status: "passed" }])
          );
        }
        return { success: true, output: "", error: "", returnCode: 0 };
      };
      const { executor, artifactStore } = buildProvider(shell);
      // The Test Explorer opened a batch; a codelens/palette run then fires at the shared seam with
      // no handle. Its parsed results must not land in the open Explorer artifact.
      const batch = artifactStore.beginBatch({ kind: "all-mapped" });
      await executor.runPathFilterWithOutput(fixture.featurePath);
      const sealed = artifactStore.sealBatch(batch, "complete");

      expect(sealed?.shards).toEqual([]);
      expect(sealed?.results).toEqual([]);
      expect(sealed?.state).toBe("complete");
    });

    it("a throwing invocation seals the batch partial through the provider run path", async () => {
      const shell: ShellRunner = async () => { throw new Error("spawn failed"); };
      const { provider, controller, artifactStore } = buildProvider(shell);
      await provider.discoverTests();

      const feature = controller.find(fixture.featurePath)!;
      await runItem(controller, feature);

      const latest = artifactStore.latest();
      expect(latest?.state).toBe("partial");
      expect(latest?.shards).toHaveLength(1);
      expect(latest?.shards[0]?.success).toBe(false);
    });

    it("cancelling the run seals the batch cancelled through the provider run path", async () => {
      const source = new vscode.CancellationTokenSource();
      const shell: ShellRunner = async () => {
        source.cancel();
        return { success: false, output: "", error: "killed", returnCode: 130 };
      };
      const { provider, controller, artifactStore } = buildProvider(shell);
      await provider.discoverTests();

      const leaf = controller.find(`${fixture.featurePath}:4`)!;
      const runProfile = controller.profile("Run")!;
      await runProfile.runHandler(new vscode.TestRunRequest([leaf]), source.token);

      expect(artifactStore.latest()?.state).toBe("cancelled");
    });
  });

  it("renders the scenario's step lines in the run summary", async () => {
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {
        fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], reportJson(fixture, [{
          title: "Passing scenario",
          line: 6,
          status: "passed",
          steps: [{ title: "Given I am on the test page", duration: 3 }],
        }]));
      }
      return { success: true, output: "", error: "", returnCode: 0 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    await runItem(controller, controller.find(`${fixture.featurePath}:4`)!);

    expect(controller.runs.at(-1)!.outcome.output.join("")).toContain("Given I am on the test page");
  });

  it("does not let one target's \"no tests found\" mask another target's empty failure", async () => {
    // Run-wide output: the first target is genuinely out of scope, the second fails outright. The
    // carve-out is only readable as one target's own when the run had exactly one.
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {
        fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], JSON.stringify({ suites: [] }));
      }
      return { success: false, output: "", error: "Error: No tests found", returnCode: 1 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();
    const scenario = controller.find(`${fixture.featurePath}:4`)!;
    const outline = controller.find(`${fixture.featurePath}${OUTLINE_ID_SEPARATOR}7:Math`)!;

    await controller.profile("Run")!.runHandler(
      new vscode.TestRunRequest([scenario, outline]),
      new vscode.CancellationTokenSource().token
    );

    const run = controller.runs.at(-1)!;
    expect(run.outcome.failed.map((entry) => entry.id)).toContain(outline.id);
    expect(run.outcome.skipped).not.toContain(outline.id);
  });

  it("leaves a root the stopped run never reached skipped, not failed", async () => {
    let runs = 0;
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      if (!env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {
        return { success: true, output: "", error: "", returnCode: 0 };
      }
      runs += 1;
      if (runs === 1) {
        fs.writeFileSync(
          env["PLAYWRIGHT_JSON_OUTPUT_NAME"],
          reportJson(fixture, [{ title: "Passing scenario", line: 6, status: "passed" }])
        );
        return { success: true, output: "", error: "", returnCode: 0 };
      }
      // The second invocation dies before writing anything, which stops the run.
      return { success: false, output: "", error: "worker crashed", returnCode: 1 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();
    const scenario = controller.find(`${fixture.featurePath}:4`)!;
    const outline = controller.find(`${fixture.featurePath}${OUTLINE_ID_SEPARATOR}7:Math`)!;

    await controller.profile("Run")!.runHandler(
      new vscode.TestRunRequest([scenario, outline]),
      new vscode.CancellationTokenSource().token
    );

    const run = controller.runs.at(-1)!;
    expect(run.outcome.passed).toContain(`${fixture.featurePath}:4`);
    expect(run.outcome.failed).toEqual([]);
    expect(run.outcome.skipped).toContain(outline.id);
  });

  describe("outline run targets", () => {
    // The spec-line target is resolved against the run's working directory, so the fixture has to be
    // the workspace for a row target to reach bddFileData at all.
    beforeEach(() => {
      (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [
        { uri: { fsPath: fixture.root } },
      ];
    });

    afterEach(() => {
      (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
    });

    function recordingShell(commands: string[]): ShellRunner {
      return async (command, _dir, env) => {
        commands.push(command);
        if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {
          fs.writeFileSync(
            env["PLAYWRIGHT_JSON_OUTPUT_NAME"],
            reportJson(fixture, [{ title: "Example #1", line: 18, status: "passed" }])
          );
        }
        return { success: true, output: "", error: "", returnCode: 0 };
      };
    }

    it("targets one example row by its own generated spec line", async () => {
      const commands: string[] = [];
      const warn = vi.spyOn(Logger.prototype, "warn");
      const { provider, controller } = buildProvider(recordingShell(commands));
      await provider.discoverTests();

      await runItem(controller, controller.find(`${fixture.featurePath}:12`)!);

      // pickleLine 12 maps to pwTestLine 18 in the fixture's bddFileData.
      expect(commands.at(-1)).toContain("test.feature.spec.js:18");
      expect(commands.at(-1)).not.toContain("--grep");
      expect(warn.mock.calls.map(String).join("\n")).not.toContain("Could not target example row");
    });

    it("runs a whole outline by title with no line and no stale-spec warning", async () => {
      const commands: string[] = [];
      const warn = vi.spyOn(Logger.prototype, "warn");
      const { provider, controller } = buildProvider(recordingShell(commands));
      await provider.discoverTests();
      const node = controller.find(`${fixture.featurePath}${OUTLINE_ID_SEPARATOR}7:Math`);
      expect(node, "outline node should be discovered").toBeTruthy();

      await runItem(controller, node!);

      expect(commands.at(-1)).toContain('--grep "Math"');
      expect(commands.at(-1)).not.toContain("test.feature.spec.js:");
      expect(warn.mock.calls.map(String).join("\n")).not.toContain("Could not target example row");
    });

    it("excludes a separately mapped Examples block from an ordinary Test Explorer outline run", async () => {
      const commands: string[] = [];
      const mappedBlock: ScenarioRef = {
        filePath: fixture.featurePath,
        line: 10,
        name: "Math examples",
        kind: "examplesBlock",
        outlineName: "Math",
      };
      const { provider, controller, artifactStore } = buildProvider(
        recordingShell(commands),
        undefined,
        false,
        [mappedBlock]
      );
      await provider.discoverTests();
      const outline = controller.find(`${fixture.featurePath}${OUTLINE_ID_SEPARATOR}7:Math`)!;

      await runItem(controller, outline);

      expect(commands).toEqual([]);
      expect(artifactStore.latest()).toMatchObject({ state: "partial", results: [] });
      expect(controller.runs.at(-1)?.outcome.output.join(""))
        .toContain("owns no parsed rows");
    });
  });

  it("maps outline examples by their .feature line (Example #N → passed/failed)", async () => {
    // The report titles examples "Example #N" with the generated spec line; only the
    // bddFileData line-mapping connects them to the right .feature example row.
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      // bddgen runs first as its own step (no JSON env); succeed so the playwright run proceeds.
      if (!env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {
        return { success: true, output: "", error: "", returnCode: 0 };
      }
      const out = reportJson(fixture, [
        { title: "Example #1", line: 18, status: "passed" },
        { title: "Example #2", line: 24, status: "failed" },
      ]);
      fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], out);
      return { success: false, output: "", error: "", returnCode: 1 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    const ex1 = controller.find(`${fixture.featurePath}:12`);
    const ex2 = controller.find(`${fixture.featurePath}:13`);
    expect(ex1, "example #1 leaf").toBeTruthy();
    expect(ex2, "example #2 leaf").toBeTruthy();

    // Running each example resolves to its own .feature line via bddFileData.
    await runItem(controller, ex1!);
    expect(controller.runs.at(-1)!.outcome.passed).toContain(`${fixture.featurePath}:12`);

    await runItem(controller, ex2!);
    expect(controller.runs.at(-1)!.outcome.failed.map((f) => f.id))
      .toContain(`${fixture.featurePath}:13`);
  });

  it("flags an out-of-scope run (no results attributed) in the Test Results output", async () => {
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      // bddgen step (no JSON env) succeeds; the playwright run then matches nothing; Playwright
      // reports "no tests found" and writes an empty report.
      if (!env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {
        return { success: true, output: "", error: "", returnCode: 0 };
      }
      fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], JSON.stringify({ suites: [] }));
      return { success: false, output: "", error: "Error: No tests found", returnCode: 1 };
    };
    const { provider, controller } = buildProvider(shell, undefined, true);
    await provider.discoverTests();

    const leaf = controller.find(`${fixture.featurePath}:4`);
    await runItem(controller, leaf!);

    const run = controller.runs.at(-1)!;
    const output = run.outcome.output.join("\n");
    expect(output).toContain("No results were attributed to");
    expect(output).toContain("**/*.feature");
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

  it("reports the synthesized failure guidance once, under the streamed output", async () => {
    // The guidance (bddgen failure, missing-binary hint) never crossed the stream, so the run's
    // output projection carries it; the summary must not print the same line a second time.
    const shell: ShellRunner = async () => ({
      success: false,
      output: "raw streamed tail",
      error: "zsh: command not found: npx",
      returnCode: 127,
      outputStreamed: true,
    });
    const { controller } = buildProvider(shell);
    const featurePath = "/repo/features/a.feature";
    const featureItem = controller.createTestItem(featurePath, "A feature", { fsPath: featurePath });
    controller.items.add(featureItem);

    await runItem(controller, featureItem);

    const output = controller.runs.at(-1)!.outcome.output.join("\n");
    expect(output.match(/The command "npx" was not found/g)).toHaveLength(1);
    expect(output).not.toContain("raw streamed tail");
  });

  it("scopes the run summary to the target when the report's featurePath differs only by Windows drive-letter case/separators", async () => {
    // The run targets one feature but the report attributes results to it AND another feature.
    // formatRunOutput must scope the summary to the target, comparing through normalizePathKey so a
    // VS Code lowercase-drive backslash path (c:\repo\…) folds onto the report's uppercase-drive
    // forward-slash path (C:/repo/…). A raw === would miss on Windows and render BOTH features.
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      const report = JSON.stringify({
        suites: [{
          title: "Suite",
          specs: [
            {
              title: "Target scenario", file: "a.spec.js", line: 4,
              tests: [{
                annotations: [{ type: "C:/repo/features/a.feature:4" }],
                results: [{ status: "passed", duration: 5, steps: [] }],
              }],
            },
            {
              title: "Other scenario", file: "b.spec.js", line: 7,
              tests: [{
                annotations: [{ type: "C:/repo/features/b.feature:7" }],
                results: [{ status: "passed", duration: 5, steps: [] }],
              }],
            },
          ],
        }],
      });
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], report);}
      return { success: true, output: "", error: "", returnCode: 0 };
    };
    const { controller } = buildProvider(shell);

    // A Windows-style feature item: VS Code lowercase drive + backslashes. No discovery needed;
    // the run path only reads the item's uri/id/label.
    const winPath = "c:\\repo\\features\\a.feature";
    const featureItem = controller.createTestItem(winPath, "A feature", { fsPath: winPath });
    controller.items.add(featureItem);

    await runItem(controller, featureItem);

    const output = controller.runs.at(-1)!.outcome.output.join("\n");
    expect(output).toContain("Target scenario");
    expect(output).not.toContain("Other scenario");
    // Scoped to one: the tally counts a single scenario, not both.
    expect(output).not.toContain("2 scenarios");
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

  describe("scenario outlines whose title contains <placeholders> (substituted report titles)", () => {
    // The user-reported bug: an outline titled with placeholders makes playwright-bdd generate
    // tests titled with the SUBSTITUTED values ("Add (2/2) widgets"), never "Example #N" and
    // never the tree's synthetic example label, so name-based mapping can only go through the
    // row's substitutedName.
    const SUBSTITUTED_FEATURE = [
      "Feature: Sample feature",
      "",
      "  Scenario Outline: Add (<a>/<b>) widgets", // line 3
      "    Given <a> plus <b>",
      "",
      "    Examples:",
      "      | a | b |",
      "      | 2 | 2 |", // line 8 → generated test "Add (2/2) widgets"
      "      | 3 | 3 |", // line 9 → generated test "Add (3/3) widgets"
    ].join("\n");

    beforeEach(() => {
      fs.writeFileSync(fixture.featurePath, SUBSTITUTED_FEATURE);
      (vscode.workspace.fs as { readFile: unknown }).readFile = async (): Promise<Uint8Array> =>
        new TextEncoder().encode(SUBSTITUTED_FEATURE);
      // The run target is resolved from the generated file before the report parser exercises its
      // own path and substituted-title fallbacks. Keep this map aligned with the feature above.
      fs.writeFileSync(
        fixture.genSpecPath,
        [
          "// Generated from: features/test.feature",
          "const bddFileData = [ // bdd-data-start",
          '  {"pwTestLine":14,"pickleLine":8},',
          '  {"pwTestLine":20,"pickleLine":9},',
          "]; // bdd-data-end",
        ].join("\n")
      );
    });

    function substitutedReport(rootDir: string): string {
      return JSON.stringify({
        config: { rootDir, configFile: path.join(fixture.root, "playwright.config.ts") },
        suites: [{
          title: "Sample feature",
          suites: [{
            title: "Add (<a>/<b>) widgets",
            specs: [
              {
                title: "Add (2/2) widgets", file: "features/test.feature.spec.js", line: 14,
                tests: [{ results: [{ status: "passed", duration: 5, steps: [] }] }],
              },
              {
                title: "Add (3/3) widgets", file: "features/test.feature.spec.js", line: 20,
                tests: [{ results: [{ status: "failed", duration: 5, steps: [] }] }],
              },
            ],
          }],
        }],
      });
    }

    function substitutedShell(rootDir: string): ShellRunner {
      return async (_cmd, _dir, env) => {
        if (!env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {
          return { success: true, output: "", error: "", returnCode: 0 };
        }
        fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], substitutedReport(rootDir));
        return { success: false, output: "", error: "", returnCode: 1 };
      };
    }

    function outlineItem(controller: FakeTestController): FakeTestItem {
      const item = controller.find(
        `${fixture.featurePath}${OUTLINE_ID_SEPARATOR}3:Add (<a>/<b>) widgets`
      );
      expect(item, "outline item should be discovered").toBeTruthy();
      return item!;
    }

    it("maps the example rows to their real statuses when the report's spec path is unresolvable (the user's environment)", async () => {
      // The user's environment: a custom featuresGenDir / cleaned gen dir means the parser can't
      // read the generated spec, so resolveSourceLocation fails and each result's featurePath
      // falls back to the RELATIVE spec path; no line-based or feature-path-based key can ever
      // match. Only the substitutedName suffix scan connects report entries to the example rows.
      const { provider, controller } = buildProvider(
        substitutedShell(path.join(fixture.root, "no-such-gen-dir"))
      );
      await provider.discoverTests();

      await runItem(controller, outlineItem(controller));

      const run = controller.runs.at(-1)!;
      expect(run.outcome.passed).toContain(`${fixture.featurePath}:8`);
      expect(run.outcome.failed.map((f) => f.id)).toContain(`${fixture.featurePath}:9`);
      expect(run.outcome.skipped).not.toContain(`${fixture.featurePath}:8`);
      expect(run.outcome.skipped).not.toContain(`${fixture.featurePath}:9`);
      // Results WERE attributed (by substituted title), so the out-of-scope warning must not fire.
      expect(run.outcome.output.join("\n")).not.toContain("No results were attributed");
    });

    it("still maps by .feature line when the generated spec is resolvable (substituted-name lookups don't interfere)", async () => {
      const { provider, controller } = buildProvider(
        substitutedShell(path.join(fixture.root, ".features-gen"))
      );
      await provider.discoverTests();

      await runItem(controller, outlineItem(controller));

      const run = controller.runs.at(-1)!;
      expect(run.outcome.passed).toContain(`${fixture.featurePath}:8`);
      expect(run.outcome.failed.map((f) => f.id)).toContain(`${fixture.featurePath}:9`);
      expect(run.outcome.output.join("\n")).not.toContain("No results were attributed");
    });
  });

  describe("selected-gateway rediscovery on watcher events (FeatureBased)", () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });

    it("refreshes the selected gateway and replaces the changed file", async () => {
      const { provider, controller, discoveryManager } = buildProvider(shell);
      await provider.discoverTests();
      expect(controller.find(`${fixture.featurePath}:12`), "outline example seeded").toBeTruthy();
      // Isolate the watcher-triggered calls from the initial explicit discovery.
      discoveryManager.discoverTestFiles.mockClear();

      // The file now has one plain scenario at line 7 where the outline used to be.
      const changed = [
        "@feature",
        "Feature: Sample feature",
        "",
        "  Scenario: Passing scenario", // line 4
        "    Given I am on the test page",
        "",
        "  Scenario: Brand new scenario", // line 7
        "    Given something new",
      ].join("\n");
      fs.writeFileSync(fixture.featurePath, changed);

      await vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath));

      expect(controller.find(`${fixture.featurePath}:7`), "new scenario added").toBeTruthy();
      // The old outline example rows are gone from both the tree and the id→scenario map.
      expect(controller.find(`${fixture.featurePath}:12`)).toBeUndefined();
      expect(provider.testIdToScenarioMap.has(`${fixture.featurePath}:12`)).toBe(false);
      expect(discoveryManager.discoverTestFiles).not.toHaveBeenCalled();
    });

    it("removes the node and its state when a file is deleted", async () => {
      const { provider, controller, discoveryManager } = buildProvider(shell);
      await provider.discoverTests();
      expect(controller.find(fixture.featurePath)).toBeTruthy();
      discoveryManager.discoverTestFiles.mockClear();
      discoveryManager.discoverTestFiles.mockResolvedValue([]);

      await vscode.__fireFileWatcher("delete", vscode.Uri.file(fixture.featurePath));

      expect(controller.find(fixture.featurePath)).toBeUndefined();
      expect(controller.find(`${fixture.featurePath}:4`)).toBeUndefined();
      expect(provider.testIdToScenarioMap.has(`${fixture.featurePath}:4`)).toBe(false);
      expect(discoveryManager.discoverTestFiles).not.toHaveBeenCalled();
    });

    it("keeps the last good node when a changed file no longer parses", async () => {
      const { provider, controller } = buildProvider(shell);
      await provider.discoverTests();
      expect(controller.find(fixture.featurePath)).toBeTruthy();

      fs.writeFileSync(fixture.featurePath, "this text has no Feature keyword");

      await vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath));

      expect(controller.find(fixture.featurePath)).toBeTruthy();
      expect(provider.testIdToScenarioMap.has(`${fixture.featurePath}:4`)).toBe(true);
    });

    it("keeps the newest same-file presentation when delayed reads finish in reverse", async () => {
      const { provider, controller } = buildProvider(shell);
      await provider.discoverTests();
      let releaseFirst!: (data: Uint8Array) => void;
      let releaseSecond!: (data: Uint8Array) => void;
      const first = new Promise<Uint8Array>((resolve) => {releaseFirst = resolve;});
      const second = new Promise<Uint8Array>((resolve) => {releaseSecond = resolve;});
      let reads = 0;
      (vscode.workspace.fs as { readFile: unknown }).readFile = () => {
        reads += 1;
        return reads === 1 ? first : second;
      };

      const older = vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath));
      await Promise.resolve();
      const newer = vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath));
      await Promise.resolve();
      releaseFirst(new TextEncoder().encode(["Feature: Old", "", "  Scenario: Oldest"].join("\n")));
      await older;
      releaseSecond(new TextEncoder().encode(["Feature: New", "", "  Scenario: Newest"].join("\n")));
      await newer;

      expect(controller.find(`${fixture.featurePath}:3`)?.label).toBe("Newest");
    });

    it("keeps a deleted file deleted when an earlier change read settles later", async () => {
      const { provider, controller } = buildProvider(shell);
      await provider.discoverTests();
      let release!: (data: Uint8Array) => void;
      const pending = new Promise<Uint8Array>((resolve) => {release = resolve;});
      (vscode.workspace.fs as { readFile: unknown }).readFile = () => pending;

      const changed = vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath));
      await Promise.resolve();
      const deleted = vscode.__fireFileWatcher("delete", vscode.Uri.file(fixture.featurePath));
      release(new TextEncoder().encode(FEATURE));
      await changed;
      await deleted;

      expect(controller.find(fixture.featurePath)).toBeUndefined();
    });

    it("does not commit an admitted change after local capability is withdrawn", async () => {
      let localCapability = true;
      const { provider, controller } = buildProvider(shell, undefined, false, [], {
        localCapability: () => localCapability,
      });
      await provider.discoverTests();
      let release!: (data: Uint8Array) => void;
      const pending = new Promise<Uint8Array>((resolve) => {release = resolve;});
      (vscode.workspace.fs as { readFile: unknown }).readFile = () => pending;

      const changed = vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath));
      await Promise.resolve();
      localCapability = false;
      release(new TextEncoder().encode(["Feature: Changed", "", "  Scenario: Rejected"].join("\n")));
      await changed;

      expect(controller.find(`${fixture.featurePath}:4`)?.label).toBe("Passing scenario");
    });

    it("does not commit a delayed exact update after disposal", async () => {
      const { provider, controller } = buildProvider(shell);
      await provider.discoverTests();
      let release!: (data: Uint8Array) => void;
      const pending = new Promise<Uint8Array>((resolve) => {release = resolve;});
      (vscode.workspace.fs as { readFile: unknown }).readFile = () => pending;

      const changed = vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath));
      await Promise.resolve();
      provider.dispose();
      release(new TextEncoder().encode(["Feature: Changed", "", "  Scenario: Rejected"].join("\n")));
      await changed;

      expect(controller.find(`${fixture.featurePath}:4`)?.label).toBe("Passing scenario");
    });

    it("adds a created feature through the exact-file presentation seam", async () => {
      const { provider, controller, discoveryManager } = buildProvider(shell);
      await provider.discoverTests();
      discoveryManager.discoverTestFiles.mockClear();
      const createdPath = path.join(fixture.root, "features", "created.feature");
      fs.writeFileSync(createdPath, ["Feature: Created", "", "  Scenario: New", "    Given new"].join("\n"));

      await vscode.__fireFileWatcher("create", vscode.Uri.file(createdPath));

      expect(controller.find(createdPath)).toBeTruthy();
      expect(controller.find(`${createdPath}:3`)).toBeTruthy();
      expect(discoveryManager.discoverTestFiles).not.toHaveBeenCalled();
    });

    it("commits concurrent exact updates for distinct files", async () => {
      const { provider, controller } = buildProvider(shell);
      await provider.discoverTests();
      fs.writeFileSync(fixture.featurePath, ["Feature: Updated", "", "  Scenario: A changed"].join("\n"));
      const secondPath = path.join(fixture.root, "features", "second.feature");
      fs.writeFileSync(secondPath, ["Feature: Second", "", "  Scenario: B changed"].join("\n"));

      await Promise.all([
        vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath)),
        vscode.__fireFileWatcher("create", vscode.Uri.file(secondPath)),
      ]);

      expect(controller.find(`${fixture.featurePath}:3`)?.label).toBe("A changed");
      expect(controller.find(`${secondPath}:3`)?.label).toBe("B changed");
    });

    it("bounds a same-file watcher burst to one preparation after admission", async () => {
      const { provider } = buildProvider(shell);
      await provider.discoverTests();
      let release!: (data: Uint8Array) => void;
      const pending = new Promise<Uint8Array>((resolve) => {release = resolve;});
      let reads = 0;
      (vscode.workspace.fs as { readFile: unknown }).readFile = () => {
        reads += 1;
        return pending;
      };

      const events = Array.from({ length: 10 }, () =>
        vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath))
      );
      await Promise.resolve();
      release(new TextEncoder().encode(FEATURE));
      await Promise.all(events);

      expect(reads).toBe(1);
    });

    it("follows an exact update during canonical discovery with one authoritative pass", async () => {
      const { provider, controller, discoveryManager } = buildProvider(shell);
      await provider.discoverTests();
      let release!: (paths: string[]) => void;
      const pending = new Promise<string[]>((resolve) => {release = resolve;});
      discoveryManager.discoverTestFiles.mockClear();
      discoveryManager.discoverTestFiles.mockReturnValueOnce(pending);
      fs.writeFileSync(fixture.featurePath, ["Feature: Updated", "", "  Scenario: Final canonical"].join("\n"));

      const refresh = provider.discoverTests();
      await Promise.resolve();
      const changed = vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath));
      release([fixture.featurePath]);
      await Promise.all([refresh, changed]);

      expect(discoveryManager.discoverTestFiles).toHaveBeenCalledTimes(2);
      expect(controller.find(`${fixture.featurePath}:3`)?.label).toBe("Final canonical");
    });

    it("follows a second exact update during the canonical follow-up", async () => {
      const { provider, controller, discoveryManager } = buildProvider(shell);
      await provider.discoverTests();
      let releaseFirst!: (paths: string[]) => void;
      let releaseSecond!: (paths: string[]) => void;
      const first = new Promise<string[]>((resolve) => {releaseFirst = resolve;});
      const second = new Promise<string[]>((resolve) => {releaseSecond = resolve;});
      discoveryManager.discoverTestFiles.mockClear();
      discoveryManager.discoverTestFiles.mockReturnValueOnce(first).mockReturnValueOnce(second)
        .mockResolvedValue([fixture.featurePath]);

      const refresh = provider.discoverTests();
      await Promise.resolve();
      fs.writeFileSync(fixture.featurePath, ["Feature: Updated", "", "  Scenario: Second event"].join("\n"));
      const firstChange = vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath));
      releaseFirst([fixture.featurePath]);
      await vi.waitFor(() => expect(discoveryManager.discoverTestFiles).toHaveBeenCalledTimes(2));
      fs.writeFileSync(fixture.featurePath, ["Feature: Updated", "", "  Scenario: Newest canonical"].join("\n"));
      const secondChange = vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath));
      releaseSecond([fixture.featurePath]);

      await Promise.all([refresh, firstChange, secondChange]);
      expect(discoveryManager.discoverTestFiles).toHaveBeenCalledTimes(3);
      expect(controller.find(`${fixture.featurePath}:3`)?.label).toBe("Newest canonical");
    });

    it("ignores a watcher event for a generated (excluded-dir) feature copy", async () => {
      const { provider, controller, discoveryManager } = buildProvider(shell);
      await provider.discoverTests();
      discoveryManager.discoverTestFiles.mockClear();

      const genCopy = path.join(fixture.root, ".features-gen", "features", "test.feature");
      await vscode.__fireFileWatcher("change", vscode.Uri.file(genCopy));

      expect(controller.find(genCopy)).toBeUndefined();
      expect(controller.find(fixture.featurePath), "source node untouched").toBeTruthy();
      expect(discoveryManager.discoverTestFiles).toHaveBeenCalledWith({ forceRefresh: true });
    });

    it("falls back to a full refresh under a non-FeatureBased strategy", async () => {
      const { provider, discoveryManager } = buildProvider(shell);
      await provider.discoverTests();
      discoveryManager.discoverTestFiles.mockClear();

      const tagStrategy = provider
        .getAvailableOrganizationStrategies()
        .find((s) => s.strategy.strategyType === "TagBasedOrganization")!.strategy;
      provider.setOrganizationStrategy(tagStrategy);

      await vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath));

      // Content can move scenarios between tag groups, so the whole workspace is re-swept.
      expect(discoveryManager.discoverTestFiles).toHaveBeenCalledTimes(1);
    });

    it("falls back to canonical discovery for an unknown execution gateway", async () => {
      const gateway = testGateway(async () => ({
        identity: EXECUTION_IDENTITY, state: "complete", results: [], passed: 0, failed: 0, durationMs: 0, output: "",
      }), [{
        id: `${fixture.featurePath}:4`, name: "Passing scenario", source: { path: fixture.featurePath, line: 4 },
        suites: [{ name: "Sample feature", source: { path: fixture.featurePath, line: 1 } }], tags: [],
      }]);
      const { provider } = buildProvider(shell, gateway);
      await provider.discoverTests();
      vi.mocked(gateway.discover).mockClear();

      await vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath));

      expect(gateway.discover).toHaveBeenCalledWith({ refresh: true });
    });

    it("reconciles each pattern change and ignores stale watcher generations", async () => {
      let pattern = "**/*.feature";
      const { provider, discoveryManager } = buildProvider(shell, undefined, false, [], {
        testFilePattern: () => pattern,
      });
      await provider.discoverTests();
      discoveryManager.discoverTestFiles.mockClear();
      const change = provider as unknown as { handleConfigurationChange(): Promise<void> };

      pattern = "features/*.feature";
      await change.handleConfigurationChange();
      pattern = "**/*.feature";
      await change.handleConfigurationChange();
      await vscode.__fireFileWatcherAt(0, "change", vscode.Uri.file(fixture.featurePath));

      expect(discoveryManager.discoverTestFiles).toHaveBeenCalledTimes(2);
    });

    it("does not commit a delayed watcher change after its pattern is retired", async () => {
      let pattern = "**/*.feature";
      const { provider, controller } = buildProvider(shell, undefined, false, [], {
        testFilePattern: () => pattern,
      });
      await provider.discoverTests();
      let release!: (data: Uint8Array) => void;
      const pending = new Promise<Uint8Array>((resolve) => {release = resolve;});
      (vscode.workspace.fs as { readFile: unknown }).readFile = () => pending;

      const changed = vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath));
      await Promise.resolve();
      pattern = "features/*.feature";
      await (provider as unknown as { handleConfigurationChange(): Promise<void> }).handleConfigurationChange();
      release(new TextEncoder().encode(["Feature: Changed", "", "  Scenario: Rejected"].join("\n")));
      await changed;

      expect(controller.find(`${fixture.featurePath}:3`)?.label).not.toBe("Rejected");
    });
  });
});
