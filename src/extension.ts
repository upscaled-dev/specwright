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
import { TraceabilitySubsystem } from "./traceability/traceability-subsystem";
import { RunResultStore } from "./traceability/run-result-store";
import { RunArtifactStore } from "./traceability/run-artifact-store";
import { TraceabilityAdapterRegistry } from "./traceability/adapter-registry";
import { createInMemoryAdapterFactory } from "./traceability/in-memory-adapter";
import { createXrayAdapterFactory, XrayPublishSupport } from "./xray/xray-adapter-factory";
import { makeFeatureStepResolver } from "./xray/feature-step-resolver";
import { PublishLedger } from "./traceability/publish-ledger";
import { probeXrayConnection, type XrayConnectionTestDeps, type XrayProbeOptions } from "./xray/xray-connection-test";
import { XrayCredentialStore } from "./xray/xray-credential-store";
import { singleFlight } from "./utils/single-flight";
import { PROMPTED_STATE_KEY } from "./commands/prompt-worker-count";
import { StatusBar } from "./ui/status-bar";

let testProvider: PlaywrightBddTestProvider | undefined;
let commandManager: CommandManager | undefined;
let isActivated = false;
let testController: vscode.TestController | undefined;
let providerRegistry: ProviderRegistry | undefined;
let traceabilitySubsystem: TraceabilitySubsystem | undefined;
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
        readonly stepsPanelActive: boolean;
        readonly stepPaths: readonly string[];
      }
    | undefined;
  /** @internal */
  readonly traceabilitySubsystem:
    | {
        readonly traceabilityPanelActive: boolean;
      }
    | undefined;
  /** @internal */
  seedParallelProfilePrompted(value: boolean): Promise<void>;
}

function buildApi(
  provider: PlaywrightBddTestProvider | undefined,
  registry: ProviderRegistry | undefined,
  traceability: TraceabilitySubsystem | undefined,
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
        get stepsPanelActive() { return registry.stepsPanelActive; },
        get stepPaths() { return registry.stepPaths; },
      }
    : undefined;
  const traceabilityApi = traceability
    ? {
        get traceabilityPanelActive() { return traceability.traceabilityPanelActive; },
      }
    : undefined;
  if (!provider) {
    return {
      testProvider: undefined,
      providerRegistry: registryApi,
      traceabilitySubsystem: traceabilityApi,
      seedParallelProfilePrompted,
    };
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
    traceabilitySubsystem: traceabilityApi,
    seedParallelProfilePrompted,
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  // Nothing is awaited during activation yet; this keeps the async contract (and the
  // require-await lint rule) satisfied so future async setup won't change the signature.
  await Promise.resolve();

  if (isActivated) {
    activationLogger?.warn("Extension already activated, skipping duplicate activation");
    return buildApi(testProvider, providerRegistry, traceabilitySubsystem, context.workspaceState);
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

  const credentialStore = new XrayCredentialStore(context.secrets);
  context.subscriptions.push(credentialStore);
  // One session-scoped store shared by the run seams (test executor + debug path) and the panel, so
  // Test Explorer run/debug outcomes feed live badges (§3.5).
  const runResultStore = new RunResultStore();
  context.subscriptions.push(runResultStore);
  // The publishable sibling of the badge store, fed at the same seams and persisted to
  // workspaceState so the last few runs survive a reload.
  const runArtifactStore = new RunArtifactStore(context.workspaceState, logger);
  // The publish idempotency ledger (last few publishes, current-site scoped) — persisted alongside
  // the artifacts so the "already published" banner survives a reload.
  const publishLedger = new PublishLedger(context.workspaceState, logger);
  const traceabilityRegistry = new TraceabilityAdapterRegistry();
  // One credential-save event fans out into the subsystem's connection-refresh verify and the setup
  // panel's post-save verify; keyed by (site, authOnly), coincident identical probes share a single
  // handshake instead of racing three of them (§12 F5 finding #3).
  const probe = singleFlight(
    (deps: XrayConnectionTestDeps, options?: XrayProbeOptions) =>
      `${deps.site} ${options?.authOnly ? "auth" : "full"}`,
    probeXrayConnection
  );
  const publishSupport: XrayPublishSupport = {
    resolveSteps: makeFeatureStepResolver(featureParser),
    workspaceRootFor: (filePath) => vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath,
  };
  const xrayFactory = createXrayAdapterFactory(credentialStore, probe, context.globalState, publishSupport);
  traceabilityRegistry.register(xrayFactory);
  // Not in the public settings enum — resolved only from a hand-typed `traceability.provider`
  // value so the contract-test adapter can be driven in a dev window.
  traceabilityRegistry.register(createInMemoryAdapterFactory());
  traceabilitySubsystem = new TraceabilitySubsystem(
    config,
    traceabilityRegistry,
    featureParser,
    TestDiscoveryManager.create(logger, config),
    PlaywrightJsonParser.create(logger),
    runResultStore,
    logger,
    context.workspaceState
  );
  context.subscriptions.push(traceabilitySubsystem);
  // Thread scenario→testKey from the snapshot into every artifact capture (Test Explorer runs
  // included), so a mapped scenario's result carries its key and `latestOutcome(testKey)` lights up.
  // The factory is invoked per batch, freezing one snapshot for the whole artifact.
  const subsystemForKeys = traceabilitySubsystem;
  runArtifactStore.setKeyResolver(() => subsystemForKeys.captureKeyResolver());

  // The command context needs a browse-URL adapter for the active provider; construct one from the
  // registry (Xray fallback) and own its lifetime if it holds resources.
  const traceabilityAdapter =
    traceabilityRegistry.create(config.traceabilityProvider, { config, logger }) ??
    xrayFactory.create({ config, logger });
  if (typeof traceabilityAdapter.dispose === "function") {
    context.subscriptions.push(traceabilityAdapter as vscode.Disposable);
  }

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
    traceabilityAdapter,
    runResultStore,
    runArtifactStore,
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
    commandManager.setUsageIndexHost(providerRegistry);
    commandManager.setCredentialStore(credentialStore);
    commandManager.setXrayProbe(probe);
    commandManager.setPublishLedger(publishLedger);
    commandManager.setTraceabilitySubsystem(traceabilitySubsystem);
    // After the setters above, so a Coverage Board tab revived from the previous window reads deps that
    // are fully wired.
    commandManager.registerBoardSerializer(context);

    providerRegistry.applyCurrent();
    traceabilitySubsystem.applyCurrent();

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

  return buildApi(testProvider, providerRegistry, traceabilitySubsystem, context.workspaceState);
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
    traceabilitySubsystem = undefined;
    activationLogger = undefined;
    // The logger must outlive every log call above, so it is disposed last.
    try { logger?.dispose(); } catch { /* already disposed */ }
  }
}
