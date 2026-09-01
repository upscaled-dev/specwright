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
import { RunArtifactStore } from "../../traceability/run-artifact-store";
import type { ScenarioRef } from "../../traceability/scenario-ref";
import type {
  ExecutionGateway,
  ExecutionDefinition,
  ExecutionOptions,
  RunCompletion,
  RunIntent,
} from "../../core/run-contracts";
import { LegacyDirectExecutionGateway } from "../../core/execution-gateway";
import { LegacyExecutionDiscovery } from "../../core/legacy-discovery";
import { LegacyArtifactGateway } from "../../ui/legacy-artifact-gateway";
import { WorkspaceTrust } from "../../core/workspace-trust";
import { FakeTestController, FakeTestItem } from "./helpers/fake-test-controller";
import { parseExecutableCommand } from "../../core/bounded-command-runner";

const FEATURE = [
  "@feature",
  "Feature: Sample feature",
  "",
  "  Scenario: Passing scenario",
  "    Given I am on the test page",
  "",
  "  Scenario Outline: Math",
  "    Given <a> plus <b>",
  "",
  "    Examples:",
  "      | a | b |",
  "      | 1 | 2 |",
  "      | 3 | 4 |",
].join("\n");

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
