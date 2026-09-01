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
import { OUTLINE_ID_SEPARATOR } from "../../test-providers/constants";
import { TestExecutor, ShellRunner } from "../../core/test-executor";
import { CommandBuilder } from "../../core/command-builder";
import { PlaywrightJsonParser } from "../../utils/playwright-json-parser";
import { FeatureParser } from "../../parsers/feature-parser";
import { TestOrganizationManager } from "../../core/test-organization";
import { ExtensionConfig } from "../../core/extension-config";
import { Logger } from "../../utils/logger";
import { PlaywrightBddExtensionContext } from "../../types";
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


});
