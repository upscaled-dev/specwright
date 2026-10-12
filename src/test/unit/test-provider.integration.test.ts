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
import { normalizePathKey, PlaywrightJsonParser } from "../../utils/playwright-json-parser";
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
    options: { testFilePattern?: () => string; localCapability?: () => boolean; workerCount?: number; workspaceState?: import("vscode").Memento } = {}
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
        if (key === "maxParallelProcesses" && options.workerCount !== undefined) {return options.workerCount as T;}
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
      options.workspaceState,
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

    await controller.resolveHandler?.(controller.find(fixture.featurePath));
    expect(discoveryManager.discoverTestFiles).toHaveBeenCalledTimes(1);

    await controller.refreshHandler?.();
    expect(discoveryManager.discoverTestFiles).toHaveBeenCalledTimes(2);
  });

  it("updates one feature's Test Explorer rows when its watched file changes or is deleted", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { provider, controller, discoveryManager } = buildProvider(shell);
    await provider.discoverTests();
    expect(controller.find(`${fixture.featurePath}:4`)?.label).toBe("Passing scenario");

    fs.writeFileSync(fixture.featurePath, "Feature: Changed\n\nScenario: New login\n  Given credentials\n");
    await vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath));
    expect(controller.find(fixture.featurePath)?.label).toBe("Changed");
    expect(controller.find(`${fixture.featurePath}:3`)?.label).toBe("New login");
    expect(controller.find(`${fixture.featurePath}:4`)).toBeUndefined();
    expect(discoveryManager.discoverTestFiles).toHaveBeenCalledOnce();

    await vscode.__fireFileWatcher("delete", vscode.Uri.file(fixture.featurePath));
    expect(controller.find(fixture.featurePath)).toBeUndefined();
    expect(provider.getDiscoveredTests().has(fixture.featurePath)).toBe(false);
    expect(discoveryManager.discoverTestFiles).toHaveBeenCalledOnce();
  });

  it("updates a watched feature from a scenario to grouped outline examples", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();
    fs.writeFileSync(fixture.featurePath, [
      "Feature: Pricing", "", "  Scenario Outline: Add <count> widgets",
      "    Given I add <count> widgets", "", "    Examples: Quantities",
      "      | count |", "      | 2 |", "      | 3 |",
    ].join("\n"));

    await vscode.__fireFileWatcher("change", vscode.Uri.file(fixture.featurePath));

    const feature = controller.find(fixture.featurePath)!;
    const children: FakeTestItem[] = [];
    feature.children.forEach((child) => children.push(child));
    expect(feature.label).toBe("Pricing");
    expect(children.map((child) => child.label)).toEqual(["Scenario Outline: Add <count> widgets"]);
    expect(children[0]?.description).toBe("2 example(s)");
    const examples: FakeTestItem[] = [];
    children[0]?.children.forEach((child) => examples.push(child));
    expect(examples.map((example) => example.label)).toEqual([
      "1: Add <count> widgets - count: 2",
      "2: Add <count> widgets - count: 3",
    ]);
    expect(controller.find(`${fixture.featurePath}:4`)).toBeUndefined();
  });

  it("leaves an unparsable feature out of Test Explorer until its content is corrected", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { provider, controller } = buildProvider(shell);
    const uri = vscode.Uri.file(fixture.featurePath) as unknown as import("vscode").Uri;
    fs.writeFileSync(fixture.featurePath, "This is not a feature\n");

    await provider.addFeatureFileToTestController(uri);
    expect(controller.find(fixture.featurePath)).toBeUndefined();

    fs.writeFileSync(fixture.featurePath, "Feature: Checkout\n\nScenario: Pay\n  Given a basket\n");
    await provider.addFeatureFileToTestController(uri);
    expect(controller.find(fixture.featurePath)?.label).toBe("Checkout");
    expect(controller.find(`${fixture.featurePath}:3`)?.label).toBe("Pay");
  });

  it("restores the saved grouping before the first Test Explorer discovery", async () => {
    const workspaceState = fakeMemento();
    await workspaceState.update("playwrightBddRunner.organizationStrategyType", "TagBasedOrganization");
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { provider, controller } = buildProvider(shell, undefined, false, [], { workspaceState });

    await provider.discoverTests();

    expect(provider.getOrganizationStrategy().strategyType).toBe("TagBasedOrganization");
    expect(controller.find("tag:@feature")?.label).toBe("@feature");
    expect(controller.find(`${fixture.featurePath}:4`)?.label).toBe("Passing scenario");
  });

  it("keeps the feature tree when a saved grouping name is no longer available", async () => {
    const workspaceState = fakeMemento();
    await workspaceState.update("playwrightBddRunner.organizationStrategyType", "RemovedOrganization");
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { provider, controller } = buildProvider(shell, undefined, false, [], { workspaceState });

    await provider.discoverTests();

    expect(provider.getOrganizationStrategy().strategyType).toBe("FeatureBasedOrganization");
    expect(controller.find(fixture.featurePath)?.label).toBe("Sample feature");
    expect(controller.find(`${fixture.featurePath}:4`)?.label).toBe("Passing scenario");
  });

  it("presents canonical outline examples and tags under their feature in Test Explorer", async () => {
    const feature = fixture.featurePath;
    const suite = { name: "Sample feature", source: { path: feature, line: 2 } };
    const gateway = testGateway(async () => ({
      identity: EXECUTION_IDENTITY, state: "complete", results: [], passed: 0, failed: 0,
      durationMs: 1, output: "",
    }), [
      { id: `${feature}:4`, name: "Passing scenario", source: { path: feature, line: 4 }, suites: [suite], tags: ["@smoke"] },
      { id: `${feature}:12`, name: "Math 1+2", source: { path: feature, line: 12 }, suites: [suite], tags: ["@outline"],
        parameterized: { groupName: "Math", groupLine: 7, blockLine: 10, blockName: "Numbers", substitutedName: "Math 1+2" } },
      { id: `${feature}:13`, name: "Math 3+4", source: { path: feature, line: 13 }, suites: [suite], tags: ["@outline"],
        parameterized: { groupName: "Math", groupLine: 7, blockLine: 10, blockName: "Numbers", substitutedName: "Math 3+4" } },
    ]);
    const { provider, controller } = buildProvider(
      async () => ({ success: true, output: "", error: "", returnCode: 0 }), gateway
    );

    await provider.discoverTests();

    const featureItem = controller.find(feature)!;
    expect(featureItem.label).toBe("Sample feature");
    expect(featureItem.range?.start.line).toBe(1);
    expect(controller.find(`${feature}:4`)?.description).toContain("Tags: @smoke");
    const children: FakeTestItem[] = [];
    featureItem.children.forEach((child) => children.push(child));
    const outline = children.find((child) => child.label === "Scenario Outline: Math")!;
    expect(outline.description).toBe("2 example(s)");
    expect(outline.range?.start.line).toBe(6);
    expect(outline.children.size).toBe(2);
    expect(controller.find(`${feature}:12`)?.label).toBe("Math 1+2");
    expect(controller.find(`${feature}:13`)?.label).toBe("Math 3+4");
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

  it("runs and projects a discovered scenario from an open file without a workspace folder", async () => {
    const scenario = { filePath: fixture.featurePath, line: 4, name: "Passing scenario", kind: "scenario" as const };
    const gateway = testGateway(async () => ({
      identity: EXECUTION_IDENTITY, state: "complete", results: [{
        scenario, outcome: "passed", durationMs: 5, attempts: 1, flaky: false, evidenceRefs: [],
      }], passed: 1, failed: 0, durationMs: 5, output: "",
    }), [{
      id: `${fixture.featurePath}:4`, name: "Passing scenario",
      source: { path: fixture.featurePath, line: 4 },
      suites: [{ name: "Sample feature", source: { path: fixture.featurePath, line: 2 } }], tags: [],
    }]);
    const { provider, controller } = buildProvider(
      async () => ({ success: true, output: "", error: "", returnCode: 0 }), gateway
    );
    await provider.discoverTests();
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;

    await runItem(controller, controller.find(`${fixture.featurePath}:4`)!);
    expect(controller.runs.at(-1)!.outcome.passed).toContain(`${fixture.featurePath}:4`);
    await runItem(controller, controller.find(fixture.featurePath)!);
    expect(controller.runs.at(-1)!.outcome.passed).toContain(fixture.featurePath);
    expect(gateway.run).toHaveBeenCalledTimes(2);

    provider.applyExternalRunResult(fixture.featurePath, {
      success: true, output: "", duration: 5,
      scenarioResults: { [`${normalizePathKey(fixture.featurePath)}:4`]: "passed" },
    }, { lineNumber: 4 });
    expect(controller.runs.at(-1)!.outcome.passed).toContain(`${fixture.featurePath}:4`);
  });

  it("carries the selected parallel worker count into a scenario run", async () => {
    const gateway = testGateway(async () => ({
      identity: EXECUTION_IDENTITY, state: "complete", results: [], passed: 0, failed: 0, durationMs: 0, output: "",
    }), [{
      id: `${fixture.featurePath}:4`, name: "Passing scenario", source: { path: fixture.featurePath, line: 4 },
      suites: [{ name: "Sample feature", source: { path: fixture.featurePath, line: 1 } }], tags: [],
    }]);
    const { controller } = buildProvider(async () => ({ success: true, output: "", error: "", returnCode: 0 }), gateway, false, [], { workerCount: 3 });
    await controller.resolveHandler?.(undefined);
    const scenario = controller.find(`${fixture.featurePath}:4`);
    expect(scenario).toBeDefined();

    await controller.profile("Run in Parallel")!.runHandler(
      new vscode.TestRunRequest([scenario!]), new vscode.CancellationTokenSource().token
    );

    expect(gateway.prepare).toHaveBeenCalledWith(expect.objectContaining({
      mode: "run", maxWorkers: 3,
      targets: [expect.objectContaining({ kind: "scenario" })],
    }));
    expect(gateway.run).toHaveBeenCalledTimes(1);
  });

  it("does not start a parallel Test Explorer run when its first worker prompt is dismissed", async () => {
    const gateway = testGateway(async () => ({
      identity: EXECUTION_IDENTITY, state: "complete", results: [], passed: 0, failed: 0,
      durationMs: 0, output: "",
    }));
    const picker = vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    const { controller } = buildProvider(
      async () => ({ success: true, output: "", error: "", returnCode: 0 }),
      gateway, false, [], { workspaceState: fakeMemento() }
    );

    try {
      await controller.profile("Run in Parallel")!.runHandler(
        new vscode.TestRunRequest(), new vscode.CancellationTokenSource().token
      );
      expect(picker).toHaveBeenCalledOnce();
      expect(gateway.prepare).not.toHaveBeenCalled();
      expect(gateway.run).not.toHaveBeenCalled();
      expect(controller.runs).toEqual([]);
    } finally {
      picker.mockRestore();
    }
  });

  it("reports an adjusted parallel worker count and runs with that value", async () => {
    const gateway = testGateway(async () => ({
      identity: EXECUTION_IDENTITY, state: "complete", results: [], passed: 0, failed: 0, durationMs: 0, output: "",
    }), [{
      id: `${fixture.featurePath}:4`, name: "Passing scenario", source: { path: fixture.featurePath, line: 4 },
      suites: [{ name: "Sample feature", source: { path: fixture.featurePath, line: 1 } }], tags: [],
    }]);
    const info = vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined);
    try {
      const { controller } = buildProvider(async () => ({ success: true, output: "", error: "", returnCode: 0 }), gateway, false, [], { workerCount: 99 });
      await controller.resolveHandler?.(undefined);
      await controller.profile("Run in Parallel")!.runHandler(
        new vscode.TestRunRequest([controller.find(`${fixture.featurePath}:4`)!]), new vscode.CancellationTokenSource().token
      );

      const prepared = vi.mocked(gateway.prepare).mock.calls[0]?.[0];
      expect(prepared?.maxWorkers).toBeGreaterThanOrEqual(1);
      expect(prepared?.maxWorkers).toBeLessThanOrEqual(16);
      expect(info).toHaveBeenCalledWith(expect.stringContaining(`Using ${prepared?.maxWorkers} workers (auto-adjusted from invalid maxParallelProcesses=99`));
      expect(gateway.run).toHaveBeenCalledTimes(1);
    } finally {
      info.mockRestore();
    }
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

  it("shows the three report outcomes on a whole-feature run and fails the feature when an example fails", async () => {
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      const report = reportJson(fixture, [
        { title: "Passing scenario", line: 6, status: "passed" },
        { title: "Example #1", line: 18, status: "skipped" },
        { title: "Example #2", line: 24, status: "failed" },
      ]);
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {
        fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], report);
      }
      return { success: false, output: "", error: "1 failed, 1 skipped", returnCode: 1 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    await runItem(controller, controller.find(fixture.featurePath)!);

    const run = controller.runs.at(-1)!;
    expect(run.outcome.passed).toContain(`${fixture.featurePath}:4`);
    expect(run.outcome.skipped).toContain(`${fixture.featurePath}:12`);
    expect(run.outcome.failed.map((failure) => failure.id)).toEqual(
      expect.arrayContaining([`${fixture.featurePath}:13`, fixture.featurePath])
    );
  });

  it("shows a failed scenario's assertion and step stack in the Test Results failure", async () => {
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      const report = JSON.parse(reportJson(fixture, [
        { title: "Passing scenario", line: 6, status: "failed" },
      ])) as {
        suites: Array<{ specs: Array<{ tests: Array<{
          results: Array<{ error?: { message: string; stack: string } }>;
        }> }> }>;
      };
      report.suites[0]!.specs[0]!.tests[0]!.results[0]!.error = {
        message: "Expected checkout total to be 42",
        stack: "Error: expected 42\n    at checkout.steps.ts:9:3",
      };
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {
        fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], JSON.stringify(report));
      }
      return { success: false, output: "", error: "1 test failed", returnCode: 1 };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    await runItem(controller, controller.find(`${fixture.featurePath}:4`)!);

    const failure = controller.runs.at(-1)!.outcome.failed.find(
      ({ id }) => id === `${fixture.featurePath}:4`
    );
    expect(failure?.message).toContain("Expected checkout total to be 42");
    expect(failure?.message).toContain("at checkout.steps.ts:9:3");
  });

  it.each([
    ["workspace-relative source line", (_featurePath: string) => `features/test.feature:4`],
    ["workspace-relative scenario title", (_featurePath: string) => `features/test.feature::Passing scenario`],
    ["absolute scenario title", (featurePath: string) => `${featurePath}::Passing scenario`],
    ["reporter title suffix", (_featurePath: string) => `chromium::Passing scenario`],
  ])("maps an external report by %s without passing sibling scenarios", async (_format, keyFor) => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    provider.applyExternalRunResult(fixture.featurePath, {
      success: true,
      output: "",
      duration: 1,
      scenarioResults: { [normalizePathKey(keyFor(fixture.featurePath))]: "passed" },
    });

    const run = controller.runs.at(-1)!;
    expect(run.outcome.passed).toContain(`${fixture.featurePath}:4`);
    expect(run.outcome.passed).not.toContain(`${fixture.featurePath}:12`);
    expect(run.outcome.passed).not.toContain(`${fixture.featurePath}:13`);
  });

  it("matches outline example results by substituted title when the reporter has no source line", async () => {
    fs.writeFileSync(fixture.featurePath, [
      "Feature: Cart", "", "Scenario Outline: Add <item>", "  Given <item>",
      "  Examples:", "    | item |", "    | apple |", "    | pear |",
    ].join("\n"));
    const cases: ExecutionDefinition[] = [
      { id: `${fixture.featurePath}:7`, name: "Example #1", source: { path: fixture.featurePath, line: 7 },
        suites: [{ name: "Cart", source: { path: fixture.featurePath, line: 1 } }], tags: [],
        parameterized: { groupName: "Add <item>", groupLine: 3, blockLine: 5, substitutedName: "Add apple" } },
      { id: `${fixture.featurePath}:8`, name: "Example #2", source: { path: fixture.featurePath, line: 8 },
        suites: [{ name: "Cart", source: { path: fixture.featurePath, line: 1 } }], tags: [],
        parameterized: { groupName: "Add <item>", groupLine: 3, blockLine: 5, substitutedName: "Add pear" } },
    ];
    const gateway = testGateway(async () => ({
      identity: EXECUTION_IDENTITY, state: "complete", results: [], passed: 0, failed: 0, durationMs: 1, output: "",
    }), cases);
    const { provider, controller } = buildProvider(
      async () => ({ success: true, output: "", error: "", returnCode: 0 }), gateway
    );
    await provider.discoverTests();

    provider.applyExternalRunResult(fixture.featurePath, {
      success: false,
      output: "",
      error: "One example failed",
      duration: 1,
      scenarioResults: {
        [`${normalizePathKey(fixture.featurePath)}::Add apple`]: "passed",
        "features/test.feature::Add pear": "failed",
      },
    });

    const run = controller.runs.at(-1)!.outcome;
    expect(run.passed).toContain(`${fixture.featurePath}:7`);
    expect(run.failed.map(({ id }) => id)).toContain(`${fixture.featurePath}:8`);
    expect(run.failed.map(({ id }) => id)).toContain(fixture.featurePath);
  });

  it("does not transfer an external result to another discovered feature", async () => {
    const other = path.join(fixture.root, "features", "account.feature");
    fs.writeFileSync(other, "Feature: Account\nScenario: Reset password\n  Given a user\n");
    const cases: ExecutionDefinition[] = [
      { id: `${fixture.featurePath}:4`, name: "Passing scenario", source: { path: fixture.featurePath, line: 4 },
        suites: [{ name: "Sample feature", source: { path: fixture.featurePath, line: 2 } }], tags: [] },
      { id: `${other}:2`, name: "Reset password", source: { path: other, line: 2 },
        suites: [{ name: "Account", source: { path: other, line: 1 } }], tags: [] },
    ];
    const gateway = testGateway(async () => ({
      identity: EXECUTION_IDENTITY, state: "complete", results: [], passed: 0, failed: 0, durationMs: 1, output: "",
    }), cases);
    const { provider, controller } = buildProvider(
      async () => ({ success: true, output: "", error: "", returnCode: 0 }), gateway
    );
    await provider.discoverTests();

    provider.applyExternalRunResult(fixture.featurePath, {
      success: true, output: "", duration: 1,
      scenarioResults: { [`${normalizePathKey(fixture.featurePath)}:4`]: "passed" },
    });

    expect(controller.runs.at(-1)!.outcome.passed).toContain(`${fixture.featurePath}:4`);
    expect(controller.runs.at(-1)!.outcome.passed).not.toContain(`${other}:2`);
    expect(provider.getItemStatus(`${other}:2`)).toBeUndefined();
  });

  it("projects mixed external results onto scenarios and rolls a failed outline up to the feature", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    provider.applyExternalRunResult(fixture.featurePath, {
      success: false,
      output: "",
      error: "One example failed",
      duration: 1,
      scenarioResults: {
        [`${normalizePathKey(fixture.featurePath)}:4`]: "passed",
        [`${normalizePathKey(fixture.featurePath)}:12`]: "skipped",
        [`${normalizePathKey(fixture.featurePath)}:13`]: "failed",
      },
      scenarioDetails: [{
        featurePath: fixture.featurePath,
        lineNumber: 13,
        scenarioName: "Example #2",
        status: "failed",
        durationMs: 5,
        attempts: 1,
        flaky: false,
        errorMessage: "One example failed",
      }],
    });

    const run = controller.runs.at(-1)!;
    expect(run.outcome.passed).toContain(`${fixture.featurePath}:4`);
    expect(run.outcome.skipped).toContain(`${fixture.featurePath}:12`);
    expect(run.outcome.failed.map(({ id }) => id)).toEqual(expect.arrayContaining([
      `${fixture.featurePath}:13`, fixture.featurePath,
    ]));
    expect(run.outcome.failed.find(({ id }) => id === `${fixture.featurePath}:13`)?.message)
      .toContain("One example failed");
  });

  it("fails only the targeted external scenario when generation leaves no parseable report", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    provider.applyExternalRunResult(fixture.featurePath, {
      success: false,
      output: "bddgen stopped before tests started",
      error: "bddgen failed: checkout.steps.ts could not compile",
      duration: 1,
      scenarioResults: {},
    }, { lineNumber: 4 });

    const run = controller.runs.at(-1)!;
    expect(run.outcome.failed.map(({ id }) => id)).toEqual([`${fixture.featurePath}:4`]);
    expect(run.outcome.failed[0]?.message).toContain("checkout.steps.ts could not compile");
    expect(run.outcome.passed).not.toContain(`${fixture.featurePath}:12`);
    expect(run.outcome.skipped).not.toContain(`${fixture.featurePath}:13`);
  });

  it("marks a whole external feature failed when an early runner failure leaves no case results", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    provider.applyExternalRunResult(fixture.featurePath, {
      success: false,
      output: "",
      error: "",
      duration: 1,
      scenarioResults: {},
    });

    const failures = controller.runs.at(-1)!.outcome.failed;
    expect(failures.map(({ id }) => id)).toEqual(expect.arrayContaining([
      fixture.featurePath,
      `${fixture.featurePath}:4`,
      `${fixture.featurePath}:12`,
      `${fixture.featurePath}:13`,
    ]));
    expect(failures.find(({ id }) => id === `${fixture.featurePath}:4`)?.message)
      .toContain("Test failed: see the Test Results output panel.");
  });

  it("clears a previously passing feature when every externally reported case is skipped", async () => {
    const shell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();
    const everyCase = [4, 12, 13].map((line) => `${fixture.featurePath}:${line}`);
    provider.applyExternalRunResult(fixture.featurePath, {
      success: true,
      output: "",
      duration: 1,
      scenarioResults: Object.fromEntries(everyCase.map((id) => [normalizePathKey(id), "passed"])),
    });
    expect(provider.getItemStatus(fixture.featurePath)).toBe("passed");

    provider.applyExternalRunResult(fixture.featurePath, {
      success: true,
      output: "",
      duration: 1,
      scenarioResults: Object.fromEntries(everyCase.map((id) => [normalizePathKey(id), "skipped"])),
    });

    const run = controller.runs.at(-1)!;
    expect(run.outcome.skipped).toEqual(expect.arrayContaining([fixture.featurePath, ...everyCase]));
    expect(run.outcome.failed).toEqual([]);
    expect(provider.getItemStatus(fixture.featurePath)).toBeUndefined();
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

  it("points a skipped run with missing-step output at the scaffold command", async () => {
    const shell: ShellRunner = async (_cmd, _dir, env) => {
      const out = reportJson(fixture, [{ title: "Passing scenario", line: 6, status: "skipped" }]);
      if (env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"]) {fs.writeFileSync(env["PLAYWRIGHT_JSON_OUTPUT_NAME"], out);}
      return {
        success: true,
        output: "Missing step definitions:\nGiven('a completed checkout', () => {});\nUse snippets above to create missing steps.",
        error: "", returnCode: 0,
      };
    };
    const { provider, controller } = buildProvider(shell);
    await provider.discoverTests();

    await runItem(controller, controller.find(`${fixture.featurePath}:4`)!);

    const output = controller.runs.at(-1)!.outcome.output.join("");
    expect(output).toContain("Missing step definitions:");
    expect(output).toContain('Tip: run "Specwright: Generate Missing Step Definitions" to scaffold these.');
    expect(controller.runs.at(-1)!.outcome.skipped).toContain(`${fixture.featurePath}:4`);
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

  it("releases a debug cancellation that cannot confirm session termination", async () => {
    // No terminate event is ever fired, so cancellation cannot claim the debug process stopped.
    const warn = vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
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
    expect(run.outcome.failed).toEqual([]);
    // The second item never launches a session of its own.
    expect(vscode.debug.__startDebuggingCalls).toHaveLength(1);
    expect(vscode.debug.__stopDebuggingCalls).toEqual([root]);
    expect(artifactStore.latest()?.state).toBe("cancelled");
    expect(fs.existsSync(path.dirname(reportPath))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(
      /termination was not confirmed.*Test execution was not blocked/s
    ));

    const next = new vscode.CancellationTokenSource();
    const admitted = Promise.resolve(debugProfile.runHandler(new vscode.TestRunRequest([first]), next.token));
    await vi.waitFor(() => {
      expect(vscode.debug.__startDebuggingCalls).toHaveLength(2);
    });
    next.cancel();
    await admitted;
    warn.mockRestore();
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
