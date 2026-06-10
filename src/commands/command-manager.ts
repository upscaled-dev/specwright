import * as vscode from "vscode";
import * as fs from "node:fs";
import { Logger } from "../utils/logger";
import { CommandArguments, CommandHandler, ParsedFeature, PlaywrightBddExtensionContext, TestExecutionOptions } from "../types";
import { RunOutputResult } from "../core/test-executor";
import { GenerateStepsCommand } from "./generate-steps";
import { StepResolver, UnmatchedStep } from "../providers/step-resolver";
import { StepDefinitionProvider } from "../providers/step-definition-provider";

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

function errMsg(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

export class CommandManager {
  private readonly commands = new Map<string, vscode.Disposable>();
  private readonly context: PlaywrightBddExtensionContext;
  private testProvider: unknown;
  private readonly parsedFeatureCache = new Map<string, { mtimeMs: number; parsed: ParsedFeature }>();
  private generateStepsCommand: GenerateStepsCommand | undefined;
  private generateStepsResolver: StepResolver | undefined;

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
    const provider = new StepDefinitionProvider(this.context.config.stepDefinitionPaths, this.logger);
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
