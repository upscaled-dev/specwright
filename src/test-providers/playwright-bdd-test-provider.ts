import * as vscode from "vscode";
import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { FeatureParser } from "../parsers/feature-parser";
import { groupScenariosByOutline } from "./group-scenarios";
import { OUTLINE_ID_SEPARATOR } from "./constants";
import { TestExecutor, RunOutputResult, ShellRunner } from "../core/test-executor";
import {
  Scenario,
  TestOrganizationStrategy,
  TestGroup,
  PlaywrightBddExtensionContext,
  TestExecutionOptions,
} from "../types";
import { Logger } from "../utils/logger";
import { ExtensionConfig } from "../core/extension-config";
import { TestDiscoveryManager } from "../core/test-discovery-manager";
import { TestOrganizationManager } from "../core/test-organization";
import {
  PlaywrightJsonParser,
  ScenarioStatus,
  ScenarioResult,
} from "../utils/playwright-json-parser";
import { CommandBuilder } from "../core/command-builder";
import {
  ensureWorkerCount,
  resolveWorkerCountDetailed,
  WorkerCountResolution,
} from "../commands/prompt-worker-count";

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/**
 * Pull bddgen's "Missing step definitions" block (count + suggested snippets) out of captured
 * run output. bddgen runs before the Playwright runner, so the block is bounded by its own
 * trailing marker, or — defensively — by the first Playwright reporter line that follows.
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

// Disambiguates report paths when several items are debugged within the same millisecond.
let debugReportSequence = 0;

/** workspaceState key under which the chosen organization strategy type is persisted. */
const ORG_STRATEGY_STATE_KEY = "playwrightBddRunner.organizationStrategyType";

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
  private readonly featureTitleByPath = new Map<string, string>();
  private readonly runProfiles: vscode.TestRunProfile[] = [];
  private isTestRunning = false;
  private fileWatcher: vscode.FileSystemWatcher | undefined;
  private watchedPattern: string | undefined;
  private configChangeSubscription: vscode.Disposable | undefined;
  private discoveryQueue: Promise<void> = Promise.resolve();

  public static create(
    testController: vscode.TestController,
    context?: PlaywrightBddExtensionContext,
    workspaceState?: vscode.Memento
  ): PlaywrightBddTestProvider {
    return new PlaywrightBddTestProvider(testController, context, workspaceState);
  }

  constructor(
    testController: vscode.TestController,
    context?: PlaywrightBddExtensionContext,
    workspaceState?: vscode.Memento
  ) {
    this.testController = testController;
    this.discoveredTests = new Map();
    this.context = context ?? this.createDefaultContext();
    this.workspaceState = workspaceState;
    // Restore the persisted organization strategy before the first discovery so the tree is
    // built with the user's last choice instead of the default.
    this.restorePersistedStrategy();
    this.setupTestController();

    this.discoverTests().catch(() => { /* surfaced via logger */ });
    this.setupFileWatcher();
  }

  private createDefaultContext(): PlaywrightBddExtensionContext {
    const logger = Logger.create();
    const config = ExtensionConfig.create();
    return {
      logger,
      config,
      testExecutor: TestExecutor.create(),
      discoveryManager: TestDiscoveryManager.create(logger, config),
      organizationManager: TestOrganizationManager.create(logger),
      featureParser: FeatureParser.create(logger),
      playwrightJsonParser: PlaywrightJsonParser.create(logger),
      commandBuilder: CommandBuilder.create(config, logger),
    };
  }

  // --- VS Code wiring ---------------------------------------------------------

  private setupTestController(): void {
    this.testController.resolveHandler = async (test) => {
      if (!test) {await this.discoverTests();}
    };

    // Without a refreshHandler the Test Explorer's refresh button and the
    // `testing.refreshTests` command are no-ops, leaving the tree stale.
    this.testController.refreshHandler = async () => {
      await this.refreshTests();
    };

    const runProfile = this.testController.createRunProfile(
      "Run",
      vscode.TestRunProfileKind.Run,
      async (request) => { await this.runTests(request); }
    );
    runProfile.configureHandler = () => { /* no-op */ };
    this.runProfiles.push(runProfile);

    const debugProfile = this.testController.createRunProfile(
      "Debug",
      vscode.TestRunProfileKind.Debug,
      async (request) => { await this.debugTests(request); }
    );
    debugProfile.configureHandler = () => { /* no-op */ };
    this.runProfiles.push(debugProfile);

    const parallelProfile = this.testController.createRunProfile(
      "Run in Parallel",
      vscode.TestRunProfileKind.Run,
      async (request) => {
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

        this.context.testExecutor.setForceParallel(true, resolution.workers);
        try {
          await this.runTests(request);
        } finally {
          this.context.testExecutor.setForceParallel(false);
        }
      },
      false
    );
    parallelProfile.configureHandler = () => { /* no-op */ };
    this.runProfiles.push(parallelProfile);
  }

  private setupFileWatcher(): void {
    this.createFileWatcher();
    this.configChangeSubscription = this.context.config.addChangeListener(() => {
      if (this.context.config.testFilePattern !== this.watchedPattern) {
        this.createFileWatcher();
      }
    });
  }

  private createFileWatcher(): void {
    this.fileWatcher?.dispose();
    this.watchedPattern = this.context.config.testFilePattern;
    const watcher = vscode.workspace.createFileSystemWatcher(this.watchedPattern);
    watcher.onDidCreate(() => { this.refreshTests().catch(() => { /* logged */ }); });
    watcher.onDidChange(() => { this.refreshTests().catch(() => { /* logged */ }); });
    watcher.onDidDelete(() => { this.refreshTests().catch(() => { /* logged */ }); });
    this.fileWatcher = watcher;
  }

  // --- Discovery --------------------------------------------------------------

  public discoverTests(): Promise<void> {
    // Serialized: a watcher burst must not interleave one pass's items.replace([]) with
    // another's items.add(). performDiscovery never rejects, so the chain can't be poisoned.
    this.discoveryQueue = this.discoveryQueue.then(() => this.performDiscovery());
    return this.discoveryQueue;
  }

  private async performDiscovery(): Promise<void> {
    try {
      const pattern = this.context.config.testFilePattern;
      if (!pattern || pattern.trim() === "") {
        throw new Error("Test file pattern is empty or invalid");
      }

      const filePaths = await this.context.discoveryManager.discoverTestFiles({
        pattern,
        forceRefresh: true,
      });

      this.testController.items.replace([]);
      this.discoveredTests.clear();
      this.scenarioByTestId.clear();
      this.featureTitleByPath.clear();

      const allScenarios: Array<{ scenario: Scenario; file: vscode.Uri }> = [];
      for (const filePath of filePaths) {
        try {
          const file = vscode.Uri.file(filePath);
          const content = await vscode.workspace.fs.readFile(file);
          const text = new TextDecoder().decode(content);
          const parsed = this.context.featureParser.parseFeatureContent(text);
          if (!parsed) {continue;}
          // Remember each file's Feature title so runs (in any organization strategy) can grep
          // by the exact title rather than the filename.
          this.featureTitleByPath.set(file.fsPath, parsed.feature);
          for (const scenario of parsed.scenarios) {
            scenario.filePath = file.fsPath;
            allScenarios.push({ scenario, file });
          }
        } catch (fileError) {
          this.context.logger.error(
            `Failed to process feature file ${filePath}: ${errMsg(fileError)}`
          );
        }
      }

      const organized = this.context.organizationManager.organizeTests(
        allScenarios.map((s) => s.scenario)
      );
      const strategy = this.context.organizationManager.getStrategy().strategyType;

      if (strategy === "FeatureBasedOrganization") {
        await this.buildHierarchicalFeatureView(allScenarios);
      } else {
        this.buildGroupItems(organized);
      }
    } catch (error) {
      const msg = errMsg(error);
      this.context.logger.error(`Failed to discover tests: ${msg}`);
      vscode.window.showErrorMessage(`Test discovery failed: ${msg}`);
    }
  }

  public async refreshTests(): Promise<void> {
    try {
      await this.context.discoveryManager.refreshCache();
      await this.discoverTests();
    } catch (error) {
      const msg = errMsg(error);
      this.context.logger.error(`Failed to refresh tests: ${msg}`);
      vscode.window.showErrorMessage(`Failed to refresh tests: ${msg}`);
    }
  }

  public async forceRefreshTestExplorer(): Promise<void> {
    this.testController.items.replace([]);
    this.discoveredTests.clear();
    this.scenarioByTestId.clear();
    if (this.testController.resolveHandler) {
      await this.testController.resolveHandler(undefined);
    }
    try { await vscode.commands.executeCommand("testing.refreshTests"); } catch { /* ignore */ }
  }

  public async addFeatureFileToTestController(file: vscode.Uri): Promise<void> {
    try {
      if (!file?.fsPath) {throw new Error("Invalid file URI provided");}
      const content = await vscode.workspace.fs.readFile(file);
      const text = new TextDecoder().decode(content);
      const parsed = this.context.featureParser.parseFeatureContent(text);
      if (!parsed) {
        this.context.logger.warn(`Unparsable feature file: ${file.fsPath}`);
        return;
      }

      this.featureTitleByPath.set(file.fsPath, parsed.feature);
      for (const scenario of parsed.scenarios) {
        scenario.filePath = file.fsPath;
      }

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
          featureItem.children.add(this.createScenarioTestItem(file, first));
        } else if (first.isScenarioOutline) {
          // The outline line keeps the id unique when two outlines share a title in one file.
          const outlineItem = this.createOutlineTestItem(
            file,
            first.outlineName,
            scenarios,
            `${file.fsPath}${OUTLINE_ID_SEPARATOR}${first.outlineLineNumber}:${first.outlineName}`
          );
          featureItem.children.add(outlineItem);
        }
      }

      this.testController.items.add(featureItem);
      this.discoveredTests.set(file.fsPath, featureItem);
    } catch (error) {
      this.context.logger.error(
        `Failed to add feature file to test controller: ${errMsg(error)}`,
        { filePath: file.fsPath }
      );
    }
  }

  private createOutlineTestItem(
    file: vscode.Uri,
    outlineName: string,
    examples: Scenario[],
    testId: string
  ): vscode.TestItem {
    const item = this.testController.createTestItem(testId, `Scenario Outline: ${outlineName}`, file);
    item.canResolveChildren = false;
    item.description = `${examples.length} example(s)`;
    const first = examples[0];
    const outlineLine = first?.isScenarioOutline ? first.outlineLineNumber : undefined;
    if (outlineLine && outlineLine > 0) {
      item.range = new vscode.Range(outlineLine - 1, 0, outlineLine - 1, 0);
    }
    if (first) {this.scenarioByTestId.set(testId, first);}
    for (const example of examples) {
      item.children.add(this.createScenarioTestItem(file, example));
    }
    return item;
  }

  private createScenarioTestItem(file: vscode.Uri, scenario: Scenario): vscode.TestItem {
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
    this.scenarioByTestId.set(id, scenario);
    return item;
  }

  // Group ids come prefixed from the organization strategies (`tag:` / `group:`), which is what
  // runSingleTopLevelItem dispatches on — an unprefixed id would make the node silently unrunnable.
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

  private async buildHierarchicalFeatureView(
    scenarios: Array<{ scenario: Scenario; file: vscode.Uri }>
  ): Promise<void> {
    const uniqueFiles = new Set<string>();
    for (const { file } of scenarios) {uniqueFiles.add(file.fsPath);}
    for (const filePath of uniqueFiles) {
      await this.addFeatureFileToTestController(vscode.Uri.file(filePath));
    }
  }

  // --- Execution --------------------------------------------------------------

  private async runTests(request: vscode.TestRunRequest): Promise<void> {
    if (this.isTestRunning) {
      vscode.window.showWarningMessage("A test run is already in progress.");
      return;
    }
    this.isTestRunning = true;
    const run = this.testController.createTestRun(request);

    try {
      for (const test of this.requestedItems(request)) {
        run.started(test);
        await this.runSingleTopLevelItem(test, run);
      }
    } catch (error) {
      const msg = errMsg(error);
      this.context.logger.error(`Error running tests: ${msg}`);
    } finally {
      run.end();
      this.isTestRunning = false;
    }
  }

  /**
   * VS Code passes `include === undefined` to mean "run everything" and `exclude` to carve items
   * out. Expand the request into the maximal non-excluded subtrees: an excluded descendant splits
   * its ancestor into individually-run children instead of running the whole ancestor.
   */
  private requestedItems(request: vscode.TestRunRequest): vscode.TestItem[] {
    const roots: vscode.TestItem[] = [];
    if (request.include) {
      roots.push(...request.include);
    } else {
      this.testController.items.forEach((item) => roots.push(item));
    }
    const excluded = new Set<vscode.TestItem>(request.exclude ?? []);
    if (excluded.size === 0) {return roots;}

    const expanded: vscode.TestItem[] = [];
    const visit = (item: vscode.TestItem): void => {
      if (excluded.has(item)) {return;}
      if (this.hasExcludedDescendant(item, excluded)) {
        item.children.forEach(visit);
      } else {
        expanded.push(item);
      }
    };
    for (const root of roots) {visit(root);}
    return expanded;
  }

  private hasExcludedDescendant(item: vscode.TestItem, excluded: Set<vscode.TestItem>): boolean {
    let found = false;
    item.children.forEach((child) => {
      if (!found && (excluded.has(child) || this.hasExcludedDescendant(child, excluded))) {
        found = true;
      }
    });
    return found;
  }

  private async runSingleTopLevelItem(test: vscode.TestItem, run: vscode.TestRun): Promise<void> {
    try {
      if (test.uri) {
        const isFeatureFile = this.isFeatureFileTest(test.id);
        const isOutline = test.id.includes(OUTLINE_ID_SEPARATOR);

        if (isFeatureFile) {
          const result = await this.context.testExecutor.runFeatureFileWithOutput({
            filePath: test.uri.fsPath,
            featureName: this.featureTitleByPath.get(test.uri.fsPath) ?? test.label,
          });
          this.appendRunOutput(run, result, test, test.uri.fsPath);
          this.applyResultsToChildren(test, run, result, test.uri.fsPath);
        } else if (isOutline) {
          const scenario = this.scenarioByTestId.get(test.id);
          // On a lookup miss the name is unknown — omit it rather than pass "", which downstream
          // turned into a --grep that matched the entire suite.
          const outlineName = scenario?.isScenarioOutline ? scenario.outlineName : undefined;
          const options: TestExecutionOptions = {
            filePath: test.uri.fsPath,
            ...(outlineName ? { outlineName } : {}),
          };
          const result = await this.context.testExecutor.runScenarioWithOutput(options);
          this.appendRunOutput(run, result, test, test.uri.fsPath);
          this.applyResultsToChildren(test, run, result, test.uri.fsPath);
        } else {
          const lineNumber = this.lineFromId(test.id);
          const scenario = this.scenarioByTestId.get(test.id);
          const outlineName = scenario?.isScenarioOutline ? scenario.outlineName : undefined;
          const options: TestExecutionOptions = {
            filePath: test.uri.fsPath,
            ...(lineNumber ? { lineNumber } : {}),
            scenarioName: test.label,
            ...(outlineName ? { outlineName } : {}),
          };
          const result = await this.context.testExecutor.runScenarioWithOutput(options);
          this.appendRunOutput(run, result, test, test.uri.fsPath);
          this.applyStatusToItem(test, run, result, test.uri.fsPath);
        }
      } else if (test.id.startsWith("group:") || test.id.startsWith("tag:")) {
        await this.runGroupOrTag(test, run);
      }
    } catch (error) {
      const msg = errMsg(error);
      this.context.logger.error(`Test execution failed for ${test.label}: ${msg}`);
      run.failed(test, new vscode.TestMessage(`Test execution failed: ${msg}`));
      this.testStatusCache.set(test.id, "failed");
    }
  }

  private async runGroupOrTag(test: vscode.TestItem, run: vscode.TestRun): Promise<void> {
    if (test.id.startsWith("tag:")) {
      const tag = test.id.slice("tag:".length) || test.label;
      const result = await this.context.testExecutor.runAllTestsWithTagsOutput(tag);
      this.appendRunOutput(run, result, test);
      this.applyResultsToChildren(test, run, result);
      return;
    }

    // File/scenario-type/flat group: run each unique feature file and aggregate.
    const featureFiles = this.collectFeatureFiles(test);
    const aggregated: Record<string, ScenarioStatus> = {};
    const aggregatedDetails: ScenarioResult[] = [];
    let success = true;
    for (const filePath of featureFiles) {
      const featureName = this.featureTitleByPath.get(filePath);
      const result = await this.context.testExecutor.runFeatureFileWithOutput({
        filePath,
        ...(featureName ? { featureName } : {}),
      });
      this.appendRunOutput(run, result, test, filePath);
      if (!result.success) {success = false;}
      if (result.scenarioResults) {Object.assign(aggregated, result.scenarioResults);}
      if (result.scenarioDetails) {aggregatedDetails.push(...result.scenarioDetails);}
    }
    this.applyResultsToChildren(test, run, {
      success,
      output: "",
      duration: 1,
      scenarioResults: aggregated,
      scenarioDetails: aggregatedDetails,
    });
  }

  private collectFeatureFiles(test: vscode.TestItem): Set<string> {
    const files = new Set<string>();
    const walk = (item: vscode.TestItem): void => {
      if (item.uri) {files.add(item.uri.fsPath);}
      item.children.forEach((child) => walk(child));
    };
    walk(test);
    return files;
  }

  /**
   * Write a legible run summary into the Test Explorer's "Test Results" output panel. When the
   * JSON report parsed into per-scenario results we render those (status icons, durations, error
   * text); otherwise we fall back to the raw stdout/stderr. VS Code's terminal renderer requires
   * CRLF line endings.
   */
  private appendRunOutput(
    run: vscode.TestRun,
    result: RunOutputResult,
    test: vscode.TestItem,
    targetFeaturePath?: string
  ): void {
    if (typeof run.appendOutput !== "function") {return;}

    const parts = [
      this.outOfScopeWarning(result, targetFeaturePath) + this.formatRunOutput(result, targetFeaturePath),
      this.missingStepsSection(result),
    ].filter((s) => s.trim() !== "");
    const text = parts.join("\n\n");
    if (text === "") {return;}
    run.appendOutput(text.replace(/\r?\n/g, "\r\n"), undefined, test);
  }

  /**
   * Re-surface bddgen's "Missing step definitions" block (with the suggested step snippets) from
   * the captured output. With `missingSteps: "skip-scenario"` the run still exits 0, so this
   * guidance only lives in stdout/stderr — and the formatted summary alone would otherwise drop
   * it. Bounded by bddgen's own trailing marker so we don't pull in the Playwright reporter lines
   * that follow.
   */
  private missingStepsSection(result: RunOutputResult): string {
    const combined = [result.output, result.error]
      .filter((s): s is string => typeof s === "string")
      .join("\n");
    const block = extractMissingStepsBlock(combined);
    if (block === "") {return "";}
    return `${block}\n\nTip: run "Playwright-BDD: Generate Missing Step Definitions" to scaffold these.`;
  }

  /**
   * Flag a feature that the run couldn't attribute any results to: either it's outside
   * playwright-bdd's `features` glob (so bddgen never generates it — Playwright then reports "no
   * tests found") or the run matched a different feature. We require a positive signal (other
   * features produced results, or Playwright explicitly found no tests) so a genuine build/parse
   * failure — which leaves no results for a different reason — isn't mislabelled as out-of-scope.
   */
  private outOfScopeWarning(result: RunOutputResult, targetFeaturePath?: string): string {
    if (!targetFeaturePath) {return "";}
    const details = result.scenarioDetails ?? [];
    if (details.some((d) => d.featurePath === targetFeaturePath)) {return "";}

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

  private formatRunOutput(result: RunOutputResult, targetFeaturePath?: string): string {
    let details = result.scenarioDetails ?? [];
    // When a single feature/scenario was targeted, scope the summary to that file. A name-based
    // `--grep` can over-match a different feature whose title shares this one's title prefix; the
    // status mapping already ignores those, so narrow the summary too (only when at least one
    // result belongs to the target — otherwise keep all, which aids diagnosing a mis-targeted run).
    if (targetFeaturePath && details.length > 0) {
      const scoped = details.filter((d) => d.featurePath === targetFeaturePath);
      if (scoped.length > 0) {details = scoped;}
    }
    if (details.length > 0) {
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      return this.context.playwrightJsonParser.formatResults(details, workspaceRoot);
    }
    // No parsed scenarios (e.g. a pre-run hook or bddgen failure): show the raw output so the
    // user still sees why the run produced nothing.
    return [result.output, result.error]
      .filter((s): s is string => typeof s === "string" && s.trim() !== "")
      .join("\n");
  }

  private applyResultsToChildren(
    parent: vscode.TestItem,
    run: vscode.TestRun,
    result: RunOutputResult,
    fallbackFeaturePath?: string
  ): void {
    const results = result.scenarioResults ?? {};
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    let anyFailed = false;
    let anyPassed = false;

    const walk = (item: vscode.TestItem): void => {
      if (item.children.size === 0) {
        const status = this.resolveStatusForItem(item, results, fallbackFeaturePath, workspaceRoot);
        if (status === "passed") {
          run.passed(item);
          this.testStatusCache.set(item.id, "passed");
          anyPassed = true;
        } else if (status === "failed") {
          run.failed(item, this.failureMessage(item, result.scenarioDetails, "Test failed"));
          this.testStatusCache.set(item.id, "failed");
          anyFailed = true;
        } else {
          run.skipped(item);
        }
        return;
      }
      run.started(item);
      item.children.forEach((child) => walk(child));
    };

    parent.children.forEach((child) => walk(child));

    if (anyFailed) {
      run.failed(parent, new vscode.TestMessage("One or more scenarios failed"));
      this.testStatusCache.set(parent.id, "failed");
    } else if (anyPassed) {
      run.passed(parent);
      this.testStatusCache.set(parent.id, "passed");
    } else {
      run.skipped(parent);
    }
  }

  private applyStatusToItem(
    item: vscode.TestItem,
    run: vscode.TestRun,
    result: RunOutputResult,
    featurePath: string
  ): void {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const status = this.resolveStatusForItem(item, result.scenarioResults ?? {}, featurePath, workspaceRoot);

    if (status === "passed" || (!status && result.success)) {
      run.passed(item);
      this.testStatusCache.set(item.id, "passed");
    } else if (status === "failed" || (!status && !result.success)) {
      const fallback = result.error?.trim() ? result.error : "Test failed — see the Test Results output panel.";
      run.failed(item, this.failureMessage(item, result.scenarioDetails, fallback));
      this.testStatusCache.set(item.id, "failed");
    } else {
      run.skipped(item);
    }
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
    const detail = this.findDetailForItem(item, details);
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
    details: ScenarioResult[] | undefined
  ): ScenarioResult | undefined {
    if (!details || details.length === 0) {return undefined;}
    const line = this.lineFromId(item.id);
    return (
      details.find((d) => line !== undefined && d.lineNumber === line) ??
      details.find((d) => d.scenarioName === item.label)
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
   * blanket-marks its siblings). File-owned parents — the feature node and outline nodes — are
   * rolled up from their children. This replaces the old command-side logic that marked an item
   * and all its descendants with one status derived solely from the process exit code.
   */
  public applyExternalRunResult(
    filePath: string,
    result: RunOutputResult,
    target?: { lineNumber?: number }
  ): void {
    const results = result.scenarioResults ?? {};
    const run = this.testController.createTestRun(new vscode.TestRunRequest());
    try {
      if (Object.keys(results).length === 0) {
        // The report had no parseable scenarios (e.g. bddgen/compile failure before any test
        // ran). Fall back to a blanket status on the targeted item so the icon isn't left stale.
        this.applyBlanketStatus(filePath, run, result, target?.lineNumber);
        return;
      }
      const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      this.testController.items.forEach((item) =>
        this.applyMappedStatus(item, run, result, results, filePath, workspaceRoot)
      );
    } finally {
      run.end();
    }
  }

  /** Recursively apply mapped statuses to a subtree; returns the rolled-up status of file items. */
  private applyMappedStatus(
    item: vscode.TestItem,
    run: vscode.TestRun,
    result: RunOutputResult,
    results: Record<string, ScenarioStatus>,
    filePath: string,
    workspaceRoot: string
  ): ScenarioStatus | undefined {
    if (item.children.size === 0) {
      if (item.uri?.fsPath !== filePath) {return undefined;}
      const status = this.resolveStatusForItem(item, results, filePath, workspaceRoot);
      if (status === "passed") {
        run.passed(item);
        this.testStatusCache.set(item.id, "passed");
      } else if (status === "failed") {
        run.failed(item, this.failureMessage(item, result.scenarioDetails, "Test failed"));
        this.testStatusCache.set(item.id, "failed");
      } else if (status === "skipped") {
        run.skipped(item);
      }
      return status;
    }

    let anyFailed = false;
    let anyPassed = false;
    let anySkipped = false;
    item.children.forEach((child) => {
      const childStatus = this.applyMappedStatus(child, run, result, results, filePath, workspaceRoot);
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
    return "skipped";
  }

  /** Blanket pass/fail for the targeted item when no per-scenario results could be parsed. */
  private applyBlanketStatus(
    filePath: string,
    run: vscode.TestRun,
    result: RunOutputResult,
    lineNumber?: number
  ): void {
    const mark = (item: vscode.TestItem): void => {
      if (result.success) {
        run.passed(item);
        this.testStatusCache.set(item.id, "passed");
      } else {
        const fallback = result.error?.trim() ? result.error : "Test failed — see the Test Results output panel.";
        run.failed(item, this.failureMessage(item, result.scenarioDetails, fallback));
        this.testStatusCache.set(item.id, "failed");
      }
      item.children.forEach((child) => mark(child));
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
   * Returns undefined if no key matches — the caller decides whether to mark skipped.
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

    if (featurePath && line) {
      const absKey = `${featurePath}:${line}`;
      if (results[absKey]) {return results[absKey];}
      const relKey = `${path.relative(workspaceRoot, featurePath)}:${line}`;
      if (results[relKey]) {return results[relKey];}
    }

    if (featurePath && name) {
      const relKey = `${path.relative(workspaceRoot, featurePath)}::${name}`;
      if (results[relKey]) {return results[relKey];}
      const absKey = `${featurePath}::${name}`;
      if (results[absKey]) {return results[absKey];}
    }

    // Last resort: any key whose suffix matches the scenario name. Useful when playwright-bdd
    // tags scenarios with their feature title rather than their source location.
    if (name) {
      for (const [key, status] of Object.entries(results)) {
        if (key.endsWith(`::${name}`)) {return status;}
      }
    }
    return undefined;
  }

  private async debugTests(request: vscode.TestRunRequest): Promise<void> {
    if (this.isTestRunning) {
      vscode.window.showWarningMessage("A test run is already in progress.");
      return;
    }
    this.isTestRunning = true;
    // The testing service considers a Debug-kind request done once the handler resolves and its
    // TestRun ends; returning at session start made VS Code tear down the run before the
    // debuggee attached, so feature-file breakpoints never bound from the Test Explorer.
    const run = this.testController.createTestRun(request);
    try {
      for (const test of this.requestedItems(request)) {
        try {
          if (test.uri) {
            const isFeatureFile = this.isFeatureFileTest(test.id);
            const scenarioName = isFeatureFile ? undefined : test.label;
            const line = this.lineFromId(test.id);
            const scenario = this.scenarioByTestId.get(test.id);
            const outlineName = scenario?.isScenarioOutline ? scenario.outlineName : undefined;
            // The debugged command runs in a terminal (no stdout capture), so the only way to
            // learn the outcome is Playwright's file-based JSON report.
            debugReportSequence += 1;
            const jsonReportPath = path.join(
              os.tmpdir(),
              `playwright-bdd-debug-report-${process.pid}-${Date.now()}-${debugReportSequence}.json`
            );
            run.started(test);
            try {
              await this.context.testExecutor.debugScenario({
                filePath: test.uri.fsPath,
                ...(line ? { lineNumber: line } : {}),
                ...(scenarioName ? { scenarioName } : {}),
                ...(outlineName ? { outlineName } : {}),
                debug: true,
                waitForSessionEnd: true,
                jsonReportPath,
              });
              this.applyDebugReportStatus(test, run, jsonReportPath);
            } finally {
              try { fs.unlinkSync(jsonReportPath); } catch { /* best effort */ }
            }
          }
        } catch (testError) {
          const msg = errMsg(testError);
          this.context.logger.error(`Failed to debug test ${test.label}: ${msg}`);
          vscode.window.showErrorMessage(`Failed to debug test "${test.label}": ${msg}`);
        }
      }
    } finally {
      run.end();
      this.isTestRunning = false;
    }
  }

  // When the report is missing or unparseable the status is left unset — a stale icon is less
  // wrong than marking a passing debug run skipped/failed.
  private applyDebugReportStatus(
    test: vscode.TestItem,
    run: vscode.TestRun,
    reportPath: string
  ): void {
    if (!fs.existsSync(reportPath)) {
      this.context.logger.debug(
        `No JSON report at ${reportPath} after the debug session; leaving the test status unset`
      );
      return;
    }
    const details = this.context.playwrightJsonParser.parseFromFile(reportPath);
    if (details.length === 0) {
      this.context.logger.debug(
        `Debug JSON report at ${reportPath} contained no scenario results; leaving the test status unset`
      );
      return;
    }
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
    const results = this.context.playwrightJsonParser.toStatusMap(details, workspaceRoot);
    const featurePath = test.uri?.fsPath;

    if (test.children.size > 0) {
      this.applyResultsToChildren(
        test,
        run,
        {
          success: !details.some((d) => d.status === "failed"),
          output: "",
          duration: 1,
          scenarioResults: results,
          scenarioDetails: details,
        },
        featurePath
      );
      return;
    }

    const status = this.resolveStatusForItem(test, results, featurePath, workspaceRoot);
    if (status === "passed") {
      run.passed(test, this.findDetailForItem(test, details)?.durationMs);
      this.testStatusCache.set(test.id, "passed");
    } else if (status === "failed") {
      run.failed(test, this.failureMessage(test, details, "Test failed"));
      this.testStatusCache.set(test.id, "failed");
    } else if (status === "skipped") {
      run.skipped(test);
    }
  }

  // --- Helpers ----------------------------------------------------------------

  private lineFromId(testId: string): number | undefined {
    const match = testId.match(/:(\d+)$/);
    if (!match) {return undefined;}
    const n = parseInt(match[1] ?? "0", 10);
    return n > 0 ? n : undefined;
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
