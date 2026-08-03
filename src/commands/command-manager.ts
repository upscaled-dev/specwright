import * as vscode from "vscode";
import { StepDefinitionProvider } from "../providers/step-definition-provider";
import { StepResolver, UnmatchedStep } from "../providers/step-resolver";
import { StepUsageIndex } from "../providers/step-usage-index";
import { StepDefinitionNode, UnmatchedFileNode, UnmatchedStepNode } from "../providers/steps-tree-data-provider";
import type { PublishLedger } from "../traceability/publish-ledger";
import type { TraceabilitySubsystem } from "../traceability/traceability-subsystem";
import {
  CommandArguments,
  CommandHandler,
  PlaywrightBddExtensionContext,
} from "../types";
import { Logger } from "../utils/logger";
import { errMsg } from "../utils/text";
import type { XrayProbe } from "../xray/xray-connection-test";
import type { XrayCredentialStore } from "../xray/xray-credential-store";
import { exportScenariosCatalog, exportStepsCatalog } from "./export-catalogs";
import { GenerateStepsCommand } from "./generate-steps";
import { runInsertStep } from "./insert-step";
import { TraceabilityCommands } from "./traceability-commands";
import { RunCommands } from "./run-commands";

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

export class CommandManager {
  private readonly commands = new Map<string, { title: string; disposable: vscode.Disposable }>();
  private readonly context: PlaywrightBddExtensionContext;
  private testProvider: unknown;
  private generateStepsCommand: GenerateStepsCommand | undefined;
  private generateStepsResolver: StepResolver | undefined;
  private stepDefinitionProvider: StepDefinitionProvider | undefined;
  private stepDefinitionResolver: StepResolver | undefined;
  private stepDefinitionConfigListener: vscode.Disposable | undefined;
  private usageIndexHost: UsageIndexHost | undefined;
  private credentialStore: XrayCredentialStore | undefined;
  private xrayProbe: XrayProbe | undefined;
  private traceabilitySubsystem: TraceabilitySubsystem | undefined;
  private publishLedger: PublishLedger | undefined;
  private extensionUri: vscode.Uri | undefined;
  private readonly traceabilityCommands: TraceabilityCommands;
  private readonly runCommands: RunCommands;

  public static create(context: PlaywrightBddExtensionContext): CommandManager {
    return new CommandManager(context);
  }

  private constructor(context: PlaywrightBddExtensionContext) {
    this.context = context;
    this.runCommands = new RunCommands(context, () => this.testProvider);
    this.traceabilityCommands = new TraceabilityCommands(context.logger, {
      config: context.config,
      fallbackAdapter: () => context.traceabilityAdapter,
      credentialStore: () => this.credentialStore,
      xrayProbe: () => this.xrayProbe,
      subsystem: () => this.traceabilitySubsystem,
      publishLedger: () => this.publishLedger,
      extensionUri: () => this.extensionUri,
      runArtifactStore: context.runArtifactStore,
      executionGateway: context.executionGateway,
      featureParser: context.featureParser,
    });
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

  public registerCommands(context: vscode.ExtensionContext): void {
    try {
      this.clearCommands();
      // The only place the extension root reaches this class; the board's tab icon resolves against it.
      this.extensionUri = context.extensionUri;

      const commands: CommandOptions[] = [
        { command: "playwrightBddRunner.runScenario", title: "Run Scenario", category: CATEGORY, handler: this.runCommands.runScenario.bind(this.runCommands) },
        { command: "playwrightBddRunner.runFeatureFile", title: "Run Feature File", category: CATEGORY, handler: this.runCommands.runFeature.bind(this.runCommands) },
        { command: "playwrightBddRunner.runAllTests", title: "Run All Tests", category: CATEGORY, handler: this.runCommands.runAllTests.bind(this.runCommands) },
        { command: "playwrightBddRunner.debugScenario", title: "Debug Scenario", category: CATEGORY, handler: this.runCommands.debugScenario.bind(this.runCommands) },
        { command: "playwrightBddRunner.refreshTests", title: "Refresh Tests", category: CATEGORY, handler: this.refreshTests.bind(this) },
        { command: "playwrightBddRunner.showOutput", title: "Show Test Output", category: CATEGORY, handler: this.showOutput.bind(this) },
        { command: "playwrightBddRunner.validateConfiguration", title: "Validate Configuration", category: CATEGORY, handler: this.validateConfiguration.bind(this) },
        { command: "playwrightBddRunner.discoverTests", title: "Discover Tests", category: CATEGORY, handler: this.discoverTests.bind(this) },
        { command: "playwrightBddRunner.runFeatureFileWithTags", title: "Run Feature File with Tags", category: CATEGORY, handler: this.runCommands.runFeatureWithTags.bind(this.runCommands) },
        { command: "playwrightBddRunner.runScenarioWithTags", title: "Run Scenario with Tags", category: CATEGORY, handler: this.runCommands.runScenarioWithTags.bind(this.runCommands) },
        { command: "playwrightBddRunner.runAllTestsParallel", title: "Run All Tests in Parallel", category: CATEGORY, handler: this.runCommands.runAllTestsParallel.bind(this.runCommands) },
        { command: "playwrightBddRunner.runScenarioWithContext", title: "Run Scenario", category: CATEGORY, handler: this.runCommands.runScenarioWithContext.bind(this.runCommands) },
        { command: "playwrightBddRunner.debugScenarioWithContext", title: "Debug Scenario", category: CATEGORY, handler: this.runCommands.debugScenarioWithContext.bind(this.runCommands) },
        { command: "playwrightBddRunner.runFeatureFileWithContext", title: "Run Feature File", category: CATEGORY, handler: this.runCommands.runFeatureWithContext.bind(this.runCommands) },
        { command: "playwrightBddRunner.setOrganizationStrategy", title: "Set Organization Strategy", category: CATEGORY, handler: this.setOrganizationStrategy.bind(this) },
        { command: "playwrightBddRunner.setTagBasedOrganization", title: "Organize by Tags", category: CATEGORY, handler: () => this.setStrategyByValue("tag") },
        { command: "playwrightBddRunner.setFileBasedOrganization", title: "Organize by File", category: CATEGORY, handler: () => this.setStrategyByValue("file") },
        { command: "playwrightBddRunner.setScenarioTypeOrganization", title: "Organize by Scenario Type", category: CATEGORY, handler: () => this.setStrategyByValue("scenarioType") },
        { command: "playwrightBddRunner.setFlatOrganization", title: "Flat Organization", category: CATEGORY, handler: () => this.setStrategyByValue("flat") },
        { command: "playwrightBddRunner.setFeatureBasedOrganization", title: "Hierarchical Organization", category: CATEGORY, handler: () => this.setStrategyByValue("feature") },
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
        { command: "playwrightBddRunner.traceability.openIssue", title: "Open Issue in Tracker", category: CATEGORY, handler: this.traceabilityCommands.openIssueInTracker.bind(this.traceabilityCommands) },
        { command: "playwrightBddRunner.traceability.copyKey", title: "Copy Issue Key", category: CATEGORY, handler: this.traceabilityCommands.copyIssueKey.bind(this.traceabilityCommands) },
        { command: "playwrightBddRunner.traceability.linkScenario", title: "Link Scenario to Test", category: CATEGORY, handler: this.traceabilityCommands.linkScenario.bind(this.traceabilityCommands) },
        { command: "playwrightBddRunner.traceability.runAndPublish", title: "Run Locally and Publish…", category: CATEGORY, handler: this.traceabilityCommands.runAndPublish.bind(this.traceabilityCommands) },
        { command: "playwrightBddRunner.traceability.runAndPublishAllMapped", title: "Run All Mapped Scenarios and Publish", category: CATEGORY, handler: () => this.traceabilityCommands.runAndPublishAllMapped() },
        { command: "playwrightBddRunner.traceability.runAndPublishFeature", title: "Run and Publish", category: CATEGORY, handler: this.traceabilityCommands.runAndPublishFeature.bind(this.traceabilityCommands) },
        { command: "playwrightBddRunner.traceability.runAndPublishFolder", title: "Run and Publish", category: CATEGORY, handler: this.traceabilityCommands.runAndPublishFolder.bind(this.traceabilityCommands) },
        { command: "playwrightBddRunner.traceability.runAndPublishByTagExpression", title: "Run and Publish by Tag Expression", category: CATEGORY, handler: () => this.traceabilityCommands.runAndPublishByTagExpression() },
        { command: "playwrightBddRunner.traceability.publishLastRun", title: "Publish Last Run…", category: CATEGORY, handler: () => this.traceabilityCommands.publishLastRun() },
        // Wrapped rather than bound: a command handler is called with the invoking context's arguments,
        // which must never be read as a sync request. The palette and the view title always announce.
        { command: "playwrightBddRunner.traceability.sync", title: "Sync Traceability", category: CATEGORY, handler: () => this.traceabilityCommands.syncTraceability() },
        { command: "playwrightBddRunner.traceability.openBoard", title: "Open Coverage Board", category: CATEGORY, handler: () => this.traceabilityCommands.openBoard() },
        { command: "playwrightBddRunner.traceability.manageConnection", title: "Manage Xray Connection", category: CATEGORY, handler: () => this.traceabilityCommands.manageConnection() },
        { command: "playwrightBddRunner.traceability.connect", title: "Connect to Xray", category: CATEGORY, handler: () => this.traceabilityCommands.connect() },
        { command: "playwrightBddRunner.traceability.disconnect", title: "Disconnect from Xray", category: CATEGORY, handler: () => this.traceabilityCommands.disconnect() },
        { command: "playwrightBddRunner.traceability.testConnection", title: "Test Xray Connection", category: CATEGORY, handler: () => this.traceabilityCommands.testConnection() },
        { command: "playwrightBddRunner.traceability.hidePanel", title: "Hide Traceability Panel", category: CATEGORY, handler: () => this.traceabilityCommands.hideTraceabilityPanel() },
        { command: "playwrightBddRunner.traceability.toggleGrouping", title: "Toggle Grouping", category: CATEGORY, handler: () => this.traceabilityCommands.toggleGrouping() },
        { command: "playwrightBddRunner.traceability.switchDefaultProject", title: "Switch Default Project…", category: CATEGORY, handler: () => this.traceabilityCommands.switchDefaultProject() },
        { command: "playwrightBddRunner.traceability.clearLocalRunHistory", title: "Clear Local Run History…", category: CATEGORY, handler: () => this.traceabilityCommands.clearLocalRunHistory() },
        { command: "playwrightBddRunner.traceability.bulkCreateTests", title: "Create Tests from Scenarios…", category: CATEGORY, handler: () => this.traceabilityCommands.bulkCreateTests() },
        { command: "playwrightBddRunner.traceability.createTestSet", title: "Create Test Set…", category: CATEGORY, handler: () => this.traceabilityCommands.createTestSet() },
        { command: "playwrightBddRunner.traceability.createTestPlan", title: "Create Test Plan…", category: CATEGORY, handler: () => this.traceabilityCommands.createTestPlan() },
        { command: "playwrightBddRunner.traceability.createTestExecution", title: "Create Test Execution…", category: CATEGORY, handler: () => this.traceabilityCommands.createTestExecution() },
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

  public registerBoardSerializer(context: vscode.ExtensionContext): void {
    this.traceabilityCommands.registerBoardSerializer(context);
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
    this.commands.set(options.command, { title: options.title, disposable });
    context.subscriptions.push(disposable);
  }

  /** Registered id → the title its failure messages name. The manifest must declare the same string. */
  public get registeredTitles(): ReadonlyMap<string, string> {
    return new Map([...this.commands].map(([command, { title }]) => [command, title]));
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

  private showErrorMessage(message: string): void {
    vscode.window.showErrorMessage(message);
  }

  public dispose(): void {
    for (const { disposable } of this.commands.values()) {
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
      // the tree from the now-active strategy. A single `items.replace()` is the canonical
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

    // Multiple matches (ambiguous step): let VS Code show its definition picker/peek.
    await vscode.commands.executeCommand(
      "editor.action.goToLocations",
      doc.uri,
      position,
      locations,
      "goto",
      "No matching step definition found."
    );
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
