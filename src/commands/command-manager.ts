import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { Logger } from "../utils/logger";
import { CommandArguments, CommandHandler, ParsedFeature, PlaywrightBddExtensionContext, TestExecutionOptions } from "../types";
import { RunOutputResult } from "../core/test-executor";
import { GenerateStepsCommand } from "./generate-steps";
import { StepResolver, UnmatchedStep } from "../providers/step-resolver";
import { StepDefinitionProvider } from "../providers/step-definition-provider";
import { StepUsageIndex } from "../providers/step-usage-index";
import { StepDefinitionNode, UnmatchedFileNode, UnmatchedStepNode } from "../providers/steps-tree-data-provider";
import { runInsertStep } from "./insert-step";
import { exportScenariosCatalog, exportStepsCatalog } from "./export-catalogs";
import { XrayConnectionCommands } from "../xray/xray-connection-commands";
import { XrayCredentialStore } from "../xray/xray-credential-store";
import type { XrayProbe } from "../xray/xray-connection-test";
import {
  authorScenarioTest,
  AuthorScenarioTestUi,
  buildTestTag,
  linkScenarioPicks,
  scenarioGherkinSlice,
} from "../traceability/link-scenario";
import { applyTagInsert, applyTagRemove, TagWrite } from "../traceability/tag-edit";
import { LinkedRow, runLinkPickerFlow } from "../traceability/link-picker-flow";
import { BoardDropResolution, buildBoardViewModel, buildExecutionRows, resolveBoardDrop, resolveBoardUnlink } from "../traceability/board-data";
import { BoardPanel, BoardPanelDeps } from "../traceability/board-panel";
import { knownProjectKeys, NO_PROJECT_SCOPE } from "../traceability/project-scope";
import { linkedTestsForScenario, ScenarioRef } from "../traceability/traceability-model";
import { runTraceabilitySync } from "../traceability/traceability-sync";
import {
  BatchSelection,
  KeyGrammar,
  NewTestSpec,
  PreflightDecision,
  PreflightItem,
  PreflightState,
  PublishOutcome,
  PublishRequest,
  RunArtifact,
  SyncScope,
  TraceabilityAdapter,
} from "../traceability/contracts";
import { BatchInvocation, resolveBatchSelection } from "../traceability/batch-selection";
import { PreflightChoice, runPreflightFlow } from "../traceability/preflight-flow";
import { isPublishable, publishableResults } from "../traceability/publish-core";
import { AttachmentSuggestion, PublishAttachmentsModel, runPublishFlow } from "../traceability/publish-flow";
import { PendingAttachmentsResult, PublishDialogDelegate } from "../traceability/publish-dialog-panel";
import { PublishLedger } from "../traceability/publish-ledger";
import { makeFeatureStepResolver } from "../xray/feature-step-resolver";
import { XrayImportError } from "../xray/execution-importers";
import { fetchJiraAttachmentMeta, uploadJiraAttachments } from "../xray/jira-attachments";
import { buildAttachmentsModel } from "../xray/publish-attachment-support";
import { JiraAccessError, JiraProject, searchJiraProjects } from "../xray/jira-project-search";
import { normalizeSiteUrl } from "../xray/xray-adapter";
import type { TraceabilitySubsystem } from "../traceability/traceability-subsystem";

// VS Code refusing an edit or a save is silent, so every tag-write caller says the same thing about it.
const REJECTED_WRITE = "the feature file edit was not applied";

// Carries its own toast text out of the create flow: the remote test exists, so the generic "could not
// create" wording would be false and would invite a duplicate-creating retry.
class TagWriteRejected extends Error {}

const PREFLIGHT_STATE_LABEL: Record<PreflightState, string> = {
  "ready": "ready",
  "unmapped": "no @TEST_ tag",
  "invalid-key": "broken test tag",
  "duplicate-mapping": "duplicate mapping",
  "incompatible-test-type": "not a Gherkin test",
  "automation-binding-required": "automation binding required",
  "not-in-target-plan": "not in the target plan",
};

interface OrganizationStrategy {
  strategyType: string;
  getDescription(): string;
}
interface OrganizationManagerLike {
  getAvailableStrategies(): Array<{ name: string; description: string; strategy: OrganizationStrategy }>;
  getStrategy(): OrganizationStrategy;
  setStrategy(strategy: OrganizationStrategy): void;
}
interface DiscoveryManagerLike {
  clearCache(): void;
}
interface TestProviderLike {
  organizationManager?: OrganizationManagerLike;
  discoveryManager?: DiscoveryManagerLike;
  discoverTests?: () => Promise<void>;
  forceRefreshTestExplorer?: () => Promise<void>;
  persistOrganizationStrategy?: (strategyType: string) => void;
  applyExternalRunResult?: (
    filePath: string,
    result: RunOutputResult,
    target?: { lineNumber?: number }
  ) => void;
}

interface UsageIndexHost {
  getUsageIndex(): StepUsageIndex;
}

export interface CommandOptions {
  command: string;
  title: string;
  category?: string;
  when?: string;
  handler: CommandHandler;
}

const STRATEGY_TYPE_BY_VALUE: Record<string, string> = {
  tag: "TagBasedOrganization",
  file: "FileBasedOrganization",
  scenarioType: "ScenarioTypeOrganization",
  flat: "FlatOrganization",
  feature: "FeatureBasedOrganization",
};

const CATEGORY = "Specwright";
const NO_PUBLISHABLE_RUNS_MESSAGE = "No local runs to publish yet. Run a batch first.";

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

function plural(count: number, word: string, many = `${word}s`): string {
  return count === 1 ? word : many;
}

// The clear-run-history toast, naming only what was actually removed.
function clearedHistoryMessage(runs: number, entries: number): string {
  const parts: string[] = [];
  if (runs > 0) {parts.push(`${runs} local ${plural(runs, "run")}`);}
  if (entries > 0) {parts.push(`${entries} ledger ${plural(entries, "entry", "entries")}`);}
  return parts.length === 0 ? "Local run history is already empty." : `Cleared ${parts.join(" and ")}.`;
}

export class CommandManager {
  private readonly commands = new Map<string, vscode.Disposable>();
  private readonly context: PlaywrightBddExtensionContext;
  private testProvider: unknown;
  private readonly parsedFeatureCache = new Map<string, { mtimeMs: number; parsed: ParsedFeature }>();
  private generateStepsCommand: GenerateStepsCommand | undefined;
  private generateStepsResolver: StepResolver | undefined;
  private stepDefinitionProvider: StepDefinitionProvider | undefined;
  private stepDefinitionResolver: StepResolver | undefined;
  private stepDefinitionConfigListener: vscode.Disposable | undefined;
  private usageIndexHost: UsageIndexHost | undefined;
  private credentialStore: XrayCredentialStore | undefined;
  private xrayProbe: XrayProbe | undefined;
  private xrayConnectionCommands: XrayConnectionCommands | undefined;
  private traceabilitySubsystem: TraceabilitySubsystem | undefined;
  private publishLedger: PublishLedger | undefined;
  private syncInFlight: Promise<void> | undefined;
  // The board's snapshot-change source when no subsystem is wired (unit rigs); it never fires.
  private readonly boardChange = new vscode.EventEmitter<void>();

  public static create(context: PlaywrightBddExtensionContext): CommandManager {
    return new CommandManager(context);
  }

  private constructor(context: PlaywrightBddExtensionContext) {
    this.context = context;
  }

  private get logger(): Logger {
    return this.context.logger;
  }

  public setTestProvider(testProvider: unknown): void {
    this.testProvider = testProvider;
  }

  public setUsageIndexHost(host: UsageIndexHost): void {
    this.usageIndexHost = host;
  }

  public setCredentialStore(store: XrayCredentialStore): void {
    this.credentialStore = store;
  }

  // The single-flighted probe built in activation and shared with the adapter factory's `verify`, so
  // the connection commands and the subsystem refresh coalesce onto one in-flight handshake.
  public setXrayProbe(probe: XrayProbe): void {
    this.xrayProbe = probe;
  }

  public setTraceabilitySubsystem(subsystem: TraceabilitySubsystem): void {
    this.traceabilitySubsystem = subsystem;
  }

  public setPublishLedger(ledger: PublishLedger): void {
    this.publishLedger = ledger;
  }

  /**
   * Reflect the outcome of a run triggered outside the Test Explorer (CodeLens, context menu)
   * onto the tree. Delegates to the provider so the exact same per-scenario JSON-report mapping
   * the Test Explorer uses is applied — keeping the gutter/Explorer icons consistent regardless
   * of where the run was launched. No-ops when no provider is wired (e.g. in unit tests).
   */
  private applyRunStatus(filePath: string, result: RunOutputResult, lineNumber?: number): void {
    const provider = this.testProvider as TestProviderLike | undefined;
    provider?.applyExternalRunResult?.(
      filePath,
      result,
      lineNumber !== undefined ? { lineNumber } : undefined
    );
  }

  public registerCommands(context: vscode.ExtensionContext): void {
    try {
      this.clearCommands();

      const commands: CommandOptions[] = [
        { command: "playwrightBddRunner.runScenario", title: "Run Scenario", category: CATEGORY, handler: this.runScenario.bind(this) },
        { command: "playwrightBddRunner.runFeatureFile", title: "Run Feature File", category: CATEGORY, handler: this.runFeature.bind(this) },
        { command: "playwrightBddRunner.runAllTests", title: "Run All Tests", category: CATEGORY, handler: this.runAllTests.bind(this) },
        { command: "playwrightBddRunner.debugScenario", title: "Debug Scenario", category: CATEGORY, handler: this.debugScenario.bind(this) },
        { command: "playwrightBddRunner.refreshTests", title: "Refresh Tests", category: CATEGORY, handler: this.refreshTests.bind(this) },
        { command: "playwrightBddRunner.showOutput", title: "Show Test Output", category: CATEGORY, handler: this.showOutput.bind(this) },
        { command: "playwrightBddRunner.validateConfiguration", title: "Validate Configuration", category: CATEGORY, handler: this.validateConfiguration.bind(this) },
        { command: "playwrightBddRunner.discoverTests", title: "Discover Tests", category: CATEGORY, handler: this.discoverTests.bind(this) },
        { command: "playwrightBddRunner.runFeatureFileWithTags", title: "Run Feature File with Tags", category: CATEGORY, handler: this.runFeatureWithTags.bind(this) },
        { command: "playwrightBddRunner.runScenarioWithTags", title: "Run Scenario with Tags", category: CATEGORY, handler: this.runScenarioWithTags.bind(this) },
        { command: "playwrightBddRunner.runAllTestsParallel", title: "Run All Tests in Parallel", category: CATEGORY, handler: this.runAllTestsParallel.bind(this) },
        { command: "playwrightBddRunner.runScenarioWithContext", title: "Run Scenario", category: CATEGORY, handler: this.runScenarioWithContext.bind(this) },
        { command: "playwrightBddRunner.debugScenarioWithContext", title: "Debug Scenario", category: CATEGORY, handler: this.debugScenarioWithContext.bind(this) },
        { command: "playwrightBddRunner.runFeatureFileWithContext", title: "Run Feature File", category: CATEGORY, handler: this.runFeatureFileWithContext.bind(this) },
        { command: "playwrightBddRunner.setOrganizationStrategy", title: "Set Organization Strategy", category: CATEGORY, handler: this.setOrganizationStrategy.bind(this) },
        { command: "playwrightBddRunner.setTagBasedOrganization", title: "Organize by Tags", category: CATEGORY, handler: () => this.setStrategyByValue("tag") },
        { command: "playwrightBddRunner.setFileBasedOrganization", title: "Organize by File", category: CATEGORY, handler: () => this.setStrategyByValue("file") },
        { command: "playwrightBddRunner.setScenarioTypeOrganization", title: "Organize by Scenario Type", category: CATEGORY, handler: () => this.setStrategyByValue("scenarioType") },
        { command: "playwrightBddRunner.setFlatOrganization", title: "Flat Organization", category: CATEGORY, handler: () => this.setStrategyByValue("flat") },
        { command: "playwrightBddRunner.setFeatureBasedOrganization", title: "Feature-Based (Hierarchical) Organization", category: CATEGORY, handler: () => this.setStrategyByValue("feature") },
        { command: "playwrightBddRunner.debugOrganization", title: "Debug Organization Strategy", category: CATEGORY, handler: this.debugOrganization.bind(this) },
        { command: "playwrightBddRunner.generateStepDefinitions", title: "Generate Missing Step Definitions", category: CATEGORY, handler: this.generateStepDefinitions.bind(this) },
        { command: "playwrightBddRunner.generateStepDefinitionForStep", title: "Create Step Definition For Step", category: CATEGORY, handler: this.generateStepDefinitionForStep.bind(this) },
        { command: "playwrightBddRunner.goToStepDefinition", title: "Go to Step Definition", category: CATEGORY, handler: this.goToStepDefinition.bind(this) },
        { command: "playwrightBddRunner.refreshStepsPanel", title: "Refresh Steps Panel", category: CATEGORY, handler: this.refreshStepsPanel.bind(this) },
        { command: "playwrightBddRunner.exportSteps", title: "Export Steps", category: CATEGORY, handler: this.exportSteps.bind(this) },
        { command: "playwrightBddRunner.exportScenarios", title: "Export All Scenarios", category: CATEGORY, handler: this.exportScenarios.bind(this) },
        { command: "playwrightBddRunner.insertStep", title: "Insert Step…", category: CATEGORY, handler: this.insertStep.bind(this) },
        { command: "playwrightBddRunner.scaffoldStepFromPanel", title: "Create Step Definition", category: CATEGORY, handler: this.scaffoldStepFromPanel.bind(this) },
        { command: "playwrightBddRunner.scaffoldFeatureFromPanel", title: "Generate Missing Step Definitions", category: CATEGORY, handler: this.scaffoldFeatureFromPanel.bind(this) },
        { command: "playwrightBddRunner.traceability.openIssue", title: "Open Issue in Tracker", category: CATEGORY, handler: this.openIssueInTracker.bind(this) },
        { command: "playwrightBddRunner.traceability.copyKey", title: "Copy Issue Key", category: CATEGORY, handler: this.copyIssueKey.bind(this) },
        { command: "playwrightBddRunner.traceability.linkScenario", title: "Link Scenario to Test", category: CATEGORY, handler: this.linkScenario.bind(this) },
        { command: "playwrightBddRunner.traceability.runAndPublish", title: "Run Locally and Publish…", category: CATEGORY, handler: this.runAndPublish.bind(this) },
        { command: "playwrightBddRunner.traceability.publishLastRun", title: "Publish Last Run…", category: CATEGORY, handler: this.publishLastRun.bind(this) },
        { command: "playwrightBddRunner.traceability.sync", title: "Sync Traceability", category: CATEGORY, handler: this.syncTraceability.bind(this) },
        { command: "playwrightBddRunner.traceability.openBoard", title: "Open Coverage Board", category: CATEGORY, handler: this.openBoard.bind(this) },
        { command: "playwrightBddRunner.traceability.manageConnection", title: "Manage Xray Connection", category: CATEGORY, handler: () => this.getXrayConnectionCommands().manageConnection() },
        { command: "playwrightBddRunner.traceability.connect", title: "Connect to Xray", category: CATEGORY, handler: () => this.getXrayConnectionCommands().connect() },
        { command: "playwrightBddRunner.traceability.disconnect", title: "Disconnect from Xray", category: CATEGORY, handler: () => this.getXrayConnectionCommands().disconnect() },
        { command: "playwrightBddRunner.traceability.testConnection", title: "Test Xray Connection", category: CATEGORY, handler: () => this.getXrayConnectionCommands().testConnection() },
        { command: "playwrightBddRunner.traceability.hidePanel", title: "Hide Traceability Panel", category: CATEGORY, handler: this.hideTraceabilityPanel.bind(this) },
        { command: "playwrightBddRunner.traceability.toggleGrouping", title: "Toggle Grouping", category: CATEGORY, handler: this.toggleGrouping.bind(this) },
        { command: "playwrightBddRunner.traceability.switchDefaultProject", title: "Switch Default Project…", category: CATEGORY, handler: this.switchDefaultProject.bind(this) },
        { command: "playwrightBddRunner.traceability.clearLocalRunHistory", title: "Clear Local Run History…", category: CATEGORY, handler: this.clearLocalRunHistory.bind(this) },
      ];

      for (const cmd of commands) {
        this.registerCommand(context, cmd);
      }

      this.logger.info(`Registered ${commands.length} commands`);
    } catch (error) {
      const msg = errMsg(error);
      this.logger.error(`Failed to register commands: ${msg}`, { error });
      throw new Error(`Command registration failed: ${msg}`);
    }
  }

  private registerCommand(context: vscode.ExtensionContext, options: CommandOptions): void {
    const disposable = vscode.commands.registerCommand(options.command, async (...args: CommandArguments) => {
      try {
        await options.handler(...args);
      } catch (error) {
        const msg = errMsg(error);
        this.logger.error(`Command failed: ${options.command}`, { error: msg, args });
        this.showErrorMessage(`Failed to execute ${options.title}: ${msg}`);
      }
    });
    this.commands.set(options.command, disposable);
    context.subscriptions.push(disposable);
  }

  private resolveOutlineName(
    filePath: string,
    lineNumber: number | undefined,
    scenarioName: string | undefined
  ): string | undefined {
    if (!scenarioName) {return undefined;}
    const parsed = this.getParsedFeature(filePath);
    if (!parsed) {return undefined;}
    const match = parsed.scenarios.find(
      (s) =>
        s.name === scenarioName &&
        (lineNumber === undefined || s.lineNumber === lineNumber)
    );
    return match?.isScenarioOutline ? match.outlineName : undefined;
  }

  private getParsedFeature(filePath: string): ParsedFeature | undefined {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return undefined;
    }
    const cached = this.parsedFeatureCache.get(filePath);
    if (cached?.mtimeMs === stat.mtimeMs) {return cached.parsed;}

    try {
      const content = fs.readFileSync(filePath, "utf-8");
      const parsed = this.context.featureParser.parseFeatureContent(content);
      if (!parsed) {return undefined;}
      this.parsedFeatureCache.set(filePath, { mtimeMs: stat.mtimeMs, parsed });
      return parsed;
    } catch {
      return undefined;
    }
  }

  private async runScenarioCore(
    filePath: string,
    lineNumber: number | undefined,
    scenarioName: string | undefined,
    tags?: string
  ): Promise<RunOutputResult> {
    if (lineNumber === undefined) {
      const featureName = this.getParsedFeature(filePath)?.feature;
      return this.context.testExecutor.runFeatureFileWithOutput({
        filePath,
        ...(featureName ? { featureName } : {}),
        ...(tags ? { tags } : {}),
      });
    }

    const outlineName = this.resolveOutlineName(filePath, lineNumber, scenarioName);
    const opts: TestExecutionOptions = {
      filePath,
      lineNumber,
      ...(scenarioName !== undefined ? { scenarioName } : {}),
      ...(outlineName ? { outlineName } : {}),
      ...(tags ? { tags } : {}),
    };
    return this.context.testExecutor.runScenarioWithOutput(opts);
  }

  private logResult(label: string, result: RunOutputResult): void {
    if (result.success) {
      this.logger.info(`${label} completed`, { duration: result.duration, outputLength: result.output.length });
    } else {
      this.logger.error(`${label} failed`, { error: result.error, duration: result.duration });
    }
    // Surface the captured test output to the output channel. These commands run the test
    // once via the *WithOutput executor path (no live terminal), so without this the user
    // would see no output at all.
    const combined = [result.output, result.error]
      .filter((s): s is string => typeof s === "string" && s.trim() !== "")
      .join("\n");
    if (combined !== "") {
      this.logger.info(`${label} output:\n${combined}`);
      this.logger.showOutput();
    }
  }

  private async runScenario(...args: CommandArguments): Promise<void> {
    const [filePath, lineNumber, scenarioName] = args as [string, number | undefined, string | undefined];
    if (!filePath) {throw new Error("File path is required");}

    const result = await this.runScenarioCore(filePath, lineNumber, scenarioName);
    this.applyRunStatus(filePath, result, lineNumber);
    this.logResult("Scenario", result);
    if (!result.success) {throw new Error(`Test failed: ${result.error ?? "Unknown error"}`);}
  }

  private async runFeature(...args: CommandArguments): Promise<void> {
    const [filePath] = args as [string];
    if (!filePath) {throw new Error("File path is required");}

    const featureName = this.getParsedFeature(filePath)?.feature;
    const result = await this.context.testExecutor.runFeatureFileWithOutput({
      filePath,
      ...(featureName ? { featureName } : {}),
    });
    this.applyRunStatus(filePath, result);
    this.logResult("Feature", result);
    if (!result.success) {throw new Error(`Test failed: ${result.error ?? "Unknown error"}`);}
  }

  private async runAllTests(): Promise<void> {
    this.logger.info("Running all playwright-bdd tests");
    await this.context.testExecutor.runAllTests();
  }

  private async debugScenario(...args: CommandArguments): Promise<void> {
    const [filePath, lineNumber, scenarioName] = args as [string, number | undefined, string | undefined];
    if (!filePath) {throw new Error("File path is required");}

    this.logger.info(`Debugging scenario: ${scenarioName ?? "unnamed"}`, { filePath, lineNumber });
    const outlineName = this.resolveOutlineName(filePath, lineNumber, scenarioName);
    await this.context.testExecutor.debugScenario({
      filePath,
      ...(lineNumber !== undefined ? { lineNumber } : {}),
      ...(scenarioName ? { scenarioName } : {}),
      ...(outlineName ? { outlineName } : {}),
    });
  }

  private refreshTests(): void {
    if (!this.testProvider) {
      this.showErrorMessage("Failed to refresh tests: Test provider not available");
      return;
    }
    const provider = this.testProvider as TestProviderLike;
    provider.discoverTests?.().catch((error) => {
      this.logger.error("Failed to refresh tests", { error: errMsg(error) });
      this.showErrorMessage(`Failed to refresh tests: ${errMsg(error)}`);
    });
  }

  private showOutput(): void {
    this.logger.showOutput();
  }

  private validateConfiguration(): void {
    const errors = this.context.config.getValidationErrors();
    if (errors.length > 0) {
      this.showErrorMessage(`Configuration validation failed:\n${errors.join("\n")}`);
    } else {
      vscode.window.showInformationMessage("Configuration is valid");
    }
  }

  private discoverTests(): void {
    if (!this.testProvider) {
      this.showErrorMessage("Failed to discover tests: Test provider not available");
      return;
    }
    const provider = this.testProvider as TestProviderLike;
    provider.discoverTests?.().catch((error) => {
      this.logger.error("Failed to discover tests", { error: errMsg(error) });
      this.showErrorMessage(`Failed to discover tests: ${errMsg(error)}`);
    });
  }

  private async runFeatureWithTags(...args: CommandArguments): Promise<void> {
    const [filePath, tags] = args as [string, string];
    if (!filePath) {throw new Error("File path is required");}
    if (!tags) {throw new Error("Tags are required");}

    const result = await this.context.testExecutor.runFeatureFileWithOutput({ filePath, tags });
    this.applyRunStatus(filePath, result);
    this.logResult("Feature with tags", result);
    if (!result.success) {throw new Error(`Test failed: ${result.error ?? "Unknown error"}`);}
  }

  private async runScenarioWithTags(...args: CommandArguments): Promise<void> {
    const [filePath, lineNumber, scenarioName, tags] = args as [string, number | undefined, string | undefined, string];
    if (!filePath) {throw new Error("File path is required");}
    if (!tags) {throw new Error("Tags are required");}

    const result = await this.runScenarioCore(filePath, lineNumber, scenarioName, tags);
    this.applyRunStatus(filePath, result, lineNumber);
    this.logResult("Scenario with tags", result);
    if (!result.success) {throw new Error(`Test failed: ${result.error ?? "Unknown error"}`);}
  }

  private async runAllTestsParallel(): Promise<void> {
    this.logger.info("Running all playwright-bdd tests in parallel");
    await this.context.testExecutor.runAllTestsInParallel();
  }

  /**
   * Commands wired into editor/explorer context menus are invoked by VS Code with a
   * `vscode.Uri` as the first argument; programmatic/CodeLens callers pass a string path.
   * Normalize both to an fsPath so downstream path operations don't receive a Uri object.
   */
  private firstArgToFsPath(arg: unknown): string | undefined {
    if (typeof arg === "string") {return arg;}
    const fsPath = (arg as { fsPath?: unknown } | undefined)?.fsPath;
    return typeof fsPath === "string" ? fsPath : undefined;
  }

  private async runScenarioWithContext(...args: CommandArguments): Promise<void> {
    const filePath = this.firstArgToFsPath(args[0]);
    if (!filePath) {throw new Error("File path is required");}
    const lineNumber = typeof args[1] === "number" ? args[1] : undefined;
    const scenarioName = typeof args[2] === "string" ? args[2] : undefined;

    const outlineName = this.resolveOutlineName(filePath, lineNumber, scenarioName);
    const opts: TestExecutionOptions = {
      filePath,
      ...(lineNumber !== undefined ? { lineNumber } : {}),
      ...(scenarioName ? { scenarioName } : {}),
      ...(outlineName ? { outlineName } : {}),
    };
    const result = await this.context.testExecutor.runScenarioWithOutput(opts);
    this.applyRunStatus(filePath, result, lineNumber);
    this.logResult("Scenario with context", result);
    if (!result.success) {throw new Error(`Test failed: ${result.error ?? "Unknown error"}`);}
  }

  private async debugScenarioWithContext(...args: CommandArguments): Promise<void> {
    const filePath = this.firstArgToFsPath(args[0]);
    if (!filePath) {throw new Error("File path is required");}
    const lineNumber = typeof args[1] === "number" ? args[1] : undefined;
    const scenarioName = typeof args[2] === "string" ? args[2] : undefined;

    const outlineName = this.resolveOutlineName(filePath, lineNumber, scenarioName);
    await this.context.testExecutor.debugScenario({
      filePath,
      ...(lineNumber !== undefined ? { lineNumber } : {}),
      ...(scenarioName ? { scenarioName } : {}),
      ...(outlineName ? { outlineName } : {}),
      debug: true,
    });
  }

  private async runFeatureFileWithContext(...args: CommandArguments): Promise<void> {
    const filePath = this.firstArgToFsPath(args[0]);
    if (!filePath) {throw new Error("File path is required");}

    const featureName = this.getParsedFeature(filePath)?.feature;
    const result = await this.context.testExecutor.runFeatureFileWithOutput({
      filePath,
      ...(featureName ? { featureName } : {}),
    });
    this.applyRunStatus(filePath, result);
    this.logResult("Feature with context", result);
    if (!result.success) {throw new Error(`Test failed: ${result.error ?? "Unknown error"}`);}
  }

  private showErrorMessage(message: string): void {
    vscode.window.showErrorMessage(message);
  }

  // The traceability tree passes its node (which carries `testKey`) as the first menu arg; a
  // palette/string caller can pass the key directly.
  private issueKeyFromArg(arg: unknown): string | undefined {
    if (typeof arg === "string") {return arg;}
    const key = (arg as { testKey?: unknown } | undefined)?.testKey;
    return typeof key === "string" ? key : undefined;
  }

  private async openIssueInTracker(...args: CommandArguments): Promise<void> {
    const key = this.issueKeyFromArg(args[0]);
    if (!key) {
      this.showErrorMessage("Open in tracker: no issue key on this item.");
      return;
    }
    await this.browseIssue(this.context.traceabilityAdapter, key);
  }

  private async browseIssue(adapter: TraceabilityAdapter, key: string): Promise<void> {
    const url = adapter.browseUrl({ key });
    if (!url) {
      vscode.window.showWarningMessage(
        "Set playwrightBddRunner.xray.siteUrl to open issues in the browser."
      );
      return;
    }
    await vscode.env.openExternal(vscode.Uri.parse(url));
  }

  private async copyIssueKey(...args: CommandArguments): Promise<void> {
    const key = this.issueKeyFromArg(args[0]);
    if (!key) {
      this.showErrorMessage("Copy issue key: no issue key on this item.");
      return;
    }
    await vscode.env.clipboard.writeText(key);
    vscode.window.showInformationMessage(`Copied ${key}`);
  }

  // The traceability tree passes its untraced/mapped node; a palette invocation has none.
  private scenarioRefFromArg(arg: unknown): ScenarioRef | undefined {
    const node = arg as
      | { kind?: string; item?: { scenario?: ScenarioRef }; link?: { scenario?: ScenarioRef } }
      | undefined;
    if (node?.kind === "untraced") {return node.item?.scenario;}
    if (node?.kind === "link") {return node.link?.scenario;}
    return undefined;
  }

  private async linkScenario(...args: CommandArguments): Promise<void> {
    const scenario = this.scenarioRefFromArg(args[0]);
    if (!scenario) {
      vscode.window.showInformationMessage("Link Scenario: run this from a scenario row in the Traceability view.");
      return;
    }
    await this.linkScenarioForRef(scenario);
  }

  // The linkScenario picker (webview modal) + idempotent tag insert for a known scenario ref. Shared
  // by the context-menu command and the preflight flow's `repair` outcome.
  private async linkScenarioForRef(scenario: ScenarioRef): Promise<void> {
    const adapter = this.traceabilitySubsystem?.getActiveAdapter() ?? this.context.traceabilityAdapter;
    const metadata = adapter.metadata;
    if (!metadata) {
      vscode.window.showInformationMessage("Connect to your test tracker and run Sync before linking scenarios.");
      return;
    }
    const picks = linkScenarioPicks(metadata.snapshot());
    if (picks.length === 0 && !adapter.remoteSearch) {
      vscode.window.showInformationMessage("No synced tests to link yet — run Sync first.");
      return;
    }

    const snapshot = this.traceabilitySubsystem?.getSnapshot();
    const orphans = snapshot?.orphans ?? [];
    const linkedTests: LinkedRow[] = linkedTestsForScenario(snapshot?.links ?? [], scenario).map((link) => ({
      key: link.testKey,
      ...(link.meta?.summary !== undefined ? { summary: link.meta.summary } : {}),
      ...(link.remoteMissing ? { remoteMissing: true } : {}),
    }));
    const board = BoardPanel.open(this.boardDeps());
    const ui = board.link.begin({
      title: `Link scenario to ${adapter.label} test`,
      searchPlaceholder: `Search ${adapter.label} tests`,
    });
    await runLinkPickerFlow({
      ui,
      linkedTests,
      orphanSuggestions: orphans.map((orphan) => ({ key: orphan.testKey, summary: orphan.meta.summary })),
      localCandidates: picks,
      syncedKeys: new Set(picks.map((pick) => pick.key)),
      ...(adapter.testAuthoring ? { createLabel: `Create new ${adapter.label} test from this scenario…` } : {}),
      ...(adapter.remoteSearch ? { remoteSearch: adapter.remoteSearch } : {}),
      linkExisting: (key, synced) => this.linkExisting(scenario, key, synced, adapter),
      createNew: () => this.createTestFromScenario(adapter, scenario),
      openLinked: (key) => {
        this.browseIssue(adapter, key).catch((error) => {
          this.logger.warn("Opening the linked issue failed", { error: errMsg(error) });
        });
      },
      unlink: async (key) => {
        if ((await this.applyTagRemove(scenario, key, adapter.keyGrammar)) === "rejected") {
          // Reject so the picker keeps the row: the tag is still on the scenario.
          throw new Error(REJECTED_WRITE);
        }
      },
      logSearchError: (error) => this.logger.warn("Xray remote search failed", { error: errMsg(error) }),
      logUnlinkError: (error) => {
        this.logger.warn("Unlinking the scenario's test tag failed", { error: errMsg(error) });
        vscode.window.showErrorMessage(`Could not unlink the test tag: ${errMsg(error)}`);
      },
    });
  }

  // Confirm on an existing test: the idempotent tag insert, plus — for a test picked from remote
  // search that the snapshot never synced — an additive background merge so its summary/status appear
  // without a full sync.
  private async linkExisting(
    scenario: ScenarioRef,
    key: string,
    synced: boolean,
    adapter: TraceabilityAdapter
  ): Promise<void> {
    const outcome = await this.applyTagInsert(scenario, key, adapter.keyGrammar);
    if (outcome === "unchanged") {
      vscode.window.showInformationMessage(`Scenario already linked to ${key}.`);
      return;
    }
    if (outcome === "rejected") {
      vscode.window.showErrorMessage(`Could not link ${key}: ${REJECTED_WRITE}.`);
      return;
    }
    if (!synced && adapter.remoteSearch) {
      adapter.remoteSearch.mergeKeys([key]).catch((error) => {
        this.logger.warn("Xray metadata merge for a newly linked test failed", { error: errMsg(error) });
      });
    }
  }

  private applyTagInsert(scenario: ScenarioRef, key: string, grammar: KeyGrammar): Promise<TagWrite<"inserted">> {
    return applyTagInsert(scenario, key, grammar);
  }

  private applyTagRemove(scenario: ScenarioRef, key: string, grammar: KeyGrammar): Promise<TagWrite<"removed">> {
    return applyTagRemove(scenario, key, grammar);
  }

  // The capability-gated "Create new <provider> test from this scenario…" flow. Project comes from
  // `xray.defaultProjectKey` or a prompt; the Gherkin is the verbatim source slice (never the lossy
  // reconstruction); the modal in `authorScenarioTest` gates the remote write; on success the tag is
  // inserted and the new key is merged into the snapshot without a full sync.
  private async createTestFromScenario(adapter: TraceabilityAdapter, scenario: ScenarioRef): Promise<void> {
    const authoring = adapter.testAuthoring;
    if (!authoring) {
      return;
    }
    const project = await this.resolveProjectForCreate();
    if (project === undefined) {
      return;
    }
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(scenario.filePath));
    const gherkin = scenarioGherkinSlice(doc.getText().split("\n"), scenario.line);
    const site = normalizeSiteUrl(this.context.config.xraySiteUrl);
    const spec: NewTestSpec = { project, summary: scenario.name, gherkin };
    const ui: AuthorScenarioTestUi = {
      confirm: () => this.confirmCreateTest(project, site, scenario.name, adapter.label),
      info: (message) => {
        vscode.window.showInformationMessage(message);
      },
      error: (message) => {
        vscode.window.showErrorMessage(message);
      },
    };
    const merge = (key: string): void => {
      adapter.remoteSearch?.mergeKeys([key]).catch((error) => {
        this.logger.warn("Xray metadata merge for a newly created test failed", { error: errMsg(error) });
      });
    };
    try {
      await authorScenarioTest(spec, adapter.label, ui, {
        createTest: (input, signal) => authoring.createTest(input, signal),
        insertTag: async (key) => {
          if ((await this.applyTagInsert(scenario, key, adapter.keyGrammar)) === "rejected") {
            // The remote test exists; merging it anyway lets the picker re-link it without a sync.
            merge(key);
            throw new TagWriteRejected(
              `${key} was created, but ${REJECTED_WRITE}. Add ${buildTestTag(adapter.keyGrammar, key)} to the scenario by hand, or link it to ${key} from the picker.`
            );
          }
        },
        merge,
      });
    } catch (error) {
      this.logger.error("Create test from scenario failed", { error: errMsg(error) });
      vscode.window.showErrorMessage(
        error instanceof TagWriteRejected ? error.message : `Could not create the ${adapter.label} test: ${errMsg(error)}`
      );
    }
  }

  private async resolveProjectForCreate(): Promise<string | undefined> {
    // Normalize the configured key the same way as manual input, so the confirm dialog and the
    // mutation always see one consistent, uppercased key.
    const configured = this.context.config.xrayDefaultProjectKey.trim().toUpperCase();
    if (configured !== "") {
      return configured;
    }
    const input = await vscode.window.showInputBox({
      prompt: "Project key for the new test",
      placeHolder: "e.g. CALC",
      validateInput: (value) => (value.trim() === "" ? "Enter a project key." : undefined),
    });
    return input === undefined ? undefined : input.trim().toUpperCase();
  }

  private async confirmCreateTest(
    project: string,
    site: string,
    scenarioName: string,
    providerLabel: string
  ): Promise<boolean> {
    const target = site !== "" ? `project ${project} on ${site}` : `project ${project}`;
    const choice = await vscode.window.showWarningMessage(
      `Create a new ${providerLabel} test in ${target} from "${scenarioName}"?`,
      { modal: true },
      "Create test"
    );
    return choice === "Create test";
  }

  // Run Locally and Publish… — the preflight batch flow. Resolves the scope, classifies every
  // scenario against the snapshot, collects an explicit decision for each flagged one, then runs the
  // batch locally, seals one artifact carrying those decisions, and hands it to the publish flow. A
  // scenario/link node scopes the batch to that scenario; otherwise the whole mapped set.
  public async runAndPublish(...args: CommandArguments): Promise<void> {
    const subsystem = this.traceabilitySubsystem;
    const snapshot = subsystem?.getSnapshot();
    if (!subsystem || !snapshot) {
      vscode.window.showInformationMessage("Enable and sync the Traceability panel before running a batch.");
      return;
    }
    const scenario = this.scenarioRefFromArg(args[0]);
    const selection: BatchSelection = scenario ? { kind: "scenario", scenario } : { kind: "all-mapped" };
    const binding = subsystem.getActiveAdapter()?.automationBinding;

    let sealed: RunArtifact | undefined;
    const ran = await runPreflightFlow(selection, {
      resolve: (sel) => resolveBatchSelection(sel, subsystem.getSnapshot() ?? snapshot),
      snapshot: () => subsystem.getSnapshot() ?? snapshot,
      classifyBinding: binding ? (meta) => binding.classify(meta) : undefined,
      ui: {
        choose: (items) => this.choosePreflight(items),
        // Insert the tag, then force a synchronous rebuild so the flow re-classifies against the
        // updated snapshot rather than the stale cached one the debounced watcher hasn't refreshed.
        repair: async (ref) => {
          await this.linkScenarioForRef(ref);
          await subsystem.rebuildNow();
        },
      },
      runner: {
        run: async (sel, invocations, decisions) => {
          sealed = await this.runResolvedBatch(sel, invocations, decisions);
        },
      },
    });
    if (!ran) {
      vscode.window.showInformationMessage("Preflight cancelled — nothing was run.");
      return;
    }
    // A cancelled/partial batch, or one with nothing left after reconciliation, is reported here with
    // its specific reason rather than folded into the dialog's newest-run pick. A good run hands its id
    // to the dialog, which opens on it with the other publishable runs in the dropdown.
    if (sealed) {
      if (!isPublishable(sealed)) {
        vscode.window.showWarningMessage(`This run is ${sealed.state} — only a complete run can be published.`);
      } else if (publishableResults(sealed).publishable.length === 0) {
        vscode.window.showWarningMessage("Nothing to publish — every result was excluded by preflight or is unmapped.");
      } else {
        await this.runPublish(sealed.id);
      }
    }
  }

  // Publish Last Run… — open the dialog directly on the newest publishable run. The run-picker
  // QuickPick and the pending-attachments modal are folded into the dialog (dropdown + banner).
  private async publishLastRun(): Promise<void> {
    await this.runPublish();
  }

  // Wire the vscode-free publish flow to the UI: the View 3 webview dialog (run dropdown, republish and
  // pending-attachment banners), the success/failure/partial toasts, attachment uploads, and the
  // persistent ledger. `preselectId` opens the dialog on a specific run (the one Run Locally and Publish
  // just sealed); omitted, the newest publishable run wins. Nothing here runs a remote test — the
  // flow's only write is the capability's single import POST; attachments upload only AFTER it succeeds.
  private async runPublish(preselectId?: string): Promise<void> {
    const adapter = this.traceabilitySubsystem?.getActiveAdapter();
    const publishing = adapter?.resultPublishing;
    if (!adapter || !publishing) {
      vscode.window.showInformationMessage("Connect to your test tracker before publishing.");
      return;
    }
    // Peek the same gate the flow applies before opening the board, so Publish Last Run with nothing to
    // publish shows the toast instead of popping an empty board.
    const runs = this.context.runArtifactStore?.list() ?? [];
    if (!runs.some((artifact) => isPublishable(artifact) && publishableResults(artifact).publishable.length > 0)) {
      vscode.window.showInformationMessage(NO_PUBLISHABLE_RUNS_MESSAGE);
      return;
    }
    const board = BoardPanel.open(this.boardDeps());
    const rawSite = this.context.config.xraySiteUrl;
    const site = normalizeSiteUrl(rawSite);
    const credentials = await this.credentialStore?.getCredentials(rawSite);
    const jiraSearchAvailable = (await this.credentialStore?.hasJiraCredentials(rawSite)) ?? false;
    const resolveSteps = makeFeatureStepResolver(this.context.featureParser);
    try {
      await runPublishFlow({
        publishing,
        runs,
        ...(preselectId !== undefined ? { preselectId } : {}),
        projectOf: adapter.keyGrammar.projectOf,
        changedSinceRun: (results) => results.filter((result) => resolveSteps(result.scenario) === undefined).length,
        defaultProjectKey: this.context.config.xrayDefaultProjectKey,
        jiraSearchAvailable,
        knownProjectKeys: this.knownProjectKeys(adapter),
        // Lazy — the flow calls this only after the no-runs gate, so an empty run list never fires the
        // one allowed pre-confirm call (the attachment/meta probe).
        attachments: () => this.buildPublishAttachments(rawSite),
        priorEntryFor: (artifactId) => this.publishLedger?.find(artifactId, site),
        presentDialog: (model) => board.publish.present(model),
        attachFiles: (executionKey, files) => this.attachFiles(executionKey, files),
        recordPublish: (entry) => this.publishLedger?.record(entry),
        reportNoRuns: () => {
          vscode.window.showInformationMessage(NO_PUBLISHABLE_RUNS_MESSAGE);
        },
        reportSuccess: (outcome, request, attachedCount) => this.reportPublishSuccess(outcome, request, attachedCount),
        reportPartialAttachments: (outcome, request, attachedCount, failed, artifactId) =>
          this.reportPartialAttachments(artifactId, site, outcome, request, attachedCount, failed),
        reportFailure: (error) => this.reportPublishFailure(error),
        site,
        account: credentials?.clientId ?? "",
        now: () => Date.now(),
      });
    } finally {
      board.publish.markSettled();
    }
  }

  // Clear Local Run History: wipes the two machine-local stores behind the publish surfaces. Nothing
  // remote is touched. The ledger goes only through the second button, since losing it also loses the
  // republish warning for every past execution.
  private async clearLocalRunHistory(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      "Clear this workspace's local run history?",
      {
        modal: true,
        detail:
          "Local runs feed the Publish tab. The publish ledger drives the Executions tab and warns you before republishing a run. Clearing the ledger forfeits those warnings for past executions.",
      },
      "Clear runs",
      "Clear runs and ledger"
    );
    if (choice !== "Clear runs" && choice !== "Clear runs and ledger") {
      return;
    }
    const runs = this.context.runArtifactStore?.clear() ?? 0;
    const entries = choice === "Clear runs and ledger" ? (this.publishLedger?.clear() ?? 0) : 0;
    // Report before refreshing: the wipe has already happened, so a failing rebuild must not turn a
    // completed clear into a command failure.
    vscode.window.showInformationMessage(clearedHistoryMessage(runs, entries));
    if (runs === 0 && entries === 0) {
      return;
    }
    // An open board repaints on the subsystem's snapshot-change event, which a forced rebuild fires, so
    // the Executions tab drops the wiped runs without a reopen.
    try {
      await this.traceabilitySubsystem?.rebuildNow();
    } catch (error) {
      this.logger.warn("Refreshing the board after clearing run history failed", { error: errMsg(error) });
    }
  }

  // The pending-attachments banner's action: upload the run's ledgered pending files WITHOUT a reimport
  // (the execution already carries its results) and return how many still failed so the banner updates.
  private async attachPendingForRun(artifactId: string, site: string): Promise<PendingAttachmentsResult> {
    const entry = this.publishLedger?.find(artifactId, site);
    if (entry === undefined || entry.pendingAttachments.length === 0) {
      return { remaining: 0 };
    }
    const { failed } = await this.attachFiles(entry.executionRef, entry.pendingAttachments);
    this.publishLedger?.setPendingAttachments(artifactId, site, failed);
    const attached = entry.pendingAttachments.length - failed.length;
    if (failed.length === 0) {
      vscode.window.showInformationMessage(`${entry.executionRef} — ${attached} pending attachment(s) uploaded.`);
    } else {
      vscode.window.showWarningMessage(`${entry.executionRef} — ${failed.length} attachment(s) still failed.`);
    }
    return { remaining: failed.length };
  }

  // The Publish dialog's run-level attachments section — the vscode-free build + probe logic lives in
  // `buildAttachmentsModel`; this only wires the seams (glob discovery, file sizing, and the site's
  // attachment/meta, which is fetched only when Jira creds exist).
  private async buildPublishAttachments(rawSite: string): Promise<PublishAttachmentsModel> {
    const credentials = await this.credentialStore?.getJiraCredentials(rawSite);
    return buildAttachmentsModel({
      reportGlobs: this.context.config.xrayReportGlob,
      attachTo: this.context.config.xrayAttachTo,
      jiraAvailable: credentials !== undefined,
      findFiles: async (glob) => (await vscode.workspace.findFiles(glob, undefined, 50)).map((uri) => uri.fsPath),
      fileSize: (filePath) => this.fileSizeOrUndefined(filePath),
      baseName: (filePath) => path.basename(filePath),
      attachmentMeta: () => {
        if (credentials === undefined) {
          return Promise.resolve({ enabled: true });
        }
        return fetchJiraAttachmentMeta({ site: normalizeSiteUrl(rawSite), credentials, logger: this.logger });
      },
    });
  }

  private fileSizeOrUndefined(filePath: string): number | undefined {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return undefined;
    }
  }

  private async browsePublishFiles(): Promise<readonly AttachmentSuggestion[]> {
    const picked = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: "Attach" });
    if (!picked) {
      return [];
    }
    return picked.map((uri) => ({
      path: uri.fsPath,
      name: path.basename(uri.fsPath),
      size: this.fileSizeOrUndefined(uri.fsPath) ?? 0,
    }));
  }

  // The shared upload routine behind the flow, the partial-toast Retry, and publishLastRun resume —
  // uploads to the execution's Jira issue and reports which files still failed. No Jira creds ⇒ every
  // file is pending (the section is disabled, so this only guards a race).
  private async attachFiles(executionKey: string, files: readonly string[]): Promise<{ readonly failed: readonly string[] }> {
    const rawSite = this.context.config.xraySiteUrl;
    const credentials = await this.credentialStore?.getJiraCredentials(rawSite);
    if (credentials === undefined) {
      return { failed: files };
    }
    const result = await uploadJiraAttachments({
      site: normalizeSiteUrl(rawSite),
      credentials,
      issueKey: executionKey,
      files,
      logger: this.logger,
    });
    return { failed: result.failed };
  }

  // Replay the ledgered pending files (toast-Retry or resume). Clears the ones that upload; a still-
  // partial replay re-offers Retry. Never re-imports — the execution already carries its results.
  private async retryAttachments(
    artifactId: string,
    site: string,
    executionKey: string,
    files: readonly string[]
  ): Promise<void> {
    const { failed } = await this.attachFiles(executionKey, files);
    this.publishLedger?.setPendingAttachments(artifactId, site, failed);
    const attached = files.length - failed.length;
    if (failed.length === 0) {
      vscode.window.showInformationMessage(`${executionKey} — ${attached} pending attachment(s) uploaded.`);
      return;
    }
    Promise.resolve(
      vscode.window.showWarningMessage(`${executionKey} — ${failed.length} attachment(s) still failed.`, "Retry")
    )
      .then((choice) => (choice === "Retry" ? this.retryAttachments(artifactId, site, executionKey, failed) : undefined))
      .catch(() => undefined);
  }

  private reportPublishSuccess(outcome: PublishOutcome, request: PublishRequest, attachedCount: number): void {
    const base =
      request.mode === "create-new"
        ? `${outcome.ref.key} created — ${outcome.imported} results imported`
        : `appended to ${outcome.ref.key} — ${outcome.imported} results`;
    const notes = [...outcome.warnings];
    if (attachedCount > 0) {
      notes.unshift(`${attachedCount} ${plural(attachedCount, "file")} attached`);
    }
    const message = notes.length > 0 ? `${base} · ${notes.join(" · ")}` : base;
    this.showBrowseToast(message, outcome, "info");
  }

  // Import succeeded, some attachment uploads failed (§8-P3 partial recovery): report the count and
  // offer Retry off the ledgered pending files — the import is never rolled back.
  private reportPartialAttachments(
    artifactId: string,
    site: string,
    outcome: PublishOutcome,
    request: PublishRequest,
    attachedCount: number,
    failed: readonly string[]
  ): void {
    const base =
      request.mode === "create-new"
        ? `${outcome.ref.key} created — ${outcome.imported} results imported`
        : `appended to ${outcome.ref.key} — ${outcome.imported} results`;
    const attachedNote = attachedCount > 0 ? ` · ${attachedCount} ${plural(attachedCount, "file")} attached` : "";
    const message = `${base}${attachedNote} · ${failed.length} ${plural(failed.length, "attachment")} failed`;
    const adapter = this.traceabilitySubsystem?.getActiveAdapter() ?? this.context.traceabilityAdapter;
    const url = adapter.browseUrl(outcome.ref);
    const buttons = url ? ["Retry", "Open in Jira"] : ["Retry"];
    Promise.resolve(vscode.window.showWarningMessage(message, ...buttons))
      .then(async (choice) => {
        if (choice === "Retry") {
          await this.retryAttachments(artifactId, site, outcome.ref.key, failed);
        } else if (choice === "Open in Jira" && url) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
      })
      .catch(() => undefined);
  }

  private showBrowseToast(message: string, outcome: PublishOutcome, level: "info" | "warn"): void {
    const adapter = this.traceabilitySubsystem?.getActiveAdapter() ?? this.context.traceabilityAdapter;
    const url = adapter.browseUrl(outcome.ref);
    const buttons = url ? ["Open in Jira"] : [];
    const show = level === "info" ? vscode.window.showInformationMessage : vscode.window.showWarningMessage;
    Promise.resolve(show(message, ...buttons))
      .then((choice) => {
        if (choice === "Open in Jira" && url) {
          return vscode.env.openExternal(vscode.Uri.parse(url));
        }
        return undefined;
      })
      .catch(() => undefined);
  }

  // The server's own error text is the diagnostic that makes a 400 legible, so it rides both the
  // toast (verbatim) and the log. The request body, headers, and token never do.
  private reportPublishFailure(error: unknown): void {
    if (error instanceof XrayImportError) {
      this.logger.error("Publish failed", { status: error.status, message: error.serverMessage ?? error.message });
      vscode.window.showErrorMessage(`Publish failed: ${error.serverMessage ?? `HTTP ${error.status}`}`);
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error("Publish failed", { message });
    vscode.window.showErrorMessage(`Publish failed: ${message}`);
  }

  // The quick-pick preflight surface (no webview in P2). Batch-level actions assign an explicit
  // decision to every flagged item so none is silently dropped; a per-item entry jumps into repair.
  private async choosePreflight(items: readonly PreflightItem[]): Promise<PreflightChoice> {
    const flagged = items.filter((item) => item.state !== "ready");
    const readyCount = items.length - flagged.length;
    interface Row extends vscode.QuickPickItem {
      choice?: PreflightChoice | undefined;
    }
    const rows: Row[] = [
      {
        label: "$(play) Run all locally",
        description: `${readyCount} ready · ${flagged.length} flagged`,
        choice: { kind: "run", outcome: "local-only" },
      },
    ];
    if (flagged.length > 0) {
      rows.push({
        label: "$(circle-slash) Exclude flagged and run the rest",
        description: `${flagged.length} excluded`,
        choice: { kind: "run", outcome: "exclude" },
      });
      rows.push({ label: "Repair", kind: vscode.QuickPickItemKind.Separator });
      for (const item of flagged) {
        rows.push({
          label: `$(tools) ${item.scenario.name}`,
          description: PREFLIGHT_STATE_LABEL[item.state],
          ...(item.detail ? { detail: item.detail } : {}),
          choice: { kind: "repair", scenario: item.scenario },
        });
      }
    }
    const picked = await vscode.window.showQuickPick(rows, {
      placeHolder: "Preflight — resolve flagged scenarios before the batch runs",
      ignoreFocusOut: true,
    });
    return picked?.choice ?? { kind: "cancel" };
  }

  // Opens one artifact batch, dispatches every invocation with output capture (threading the batch
  // handle + a shared AbortController), and seals — cancelled when the progress stop button aborts.
  private async runResolvedBatch(
    selection: BatchSelection,
    invocations: readonly BatchInvocation[],
    decisions: readonly PreflightDecision[]
  ): Promise<RunArtifact | undefined> {
    const store = this.context.runArtifactStore;
    const handle = store?.beginBatch(selection, decisions);
    const controller = new AbortController();
    let sealed: RunArtifact | undefined;
    try {
      // Notification (not the view location) so the stop button is actually surfaced — a batch run is
      // cancellable, unlike the deliberately-uncancellable sync that renders on the tree view.
      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Running batch locally…", cancellable: true },
        async (_progress, token) => {
          token.onCancellationRequested(() => controller.abort());
          for (const invocation of invocations) {
            if (controller.signal.aborted) {break;}
            await this.dispatchInvocation(invocation, controller.signal, handle);
          }
        }
      );
    } finally {
      if (handle !== undefined) {
        sealed = store?.sealBatch(handle, controller.signal.aborted);
      }
    }
    return sealed;
  }

  private async dispatchInvocation(
    invocation: BatchInvocation,
    signal: AbortSignal,
    handle: number | undefined
  ): Promise<void> {
    const executor = this.context.testExecutor;
    if (invocation.kind === "path-filter") {
      await executor.runPathFilterWithOutput(invocation.target, signal, handle);
      return;
    }
    if (invocation.kind === "grep") {
      const names = invocation.refs.map((ref) => ref.outlineName ?? ref.name);
      await executor.runGrepWithOutput(names, signal, handle);
      return;
    }
    if (invocation.kind === "tags") {
      await executor.runAllTestsWithTagsOutput(invocation.expression, signal, handle);
      return;
    }
    const ref = invocation.ref;
    const options: TestExecutionOptions = {
      filePath: ref.filePath,
      signal,
      ...(handle !== undefined ? { artifactBatch: handle } : {}),
    };
    if (ref.kind === "scenario") {
      options.scenarioName = ref.name;
    } else {
      options.outlineName = ref.outlineName ?? ref.name;
    }
    if (ref.line > 0) {
      options.lineNumber = ref.line;
    }
    await executor.runScenarioWithOutput(options);
  }

  // Open the Coverage Board — a singleton, document-like webview that renders offline from tags (no
  // connected-state gate). It reads snapshots from and re-renders on the subsystem, so it survives
  // syncs and provider swaps while open.
  private openBoard(): void {
    const subsystem = this.traceabilitySubsystem;
    // The subsystem is always wired, but its panel is off when the setting is disabled — with no live
    // model the board would render permanently empty, so guide the user to enable it instead. Publish
    // and Link open the board without this gate: their own preconditions are the real check.
    if (!subsystem?.traceabilityPanelActive) {
      vscode.window.showInformationMessage("Enable the Traceability panel to open the Coverage Board.");
      return;
    }
    BoardPanel.open(this.boardDeps());
  }

  // The project keys this workspace knows: the sync setting, the synced catalogue, and the default key.
  // One list behind both the publish dialog's project dropdown and the board's scope selector.
  private knownProjectKeys(adapter: TraceabilityAdapter | undefined): string[] {
    return knownProjectKeys(
      this.context.config.xraySyncProjectKeys,
      adapter?.metadata?.snapshot().catalogueProjects ?? [],
      this.context.config.xrayDefaultProjectKey
    );
  }

  // The board's dependencies, shared by openBoard, runPublish, and linkScenarioForRef. The board reads
  // the subsystem live (empty when it's absent or the panel is off), owns the Publish tab's delegate,
  // and fires runPublish when that tab is activated idle.
  private boardDeps(): BoardPanelDeps {
    const subsystem = this.traceabilitySubsystem;
    const roots = (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.fsPath);
    const site = normalizeSiteUrl(this.context.config.xraySiteUrl);
    return {
      providerLabel: subsystem?.getActiveAdapter()?.label ?? "Xray",
      buildModel: () =>
        buildBoardViewModel(
          subsystem?.getSnapshot(),
          roots,
          subsystem?.getActiveAdapter()?.keyGrammar.testPrefix ?? "",
          this.context.config.xraySyncProjectKeys.length > 0,
          subsystem?.getActiveAdapter()?.keyGrammar.projectOf
        ),
      // A provider whose grammar derives no project stamps nothing on the cards, so every option would
      // empty both groups: offer none and the selector stays on All Projects.
      knownProjects: () => {
        const adapter = subsystem?.getActiveAdapter();
        return adapter?.keyGrammar.projectOf ? this.knownProjectKeys(adapter) : [];
      },
      projectScope: subsystem?.projectScope() ?? NO_PROJECT_SCOPE,
      buildExecutions: () => buildExecutionRows(this.publishLedger?.entriesForSite(site) ?? []),
      onDidChange: subsystem?.onDidChangeSnapshot ?? this.boardChange.event,
      applyDrop: (scenario, key) => this.applyBoardDrop(scenario, key),
      applyUnlink: (scenario, key) => this.applyBoardUnlink(scenario, key),
      runSync: () => this.syncTraceability(),
      openExecution: (key) => {
        const adapter = subsystem?.getActiveAdapter() ?? this.context.traceabilityAdapter;
        this.browseIssue(adapter, key).catch((error) => {
          this.logger.warn("Opening the execution issue failed", { error: errMsg(error) });
        });
      },
      publishDelegate: this.publishDelegate(),
      startPublish: () => {
        this.runPublish().catch((error) => {
          this.logger.warn("Publish from the board tab failed", { error: errMsg(error) });
        });
      },
    };
  }

  // The Publish tab's delegate, reading the active adapter and site lazily so a board opened before a
  // connection still searches/attaches correctly once one is present.
  private publishDelegate(): PublishDialogDelegate {
    return {
      searchTargets: (kind, query, signal) => {
        const publishing = this.traceabilitySubsystem?.getActiveAdapter()?.resultPublishing;
        if (!publishing) {
          return Promise.reject(new Error("Connect to your test tracker to search."));
        }
        return publishing.searchTargets(kind, query, signal);
      },
      browseFiles: () => this.browsePublishFiles(),
      attachPending: (runId) => this.attachPendingForRun(runId, normalizeSiteUrl(this.context.config.xraySiteUrl)),
    };
  }

  // A board drag-to-link drop: validate the {scenario, key} pair against the CURRENT snapshot (a drop
  // staged before a rebuild may name a card that no longer exists) and, when it still holds, write the
  // tag through the same insert path as linkExisting. The file watcher rebuilds and the board
  // re-renders on its own, so nothing here patches the view model. This runs outside the command
  // registration's try/catch (it is a panel callback), so it surfaces a failed write itself.
  private async applyBoardDrop(dropId: string, key: string): Promise<void> {
    const subsystem = this.traceabilitySubsystem;
    const adapter = subsystem?.getActiveAdapter();
    if (!subsystem || !adapter) {
      return;
    }
    await this.applyBoardMutation(
      resolveBoardDrop(subsystem.getSnapshot(), dropId, key),
      adapter.keyGrammar,
      (ref, k, grammar) => this.applyTagInsert(ref, k, grammar),
      {
        stale: "That link is out of date because the board changed. Try the drag again.",
        failLog: "Board drag-to-link write failed",
        failToast: (k, error) => `Could not link ${k}: ${error}`,
      }
    );
  }

  // A board unlink (the Unlink button on a mapped test card's scenario row): validate the
  // {scenario, key} pair against the CURRENT snapshot and, when a live link matches both,
  // strip just that `@TEST_<key>` tag through the same applyTagRemove path the link dialog uses. The
  // watcher rebuild re-renders the board, so nothing here patches the view model.
  private async applyBoardUnlink(dropId: string, key: string): Promise<void> {
    const subsystem = this.traceabilitySubsystem;
    const adapter = subsystem?.getActiveAdapter();
    if (!subsystem || !adapter) {
      return;
    }
    await this.applyBoardMutation(
      resolveBoardUnlink(subsystem.getSnapshot(), dropId, key),
      adapter.keyGrammar,
      (ref, k, grammar) => this.applyTagRemove(ref, k, grammar),
      {
        stale: "That link is out of date because the board changed. Try again.",
        failLog: "Board unlink write failed",
        failToast: (k, error) => `Could not unlink ${k}: ${error}`,
      }
    );
  }

  // The shared body behind applyBoardDrop and applyBoardUnlink: an unmatched resolve (the pair went
  // stale against the current snapshot) toasts and leaves the board untouched for a retry; otherwise the
  // tag write runs through `apply`, surfacing a failure as an error toast rather than throwing back into
  // the panel callback.
  private async applyBoardMutation(
    resolved: BoardDropResolution | undefined,
    grammar: KeyGrammar,
    apply: (ref: ScenarioRef, key: string, grammar: KeyGrammar) => Promise<TagWrite<"inserted" | "removed">>,
    messages: { stale: string; failLog: string; failToast: (key: string, error: string) => string }
  ): Promise<void> {
    if (!resolved) {
      vscode.window.showWarningMessage(messages.stale);
      return;
    }
    try {
      if ((await apply(resolved.ref, resolved.key, grammar)) === "rejected") {
        // A refusal is silent, so raise it into the same failure path a thrown write already takes.
        throw new Error(REJECTED_WRITE);
      }
    } catch (error) {
      this.logger.error(messages.failLog, { error: errMsg(error) });
      vscode.window.showErrorMessage(messages.failToast(resolved.key, errMsg(error)));
    }
  }

  // Serialize sync: the palette entry and the view-title button can both fire; a second invoke while
  // one run is in flight awaits the same run rather than starting a second (interleaved state writes,
  // two AbortControllers).
  private syncTraceability(): Promise<void> {
    if (this.syncInFlight) {
      return this.syncInFlight;
    }
    this.syncInFlight = this.runTraceabilitySyncCommand().finally(() => {
      this.syncInFlight = undefined;
    });
    return this.syncInFlight;
  }

  // Gated on the connected context key, but the metadata capability can still be absent (browse-only
  // adapter, provider without a client); guide the user rather than throwing. Progress renders on the
  // tree view; cancellation flows through to the fetch's AbortSignal.
  private async runTraceabilitySyncCommand(): Promise<void> {
    const metadata = this.traceabilitySubsystem?.getActiveAdapter()?.metadata;
    if (!metadata) {
      vscode.window.showInformationMessage("Connect to your test tracker before syncing.");
      return;
    }
    const scope: SyncScope = {
      testKeys: this.traceabilitySubsystem?.knownTestKeys() ?? [],
      projectKeys: this.context.config.xraySyncProjectKeys,
    };
    const controller = new AbortController();
    const result = await vscode.window.withProgress(
      { location: { viewId: "playwrightBddRunner.traceability" }, title: "Syncing traceability…" },
      (_progress, token) => {
        token.onCancellationRequested(() => controller.abort());
        return runTraceabilitySync({ metadata, scope, signal: controller.signal, logger: this.logger });
      }
    );
    if (!result.ok) {
      const pick = await vscode.window.showErrorMessage(result.message, "Show Output");
      if (pick === "Show Output") {
        this.logger.showOutput();
      }
    }
  }

  // Welcome-only "Hide this panel" affordance. Write to wherever the setting already lives so a
  // workspace-pinned opt-out isn't silently promoted to Global (mirrors the Xray site-URL target).
  private async hideTraceabilityPanel(): Promise<void> {
    const wsConfig = vscode.workspace.getConfiguration("playwrightBddRunner");
    const target =
      wsConfig.inspect<boolean>("traceability.enablePanel")?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await wsConfig.update("traceability.enablePanel", false, target);
  }

  // Flip the Traceability tree between the by-test and by-file layouts (title-bar button + palette).
  // The subsystem owns the persisted mode, so this just delegates.
  private toggleGrouping(): void {
    this.traceabilitySubsystem?.toggleGrouping();
  }

  // Set xray.defaultProjectKey (create-time only): a project QuickPick when Jira credentials are
  // present, a validated key input otherwise. Written back to whichever scope already holds the
  // setting, preferring Workspace over Global when both are pinned.
  private async switchDefaultProject(): Promise<void> {
    const rawSite = this.context.config.xraySiteUrl;
    const current = this.context.config.xrayDefaultProjectKey;
    const jiraCredentials = await this.credentialStore?.getJiraCredentials(rawSite);
    const chosen = jiraCredentials
      ? await this.pickDefaultProjectFromJira(rawSite, jiraCredentials, current)
      : await this.promptDefaultProjectKey(current);
    if (chosen === undefined) {
      return;
    }
    // Normalize once here so the Jira-picked key and the typed key agree; project keys are canonical
    // uppercase (the same shape resolveProjectForCreate stores).
    const normalized = chosen.toUpperCase();
    await this.writeDefaultProjectKey(normalized);
    vscode.window.showInformationMessage(
      `Default project set to ${normalized}, used only when creating tests or executions.`
    );
  }

  private async pickDefaultProjectFromJira(
    rawSite: string,
    credentials: { email: string; token: string },
    current: string
  ): Promise<string | undefined> {
    const site = normalizeSiteUrl(rawSite);
    if (site === "") {
      return this.promptDefaultProjectKey(current);
    }
    let projects: JiraProject[];
    try {
      projects = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Loading Jira projects…" },
        () => searchJiraProjects({ site, credentials, logger: this.logger })
      ).then((result) => result.projects);
    } catch (error) {
      // A terminal Jira failure degrades to the manual key input rather than dead-ending.
      const message = error instanceof JiraAccessError ? error.message : errMsg(error);
      vscode.window.showWarningMessage(`Could not list Jira projects: ${message}`);
      return this.promptDefaultProjectKey(current);
    }
    if (projects.length === 0) {
      return this.promptDefaultProjectKey(current);
    }
    interface ProjectItem extends vscode.QuickPickItem {
      key: string;
    }
    const items: ProjectItem[] = projects.map((project) => ({
      label: project.key,
      description: project.name,
      key: project.key,
    }));
    const picker = vscode.window.createQuickPick<ProjectItem>();
    picker.title = "Switch Default Project";
    picker.placeholder = "Select the default Jira project (used only when creating tests or executions)";
    picker.items = items;
    const currentItem = items.find((item) => item.key === current);
    if (currentItem) {
      picker.activeItems = [currentItem];
    }
    try {
      const picked = await new Promise<ProjectItem | undefined>((resolve) => {
        picker.onDidAccept(() => resolve(picker.selectedItems[0]));
        picker.onDidHide(() => resolve(undefined));
        picker.show();
      });
      return picked?.key;
    } finally {
      picker.dispose();
    }
  }

  private async promptDefaultProjectKey(current: string): Promise<string | undefined> {
    const input = await vscode.window.showInputBox({
      title: "Switch Default Project",
      prompt: "Jira project key, used only when creating tests or executions",
      placeHolder: "e.g. CALC",
      value: current,
      validateInput: (value) =>
        (/^[A-Za-z][A-Za-z0-9_]*$/.test(value.trim()) ? undefined : "Enter a project key such as CALC."),
    });
    // Caller (switchDefaultProject) uppercases at the shared write path, so just trim here.
    return input === undefined ? undefined : input.trim();
  }

  // Write to wherever the setting already lives so a workspace-pinned value isn't promoted to Global
  // (mirrors the Xray site-URL and hide-panel targets); Workspace wins when both scopes hold a value.
  private async writeDefaultProjectKey(key: string): Promise<void> {
    const wsConfig = vscode.workspace.getConfiguration("playwrightBddRunner");
    const target =
      wsConfig.inspect<string>("xray.defaultProjectKey")?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await wsConfig.update("xray.defaultProjectKey", key, target);
  }

  public dispose(): void {
    for (const [, disposable] of this.commands) {
      try { disposable.dispose(); } catch { /* ignore */ }
    }
    this.commands.clear();
    if (this.generateStepsResolver) {
      try { this.generateStepsResolver.dispose(); } catch { /* ignore */ }
      this.generateStepsResolver = undefined;
      this.generateStepsCommand = undefined;
    }
    if (this.stepDefinitionConfigListener) {
      try { this.stepDefinitionConfigListener.dispose(); } catch { /* ignore */ }
      this.stepDefinitionConfigListener = undefined;
    }
    this.invalidateStepDefinitionProvider();
  }

  private clearCommands(): void {
    this.dispose();
  }

  private async setOrganizationStrategy(): Promise<void> {
    const strategies = [
      { label: "Tag-based", description: "Group scenarios by their tags", value: "tag" },
      { label: "File-based", description: "Group scenarios by their file location", value: "file" },
      { label: "Scenario Type", description: "Group by regular scenarios vs scenario outlines", value: "scenarioType" },
      { label: "Flat", description: "No grouping, all scenarios in one list", value: "flat" },
      { label: "Feature-Based (Hierarchical)", description: "Show feature files as roots with scenarios as children", value: "feature" },
    ];
    const selected = await vscode.window.showQuickPick(strategies, {
      placeHolder: "Select organization strategy",
      canPickMany: false,
    });
    if (selected) {await this.setStrategyByValue(selected.value);}
  }

  private async setStrategyByValue(strategyValue: string): Promise<void> {
    try {
      const provider = this.testProvider as TestProviderLike | undefined;
      const organizationManager = provider?.organizationManager;
      if (!organizationManager) {throw new Error("Organization manager not available");}

      const targetType = STRATEGY_TYPE_BY_VALUE[strategyValue];
      const available = organizationManager.getAvailableStrategies();
      const strategy = (targetType && available.find((s) => s.strategy.strategyType === targetType)) ?? available[0];
      if (!strategy) {throw new Error(`Strategy not found: ${strategyValue}`);}

      organizationManager.setStrategy(strategy.strategy);
      provider?.persistOrganizationStrategy?.(strategy.strategy.strategyType);
      // discoverTests() clears the controller items and the internal id maps, then rebuilds
      // the tree from the now-active strategy — a single `items.replace()` is the canonical
      // way to refresh the Test Explorer. The previous triple-step dance (discover +
      // forceRefresh + testing.refreshTests) re-cleared the tree mid-flight and leaned on a
      // refreshHandler that didn't exist, which is why the view appeared stuck.
      provider?.discoveryManager?.clearCache();
      await provider?.discoverTests?.();

      vscode.window.showInformationMessage(`Organization strategy changed to: ${strategy.name}`);
    } catch (error) {
      const msg = errMsg(error);
      this.logger.error("Failed to change organization strategy", { error: msg });
      this.showErrorMessage(`Failed to change organization strategy: ${msg}`);
    }
  }

  private async generateStepDefinitions(...args: CommandArguments): Promise<void> {
    const [arg] = args as [vscode.Uri | string | undefined];
    const command = this.getGenerateStepsCommand();
    await command.execute(arg);
  }

  private async generateStepDefinitionForStep(...args: CommandArguments): Promise<void> {
    const [featureUri, info] = args as [vscode.Uri | undefined, Partial<UnmatchedStep> | undefined];
    if (!featureUri || typeof (featureUri as { fsPath?: unknown }).fsPath !== "string") {
      this.logger.warn("generateStepDefinitionForStep: missing or invalid featureUri", { args });
      return;
    }
    if (!info || typeof info.line !== "number" || typeof info.text !== "string" || typeof info.keyword !== "string") {
      this.logger.warn("generateStepDefinitionForStep: missing or invalid step info", { args });
      return;
    }
    const effective = info.effectiveKeyword;
    if (effective !== "Given" && effective !== "When" && effective !== "Then") {
      this.logger.warn("generateStepDefinitionForStep: invalid effectiveKeyword", { args });
      return;
    }
    const step: UnmatchedStep = {
      line: info.line,
      keyword: info.keyword,
      effectiveKeyword: effective,
      text: info.text,
    };
    const command = this.getGenerateStepsCommand();
    await command.executeForSteps(featureUri, [step]);
  }

  private requireUsageIndexHost(action: string): UsageIndexHost | undefined {
    if (!this.usageIndexHost) {
      this.showErrorMessage(`${action} is unavailable: provider registry not wired.`);
      return undefined;
    }
    return this.usageIndexHost;
  }

  private refreshStepsPanel(): void {
    // rescan() fires onDidChangeUsages, which the Steps tree provider maps to a tree refresh.
    this.requireUsageIndexHost("Refresh Steps Panel")?.getUsageIndex().rescan();
  }

  private async exportSteps(): Promise<void> {
    const host = this.requireUsageIndexHost("Export Steps");
    if (!host) {return;}
    await exportStepsCatalog(
      host.getUsageIndex(),
      this.context.config.collapseMarkdownExportSections,
    );
  }

  private async exportScenarios(): Promise<void> {
    await exportScenariosCatalog(this.context);
  }

  private async insertStep(...args: CommandArguments): Promise<void> {
    const host = this.requireUsageIndexHost("Insert Step");
    if (!host) {return;}
    const node = args[0] as StepDefinitionNode | undefined;
    const preselected =
      node?.kind === "stepDefinition"
        ? { pattern: node.pattern, isRegex: node.isRegex }
        : undefined;
    await runInsertStep(
      async () => [...(await host.getUsageIndex().getAllUsages()).keys()],
      preselected
    );
  }

  private async scaffoldStepFromPanel(...args: CommandArguments): Promise<void> {
    const node = args[0] as UnmatchedStepNode | undefined;
    if (node?.kind !== "unmatchedStep") {return;}
    await this.generateStepDefinitionForStep(vscode.Uri.file(node.featurePath), node.step);
  }

  private async scaffoldFeatureFromPanel(...args: CommandArguments): Promise<void> {
    const node = args[0] as UnmatchedFileNode | undefined;
    if (node?.kind !== "unmatchedFile") {return;}
    await this.generateStepDefinitions(node.featurePath);
  }

  /**
   * Jump from the Gherkin step under the cursor to its matching `Given/When/Then` step
   * definition. Reuses the same resolver as the F12 DefinitionProvider, but surfaces it as an
   * explicit, discoverable command + context-menu action that works regardless of whether the
   * navigation provider is registered.
   */
  private async goToStepDefinition(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      this.showErrorMessage("Go to Step Definition: open a .feature file and place the cursor on a step.");
      return;
    }
    const doc = editor.document;
    if (doc.languageId !== "gherkin" && !doc.fileName.endsWith(".feature")) {
      this.showErrorMessage("Go to Step Definition only works inside .feature files.");
      return;
    }

    const position = editor.selection.active;
    const provider = this.getStepDefinitionProvider();
    const locations = await provider.provideDefinition(doc, position);
    if (!locations || locations.length === 0) {
      vscode.window.showInformationMessage(
        "No matching step definition found for the step under the cursor."
      );
      return;
    }

    if (locations.length === 1 && locations[0]) {
      const { uri, range } = locations[0];
      const targetDoc = await vscode.workspace.openTextDocument(uri);
      const opened = await vscode.window.showTextDocument(targetDoc);
      opened.selection = new vscode.Selection(range.start, range.start);
      opened.revealRange(range, vscode.TextEditorRevealType.InCenter);
      return;
    }

    // Multiple matches (ambiguous step) — let VS Code show its definition picker/peek.
    await vscode.commands.executeCommand(
      "editor.action.goToLocations",
      doc.uri,
      position,
      locations,
      "goto",
      "No matching step definition found."
    );
  }

  private getXrayConnectionCommands(): XrayConnectionCommands {
    if (!this.credentialStore || !this.xrayProbe) {
      throw new Error("Xray connection commands are unavailable: credential store or probe not wired.");
    }
    this.xrayConnectionCommands ??= new XrayConnectionCommands(
      this.context.config,
      this.credentialStore,
      this.context.logger,
      () => this.traceabilitySubsystem?.knownTestKeys() ?? [],
      this.xrayProbe
    );
    return this.xrayConnectionCommands;
  }

  private getGenerateStepsCommand(): GenerateStepsCommand {
    if (!this.generateStepsCommand) {
      this.generateStepsResolver = new StepResolver(this.context.logger);
      this.generateStepsCommand = new GenerateStepsCommand(
        this.generateStepsResolver,
        this.context.config,
        this.context.logger
      );
    }
    return this.generateStepsCommand;
  }

  // A StepDefinitionProvider bakes in `stepDefinitionPaths` and caches the scanned
  // step-definition files, so a fresh instance per invocation would re-scan every time.
  // We own its resolver explicitly (the provider isn't disposable, and its file watchers
  // must be torn down) and drop the whole cache on any config change so a changed
  // `stepDefinitionPaths` setting rebuilds the provider against the new globs.
  private getStepDefinitionProvider(): StepDefinitionProvider {
    if (!this.stepDefinitionProvider) {
      this.stepDefinitionResolver = new StepResolver(this.context.logger);
      this.stepDefinitionProvider = new StepDefinitionProvider(
        this.context.config.stepDefinitionPaths,
        this.logger,
        this.stepDefinitionResolver
      );
      this.stepDefinitionConfigListener ??= this.context.config.addChangeListener(() => {
        this.invalidateStepDefinitionProvider();
      });
    }
    return this.stepDefinitionProvider;
  }

  private invalidateStepDefinitionProvider(): void {
    if (this.stepDefinitionResolver) {
      try { this.stepDefinitionResolver.dispose(); } catch { /* ignore */ }
      this.stepDefinitionResolver = undefined;
    }
    this.stepDefinitionProvider = undefined;
  }

  private debugOrganization(): void {
    try {
      const provider = this.testProvider as TestProviderLike | undefined;
      const organizationManager = provider?.organizationManager;
      if (!organizationManager) {throw new Error("Organization manager not available");}

      const current = organizationManager.getStrategy();
      this.logger.info("Current Organization Strategy", {
        name: current.strategyType,
        description: current.getDescription(),
      });
      vscode.window.showInformationMessage(`Current Organization Strategy: ${current.strategyType}`);
    } catch (error) {
      const msg = errMsg(error);
      this.logger.error("Failed to debug organization strategy", { error: msg });
      this.showErrorMessage(`Failed to debug organization strategy: ${msg}`);
    }
  }

}
