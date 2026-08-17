import * as vscode from "vscode";
import * as path from "node:path";
import { missingStepSkipLines } from "../core/generated-test-target";
import { isOutlineExampleRow } from "../parsers/feature-parser";
import { groupScenariosByOutline } from "./group-scenarios";
import { OUTLINE_ID_SEPARATOR } from "./constants";
import type { RunOutputResult, ShellRunner } from "../core/test-executor";
import {
  Scenario,
  TestOrganizationStrategy,
  TestGroup,
  PlaywrightBddExtensionContext,
} from "../types";
import { errMsg } from "../utils/text";
import type { TestDiscoveryManager } from "../core/test-discovery-manager";
import type { TestOrganizationManager } from "../core/test-organization";
import {
  ScenarioStatus,
  ScenarioResult,
  normalizePathKey,
} from "../utils/playwright-json-parser";
import type { CommandBuilder } from "../core/command-builder";
import {
  ensureWorkerCount,
  resolveWorkerCountDetailed,
  WorkerCountResolution,
} from "../commands/prompt-worker-count";
import type { RunProgressSession } from "../core/run-progress";
import {
  beginExternalTestRun,
  LiveTestRunProgress,
} from "./live-test-run-progress";
import {
  requireExecutionAvailable,
  type ExecutionDefinition,
  type RunIntent,
} from "../core/run-contracts";
import {
  requestedTestItems,
  testExplorerRunIntent,
} from "./test-explorer-run-plan";
import { runGatewayTestRequest } from "./gateway-test-run";
import { isUnderExcludedDir, workspaceExcludeFragments } from "../utils/discovery-excludes";
import { TestDiscoveryLifecycle } from "./test-discovery-lifecycle";

/**
 * Pull bddgen's "Missing step definitions" block (count + suggested snippets) out of captured
 * run output. bddgen runs before the Playwright runner, so the block is bounded by its own
 * trailing marker, or, defensively, by the first Playwright reporter line that follows.
 * Returns "" when the output contains no such block.
 */
export function extractMissingStepsBlock(combinedOutput: string): string {
  const lines = combinedOutput.split(/\r?\n/);
  const start = lines.findIndex((l) => l.includes("Missing step definitions:"));
  if (start === -1) {return "";}

  const block: string[] = [];
  for (let i = start; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (i > start && (/^Running \d+ test/.test(line) || /^\s*\d+ (passed|failed|skipped)/.test(line))) {
      break;
    }
    block.push(line);
    if (line.includes("Use snippets above to create missing steps.")) {break;}
  }
  return block.join("\n").trim();
}

/**
 * The glob a user would add to playwright-bdd's `features` config to bring `featurePath` into
 * scope: its own directory (relative to the workspace) made recursive, with POSIX separators.
 */
export function suggestedFeatureGlob(featurePath: string, workspaceRoot?: string): string {
  const dir = path.dirname(featurePath);
  const relDir = workspaceRoot ? path.relative(workspaceRoot, dir) : dir;
  const prefix = relDir ? `${relDir}/` : "";
  return `${prefix}**/*.feature`.split(path.sep).join("/");
}

type RunStatus = "started" | "passed" | "failed";

/** workspaceState key under which the chosen organization strategy type is persisted. */
const ORG_STRATEGY_STATE_KEY = "playwrightBddRunner.organizationStrategyType";

/** Invariants of one applyMappedStatus recursion; skippedLeaves accumulates across the walk. */
interface MappedStatusContext {
  readonly run: vscode.TestRun;
  readonly result: RunOutputResult;
  readonly results: Record<string, ScenarioStatus>;
  readonly filePath: string;
  readonly workspaceRoot: string;
  readonly skippedLeaves: vscode.TestItem[];
  readonly live?: LiveTestRunProgress | undefined;
}

interface FeaturePresentation {
  readonly filePath: string;
  readonly item: vscode.TestItem;
  readonly scenarios: ReadonlyMap<string, Scenario>;
}

// The palette prefixes commands with the "Specwright" category, so tips must name that form.
const GENERATE_STEPS_COMMAND = 'Specwright: Generate Missing Step Definitions';

/**
 * Bridges VS Code's Test Explorer to playwright-bdd.
 *
 * Discovery: parses .feature files with the framework-agnostic FeatureParser, then asks the
 * active TestOrganizationStrategy how to group them in the tree.
 *
 * Execution: runs Playwright with the JSON reporter, gets back a flat list of scenario
 * results keyed by scenario name (and feature path when annotations are present), then walks
 * the active TestRun's items to apply pass/fail. Mapping is name-based by default because
 * Playwright's reporter doesn't include the source .feature line number unless playwright-bdd
 * emits a source annotation we recognize.
 */
export class PlaywrightBddTestProvider {
  private readonly testController: vscode.TestController;
  private readonly discoveredTests: Map<string, vscode.TestItem>;
  private readonly context: PlaywrightBddExtensionContext;
  private readonly workspaceState: vscode.Memento | undefined;
  private testStatusCache: Map<string, RunStatus> = new Map();
  private readonly scenarioByTestId = new Map<string, Scenario>();
  /** Feature file path → its `Feature:` title, used to grep runs precisely in any org strategy. */
  private readonly runProfiles: vscode.TestRunProfile[] = [];
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private watchedPattern: string | undefined;
  private watcherGeneration = 0;
  private configChangeSubscription: vscode.Disposable | undefined;
  private readonly discoveryLifecycle: TestDiscoveryLifecycle;

  public static create(
    testController: vscode.TestController,
    context: PlaywrightBddExtensionContext,
    workspaceState?: vscode.Memento,
    canUseLocalFeaturePresentation: () => boolean = () => false
  ): PlaywrightBddTestProvider {
    return new PlaywrightBddTestProvider(
      testController,
      context,
      workspaceState,
      canUseLocalFeaturePresentation
    );
  }

  constructor(
    testController: vscode.TestController,
    context: PlaywrightBddExtensionContext,
    workspaceState?: vscode.Memento,
    private readonly canUseLocalFeaturePresentation: () => boolean = () => false
  ) {
    this.testController = testController;
    this.discoveredTests = new Map();
    this.context = context;
    this.workspaceState = workspaceState;
    this.discoveryLifecycle = new TestDiscoveryLifecycle(() => this.performDiscovery());
    // Restore the persisted organization strategy before the first discovery so the tree is
    // built with the user's last choice instead of the default.
    this.restorePersistedStrategy();
    this.setupTestController();
    this.setupFileWatcher();
  }

  // --- VS Code wiring ---------------------------------------------------------

  private setupTestController(): void {
    this.testController.resolveHandler = async (test) => {
      if (!test) {await this.ensureDiscovered();}
    };

    // Without a refreshHandler the Test Explorer's refresh button and the
    // `testing.refreshTests` command are no-ops, leaving the tree stale.
    this.testController.refreshHandler = async () => {
      await this.refreshTests();
    };

    const runProfile = this.testController.createRunProfile(
      "Run",
      vscode.TestRunProfileKind.Run,
      async (request, token) => { await this.runTests(request, token); }
    );
    runProfile.configureHandler = () => { /* no-op */ };
    this.runProfiles.push(runProfile);

    const debugProfile = this.testController.createRunProfile(
      "Debug",
      vscode.TestRunProfileKind.Debug,
      async (request, token) => { await this.debugTests(request, token); }
    );
    debugProfile.configureHandler = () => { /* no-op */ };
    this.runProfiles.push(debugProfile);

    const parallelProfile = this.testController.createRunProfile(
      "Run in Parallel",
      vscode.TestRunProfileKind.Run,
      async (request, token) => {
        const resolution: WorkerCountResolution | undefined = this.workspaceState
          ? await ensureWorkerCount(this.workspaceState, this.context.config, this.context.logger)
          : resolveWorkerCountDetailed(this.context.config, this.context.logger);
        if (resolution === undefined) {return;}

        if (resolution.autoAdjusted) {
          vscode.window
            .showInformationMessage(
              `Using ${resolution.workers} workers (auto-adjusted from invalid maxParallelProcesses=${String(resolution.previousInvalid)}; defaults to CPU cores - 2). Adjust the setting to override.`
            )
            .then(undefined, () => { /* ignore */ });
        }

        await this.runTests(request, token, resolution.workers);
      },
      false
    );
    parallelProfile.configureHandler = () => { /* no-op */ };
    this.runProfiles.push(parallelProfile);
  }

  private setupFileWatcher(): void {
    this.createFileWatcher();
    this.configChangeSubscription = this.context.config.addChangeListener(() => {
      this.handleConfigurationChange().catch((error) => {
        this.context.logger.error(`Failed to update feature watcher: ${errMsg(error)}`);
      });
    });
  }

  private handleConfigurationChange(): Promise<void> {
    if (this.context.config.testFilePattern === this.watchedPattern) {return Promise.resolve();}
    this.discoveryLifecycle.retireExact();
    this.createFileWatcher();
    return this.discoveryLifecycle.invalidate().then(() => undefined);
  }

  private createFileWatcher(): void {
    this.fileWatcher?.dispose();
    this.watchedPattern = this.context.config.testFilePattern;
    const generation = ++this.watcherGeneration;
    const watcher = vscode.workspace.createFileSystemWatcher(this.watchedPattern);
    watcher.onDidCreate((uri) => this.onFeatureFileTouched(generation, uri).catch(() => { /* logged */ }));
    watcher.onDidChange((uri) => this.onFeatureFileTouched(generation, uri).catch(() => { /* logged */ }));
    watcher.onDidDelete((uri) => this.onFeatureFileRemoved(generation, uri).catch(() => { /* logged */ }));
    this.fileWatcher = watcher;
  }

  /** Patch the feature-file presentation only when no grouped project state is involved. */
  private onFeatureFileTouched(generation: number, uri: vscode.Uri): Promise<void> {
    if (generation !== this.watcherGeneration) {return Promise.resolve();}
    this.dropCachedStatusesFor(uri.fsPath);
    if (!this.canUpdateFeaturePresentationLocally(uri)) {
      return this.discoveryLifecycle.invalidate().then(() => undefined);
    }
    return this.discoveryLifecycle.runExact(
      normalizePathKey(uri.fsPath),
      () => this.supportsLocalFeaturePresentation(uri),
      () => this.prepareFeaturePresentation(uri),
      (presentation) => {
        if (!presentation) {return;}
        this.removeFeatureFileFromTestController(uri.fsPath);
        this.installFeaturePresentation(presentation);
      }
    );
  }

  private onFeatureFileRemoved(generation: number, uri: vscode.Uri): Promise<void> {
    if (generation !== this.watcherGeneration) {return Promise.resolve();}
    this.dropCachedStatusesFor(uri.fsPath);
    if (!this.canUpdateFeaturePresentationLocally(uri)) {
      return this.discoveryLifecycle.invalidate().then(() => undefined);
    }
    return this.discoveryLifecycle.runExact(
      normalizePathKey(uri.fsPath),
      () => this.supportsLocalFeaturePresentation(uri),
      () => Promise.resolve(undefined),
      () => this.removeFeatureFileFromTestController(uri.fsPath)
    );
  }

  /**
   * Feature-based rows are one file per root, so a local parse can update only that presentation.
   * Grouped strategies and excluded paths continue through the execution gateway, which remains the
   * authority for cross-file and future Core discovery state.
   */
  private canUpdateFeaturePresentationLocally(uri: vscode.Uri): boolean {
    return this.discoveryLifecycle.hasCanonicalPresentation && this.supportsLocalFeaturePresentation(uri);
  }

  private supportsLocalFeaturePresentation(uri: vscode.Uri): boolean {
    return this.context.organizationManager.getStrategy().strategyType === "FeatureBasedOrganization"
      && this.canUseLocalFeaturePresentation()
      && !isUnderExcludedDir(uri.fsPath, workspaceExcludeFragments());
  }

  /**
   * A cached verdict is only as durable as its file: an edit can move, rename, or rewrite the
   * scenario behind a `filePath:line` id, and restoring the old verdict onto whatever now sits
   * at that line would be confidently wrong. Dropping the file's entries before the refresh
   * keeps restoration honest; untouched files keep theirs.
   */
  private dropCachedStatusesFor(fileFsPath: string): void {
    const file = normalizePathKey(fileFsPath);
    // `${file}:` covers scenario ids (`file:line`) and outline ids (`file:outline:...`) alike.
    for (const id of this.testStatusCache.keys()) {
      const key = normalizePathKey(id);
      if (key === file || key.startsWith(`${file}:`)) {
        this.testStatusCache.delete(id);
      }
    }
  }

  // --- Discovery --------------------------------------------------------------

  public discoverTests(): Promise<void> {
    return this.discoveryLifecycle.refresh().then(() => undefined);
  }

  private ensureDiscovered(): Promise<boolean> {
    return this.discoveryLifecycle.ensure();
  }

  public onWorkspaceTrustGranted(): Promise<void> {
    return this.discoveryLifecycle.retryAfterTrustGrant().then(() => undefined);
  }

  private async performDiscovery(): Promise<boolean> {
    const ticket = this.discoveryLifecycle.beginCanonical();
    try {
      await requireExecutionAvailable(this.context.executionGateway);
      const discovery = await this.context.executionGateway.discover({ refresh: true });
      const definitions = discovery.cases;
      const allScenarios = definitions.map((definition) => ({
        scenario: this.scenarioFromDefinition(definition),
        file: vscode.Uri.file(definition.source.path),
      }));

      const organized = this.context.organizationManager.organizeTests(
        allScenarios.map((s) => s.scenario)
      );
      const strategy = this.context.organizationManager.getStrategy().strategyType;

      return await this.discoveryLifecycle.commitCanonical(ticket, () => {
        this.testController.items.replace([]);
        this.discoveredTests.clear();
        this.scenarioByTestId.clear();
        if (strategy === "FeatureBasedOrganization") {
          this.buildHierarchicalFeatureView(allScenarios, definitions);
        } else {
          this.buildGroupItems(organized);
        }
        this.restoreCachedStatuses();
      });
    } catch (error) {
      const msg = errMsg(error);
      this.context.logger.error(`Failed to discover tests: ${msg}`);
      vscode.window.showErrorMessage(`Test discovery failed: ${msg}`);
      return false;
    }
  }

  /**
   * Statuses live on TestItem instances, so every rebuild (a watcher event, an organization
   * strategy switch) forgets them while the cache still knows the verdicts. Leaf ids are
   * `filePath:line` under every strategy, which lets the last known result ride onto the
   * rebuilt tree in one short unpersisted run scoped to exactly the restored items. A verdict
   * stays valid only while its file is untouched (the watcher drops a changed file's entries),
   * and an active run owns its own statuses, so restoration stands down for it. Failure detail
   * died with the old run, so the restored message says to re-run for it; parents need nothing,
   * the Explorer derives their aggregate from descendants.
   */
  private restoreCachedStatuses(): void {
    if (this.testStatusCache.size === 0 || this.context.executionGateway.running) {return;}
    const restorable: Array<{ item: vscode.TestItem; status: "passed" | "failed" }> = [];
    const visit = (item: vscode.TestItem): void => {
      if (item.children.size > 0) {
        item.children.forEach(visit);
        return;
      }
      const status = this.testStatusCache.get(item.id);
      if (status === "passed" || status === "failed") {restorable.push({ item, status });}
    };
    this.testController.items.forEach(visit);
    if (restorable.length === 0) {return;}
    const run = this.testController.createTestRun(
      new vscode.TestRunRequest(restorable.map(({ item }) => item)),
      "Restored results",
      false
    );
    try {
      for (const { item, status } of restorable) {
        if (status === "passed") {run.passed(item);}
        else {
          run.failed(item, new vscode.TestMessage(
            "Failed in the last run before the tree was rebuilt. Re-run for details."
          ));
        }
      }
    } finally {
      run.end();
    }
  }

  private scenarioFromDefinition(definition: ExecutionDefinition): Scenario {
    const line = definition.source.line;
    const common = {
      name: definition.name,
      line,
      lineNumber: line,
      range: new vscode.Range(Math.max(0, line - 1), 0, Math.max(0, line - 1), 0),
      steps: [],
      tags: [...definition.tags],
      filePath: definition.source.path,
      featureLineNumber: definition.suites[0]?.source?.line,
      ...(definition.suites[1] ? { ruleName: definition.suites[1].name } : {}),
    };
    const parameterized = definition.parameterized;
    if (!parameterized) {return { ...common, isScenarioOutline: false };}
    const outline = {
      ...common,
      isScenarioOutline: true as const,
      outlineLineNumber: parameterized.groupLine,
      outlineName: parameterized.groupName,
    };
    return parameterized.blockLine === undefined
      ? outline
      : {
          ...outline,
          examplesBlockLineNumber: parameterized.blockLine,
          ...(parameterized.blockName ? { examplesBlockName: parameterized.blockName } : {}),
          ...(parameterized.substitutedName ? { substitutedName: parameterized.substitutedName } : {}),
        };
  }

  public async refreshTests(): Promise<void> {
    try {
      await this.discoverTests();
    } catch (error) {
      const msg = errMsg(error);
      this.context.logger.error(`Failed to refresh tests: ${msg}`);
      vscode.window.showErrorMessage(`Failed to refresh tests: ${msg}`);
    }
  }

  public async forceRefreshTestExplorer(): Promise<void> {
    await this.refreshTests();
  }

  private removeFeatureFileFromTestController(fileFsPath: string): void {
    const normalizedFilePath = normalizePathKey(fileFsPath);
    for (const [knownPath, item] of this.discoveredTests) {
      if (normalizePathKey(knownPath) !== normalizedFilePath) {continue;}
      this.testController.items.delete(item.id);
      this.discoveredTests.delete(knownPath);
    }
    for (const [testId, scenario] of this.scenarioByTestId) {
      if (normalizePathKey(scenario.filePath) === normalizedFilePath) {
        this.scenarioByTestId.delete(testId);
      }
    }
  }

  public async addFeatureFileToTestController(file: vscode.Uri): Promise<void> {
    const presentation = await this.prepareFeaturePresentation(file);
    if (presentation) {this.installFeaturePresentation(presentation);}
  }

  private async prepareFeaturePresentation(file: vscode.Uri): Promise<FeaturePresentation | undefined> {
    try {
      if (!file?.fsPath) {throw new Error("Invalid file URI provided");}
      const content = await vscode.workspace.fs.readFile(file);
      const text = new TextDecoder().decode(content);
      const parsed = this.context.featureParser.parseFeatureContent(text);
      if (!parsed) {
        this.context.logger.warn(`Unparsable feature file: ${file.fsPath}`);
        return;
      }

      for (const scenario of parsed.scenarios) {
        scenario.filePath = file.fsPath;
      }

      const scenariosByTestId = new Map<string, Scenario>();
      const featureItem = this.testController.createTestItem(file.fsPath, parsed.feature, file);
      featureItem.canResolveChildren = true;
      if (parsed.featureLineNumber && parsed.featureLineNumber > 0) {
        featureItem.range = new vscode.Range(
          parsed.featureLineNumber - 1, 0, parsed.featureLineNumber - 1, 0
        );
      }

      const groups = groupScenariosByOutline(parsed.scenarios);
      for (const scenarios of groups.values()) {
        const first = scenarios[0];
        if (!first) {continue;}
        if (scenarios.length === 1 && !first.isScenarioOutline) {
          featureItem.children.add(this.createScenarioTestItem(file, first, scenariosByTestId));
        } else if (first.isScenarioOutline) {
          // The outline line keeps the id unique when two outlines share a title in one file.
          const outlineItem = this.createOutlineTestItem(
            file,
            first.outlineName,
            scenarios,
            `${file.fsPath}${OUTLINE_ID_SEPARATOR}${first.outlineLineNumber}:${first.outlineName}`,
            scenariosByTestId
          );
          featureItem.children.add(outlineItem);
        }
      }

      return { filePath: file.fsPath, item: featureItem, scenarios: scenariosByTestId };
    } catch (error) {
      this.context.logger.error(
        `Failed to add feature file to test controller: ${errMsg(error)}`,
        { filePath: file.fsPath }
      );
      return undefined;
    }
  }

  private installFeaturePresentation(presentation: FeaturePresentation): void {
    this.testController.items.add(presentation.item);
    this.discoveredTests.set(presentation.filePath, presentation.item);
    for (const [testId, scenario] of presentation.scenarios) {
      this.scenarioByTestId.set(testId, scenario);
    }
  }

  private createOutlineTestItem(
    file: vscode.Uri,
    outlineName: string,
    examples: Scenario[],
    testId: string,
    scenariosByTestId: Map<string, Scenario> = this.scenarioByTestId
  ): vscode.TestItem {
    const item = this.testController.createTestItem(testId, `Scenario Outline: ${outlineName}`, file);
    item.canResolveChildren = false;
    item.description = `${examples.length} example(s)`;
    const first = examples[0];
    const outlineLine = first?.isScenarioOutline ? first.outlineLineNumber : undefined;
    if (outlineLine && outlineLine > 0) {
      item.range = new vscode.Range(outlineLine - 1, 0, outlineLine - 1, 0);
    }
    if (first) {scenariosByTestId.set(testId, first);}
    for (const example of examples) {
      item.children.add(this.createScenarioTestItem(file, example, scenariosByTestId));
    }
    return item;
  }

  private createScenarioTestItem(
    file: vscode.Uri,
    scenario: Scenario,
    scenariosByTestId: Map<string, Scenario> = this.scenarioByTestId
  ): vscode.TestItem {
    const id = `${scenario.filePath}:${scenario.lineNumber}`;
    const item = this.testController.createTestItem(id, scenario.name, file);
    if (scenario.lineNumber > 0) {
      item.range = new vscode.Range(scenario.lineNumber - 1, 0, scenario.lineNumber - 1, 0);
    }
    item.canResolveChildren = false;
    item.description = `Line ${scenario.lineNumber}`;
    if (scenario.tags && scenario.tags.length > 0) {
      item.description += ` | Tags: ${scenario.tags.join(", ")}`;
    }
    scenariosByTestId.set(id, scenario);
    return item;
  }

  // Group ids come prefixed from the organization strategies (`tag:` / `group:`), which is what
  // runSingleTopLevelItem dispatches on; an unprefixed id would make the node silently unrunnable.
  private buildGroupItems(groups: TestGroup[]): void {
    for (const group of groups) {
      if (group.scenarios.length === 0) {continue;}
      const groupItem = this.testController.createTestItem(group.id, group.label, undefined);
      groupItem.canResolveChildren = true;
      groupItem.description = group.description;
      for (const scenario of group.scenarios) {
        groupItem.children.add(
          this.createScenarioTestItem(vscode.Uri.file(scenario.filePath), scenario)
        );
      }
      this.testController.items.add(groupItem);
    }
  }

  private buildHierarchicalFeatureView(
    scenarios: Array<{ scenario: Scenario; file: vscode.Uri }>,
    definitions: readonly ExecutionDefinition[]
  ): void {
    const byFile = new Map<string, Scenario[]>();
    for (const { scenario } of scenarios) {
      const existing = byFile.get(scenario.filePath);
      if (existing) {existing.push(scenario);} else {byFile.set(scenario.filePath, [scenario]);}
    }
    for (const [filePath, fileScenarios] of byFile) {
      const file = vscode.Uri.file(filePath);
      const definition = definitions.find(({ source }) => source.path === filePath);
      const suite = definition?.suites[0];
      const featureItem = this.testController.createTestItem(filePath, suite?.name ?? path.basename(filePath), file);
      featureItem.canResolveChildren = true;
      if (suite?.source?.line) {
        featureItem.range = new vscode.Range(suite.source.line - 1, 0, suite.source.line - 1, 0);
      }
      for (const group of groupScenariosByOutline(fileScenarios).values()) {
        const first = group[0];
        if (!first) {continue;}
        featureItem.children.add(first.isScenarioOutline
          ? this.createOutlineTestItem(
              file,
              first.outlineName,
              group,
              `${filePath}${OUTLINE_ID_SEPARATOR}${first.outlineLineNumber}:${first.outlineName}`
            )
          : this.createScenarioTestItem(file, first));
      }
      this.testController.items.add(featureItem);
      this.discoveredTests.set(filePath, featureItem);
    }
  }

  // --- Execution --------------------------------------------------------------

  private async runTests(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    maxWorkers?: number
  ): Promise<void> {
    await this.executeGatewayRequest(request, token, "run", maxWorkers);
  }

  private async executeGatewayRequest(
    request: vscode.TestRunRequest,
    token: vscode.CancellationToken,
    mode: RunIntent["mode"],
    maxWorkers?: number
  ): Promise<void> {
    if (!await this.ensureDiscovered()) {return;}
    const roots = requestedTestItems(request, this.testController);
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const intent = testExplorerRunIntent({
      request,
      roots,
      mode,
      scenarioFor: (id) => this.scenarioByTestId.get(id),
      scenariosInFile: (filePath) => this.scenariosInFile(filePath),
      isFeatureFile: (id) => this.isFeatureFileTest(id),
      ...(maxWorkers !== undefined ? { maxWorkers } : {}),
    });
    // Captured output is run-wide, so only a run with one target can read it as that target's own.
    const singleTarget = intent.targets.length === 1;
    await runGatewayTestRequest({
      controller: this.testController,
      request,
      token,
      gateway: this.context.executionGateway,
      intent,
      roots,
      parser: this.context.playwrightJsonParser,
      workingDir: workspaceRoot,
      logger: this.context.logger,
      createLive: (run) => this.createLiveProgress(run, roots),
      start: (root, run) => {
        run.started(root);
        this.markDescendantsStarted(root, run);
      },
      summarize: (run, result, targets) => {
        // One summary per run. Scoping it to a feature only makes sense when the run had exactly
        // one root to scope it to.
        const only = targets.length === 1 ? targets[0] : undefined;
        this.appendRunOutput(run, result, only, only?.uri?.fsPath);
      },
      apply: (root, run, live, result) => {
        if (root.children.size > 0) {
          this.applyResultsToChildren(root, run, result, singleTarget, root.uri?.fsPath, live);
        } else if (root.uri) {
          this.applyStatusToItem(root, run, result, singleTarget, root.uri.fsPath, live);
        }
      },
      cancel: (root, run, live) =>
        this.markSubtreeSkipped(root, run, (item) => live.hasResult(item)),
    });
  }

  private markSubtreeSkipped(
    item: vscode.TestItem,
    run: vscode.TestRun,
    hasResult: (item: vscode.TestItem) => boolean = () => false
  ): void {
    if (!hasResult(item)) {run.skipped(item);}
    item.children.forEach((child) => this.markSubtreeSkipped(child, run, hasResult));
  }

  private createLiveProgress(
    run: vscode.TestRun,
    roots: readonly vscode.TestItem[],
    fallbackTarget?: vscode.TestItem
  ): LiveTestRunProgress {
    return LiveTestRunProgress.create({
      run,
      roots,
      scenarioFor: (id) => {
        const scenario = this.scenarioByTestId.get(id);
        if (!scenario) {return undefined;}
        return {
          source: { filePath: scenario.filePath, lineNumber: scenario.lineNumber },
          name: isOutlineExampleRow(scenario)
            ? scenario.substitutedName ?? scenario.name
            : scenario.name,
        };
      },
      ...(fallbackTarget ? { fallbackTarget } : {}),
      onStatus: (item, status) => {
        if (status === "passed" || status === "failed") {
          this.testStatusCache.set(item.id, status);
        }
      },
    });
  }

  /**
   * Write a legible run summary into the Test Explorer's "Test Results" output panel: the parsed
   * per-scenario results (status icons, durations, error text) plus what the transcript alone would
   * not tell the user. The raw stdout/stderr is not repeated here; the run's transcript reaches this
   * same panel once already (see `projectCompletionOutput`). VS Code's terminal renderer requires
   * CRLF line endings.
   */
  private appendRunOutput(
    run: vscode.TestRun,
    result: RunOutputResult,
    test?: vscode.TestItem,
    targetFeaturePath?: string
  ): void {
    if (typeof run.appendOutput !== "function") {return;}

    const warning = test ? this.outOfScopeWarning(result, test, targetFeaturePath) : "";
    const parts = [
      warning + this.formatRunOutput(result, targetFeaturePath),
      this.missingStepsSection(result),
    ].filter((s) => s.trim() !== "");
    const text = parts.join("\n\n");
    if (text === "") {return;}
    run.appendOutput(text.replace(/\r?\n/g, "\r\n"), undefined, test);
  }

  /**
   * Point at bddgen's "Missing step definitions" block. With `missingSteps: "skip-scenario"` the run
   * still exits 0, so the block and its suggested snippets only live in stdout/stderr; the summary
   * adds the way out of it rather than printing the block the transcript already carries.
   */
  private missingStepsSection(result: RunOutputResult): string {
    const combined = [result.output, result.error]
      .filter((s): s is string => typeof s === "string")
      .join("\n");
    if (extractMissingStepsBlock(combined) === "") {return "";}
    return `Tip: run "${GENERATE_STEPS_COMMAND}" to scaffold these.`;
  }

  /**
   * Flag a feature that the run couldn't attribute any results to: either it's outside
   * playwright-bdd's `features` glob (so bddgen never generates it; Playwright then reports "no
   * tests found") or the run matched a different feature. We require a positive signal (other
   * features produced results, or Playwright explicitly found no tests) so a genuine build/parse
   * failure, which leaves no results for a different reason, isn't mislabelled as out-of-scope.
   */
  private outOfScopeWarning(
    result: RunOutputResult,
    test: vscode.TestItem,
    targetFeaturePath?: string
  ): string {
    if (!targetFeaturePath) {return "";}
    const details = result.scenarioDetails ?? [];
    // Compare through normalizePathKey: targetFeaturePath comes from VS Code (lowercase Windows
    // drive) while d.featurePath is resolved from Playwright's JSON report (uppercase drive). A
    // raw === here misses on Windows and fires this warning even when results were attributed.
    const target = normalizePathKey(targetFeaturePath);
    if (details.some((d) => normalizePathKey(d.featurePath) === target)) {return "";}
    // When the report's source resolution failed, d.featurePath falls back to the generated spec
    // path and can never equal the target, yet statuses still attribute by title, the same way
    // resolveStatusForItem's suffix scan does. Don't warn about results we did attribute.
    const titles = this.subtreeTitles(test);
    if (details.some((d) => titles.has(d.scenarioName))) {return "";}

    const combined = `${result.output ?? ""}\n${result.error ?? ""}`;
    const noTestsFound = /no tests found/i.test(combined);
    if (details.length === 0 && !noTestsFound) {return "";}

    this.context.logger.warn(
      `Run produced no results for ${targetFeaturePath}; it may be outside the configured test scope.`
    );
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const glob = suggestedFeatureGlob(targetFeaturePath, workspaceRoot);

    return (
      `⚠  No results were attributed to ${path.basename(targetFeaturePath)}, so its scenarios are ` +
      "shown as skipped. It is likely outside the playwright-bdd `features` scope (so bddgen " +
      "can't generate it) or the run matched a different feature.\n" +
      "   To include it, add its path to defineBddConfig({ features: [...] }) in your Playwright " +
      `config, e.g.:\n       "${glob}"\n\n`
    );
  }

  /** Every title a report entry for this subtree could carry: item labels plus the substituted
   *  outline titles playwright-bdd generates when an outline title has `<placeholders>`. */
  private subtreeTitles(item: vscode.TestItem): Set<string> {
    const titles = new Set<string>();
    const visit = (i: vscode.TestItem): void => {
      titles.add(i.label);
      const scenario = this.scenarioByTestId.get(i.id);
      if (scenario && isOutlineExampleRow(scenario) && scenario.substitutedName) {
        titles.add(scenario.substitutedName);
      }
      i.children.forEach(visit);
    };
    visit(item);
    return titles;
  }

  private formatRunOutput(result: RunOutputResult, targetFeaturePath?: string): string {
    let details = result.scenarioDetails ?? [];
    // When a single feature/scenario was targeted, scope the summary to that file. A name-based
    // `--grep` can over-match a different feature whose title shares this one's title prefix; the
    // status mapping already ignores those, so narrow the summary too (only when at least one
    // result belongs to the target; otherwise keep all, which aids diagnosing a mis-targeted run).
    if (targetFeaturePath && details.length > 0) {
      // Compare through normalizePathKey: targetFeaturePath comes from VS Code (lowercase Windows
      // drive) while d.featurePath is resolved from the report (uppercase drive), so a raw === here
      // never scopes on Windows (see outOfScopeWarning).
      const target = normalizePathKey(targetFeaturePath);
      const scoped = details.filter((d) => normalizePathKey(d.featurePath) === target);
      if (scoped.length > 0) {details = scoped;}
    }
    if (details.length === 0) {
      // No parsed scenarios (a pre-run hook or bddgen failure): the raw output and the failure line
      // that say why are already in this panel, so there is no summary to add.
      return "";
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    // Prefer the executor's measured wall time; summing per-scenario durations double-counts
    // multi-project/retry entries and overstates elapsed time.
    return this.context.playwrightJsonParser.formatResults(details, workspaceRoot, result.duration);
  }

  /** Mark every descendant of a parent item as started, so a feature/outline run shows all the
   *  scenarios it actually executes as running, not just the clicked parent node. */
  private markDescendantsStarted(parent: vscode.TestItem, run: vscode.TestRun): void {
    parent.children.forEach((child) => {
      run.started(child);
      this.markDescendantsStarted(child, run);
    });
  }

  private applyResultsToChildren(
    parent: vscode.TestItem,
    run: vscode.TestRun,
    result: RunOutputResult,
    singleTarget: boolean,
    fallbackFeaturePath?: string,
    live?: LiveTestRunProgress
  ): void {
    const results = result.scenarioResults ?? {};
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    let anyFailed = false;
    let anyPassed = false;
    const skippedLeaves: vscode.TestItem[] = [];

    const walk = (item: vscode.TestItem): void => {
      if (item.children.size === 0) {
        const status = this.resolveStatusForItem(item, results, fallbackFeaturePath, workspaceRoot) ??
          live?.statusFor(item);
        const detail = this.findDetailForItem(item, result.scenarioDetails, status);
        const durationMs = detail?.durationMs;
        if (status === "passed") {
          if (!live || live.shouldApplyFinal(item, status, detail)) {run.passed(item, durationMs);}
          this.testStatusCache.set(item.id, "passed");
          anyPassed = true;
        } else if (status === "failed") {
          if (!live || live.shouldApplyFinal(item, status, detail)) {
            run.failed(item, this.failureMessage(item, result.scenarioDetails, "Test failed"), durationMs);
          }
          this.testStatusCache.set(item.id, "failed");
          anyFailed = true;
        } else {
          if (!live || live.shouldApplyFinal(item, "skipped", detail)) {run.skipped(item);}
          // A completed run that lands on skipped retires the cached verdict: restoring the
          // older pass/fail would claim a result this run just declined to confirm.
          this.testStatusCache.delete(item.id);
          skippedLeaves.push(item);
        }
        return;
      }
      run.started(item);
      item.children.forEach((child) => walk(child));
    };

    parent.children.forEach((child) => walk(child));
    this.appendSkipReasons(run, skippedLeaves);

    if (anyFailed) {
      run.failed(parent, new vscode.TestMessage("One or more scenarios failed"));
      this.testStatusCache.set(parent.id, "failed");
    } else if (anyPassed) {
      run.passed(parent);
      this.testStatusCache.set(parent.id, "passed");
    } else if (this.failedWithoutEvidence(result, singleTarget)) {
      // No child resolved a status yet the run failed with nothing to show for it: a bddgen/compile
      // error produced no per-scenario results anywhere, so blanket-skipping the subtree would hide
      // the failure entirely. Fail the parent (children stay skipped), but not for the deliberate
      // "no tests found" out-of-scope case, which outOfScopeWarning already explains as skipped.
      const message = result.error?.trim() ? result.error : "Test failed: see the Test Results output panel.";
      run.failed(parent, new vscode.TestMessage(message));
      this.testStatusCache.set(parent.id, "failed");
    } else {
      run.skipped(parent);
      this.testStatusCache.delete(parent.id);
    }
  }

  private applyStatusToItem(
    item: vscode.TestItem,
    run: vscode.TestRun,
    result: RunOutputResult,
    singleTarget: boolean,
    featurePath: string,
    live?: LiveTestRunProgress
  ): void {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const mapped = this.resolveStatusForItem(
      item,
      result.scenarioResults ?? {},
      featurePath,
      workspaceRoot
    );
    const status = mapped ?? live?.statusFor(item) ?? this.statusWithoutEvidence(result, singleTarget);
    const detail = this.findDetailForItem(item, result.scenarioDetails, status);
    const durationMs = detail?.durationMs;

    if (status === "passed") {
      if (!live || live.shouldApplyFinal(item, status, detail)) {run.passed(item, durationMs);}
      this.testStatusCache.set(item.id, "passed");
    } else if (status === "failed") {
      const fallback = result.error?.trim() ? result.error : "Test failed: see the Test Results output panel.";
      if (!live || live.shouldApplyFinal(item, status, detail)) {
        run.failed(item, this.failureMessage(item, result.scenarioDetails, fallback), durationMs);
      }
      this.testStatusCache.set(item.id, "failed");
    } else {
      if (!live || live.shouldApplyFinal(item, status, detail)) {run.skipped(item);}
      this.testStatusCache.delete(item.id);
      this.appendSkipReasons(run, [item]);
    }
  }

  /**
   * A scenario with an undefined step is generated as a skipped test under bddgen's
   * `missingSteps: "skip-scenario"`, so Playwright reports it skipped with no reason attached
   * and the tree shows a bare gray icon. The generated spec marks those entries, so a skip that
   * matches one gets its explanation written to the Test Results output, tied to the item.
   * Deliberate @skip/@fixme skips carry no message; they need no explaining.
   */
  private appendSkipReasons(run: vscode.TestRun, skipped: readonly vscode.TestItem[]): void {
    if (typeof run.appendOutput !== "function") {return;}
    const skipLinesByFile = new Map<string, ReadonlySet<number>>();
    for (const item of skipped) {
      const filePath = item.uri?.fsPath;
      const line = this.lineFromId(item.id);
      if (!filePath || line === undefined) {continue;}
      let skipLines = skipLinesByFile.get(filePath);
      if (skipLines === undefined) {
        skipLines = missingStepSkipLines(
          this.context.testExecutor.workingDirectoryFor(filePath),
          this.context.config.featuresGenDir,
          filePath
        );
        skipLinesByFile.set(filePath, skipLines);
      }
      if (!skipLines.has(line)) {continue;}
      run.appendOutput(
        `"${item.label}" was skipped by bddgen: a step has no matching definition. ` +
          `Tip: run "${GENERATE_STEPS_COMMAND}" to scaffold it.\r\n`,
        undefined,
        item
      );
    }
  }

  // A run that stopped early leaves later targets untouched: their items ran nothing, so their own
  // outcome is unknown. Only a failure that produced no results anywhere is attributable to them.
  private failedWithoutEvidence(result: RunOutputResult, singleTarget: boolean): boolean {
    if (result.success !== false || (result.scenarioDetails?.length ?? 0) > 0) {return false;}
    // "no tests found" excuses an out-of-scope feature, but the output belongs to the whole run: in a
    // multi-target run it may be another target's, and it must not mask this one's failure.
    const outOfScope = singleTarget &&
      /no tests found/i.test(`${result.output ?? ""}\n${result.error ?? ""}`);
    return !outOfScope;
  }

  private statusWithoutEvidence(result: RunOutputResult, singleTarget: boolean): ScenarioStatus {
    if (result.success) {return "passed";}
    return this.failedWithoutEvidence(result, singleTarget) ? "failed" : "skipped";
  }

  /**
   * Build a failure TestMessage carrying the parsed Playwright error (ANSI already stripped) and
   * a source location so VS Code can decorate the failing scenario inline. Falls back to a
   * generic message when no matching scenario result was parsed.
   */
  private failureMessage(
    item: vscode.TestItem,
    details: ScenarioResult[] | undefined,
    fallback: string
  ): vscode.TestMessage {
    const detail = this.findDetailForItem(item, details, "failed");
    const base = detail?.errorMessage?.trim() ? detail.errorMessage : fallback;
    // Append the stack so the failure peek shows clickable frames into the step-definition code.
    const text = detail?.errorStack?.trim() ? `${base}\n\n${detail.errorStack}` : base;
    const message = new vscode.TestMessage(text);

    if (detail?.featurePath && detail.lineNumber) {
      message.location = new vscode.Location(
        vscode.Uri.file(detail.featurePath),
        new vscode.Range(detail.lineNumber - 1, 0, detail.lineNumber - 1, 0)
      );
    } else if (item.uri && item.range) {
      message.location = new vscode.Location(item.uri, item.range);
    }
    return message;
  }

  /** Match a TestItem to its parsed scenario result by source line first, then by name. */
  private findDetailForItem(
    item: vscode.TestItem,
    details: ScenarioResult[] | undefined,
    status?: ScenarioStatus
  ): ScenarioResult | undefined {
    if (!details || details.length === 0) {return undefined;}
    const featurePath = item.uri ? normalizePathKey(item.uri.fsPath) : undefined;
    const inFile = featurePath
      ? details.filter((detail) => normalizePathKey(detail.featurePath) === featurePath)
      : [];
    const candidates = inFile.length > 0 ? inFile : details;
    const withStatus = status ? candidates.filter((detail) => detail.status === status) : [];
    const preferred = withStatus.length > 0 ? withStatus : candidates;
    const line = this.lineFromId(item.id);
    return (
      preferred.find((detail) => line !== undefined && detail.lineNumber === line) ??
      preferred.find((detail) => detail.scenarioName === item.label)
    );
  }

  /**
   * Apply the per-scenario outcome of a run that was triggered OUTSIDE the Test Explorer (a
   * CodeLens "Run", an editor/explorer context-menu action) to the tree, so the gutter and Test
   * Explorer icons match what an in-explorer run would show.
   *
   * The parsed JSON report is the source of truth for which scenarios actually ran: every tree
   * item belonging to `filePath` that appears in the result map gets its real pass/fail/skip
   * status, and items absent from the map are left untouched (so running a single scenario never
   * blanket-marks its siblings). File-owned parents, the feature node and outline nodes, are
   * rolled up from their children. This replaces the old command-side logic that marked an item
   * and all its descendants with one status derived solely from the process exit code.
   */
  public beginExternalRun(
    filePath: string,
    target?: { lineNumber?: number }
  ): RunProgressSession {
    return beginExternalTestRun({
      controller: this.testController,
      filePath,
      lineNumber: target?.lineNumber,
      lineFor: (item) => this.scenarioByTestId.get(item.id)?.lineNumber,
      createProgress: (run, roots, fallback) => this.createLiveProgress(run, roots, fallback),
      applyFinal: (run, result, live) =>
        this.applyExternalRunResultTo(run, filePath, result, target, live),
    });
  }

  public applyExternalRunResult(
    filePath: string,
    result: RunOutputResult,
    target?: { lineNumber?: number }
  ): void {
    const run = this.testController.createTestRun(new vscode.TestRunRequest());
    try {
      this.applyExternalRunResultTo(run, filePath, result, target);
    } finally {
      run.end();
    }
  }

  private applyExternalRunResultTo(
    run: vscode.TestRun,
    filePath: string,
    result: RunOutputResult,
    target?: { lineNumber?: number },
    live?: LiveTestRunProgress
  ): void {
    const results = result.scenarioResults ?? {};
    if (Object.keys(results).length === 0) {
      // The report had no parseable scenarios (e.g. bddgen/compile failure before any test
      // ran). Fall back to a blanket status on the targeted item so the icon isn't left stale.
      this.applyBlanketStatus(filePath, run, result, target?.lineNumber, live);
      return;
    }
    const context: MappedStatusContext = {
      run,
      result,
      results,
      filePath,
      workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd(),
      skippedLeaves: [],
      live,
    };
    this.testController.items.forEach((item) => this.applyMappedStatus(item, context));
    this.appendSkipReasons(run, context.skippedLeaves);
  }

  /** Recursively apply mapped statuses to a subtree; returns the rolled-up status of file items. */
  private applyMappedStatus(
    item: vscode.TestItem,
    context: MappedStatusContext
  ): ScenarioStatus | undefined {
    const { run, result, results, filePath, workspaceRoot, live } = context;
    if (item.children.size === 0) {
      if (item.uri?.fsPath !== filePath) {return undefined;}
      const status = this.resolveStatusForItem(item, results, filePath, workspaceRoot) ??
        live?.statusFor(item);
      const detail = this.findDetailForItem(item, result.scenarioDetails, status);
      const durationMs = detail?.durationMs;
      if (status === "passed") {
        if (!live || live.shouldApplyFinal(item, status, detail)) {run.passed(item, durationMs);}
        this.testStatusCache.set(item.id, "passed");
      } else if (status === "failed") {
        if (!live || live.shouldApplyFinal(item, status, detail)) {
          run.failed(item, this.failureMessage(item, result.scenarioDetails, "Test failed"), durationMs);
        }
        this.testStatusCache.set(item.id, "failed");
      } else if (status === "skipped") {
        if (!live || live.shouldApplyFinal(item, status, detail)) {run.skipped(item);}
        this.testStatusCache.delete(item.id);
        context.skippedLeaves.push(item);
      }
      return status;
    }

    let anyFailed = false;
    let anyPassed = false;
    let anySkipped = false;
    item.children.forEach((child) => {
      const childStatus = this.applyMappedStatus(child, context);
      if (childStatus === "failed") {anyFailed = true;}
      else if (childStatus === "passed") {anyPassed = true;}
      else if (childStatus === "skipped") {anySkipped = true;}
    });

    // Only roll up parents that belong to this feature file (the feature node, outline nodes).
    // Group/tag nodes (no uri) may span files, so leave their aggregate to a full Explorer run.
    if (item.uri?.fsPath !== filePath || !(anyFailed || anyPassed || anySkipped)) {return undefined;}
    if (anyFailed) {
      run.failed(item, new vscode.TestMessage("One or more scenarios failed"));
      this.testStatusCache.set(item.id, "failed");
      return "failed";
    }
    if (anyPassed) {
      run.passed(item);
      this.testStatusCache.set(item.id, "passed");
      return "passed";
    }
    run.skipped(item);
    this.testStatusCache.delete(item.id);
    return "skipped";
  }

  /** Blanket pass/fail for the targeted item when no per-scenario results could be parsed. */
  private applyBlanketStatus(
    filePath: string,
    run: vscode.TestRun,
    result: RunOutputResult,
    lineNumber?: number,
    live?: LiveTestRunProgress
  ): void {
    const parentStatus = (statuses: readonly ScenarioStatus[]): ScenarioStatus => {
      if (!result.success || statuses.includes("failed")) {return "failed";}
      if (statuses.includes("passed")) {return "passed";}
      return "skipped";
    };
    const mark = (item: vscode.TestItem): ScenarioStatus => {
      const childStatuses: ScenarioStatus[] = [];
      item.children.forEach((child) => childStatuses.push(mark(child)));
      const status = item.children.size === 0
        ? live?.statusFor(item) ?? (result.success ? "passed" : "failed")
        : parentStatus(childStatuses);
      const detail = this.findDetailForItem(item, result.scenarioDetails, status);
      const apply = item.children.size > 0 || !live || live.shouldApplyFinal(item, status, detail);
      if (status === "passed") {
        if (apply) {run.passed(item);}
        this.testStatusCache.set(item.id, "passed");
      } else if (status === "failed") {
        const fallback = result.error?.trim() ? result.error : "Test failed: see the Test Results output panel.";
        if (apply) {run.failed(item, this.failureMessage(item, result.scenarioDetails, fallback));}
        this.testStatusCache.set(item.id, "failed");
      } else {
        if (apply) {run.skipped(item);}
        this.testStatusCache.delete(item.id);
      }
      return status;
    };

    const visit = (item: vscode.TestItem): boolean => {
      const isTarget = item.uri?.fsPath === filePath &&
        (lineNumber === undefined || item.range?.start.line === lineNumber - 1);
      if (isTarget) {
        mark(item);
        return true;
      }
      let handled = false;
      item.children.forEach((child) => { handled = visit(child) || handled; });
      return handled;
    };
    this.testController.items.forEach((item) => visit(item));
  }

  /**
   * Look up a status for a TestItem by trying every key shape the parser produces:
   *   - `${featurePath}:${lineNumber}` (when annotations are present)
   *   - `${relFeaturePath}::${scenarioName}` (always)
   *   - `${featurePath}::${scenarioName}` (always)
   * Outline example rows get the same name-key attempts with their substituted title too:
   * playwright-bdd substitutes the row's values into the generated test title when the outline
   * title carries `<placeholders>`, so the report never uses the tree's synthetic example label.
   * Returns undefined if no key matches; the caller decides whether to mark skipped.
   */
  private resolveStatusForItem(
    item: vscode.TestItem,
    results: Record<string, ScenarioStatus>,
    fallbackFeaturePath: string | undefined,
    workspaceRoot: string
  ): ScenarioStatus | undefined {
    const featurePath = item.uri?.fsPath ?? fallbackFeaturePath;
    const line = this.lineFromId(item.id);
    const name = item.label;
    const scenario = this.scenarioByTestId.get(item.id);
    const substitutedName =
      scenario && isOutlineExampleRow(scenario) ? scenario.substitutedName : undefined;

    // Status-map keys are forward-slash normalized (see toStatusMap); fsPaths on Windows are not.
    if (featurePath && line) {
      const absKey = `${normalizePathKey(featurePath)}:${line}`;
      if (results[absKey]) {return results[absKey];}
      const relKey = `${normalizePathKey(path.relative(workspaceRoot, featurePath))}:${line}`;
      if (results[relKey]) {return results[relKey];}
    }

    if (featurePath && name) {
      const relKey = `${normalizePathKey(path.relative(workspaceRoot, featurePath))}::${name}`;
      if (results[relKey]) {return results[relKey];}
      const absKey = `${normalizePathKey(featurePath)}::${name}`;
      if (results[absKey]) {return results[absKey];}
    }

    if (featurePath && substitutedName) {
      const relKey = `${normalizePathKey(path.relative(workspaceRoot, featurePath))}::${substitutedName}`;
      if (results[relKey]) {return results[relKey];}
      const absKey = `${normalizePathKey(featurePath)}::${substitutedName}`;
      if (results[absKey]) {return results[absKey];}
    }

    // Last resort: any key whose suffix matches the scenario name. Useful when playwright-bdd
    // tags scenarios with their feature title rather than their source location.
    if (name) {
      for (const [key, status] of Object.entries(results)) {
        if (key.endsWith(`::${name}`)) {return status;}
      }
    }
    // Same scan with the substituted title; the only match possible when source resolution
    // failed AND the outline title had placeholders (the user-reported skipped-outline case).
    if (substitutedName) {
      for (const [key, status] of Object.entries(results)) {
        if (key.endsWith(`::${substitutedName}`)) {return status;}
      }
    }
    return undefined;
  }

  private async debugTests(request: vscode.TestRunRequest, token: vscode.CancellationToken): Promise<void> {
    await this.executeGatewayRequest(request, token, "debug");
  }

  // --- Helpers ----------------------------------------------------------------

  private lineFromId(testId: string): number | undefined {
    const match = testId.match(/:(\d+)$/);
    if (!match) {return undefined;}
    const n = parseInt(match[1] ?? "0", 10);
    return n > 0 ? n : undefined;
  }

  /** Every discovered scenario of one feature, however the tree happens to group them. */
  private scenariosInFile(filePath: string): Scenario[] {
    const file = normalizePathKey(filePath);
    const seen = new Set<Scenario>();
    for (const scenario of this.scenarioByTestId.values()) {
      if (normalizePathKey(scenario.filePath) === file) {seen.add(scenario);}
    }
    return [...seen];
  }

  private isFeatureFileTest(testId: string): boolean {
    if (!testId.includes(":")) {return true;}
    if (testId.includes(OUTLINE_ID_SEPARATOR) || testId.startsWith("group:") || testId.startsWith("tag:")) {
      return false;
    }
    return !/:(\d+)$/.test(testId);
  }

  // --- Public surface used by CommandManager ----------------------------------

  public get organizationManager(): TestOrganizationManager {
    return this.context.organizationManager;
  }

  public get discoveryManager(): TestDiscoveryManager {
    return this.context.discoveryManager;
  }

  public getDiscoveredTests(): Map<string, vscode.TestItem> {
    return this.discoveredTests;
  }

  public get testIdToScenarioMap(): ReadonlyMap<string, Scenario> {
    return this.scenarioByTestId;
  }

  public get registeredRunProfiles(): readonly vscode.TestRunProfile[] {
    return this.runProfiles;
  }

  public get commandBuilder(): CommandBuilder {
    return this.context.commandBuilder;
  }

  /** Last applied status for a test item id. Exposed for integration tests. */
  public getItemStatus(id: string): RunStatus | undefined {
    return this.testStatusCache.get(id);
  }

  /**
   * Integration-test seam: swap the shell runner on the shared executor (e.g. to return a canned
   * report) and restore it. Lets the real run→status path be exercised in a VS Code host without
   * launching a browser.
   */
  public overrideShellRunner(runner: ShellRunner): void {
    this.context.testExecutor.setShellRunner(runner);
  }

  public restoreShellRunner(): void {
    this.context.testExecutor.resetShellRunner();
  }

  public setOrganizationStrategy(strategy: TestOrganizationStrategy): void {
    try {
      this.context.organizationManager.setStrategy(strategy);
      this.persistOrganizationStrategy(strategy.strategyType);
    } catch (error) {
      this.context.logger.error(`Failed to set organization strategy: ${errMsg(error)}`);
    }
  }

  /** Persist the chosen strategy so it survives window reloads (per-workspace). */
  public persistOrganizationStrategy(strategyType: string): void {
    this.workspaceState
      ?.update(ORG_STRATEGY_STATE_KEY, strategyType)
      .then(undefined, (error) =>
        this.context.logger.error(`Failed to persist organization strategy: ${errMsg(error)}`)
      );
  }

  /** Re-apply the last persisted strategy on startup, if any. */
  private restorePersistedStrategy(): void {
    try {
      const saved = this.workspaceState?.get<string>(ORG_STRATEGY_STATE_KEY);
      if (!saved) {return;}
      const match = this.context.organizationManager
        .getAvailableStrategies()
        .find((s) => s.strategy.strategyType === saved);
      if (match) {this.context.organizationManager.setStrategy(match.strategy);}
    } catch (error) {
      this.context.logger.error(`Failed to restore organization strategy: ${errMsg(error)}`);
    }
  }

  public getOrganizationStrategy(): TestOrganizationStrategy {
    return this.context.organizationManager.getStrategy();
  }

  public getAvailableOrganizationStrategies(): ReturnType<
    typeof this.context.organizationManager.getAvailableStrategies
  > {
    return this.context.organizationManager.getAvailableStrategies();
  }

  public dispose(): void {
    try {
      this.discoveryLifecycle.dispose();
      this.watcherGeneration += 1;
      this.fileWatcher?.dispose();
      this.fileWatcher = undefined;
      this.configChangeSubscription?.dispose();
      this.configChangeSubscription = undefined;
      this.discoveredTests.clear();
      this.testController.dispose();
    } catch (error) {
      this.context.logger.error("Failed to dispose test provider", { error });
    }
  }
}
