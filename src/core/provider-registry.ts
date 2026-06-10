import * as vscode from "vscode";
import { ExtensionConfig } from "./extension-config";
import { FeatureParser } from "../parsers/feature-parser";
import { Logger } from "../utils/logger";
import { StepDefinitionProvider } from "../providers/step-definition-provider";
import { StepResolver } from "../providers/step-resolver";
import { StepDiagnosticsProvider } from "../providers/step-diagnostics-provider";
import { StepCodeActionProvider } from "../providers/step-code-action-provider";
import { StepCompletionProvider } from "../providers/step-completion-provider";
import { StepHoverProvider } from "../providers/step-hover-provider";
import { TagCompletionProvider } from "../providers/tag-completion-provider";
import { TagIndex } from "../providers/tag-index";
import { StepUsageIndex } from "../providers/step-usage-index";
import { StepReferenceProvider } from "../providers/step-reference-provider";
import { StepUsageCodeLensProvider } from "../providers/step-usage-codelens-provider";
import { UnusedStepDiagnosticsProvider } from "../providers/unused-step-diagnostics-provider";
import { StepLiteralPromotionProvider } from "../providers/step-literal-promotion-provider";
import { FeatureDocumentSymbolProvider } from "../providers/feature-document-symbol-provider";
import { FeatureTableFormatter } from "../providers/feature-table-formatter";
import { BddgenDiagnosticsProvider } from "../providers/bddgen-diagnostics-provider";
import { isCucumberAutocompletePresent } from "../utils/cucumber-autocomplete-detector";

const FEATURE_SELECTORS: vscode.DocumentSelector = [
  { pattern: "**/*.feature", scheme: "file" },
  { language: "gherkin", scheme: "file" },
  { language: "feature", scheme: "file" },
];

export function shouldRegisterCompletion(
  mode: "auto" | "on" | "off",
  cucumberAutocompletePresent: boolean
): boolean {
  if (mode === "off") {return false;}
  if (mode === "on") {return true;}
  return !cucumberAutocompletePresent;
}

export class ProviderRegistry implements vscode.Disposable {
  private codeLensDisposable: vscode.Disposable | undefined;
  private definitionDisposable: vscode.Disposable | undefined;
  private diagnosticsProvider: StepDiagnosticsProvider | undefined;
  private codeActionDisposable: vscode.Disposable | undefined;
  private completionDisposable: vscode.Disposable | undefined;
  private tagCompletionDisposable: vscode.Disposable | undefined;
  private hoverDisposable: vscode.Disposable | undefined;
  private referencesDisposable: vscode.Disposable | undefined;
  private usageCodeLensDisposable: vscode.Disposable | undefined;
  private usageCodeLensProvider: StepUsageCodeLensProvider | undefined;
  private unusedStepDiagnostics: UnusedStepDiagnosticsProvider | undefined;
  private literalPromotionDisposable: vscode.Disposable | undefined;
  private tableFormattingDisposable: vscode.Disposable | undefined;
  private outlineDisposable: vscode.Disposable | undefined;
  private tagIndex: TagIndex | undefined;
  private stepUsageIndex: StepUsageIndex | undefined;
  private lastTagIndexPattern: string | undefined;
  private lastStepPaths: readonly string[] | undefined;
  private lastDiagnosticsStepPaths: readonly string[] | undefined;
  private lastCompletionStepPaths: readonly string[] | undefined;
  private lastHoverStepPaths: readonly string[] | undefined;
  private lastReferencesStepPaths: readonly string[] | undefined;
  private lastUsageCodeLensStepPaths: readonly string[] | undefined;
  private lastUnusedStepDiagnosticsPaths: readonly string[] | undefined;
  private lastLiteralPromotionStepPaths: readonly string[] | undefined;
  private lastUsageIndexStepPaths: readonly string[] | undefined;
  private readonly configChangeDisposable: vscode.Disposable;
  private readonly extensionsChangeDisposable: vscode.Disposable;
  private readonly stepResolver: StepResolver;
  private readonly bddgenDiagnosticsProvider: BddgenDiagnosticsProvider;
  private disposed = false;

  constructor(
    private readonly config: ExtensionConfig,
    private readonly featureParser: FeatureParser,
    private readonly logger: Logger
  ) {
    this.stepResolver = new StepResolver(logger);
    this.bddgenDiagnosticsProvider = new BddgenDiagnosticsProvider();
    this.configChangeDisposable = config.addChangeListener(() => this.applyCurrent());
    this.extensionsChangeDisposable = vscode.extensions.onDidChange(() => this.applyCurrent());
    this.registerStaticProviders();
  }

  public get bddgenDiagnostics(): BddgenDiagnosticsProvider {
    return this.bddgenDiagnosticsProvider;
  }

  public get bddgenDiagnosticsActive(): boolean {
    return !this.disposed;
  }

  private registerStaticProviders(): void {
    this.outlineDisposable = vscode.languages.registerDocumentSymbolProvider(
      FEATURE_SELECTORS,
      new FeatureDocumentSymbolProvider()
    );
  }

  /**
   * Idempotent reconciliation between current config and active registrations.
   * Relies on ExtensionConfig refreshing its cached WorkspaceConfiguration BEFORE
   * notifying listeners (see ExtensionConfig#setupConfigurationChangeListener) —
   * otherwise this would read stale values during a change event.
   */
  public applyCurrent(): void {
    if (this.disposed) {return;}
    if (this.config.enableCodeLens && !this.codeLensDisposable) {
      this.codeLensDisposable = vscode.languages.registerCodeLensProvider(
        { pattern: "**/*.feature", scheme: "file" },
        {
          provideCodeLenses: (document: vscode.TextDocument): vscode.CodeLens[] =>
            this.featureParser.provideScenarioCodeLenses(document.getText(), document.uri.fsPath),
        }
      );
    } else if (!this.config.enableCodeLens && this.codeLensDisposable) {
      this.codeLensDisposable.dispose();
      this.codeLensDisposable = undefined;
    }

    if (this.config.enableStepDefinitionNavigation) {
      const newPaths = this.config.stepDefinitionPaths;
      if (!this.definitionDisposable) {
        this.registerDefinitionProvider(newPaths);
      } else if (!arraysEqual(newPaths, this.lastStepPaths)) {
        this.definitionDisposable.dispose();
        this.registerDefinitionProvider(newPaths);
      }
    } else if (this.definitionDisposable) {
      this.definitionDisposable.dispose();
      this.definitionDisposable = undefined;
      this.lastStepPaths = undefined;
    }

    if (this.config.enableStepDiagnostics) {
      const diagPaths = this.config.stepDefinitionPaths;
      if (!this.diagnosticsProvider) {
        this.startDiagnostics(diagPaths);
      } else if (!arraysEqual(diagPaths, this.lastDiagnosticsStepPaths)) {
        this.diagnosticsProvider.setStepGlobs(diagPaths);
        this.lastDiagnosticsStepPaths = diagPaths;
      }
    } else if (this.diagnosticsProvider) {
      this.stopDiagnostics();
    }

    this.reconcileCompletion();
    this.reconcileTagCompletion();
    this.reconcileStepHover();
    this.reconcileStepReferences();
    this.reconcileStepUsageCodeLens();
    this.reconcileUnusedStepDiagnostics();
    this.reconcileStepLiteralPromotion();
    this.reconcileTableFormatting();
    this.reconcileUsageIndexGlobs();
  }

  private ensureUsageIndex(): StepUsageIndex {
    if (!this.stepUsageIndex) {
      this.stepUsageIndex = new StepUsageIndex(this.config, this.stepResolver, this.logger);
      this.lastUsageIndexStepPaths = this.config.stepDefinitionPaths;
    }
    return this.stepUsageIndex;
  }

  private reconcileUsageIndexGlobs(): void {
    if (!this.stepUsageIndex) {return;}
    const paths = this.config.stepDefinitionPaths;
    if (arraysEqual(paths, this.lastUsageIndexStepPaths)) {return;}
    // The shared index caches defs and watchers built from the old globs.
    this.stepUsageIndex.rescan();
    this.lastUsageIndexStepPaths = paths;
  }

  private reconcileTableFormatting(): void {
    const enabled = shouldRegisterCompletion(
      this.config.tableFormattingMode,
      isCucumberAutocompletePresent()
    );
    if (!enabled) {
      if (this.tableFormattingDisposable) {
        this.tableFormattingDisposable.dispose();
        this.tableFormattingDisposable = undefined;
      }
      return;
    }
    if (this.tableFormattingDisposable) {return;}
    this.tableFormattingDisposable = vscode.languages.registerDocumentFormattingEditProvider(
      FEATURE_SELECTORS,
      new FeatureTableFormatter()
    );
    this.logger.info("Feature table formatting enabled");
  }

  private reconcileStepLiteralPromotion(): void {
    const enabled = shouldRegisterCompletion(
      this.config.stepLiteralPromotionMode,
      isCucumberAutocompletePresent()
    );
    if (!enabled) {
      if (this.literalPromotionDisposable) {
        this.literalPromotionDisposable.dispose();
        this.literalPromotionDisposable = undefined;
        this.lastLiteralPromotionStepPaths = undefined;
      }
      return;
    }
    const paths = this.config.stepDefinitionPaths;
    if (!this.literalPromotionDisposable) {
      this.registerLiteralPromotionProvider(paths);
    } else if (!arraysEqual(paths, this.lastLiteralPromotionStepPaths)) {
      this.literalPromotionDisposable.dispose();
      this.registerLiteralPromotionProvider(paths);
    }
  }

  private registerLiteralPromotionProvider(paths: readonly string[]): void {
    const provider = new StepLiteralPromotionProvider(this.stepResolver, [...paths], this.logger);
    this.literalPromotionDisposable = vscode.languages.registerCodeActionsProvider(
      FEATURE_SELECTORS,
      provider,
      { providedCodeActionKinds: StepLiteralPromotionProvider.providedCodeActionKinds }
    );
    this.lastLiteralPromotionStepPaths = paths;
    this.logger.info(`Step literal promotion enabled (paths: ${paths.join(", ")})`);
  }

  private reconcileTagCompletion(): void {
    const enabled = shouldRegisterCompletion(
      this.config.tagAutocompleteMode,
      isCucumberAutocompletePresent()
    );
    if (!enabled) {
      if (this.tagCompletionDisposable) {
        this.tagCompletionDisposable.dispose();
        this.tagCompletionDisposable = undefined;
      }
      // Dispose the index too — otherwise its FileSystemWatcher keeps consuming events
      // for the whole session even when the feature is off.
      if (this.tagIndex) {
        this.tagIndex.dispose();
        this.tagIndex = undefined;
        this.lastTagIndexPattern = undefined;
      }
      return;
    }
    const currentPattern = this.config.testFilePattern;
    if (this.tagIndex && this.lastTagIndexPattern !== currentPattern) {
      this.tagCompletionDisposable?.dispose();
      this.tagCompletionDisposable = undefined;
      this.tagIndex.dispose();
      this.tagIndex = undefined;
      this.lastTagIndexPattern = undefined;
    }
    if (this.tagCompletionDisposable) {return;}
    if (!this.tagIndex) {
      this.tagIndex = new TagIndex(this.logger, this.config);
      this.lastTagIndexPattern = currentPattern;
    }
    this.tagCompletionDisposable = vscode.languages.registerCompletionItemProvider(
      FEATURE_SELECTORS,
      new TagCompletionProvider(this.tagIndex),
      "@"
    );
    this.logger.info("Tag autocomplete enabled");
  }

  private reconcileCompletion(): void {
    const enabled = shouldRegisterCompletion(
      this.config.stepAutocompleteMode,
      isCucumberAutocompletePresent()
    );
    if (!enabled) {
      if (this.completionDisposable) {
        this.completionDisposable.dispose();
        this.completionDisposable = undefined;
        this.lastCompletionStepPaths = undefined;
      }
      return;
    }
    const paths = this.config.stepDefinitionPaths;
    if (!this.completionDisposable) {
      this.registerCompletionProvider(paths);
    } else if (!arraysEqual(paths, this.lastCompletionStepPaths)) {
      this.completionDisposable.dispose();
      this.registerCompletionProvider(paths);
    }
  }

  private reconcileStepReferences(): void {
    const enabled = shouldRegisterCompletion(
      this.config.stepReferencesMode,
      isCucumberAutocompletePresent()
    );
    if (!enabled) {
      if (this.referencesDisposable) {
        this.referencesDisposable.dispose();
        this.referencesDisposable = undefined;
        this.lastReferencesStepPaths = undefined;
      }
      this.maybeDisposeUsageIndex();
      return;
    }
    const paths = this.config.stepDefinitionPaths;
    if (!this.referencesDisposable) {
      this.registerReferenceProvider(paths);
    } else if (!arraysEqual(paths, this.lastReferencesStepPaths)) {
      this.referencesDisposable.dispose();
      this.registerReferenceProvider(paths);
    }
  }

  private registerReferenceProvider(paths: readonly string[]): void {
    const provider = new StepReferenceProvider(this.stepResolver, this.ensureUsageIndex(), [...paths]);
    const selector: vscode.DocumentSelector = paths.map((pattern) => ({ pattern, scheme: "file" }));
    this.referencesDisposable = vscode.languages.registerReferenceProvider(selector, provider);
    this.lastReferencesStepPaths = paths;
    this.logger.info(`Step references enabled (paths: ${paths.join(", ")})`);
  }

  private reconcileStepUsageCodeLens(): void {
    const enabled = shouldRegisterCompletion(
      this.config.stepUsageCodeLensMode,
      isCucumberAutocompletePresent()
    );
    if (!enabled) {
      if (this.usageCodeLensDisposable) {
        this.usageCodeLensDisposable.dispose();
        this.usageCodeLensDisposable = undefined;
        this.lastUsageCodeLensStepPaths = undefined;
      }
      if (this.usageCodeLensProvider) {
        this.usageCodeLensProvider.dispose();
        this.usageCodeLensProvider = undefined;
      }
      this.maybeDisposeUsageIndex();
      return;
    }
    const paths = this.config.stepDefinitionPaths;
    if (!this.usageCodeLensDisposable) {
      this.registerUsageCodeLensProvider(paths);
    } else if (!arraysEqual(paths, this.lastUsageCodeLensStepPaths)) {
      this.usageCodeLensDisposable.dispose();
      this.usageCodeLensProvider?.dispose();
      this.usageCodeLensProvider = undefined;
      this.registerUsageCodeLensProvider(paths);
    }
  }

  private registerUsageCodeLensProvider(paths: readonly string[]): void {
    const provider = new StepUsageCodeLensProvider(this.ensureUsageIndex());
    const selector: vscode.DocumentSelector = paths.map((pattern) => ({ pattern, scheme: "file" }));
    this.usageCodeLensDisposable = vscode.languages.registerCodeLensProvider(selector, provider);
    this.usageCodeLensProvider = provider;
    this.lastUsageCodeLensStepPaths = paths;
    this.logger.info(`Step usage CodeLens enabled (paths: ${paths.join(", ")})`);
  }

  private reconcileUnusedStepDiagnostics(): void {
    const enabled = shouldRegisterCompletion(
      this.config.unusedStepDiagnosticsMode,
      isCucumberAutocompletePresent()
    );
    if (!enabled) {
      if (this.unusedStepDiagnostics) {
        this.unusedStepDiagnostics.dispose();
        this.unusedStepDiagnostics = undefined;
        this.lastUnusedStepDiagnosticsPaths = undefined;
      }
      this.maybeDisposeUsageIndex();
      return;
    }
    const paths = this.config.stepDefinitionPaths;
    if (!this.unusedStepDiagnostics) {
      this.startUnusedStepDiagnostics(paths);
    } else if (!arraysEqual(paths, this.lastUnusedStepDiagnosticsPaths)) {
      this.unusedStepDiagnostics.setStepGlobs(paths);
      this.lastUnusedStepDiagnosticsPaths = paths;
    }
  }

  private startUnusedStepDiagnostics(paths: readonly string[]): void {
    const provider = new UnusedStepDiagnosticsProvider(
      this.stepResolver,
      this.ensureUsageIndex(),
      paths,
      this.logger
    );
    provider.start();
    this.unusedStepDiagnostics = provider;
    this.lastUnusedStepDiagnosticsPaths = paths;
    this.logger.info(`Unused step diagnostics enabled (paths: ${paths.join(", ")})`);
  }

  private maybeDisposeUsageIndex(): void {
    if (this.referencesDisposable || this.usageCodeLensDisposable || this.unusedStepDiagnostics) {return;}
    if (this.stepUsageIndex) {
      this.stepUsageIndex.dispose();
      this.stepUsageIndex = undefined;
      this.lastUsageIndexStepPaths = undefined;
    }
  }

  private reconcileStepHover(): void {
    const enabled = shouldRegisterCompletion(
      this.config.stepHoverMode,
      isCucumberAutocompletePresent()
    );
    if (!enabled) {
      if (this.hoverDisposable) {
        this.hoverDisposable.dispose();
        this.hoverDisposable = undefined;
        this.lastHoverStepPaths = undefined;
      }
      return;
    }
    const paths = this.config.stepDefinitionPaths;
    if (!this.hoverDisposable) {
      this.registerHoverProvider(paths);
    } else if (!arraysEqual(paths, this.lastHoverStepPaths)) {
      this.hoverDisposable.dispose();
      this.registerHoverProvider(paths);
    }
  }

  public get codeLensActive(): boolean {
    return this.codeLensDisposable !== undefined;
  }

  public get definitionActive(): boolean {
    return this.definitionDisposable !== undefined;
  }

  public get diagnosticsActive(): boolean {
    return this.diagnosticsProvider !== undefined;
  }

  public get completionActive(): boolean {
    return this.completionDisposable !== undefined;
  }

  public get tagCompletionActive(): boolean {
    return this.tagCompletionDisposable !== undefined;
  }

  public get hoverActive(): boolean {
    return this.hoverDisposable !== undefined;
  }

  public get stepReferencesActive(): boolean {
    return this.referencesDisposable !== undefined;
  }

  public get stepUsageIndexActive(): boolean {
    return this.stepUsageIndex !== undefined;
  }

  public get usageCodeLensActive(): boolean {
    return this.usageCodeLensDisposable !== undefined;
  }

  public get unusedStepDiagnosticsActive(): boolean {
    return this.unusedStepDiagnostics !== undefined;
  }

  public get literalPromotionActive(): boolean {
    return this.literalPromotionDisposable !== undefined;
  }

  public get tableFormattingActive(): boolean {
    return this.tableFormattingDisposable !== undefined;
  }

  public get outlineActive(): boolean {
    return this.outlineDisposable !== undefined;
  }

  public get stepPaths(): readonly string[] {
    return this.lastStepPaths ?? [];
  }

  public dispose(): void {
    this.disposed = true;
    this.configChangeDisposable.dispose();
    this.extensionsChangeDisposable.dispose();
    this.codeLensDisposable?.dispose();
    this.codeLensDisposable = undefined;
    this.definitionDisposable?.dispose();
    this.definitionDisposable = undefined;
    this.completionDisposable?.dispose();
    this.completionDisposable = undefined;
    this.lastCompletionStepPaths = undefined;
    this.tagCompletionDisposable?.dispose();
    this.tagCompletionDisposable = undefined;
    this.tagIndex?.dispose();
    this.tagIndex = undefined;
    this.lastTagIndexPattern = undefined;
    this.hoverDisposable?.dispose();
    this.hoverDisposable = undefined;
    this.lastHoverStepPaths = undefined;
    this.referencesDisposable?.dispose();
    this.referencesDisposable = undefined;
    this.lastReferencesStepPaths = undefined;
    this.usageCodeLensDisposable?.dispose();
    this.usageCodeLensDisposable = undefined;
    this.lastUsageCodeLensStepPaths = undefined;
    this.usageCodeLensProvider?.dispose();
    this.usageCodeLensProvider = undefined;
    this.unusedStepDiagnostics?.dispose();
    this.unusedStepDiagnostics = undefined;
    this.lastUnusedStepDiagnosticsPaths = undefined;
    this.literalPromotionDisposable?.dispose();
    this.literalPromotionDisposable = undefined;
    this.lastLiteralPromotionStepPaths = undefined;
    this.tableFormattingDisposable?.dispose();
    this.tableFormattingDisposable = undefined;
    this.outlineDisposable?.dispose();
    this.outlineDisposable = undefined;
    this.stepUsageIndex?.dispose();
    this.stepUsageIndex = undefined;
    this.lastUsageIndexStepPaths = undefined;
    this.stopDiagnostics();
    this.stepResolver.dispose();
    this.bddgenDiagnosticsProvider.dispose();
  }

  private registerDefinitionProvider(paths: readonly string[]): void {
    const provider = new StepDefinitionProvider([...paths], this.logger, this.stepResolver);
    this.definitionDisposable = vscode.languages.registerDefinitionProvider(
      FEATURE_SELECTORS,
      provider
    );
    this.lastStepPaths = paths;
    this.logger.info(`Step definition navigation enabled (paths: ${paths.join(", ")})`);
  }

  private startDiagnostics(paths: readonly string[]): void {
    const provider = new StepDiagnosticsProvider(this.stepResolver, this.config, this.logger);
    provider.start();
    this.diagnosticsProvider = provider;
    this.lastDiagnosticsStepPaths = paths;

    const codeActionProvider = new StepCodeActionProvider(provider);
    this.codeActionDisposable = vscode.languages.registerCodeActionsProvider(
      FEATURE_SELECTORS,
      codeActionProvider,
      { providedCodeActionKinds: StepCodeActionProvider.providedCodeActionKinds }
    );
    this.logger.info("Step diagnostics + code actions enabled");
  }

  private registerCompletionProvider(paths: readonly string[]): void {
    const provider = new StepCompletionProvider([...paths], this.stepResolver, this.logger);
    this.completionDisposable = vscode.languages.registerCompletionItemProvider(
      FEATURE_SELECTORS,
      provider
    );
    this.lastCompletionStepPaths = paths;
    this.logger.info(`Step autocomplete enabled (paths: ${paths.join(", ")})`);
  }

  private registerHoverProvider(paths: readonly string[]): void {
    const provider = new StepHoverProvider([...paths], this.stepResolver, this.logger);
    this.hoverDisposable = vscode.languages.registerHoverProvider(
      FEATURE_SELECTORS,
      provider
    );
    this.lastHoverStepPaths = paths;
    this.logger.info(`Step hover enabled (paths: ${paths.join(", ")})`);
  }

  private stopDiagnostics(): void {
    this.codeActionDisposable?.dispose();
    this.codeActionDisposable = undefined;
    this.diagnosticsProvider?.dispose();
    this.diagnosticsProvider = undefined;
    this.lastDiagnosticsStepPaths = undefined;
  }
}

function arraysEqual(
  a: readonly string[] | undefined,
  b: readonly string[] | undefined
): boolean {
  if (!a || !b) {return a === b;}
  if (a.length !== b.length) {return false;}
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {return false;}
  }
  return true;
}
