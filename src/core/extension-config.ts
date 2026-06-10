import * as vscode from "vscode";
import { ConfigurationChangeListener } from "../types";

const CONFIG_NAMESPACE = "playwrightBddRunner";

export const MAX_PARALLEL_PROCESSES_MIN = 1;
export const MAX_PARALLEL_PROCESSES_MAX = 16;

export class ExtensionConfig {
  private config: vscode.WorkspaceConfiguration;
  private changeListeners: ConfigurationChangeListener[] = [];
  private configChangeSubscription: vscode.Disposable | undefined;

  constructor(
    workspaceConfig?: vscode.WorkspaceConfiguration,
    setupChangeListener = true
  ) {
    this.config = workspaceConfig ?? vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    if (setupChangeListener) {this.setupConfigurationChangeListener();}
  }

  public static create(
    workspaceConfig?: vscode.WorkspaceConfiguration,
    setupChangeListener = true
  ): ExtensionConfig {
    return new ExtensionConfig(workspaceConfig, setupChangeListener);
  }

  private setupConfigurationChangeListener(): void {
    this.configChangeSubscription = vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(CONFIG_NAMESPACE)) {
        this.config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
        this.notifyChangeListeners();
      }
    });
  }

  public addChangeListener(listener: ConfigurationChangeListener): vscode.Disposable {
    this.changeListeners.push(listener);
    return {
      dispose: () => {
        const index = this.changeListeners.indexOf(listener);
        if (index > -1) {this.changeListeners.splice(index, 1);}
      },
    };
  }

  private notifyChangeListeners(): void {
    this.changeListeners.forEach((listener) => listener());
  }

  public get playwrightCommand(): string {
    return this.config.get<string>("playwrightCommand", "npx playwright test");
  }

  public get bddgenCommand(): string {
    return this.config.get<string>("bddgenCommand", "npx bddgen");
  }

  public get preRunCommand(): string {
    return this.config.get<string>("preRunCommand", "");
  }

  public get workingDirectory(): string {
    return this.config.get<string>("workingDirectory", "");
  }

  public get featuresGenDir(): string {
    const value = this.config.get<string>("featuresGenDir", ".features-gen");
    return value.trim() === "" ? ".features-gen" : value;
  }

  public get enableCodeLens(): boolean {
    return this.config.get<boolean>("enableCodeLens", true);
  }

  public get testFilePattern(): string {
    return this.config.get<string>("testFilePattern", "**/*.feature");
  }

  public get parallelExecution(): boolean {
    return this.config.get<boolean>("parallelExecution", false);
  }

  public get maxParallelProcesses(): number {
    return this.config.get<number>("maxParallelProcesses", 4);
  }

  public get reporter(): string {
    return this.config.get<string>("reporter", "list");
  }

  public get tags(): string {
    return this.config.get<string>("tags", "");
  }

  public get dryRun(): boolean {
    return this.config.get<boolean>("dryRun", false);
  }

  public get stepDefinitionPaths(): string[] {
    return this.config.get<string[]>("stepDefinitionPaths", [
      "features/steps/**/*.ts",
      "features/steps/**/*.js",
      "tests/steps/**/*.ts",
      "steps/**/*.ts",
    ]);
  }

  public get enableStepDefinitionNavigation(): boolean {
    return this.config.get<boolean>("enableStepDefinitionNavigation", true);
  }

  public get enableStepDiagnostics(): boolean {
    return this.config.get<boolean>("enableStepDiagnostics", true);
  }

  public get stepAutocompleteMode(): "auto" | "on" | "off" {
    const raw = this.config.get<string>("enableStepAutocomplete", "auto");
    return raw === "on" || raw === "off" ? raw : "auto";
  }

  public get tagAutocompleteMode(): "auto" | "on" | "off" {
    const raw = this.config.get<string>("enableTagAutocomplete", "auto");
    return raw === "on" || raw === "off" ? raw : "auto";
  }

  public get stepHoverMode(): "auto" | "on" | "off" {
    const raw = this.config.get<string>("enableStepHover", "auto");
    return raw === "on" || raw === "off" ? raw : "auto";
  }

  public get stepReferencesMode(): "auto" | "on" | "off" {
    const raw = this.config.get<string>("enableStepReferences", "auto");
    return raw === "on" || raw === "off" ? raw : "auto";
  }

  public get stepUsageCodeLensMode(): "auto" | "on" | "off" {
    const raw = this.config.get<string>("enableStepUsageCodeLens", "auto");
    return raw === "on" || raw === "off" ? raw : "auto";
  }

  public get unusedStepDiagnosticsMode(): "auto" | "on" | "off" {
    const raw = this.config.get<string>("enableUnusedStepDiagnostics", "auto");
    return raw === "on" || raw === "off" ? raw : "auto";
  }

  public get stepLiteralPromotionMode(): "auto" | "on" | "off" {
    const raw = this.config.get<string>("enableStepLiteralPromotion", "auto");
    return raw === "on" || raw === "off" ? raw : "auto";
  }

  public get tableFormattingMode(): "auto" | "on" | "off" {
    const raw = this.config.get<string>("enableTableFormatting", "auto");
    return raw === "on" || raw === "off" ? raw : "auto";
  }

  public validate(): void {
    const errors: string[] = [];
    if (!this.testFilePattern || this.testFilePattern.trim() === "") {
      errors.push("testFilePattern cannot be empty");
    }
    if (!this.playwrightCommand || this.playwrightCommand.trim() === "") {
      errors.push("playwrightCommand cannot be empty");
    }
    if (
      this.maxParallelProcesses < MAX_PARALLEL_PROCESSES_MIN ||
      this.maxParallelProcesses > MAX_PARALLEL_PROCESSES_MAX
    ) {
      errors.push(
        `maxParallelProcesses must be between ${MAX_PARALLEL_PROCESSES_MIN} and ${MAX_PARALLEL_PROCESSES_MAX}`
      );
    }
    const validReporters = ["list", "line", "dot", "html", "json", "junit"];
    if (!validReporters.includes(this.reporter)) {
      errors.push(`reporter must be one of: ${validReporters.join(", ")}`);
    }
    if (errors.length > 0) {
      throw new Error(`Configuration validation failed: ${errors.join(", ")}`);
    }
  }

  public isValid(): boolean {
    try {
      this.validate();
      return true;
    } catch {
      return false;
    }
  }

  public getValidationErrors(): string[] {
    try {
      this.validate();
      return [];
    } catch (error) {
      return error instanceof Error ? [error.message] : [];
    }
  }

  public reload(): void {
    this.config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    this.notifyChangeListeners();
  }

  public dispose(): void {
    this.configChangeSubscription?.dispose();
    this.configChangeSubscription = undefined;
    this.changeListeners = [];
  }
}
