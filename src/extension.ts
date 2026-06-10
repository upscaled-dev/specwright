import * as vscode from "vscode";
import { Logger } from "./utils/logger";
import { PlaywrightBddTestProvider } from "./test-providers/playwright-bdd-test-provider";
import { CommandManager } from "./commands/command-manager";
import { ExtensionConfig } from "./core/extension-config";
import { FeatureParser } from "./parsers/feature-parser";
import { PlaywrightBddExtensionContext, Scenario } from "./types";
import { TestExecutor, ShellRunner } from "./core/test-executor";
import { TestDiscoveryManager } from "./core/test-discovery-manager";
import { TestOrganizationManager } from "./core/test-organization";
import { PlaywrightJsonParser } from "./utils/playwright-json-parser";
import { CommandBuilder } from "./core/command-builder";
import { ProviderRegistry } from "./core/provider-registry";
import { PROMPTED_STATE_KEY } from "./commands/prompt-worker-count";
import { StatusBar } from "./ui/status-bar";

let testProvider: PlaywrightBddTestProvider | undefined;
let commandManager: CommandManager | undefined;
let isActivated = false;
let testController: vscode.TestController | undefined;
let providerRegistry: ProviderRegistry | undefined;
let activationLogger: Logger | undefined;

/**
 * Test-only API surface. Not a public contract for other extensions.
 * @internal
 */
export interface ExtensionApi {
  readonly testProvider:
    | {
        readonly testIdToScenarioMap: ReadonlyMap<string, Scenario>;
        readonly registeredRunProfiles: readonly vscode.TestRunProfile[];
        readonly commandBuilder: CommandBuilder;
        /** @internal — integration-test hooks for the run→status path. */
        getItemStatus(id: string): "started" | "passed" | "failed" | undefined;
        overrideShellRunner(runner: ShellRunner): void;
        restoreShellRunner(): void;
      }
    | undefined;
  /** @internal */
  readonly providerRegistry:
    | {
        readonly codeLensActive: boolean;
        readonly definitionActive: boolean;
        readonly diagnosticsActive: boolean;
        readonly completionActive: boolean;
        readonly tagCompletionActive: boolean;
        readonly hoverActive: boolean;
        readonly stepReferencesActive: boolean;
        readonly stepUsageIndexActive: boolean;
        readonly usageCodeLensActive: boolean;
        readonly unusedStepDiagnosticsActive: boolean;
        readonly literalPromotionActive: boolean;
        readonly tableFormattingActive: boolean;
        readonly outlineActive: boolean;
        readonly bddgenDiagnosticsActive: boolean;
        readonly stepPaths: readonly string[];
      }
    | undefined;
  /** @internal */
  seedParallelProfilePrompted(value: boolean): Promise<void>;
}

function buildApi(
  provider: PlaywrightBddTestProvider | undefined,
  registry: ProviderRegistry | undefined,
  workspaceState: vscode.Memento | undefined
): ExtensionApi {
  const seedParallelProfilePrompted = async (value: boolean): Promise<void> => {
    if (!workspaceState) { return; }
    await workspaceState.update(PROMPTED_STATE_KEY, value);
  };
  const registryApi = registry
    ? {
        get codeLensActive() { return registry.codeLensActive; },
        get definitionActive() { return registry.definitionActive; },
        get diagnosticsActive() { return registry.diagnosticsActive; },
        get completionActive() { return registry.completionActive; },
        get tagCompletionActive() { return registry.tagCompletionActive; },
        get hoverActive() { return registry.hoverActive; },
        get stepReferencesActive() { return registry.stepReferencesActive; },
        get stepUsageIndexActive() { return registry.stepUsageIndexActive; },
        get usageCodeLensActive() { return registry.usageCodeLensActive; },
        get unusedStepDiagnosticsActive() { return registry.unusedStepDiagnosticsActive; },
        get literalPromotionActive() { return registry.literalPromotionActive; },
        get tableFormattingActive() { return registry.tableFormattingActive; },
        get outlineActive() { return registry.outlineActive; },
        get bddgenDiagnosticsActive() { return registry.bddgenDiagnosticsActive; },
        get stepPaths() { return registry.stepPaths; },
      }
    : undefined;
  if (!provider) {
    return { testProvider: undefined, providerRegistry: registryApi, seedParallelProfilePrompted };
  }
  return {
    testProvider: {
      get testIdToScenarioMap() { return provider.testIdToScenarioMap; },
      get registeredRunProfiles() { return provider.registeredRunProfiles; },
      get commandBuilder() { return provider.commandBuilder; },
      getItemStatus: (id: string) => provider.getItemStatus(id),
      overrideShellRunner: (runner: ShellRunner) => provider.overrideShellRunner(runner),
      restoreShellRunner: () => provider.restoreShellRunner(),
    },
    providerRegistry: registryApi,
    seedParallelProfilePrompted,
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  // Nothing is awaited during activation yet; this keeps the async contract (and the
  // require-await lint rule) satisfied so future async setup won't change the signature.
  await Promise.resolve();

  if (isActivated) {
    activationLogger?.warn("Extension already activated, skipping duplicate activation");
    return buildApi(testProvider, providerRegistry, context.workspaceState);
  }

  const logger = Logger.create();
  activationLogger = logger;
  const config = ExtensionConfig.create();
  context.subscriptions.push(config);
  const featureParser = FeatureParser.create(logger);
  const commandBuilder = CommandBuilder.create(config, logger);

  const testExecutor = TestExecutor.create(
    undefined,
    undefined,
    undefined,
    config,
    logger,
    PlaywrightJsonParser.create(logger)
  );
  context.subscriptions.push(testExecutor);

  providerRegistry = new ProviderRegistry(config, featureParser, logger);
  context.subscriptions.push(providerRegistry);

  const sharedContext: PlaywrightBddExtensionContext = {
    logger,
    config,
    testExecutor,
    discoveryManager: TestDiscoveryManager.create(logger, config),
    organizationManager: TestOrganizationManager.create(logger),
    featureParser,
    playwrightJsonParser: PlaywrightJsonParser.create(logger),
    commandBuilder,
    bddgenDiagnostics: providerRegistry.bddgenDiagnostics,
  };

  testExecutor.setContext(sharedContext);

  logger.info("🚀 Specwright is activating");

  try {
    if (!config.isValid()) {
      const errors = config.getValidationErrors();
      logger.warn("Configuration validation failed during activation", { errors });
      vscode.window.showWarningMessage(
        `Specwright configuration has issues: ${errors.join(", ")}`
      );
    }

    const controllerId = "playwrightBddRunner";
    testController = vscode.tests.createTestController(controllerId, "Specwright Tests");
    context.subscriptions.push(testController);

    testProvider = PlaywrightBddTestProvider.create(testController, sharedContext, context.workspaceState);
    context.subscriptions.push(testProvider);

    testProvider.discoverTests().catch((error) => {
      logger.error("Error during initial test discovery:", {
        error: error instanceof Error ? error.message : String(error),
      });
    });

    commandManager = CommandManager.create(sharedContext);
    commandManager.registerCommands(context);
    context.subscriptions.push(commandManager);
    commandManager.setTestProvider(testProvider as unknown);

    providerRegistry.applyCurrent();

    const statusBar = StatusBar.create(testExecutor);
    context.subscriptions.push(statusBar);

    isActivated = true;
    logger.info("✅ Specwright activated");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error("❌ Error during extension activation:", { error: errorMessage });
    vscode.window.showErrorMessage(
      `Failed to activate Specwright: ${errorMessage}`
    );
  }

  return buildApi(testProvider, providerRegistry, context.workspaceState);
}

export function deactivate(): void {
  const logger = activationLogger;
  logger?.info("👋 Specwright is deactivating");

  try {
    commandManager?.dispose();
    testProvider?.dispose();
    testController?.dispose();
    logger?.info("✅ Extension cleanup completed");
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger?.error("Error during extension deactivation", { error: errorMessage });
  } finally {
    isActivated = false;
    testProvider = undefined;
    commandManager = undefined;
    testController = undefined;
    providerRegistry = undefined;
    activationLogger = undefined;
    // The logger must outlive every log call above, so it is disposed last.
    try { logger?.dispose(); } catch { /* already disposed */ }
  }
}
