import * as vscode from "vscode";
import { Logger } from "./utils/logger";
import { SupportDiagnostics } from "./core/support-diagnostics";
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
import { probeXrayConnection } from "./xray/xray-connection-test";
import { XrayCredentialStore } from "./xray/xray-credential-store";
import { PROMPTED_STATE_KEY } from "./commands/prompt-worker-count";
import { StatusBar } from "./ui/status-bar";
import { LegacyDirectExecutionGateway } from "./core/execution-gateway";
import { ExecutionAdmission, FileAdmissionStore } from "./core/execution-admission";
import { errMsg } from "./utils/text";
import { WorkspaceTrust } from "./core/workspace-trust";
import {
  CORE_SCHEMA_PROFILE,
  developmentHostEngine,
  ExecutionSelectionOwner,
  LEGACY_SCHEMA_PROFILE,
  SelectedExecutionGateway,
} from "./core/execution-engine";
import { UnavailableCoreExecutionGateway } from "./core/core-client";
import {
  executionStorageRoot,
  ExecutionNamespaceMigration,
  CompatibleAdmissionStore,
  NamespacedStateStore,
} from "./core/execution-namespace";
import type { ExecutionEngine, ExecutionGateway, ExecutionIdentity } from "./core/run-contracts";
import { LegacyExecutionDiscovery } from "./core/legacy-discovery";
import { LegacyArtifactGateway } from "./ui/legacy-artifact-gateway";
import { SelectedArtifactCatalog } from "./ui/execution-artifacts";
import { XrayAdapter } from "./xray/xray-adapter";
import { XraySetupPanel } from "./xray/xray-setup-panel";
import {
  TRACEABILITY_VIEW_ID,
  TraceabilityViewProvider,
  type TraceabilityClientSignal,
} from "./traceability/traceability-view-provider";

let testProvider: PlaywrightBddTestProvider | undefined;
let commandManager: CommandManager | undefined;
let activeTestExecutor: TestExecutor | undefined;
let isActivated = false;
let testController: vscode.TestController | undefined;
let providerRegistry: ProviderRegistry | undefined;
let traceabilitySubsystem: TraceabilitySubsystem | undefined;
let traceabilityViewProvider: TraceabilityViewProvider | undefined;
let activationLogger: Logger | undefined;
let workspaceTrust: WorkspaceTrust | undefined;
let activeExecutionGateway: ExecutionGateway | undefined;

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
        applyCurrent(): Promise<void>;
      }
    | undefined;
  /** @internal */
  readonly traceabilityView:
    | {
        readonly clientReady: boolean;
        readonly acknowledgedFocusCount: number;
        readonly currentProjection: { readonly state: "ready" | "disconnected" | "empty" | "untrusted"; readonly total: number; readonly labels: readonly string[] };
        readonly onDidReceiveClientSignal: vscode.Event<TraceabilityClientSignal>;
      }
    | undefined;
  /** @internal */
  seedParallelProfilePrompted(value: boolean): Promise<void>;
}

function buildApi(
  provider: PlaywrightBddTestProvider | undefined,
  registry: ProviderRegistry | undefined,
  traceability: TraceabilitySubsystem | undefined,
  traceabilityView: TraceabilityViewProvider | undefined,
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
        applyCurrent: () => traceability.applyCurrent(),
      }
    : undefined;
  const traceabilityViewApi = traceabilityView
    ? {
        get clientReady() { return traceabilityView.clientReady; },
        get acknowledgedFocusCount() { return traceabilityView.acknowledgedFocusCount; },
        get currentProjection() { return traceabilityView.currentProjection; },
        onDidReceiveClientSignal: traceabilityView.onDidReceiveClientSignal,
      }
    : undefined;
  if (!provider) {
    return {
      testProvider: undefined,
      providerRegistry: registryApi,
      traceabilitySubsystem: traceabilityApi,
      traceabilityView: traceabilityViewApi,
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
    traceabilityView: traceabilityViewApi,
    seedParallelProfilePrompted,
  };
}

export async function activate(context: vscode.ExtensionContext): Promise<ExtensionApi> {
  const activationStartedAt = Date.now();
  // Nothing is awaited during activation yet; this keeps the async contract (and the
  // require-await lint rule) satisfied so future async setup won't change the signature.
  await Promise.resolve();

  if (isActivated) {
    activationLogger?.warn("Extension already activated, skipping duplicate activation");
    return buildApi(testProvider, providerRegistry, traceabilitySubsystem, traceabilityViewProvider, context.workspaceState);
  }

  const diagnostics = new SupportDiagnostics();
  context.subscriptions.push(diagnostics);
  const logger = Logger.create(undefined, undefined, diagnostics);
  activationLogger = logger;
  const config = ExtensionConfig.create();
  context.subscriptions.push(config);
  const featureParser = FeatureParser.create(logger);
  const discoveryManager = TestDiscoveryManager.create(logger, config);
  const commandBuilder = CommandBuilder.create(config, logger);
  workspaceTrust = new WorkspaceTrust(() => vscode.workspace.isTrusted);
  context.subscriptions.push(workspaceTrust);

  const testExecutor = TestExecutor.create(
    undefined,
    undefined,
    undefined,
    config,
    logger,
    PlaywrightJsonParser.create(logger)
  );
  activeTestExecutor = testExecutor;
  context.subscriptions.push(testExecutor);

  providerRegistry = new ProviderRegistry(config, featureParser, logger);
  context.subscriptions.push(providerRegistry);

  const credentialStore = new XrayCredentialStore(context.secrets, workspaceTrust);
  context.subscriptions.push(credentialStore);
  // One session-scoped store shared by the run seams (test executor + debug path) and the panel, so
  // Test Explorer run/debug outcomes feed live badges (§3.5).
  const runResultStore = new RunResultStore();
  context.subscriptions.push(runResultStore);
  const legacyIdentity: ExecutionIdentity = Object.freeze({
    engine: "legacy-direct",
    schemaProfile: LEGACY_SCHEMA_PROFILE,
  });
  const coreIdentity: ExecutionIdentity = Object.freeze({
    engine: "core-client",
    schemaProfile: CORE_SCHEMA_PROFILE,
  });
  const namespaceMigration = new ExecutionNamespaceMigration(context.workspaceState, legacyIdentity);
  await namespaceMigration.stateKeys(["specwright.runArtifacts"]);
  // The publishable sibling of the badge store, fed at the same seams and persisted within the
  // selected engine and schema profile so preview engines cannot consume legacy artifacts.
  const runArtifactStore = new RunArtifactStore(
    new NamespacedStateStore(context.workspaceState, legacyIdentity),
    logger
  );
  const namespacedAdmission = FileAdmissionStore.create(
    executionStorageRoot(context.globalStorageUri.fsPath, legacyIdentity)
  );
  const legacyAdmission = FileAdmissionStore.create(context.globalStorageUri.fsPath);
  const executionAdmission = new ExecutionAdmission(new CompatibleAdmissionStore(
    namespacedAdmission,
    legacyAdmission
  ));
  try {
    await executionAdmission.recover();
  } catch (error) {
    logger.error(`Execution admission recovery failed: ${errMsg(error)}`);
  }
  const legacyGateway = new LegacyDirectExecutionGateway(
    testExecutor,
    featureParser,
    workspaceTrust,
    executionAdmission,
    legacyIdentity,
    new LegacyExecutionDiscovery(discoveryManager, featureParser)
  );
  const selectedDevelopmentEngine = (): ExecutionEngine | undefined => {
    return developmentHostEngine(
      context.extensionMode === vscode.ExtensionMode.Development,
      process.env["SPECWRIGHT_EXECUTION_ENGINE"]
    );
  };
  const executionSelection = new ExecutionSelectionOwner({
    developmentHostEnvironment: selectedDevelopmentEngine,
  });
  const executionGateway = new SelectedExecutionGateway(
    executionSelection,
    {
      "legacy-direct": new LegacyArtifactGateway(
        legacyGateway,
        runArtifactStore,
        logger,
        testExecutor,
        () => traceabilitySubsystem?.getSnapshot()?.links.map((link) => link.scenario) ?? []
      ),
      "core-client": new UnavailableCoreExecutionGateway(coreIdentity),
    }
  );
  const artifactCatalog = new SelectedArtifactCatalog(executionSelection, new Map([
    [`${legacyIdentity.engine}:${legacyIdentity.schemaProfile}`, runArtifactStore],
  ]));
  context.subscriptions.push(artifactCatalog);
  activeExecutionGateway = executionGateway;
  context.subscriptions.push(executionGateway);
  // The publish idempotency ledger (last few publishes, current-site scoped) — persisted alongside
  // the artifacts so the "already published" banner survives a reload.
  const publishLedger = new PublishLedger(context.workspaceState, logger);
  await publishLedger.ready();
  const traceabilityRegistry = new TraceabilityAdapterRegistry();
  // The setup panel and live adapter have independent cancellation owners. Keep their probes
  // independent so either lifecycle can abort and drain its own request without pinning the other.
  const probe = probeXrayConnection;
  const publishSupport: XrayPublishSupport = {
    resolveSteps: makeFeatureStepResolver(featureParser),
    workspaceRootFor: (filePath) => vscode.workspace.getWorkspaceFolder(vscode.Uri.file(filePath))?.uri.fsPath,
  };
  const xrayFactory = createXrayAdapterFactory(
    credentialStore,
    probe,
    context.globalState,
    publishSupport,
    workspaceTrust
  );
  traceabilityRegistry.register(xrayFactory);
  // Not in the public settings enum — resolved only from a hand-typed `traceability.provider`
  // value so the contract-test adapter can be driven in a dev window.
  traceabilityRegistry.register(createInMemoryAdapterFactory({
    connected: context.extensionMode !== vscode.ExtensionMode.Production,
  }));
  traceabilityViewProvider = new TraceabilityViewProvider(
    vscode.Uri.joinPath(context.extensionUri, "dist"),
    logger
  );
  const traceabilityView = traceabilityViewProvider;
  traceabilityView.setTrusted(vscode.workspace.isTrusted);
  context.subscriptions.push(
    traceabilityView,
    vscode.window.registerWebviewViewProvider(TRACEABILITY_VIEW_ID, traceabilityView, {
      webviewOptions: { retainContextWhenHidden: true },
    })
  );
  traceabilitySubsystem = new TraceabilitySubsystem(
    config,
    traceabilityRegistry,
    featureParser,
    TestDiscoveryManager.create(logger, config),
    PlaywrightJsonParser.create(logger),
    runResultStore,
    logger,
    context.workspaceState,
    () => providerRegistry?.hasTraceabilityTags() ?? Promise.resolve(false),
    () => XraySetupPanel.close(),
    traceabilityView
  );
  context.subscriptions.push(traceabilitySubsystem);
  // Thread scenario→testKey from the snapshot into every artifact capture (Test Explorer runs
  // included), so a mapped scenario's result carries its key and `latestOutcome(testKey)` lights up.
  // The factory is invoked per batch, freezing one snapshot for the whole artifact.
  const subsystemForKeys = traceabilitySubsystem;
  runArtifactStore.setKeyResolver(() => subsystemForKeys.captureKeyResolver());

  // Commands need only offline grammar and browse URLs when the panel is off. The live adapter and
  // all of its subscriptions belong exclusively to TraceabilitySubsystem's reversible lifecycle.
  const traceabilityAdapter = new XrayAdapter(config);

  const sharedContext: PlaywrightBddExtensionContext = {
    logger,
    config,
    testExecutor,
    executionGateway,
    discoveryManager,
    organizationManager: TestOrganizationManager.create(logger),
    featureParser,
    playwrightJsonParser: PlaywrightJsonParser.create(logger),
    commandBuilder,
    workspaceTrust,
    attachmentSpoolRoot: context.globalStorageUri.fsPath,
    extensionUri: context.extensionUri,
    bddgenDiagnostics: providerRegistry.bddgenDiagnostics,
    traceabilityAdapter,
    runResultStore,
    runArtifactStore: artifactCatalog,
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

    testProvider = PlaywrightBddTestProvider.create(
      testController,
      sharedContext,
      context.workspaceState,
      () => executionSelection.begin().engine === "legacy-direct"
    );
    context.subscriptions.push(testProvider);

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
    traceabilitySubsystem.applyCurrent().catch((error) => {
      logger.warn("Traceability activation failed", { error: errMsg(error) });
    });
    context.subscriptions.push(vscode.workspace.onDidGrantWorkspaceTrust(() => {
      traceabilityView.setTrusted(true);
      providerRegistry?.applyCurrent();
      traceabilitySubsystem?.applyCurrent().catch((error) => {
        logger.warn("Traceability activation after granting workspace trust failed", {
          error: errMsg(error),
        });
      });
      testProvider?.onWorkspaceTrustGranted().catch((error) => {
        logger.warn("Test discovery after granting workspace trust failed", {
          error: errMsg(error),
        });
      });
    }));

    const statusBar = StatusBar.create(executionGateway);
    context.subscriptions.push(statusBar);

    isActivated = true;
    logger.info("✅ Specwright activated", { durationMs: Date.now() - activationStartedAt });
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : "Unknown error";
    logger.error("❌ Error during extension activation:", {
      error: errorMessage,
      durationMs: Date.now() - activationStartedAt,
    });
    vscode.window.showErrorMessage(
      `Failed to activate Specwright: ${errorMessage}`
    );
  }

  return buildApi(testProvider, providerRegistry, traceabilitySubsystem, traceabilityViewProvider, context.workspaceState);
}

export async function deactivate(): Promise<void> {
  const logger = activationLogger;
  const failures: Array<{ owner: string; error: string }> = [];
  const settleCleanup = async (
    owner: string,
    cleanup: (() => void | Promise<void>) | undefined
  ): Promise<void> => {
    if (!cleanup) {return;}
    try {
      await cleanup();
    } catch (error) {
      failures.push({ owner, error: errMsg(error).slice(0, 500) });
    }
  };
  try {
    logger?.info("👋 Specwright is deactivating");
  } catch (error) {
    failures.push({ owner: "deactivation reporter", error: errMsg(error).slice(0, 500) });
  }

  try {
    // Preserve dependency order while containing each owner independently. In particular, the
    // execution gateway releases its leases before the executor, and the traceability subsystem
    // releases its active adapter before the command adapter and trust owner are disposed.
    await settleCleanup("execution gateway", () => activeExecutionGateway?.dispose());
    await settleCleanup("command manager", () => commandManager?.dispose());
    await settleCleanup("test provider", () => testProvider?.dispose());
    await settleCleanup("test controller", () => testController?.dispose());
    await settleCleanup("provider registry", () => providerRegistry?.dispose());
    await settleCleanup("traceability subsystem", () => traceabilitySubsystem?.shutdown());
    await settleCleanup("workspace trust", () => workspaceTrust?.dispose());
    await settleCleanup("test executor", () => activeTestExecutor?.dispose());

    if (failures.length === 0) {
      logger?.info("✅ Extension cleanup completed");
    } else {
      logger?.error("Extension deactivation completed with cleanup failures", {
        error: failures.map(({ owner, error }) => `${owner}: ${error}`).join("; "),
      });
    }
  } finally {
    // The logger must outlive every report above and is still attempted if reporting itself throws.
    await settleCleanup("logger", () => logger?.dispose());
    isActivated = false;
    testProvider = undefined;
    commandManager = undefined;
    activeTestExecutor = undefined;
    testController = undefined;
    providerRegistry = undefined;
    traceabilitySubsystem = undefined;
    traceabilityViewProvider = undefined;
    activationLogger = undefined;
    workspaceTrust = undefined;
    activeExecutionGateway = undefined;
  }
}
