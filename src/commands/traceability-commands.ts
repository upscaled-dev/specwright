import * as vscode from "vscode";
import { ExtensionConfig } from "../core/extension-config";
import { FeatureParser } from "../parsers/feature-parser";
import {
  buildBoardViewModel,
  buildExecutionRows,
  RENDERING_PROGRESS,
  syncProgressText,
} from "../traceability/board-data";
import { affectsBoard, BoardPanel, BoardPanelDeps } from "../traceability/board-panel";
import { SyncScope, TraceabilityAdapter } from "../traceability/contracts";
import { NO_MAPPING_PAGE_SIZE } from "../traceability/mapping-page-size";
import {
  NO_PROJECT_SCOPE,
  ProjectUniverseSources,
  resolveProjectUniverse,
  resolveSyncProjectKeys,
} from "../traceability/project-scope";
import { PublishLedger, STANDALONE_ARTIFACT_PREFIX } from "../traceability/publish-ledger";
import { RunArtifactStore } from "../traceability/run-artifact-store";
import type { TraceabilitySubsystem } from "../traceability/traceability-subsystem";
import { runTraceabilitySync } from "../traceability/traceability-sync";
import { Logger } from "../utils/logger";
import { errMsg } from "../utils/text";
import { normalizeSiteUrl } from "../xray/xray-adapter";
import { XrayConnectionCommands } from "../xray/xray-connection-commands";
import type { XrayProbe } from "../xray/xray-connection-test";
import {
  XrayCredentialStore,
  XrayCredentials,
  XrayJiraCredentials,
} from "../xray/xray-credential-store";
import { JiraAccessError, JiraProject, searchJiraProjects } from "../xray/jira-project-search";
import { TraceabilityAuthoringCommands } from "./traceability-authoring-commands";
import { TraceabilityLinkCommands } from "./traceability-link-commands";
import { TraceabilityPublishCommands } from "./traceability-publish-commands";
import { boardBatchSelection } from "./run-publish-selection";
import { commandArgFsPath } from "./run-commands";
import type { ExecutionGateway } from "../core/run-contracts";
import { ExecutionAlreadyRunningError, ExecutionFailure } from "../core/execution-gateway";

interface SyncRequest {
  readonly announce: boolean;
  readonly explicitKey?: string | undefined;
}

export interface TraceabilityCommandDeps {
  readonly config: ExtensionConfig;
  readonly fallbackAdapter: () => TraceabilityAdapter;
  readonly credentialStore: () => XrayCredentialStore | undefined;
  readonly xrayProbe: () => XrayProbe | undefined;
  readonly subsystem: () => TraceabilitySubsystem | undefined;
  readonly publishLedger: () => PublishLedger | undefined;
  readonly extensionUri: () => vscode.Uri | undefined;
  readonly runArtifactStore: RunArtifactStore | undefined;
  readonly executionGateway: ExecutionGateway;
  readonly featureParser: FeatureParser;
}

export class TraceabilityCommands {
  private linkCommands: TraceabilityLinkCommands | undefined;
  private publishCommands: TraceabilityPublishCommands | undefined;
  private authoringCommands: TraceabilityAuthoringCommands | undefined;
  private connectionCommands: XrayConnectionCommands | undefined;
  private syncInFlight: Promise<void> | undefined;
  private pendingLoad: string | undefined;
  private readonly boardChange = new vscode.EventEmitter<void>();

  constructor(private readonly logger: Logger, private readonly deps: TraceabilityCommandDeps) {}

  public registerBoardSerializer(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      BoardPanel.registerSerializer(() => {
        try {
          return this.boardDeps();
        } catch (error) {
          this.logger.error("Reviving the Coverage Board tab failed", {
            error: errMsg(error),
          });
          throw error;
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (affectsBoard(event) && BoardPanel.isOpen()) {
          this.deps.subsystem()?.scheduleRebuild();
        }
      })
    );
  }

  public openIssueInTracker(...args: unknown[]): Promise<void> {
    return this.getLinkCommands().openIssueInTracker(...args);
  }
  public copyIssueKey(...args: unknown[]): Promise<void> {
    return this.getLinkCommands().copyIssueKey(...args);
  }
  public linkScenario(...args: unknown[]): Promise<void> {
    return this.getLinkCommands().linkScenario(...args);
  }
  public runAndPublish(...args: unknown[]): Promise<void> {
    return this.getPublishCommands().runAndPublish(...args);
  }
  // The view-title button's own command: it names the whole mapped set, which the node command must
  // never infer from an empty argument list. "Whole" means whole within the board's project scope,
  // the same scope the board shows and the sync fetches.
  public runAndPublishAllMapped(): Promise<void> {
    const project = this.selectedProject();
    return this.getPublishCommands().runAndPublishSelection({
      kind: "all-mapped",
      ...(project ? { project } : {}),
    });
  }
  public runAndPublishFeature(arg?: unknown): Promise<void> {
    const filePath = commandArgFsPath(arg);
    return filePath
      ? this.getPublishCommands().runAndPublishSelection(
          { kind: "feature", filePath },
          "explorer"
        )
      : Promise.resolve();
  }
  public runAndPublishFolder(arg?: unknown): Promise<void> {
    const folderPath = commandArgFsPath(arg);
    return folderPath
      ? this.getPublishCommands().runAndPublishSelection(
          { kind: "folder", folderPath },
          "explorer"
        )
      : Promise.resolve();
  }
  public async runAndPublishByTagExpression(): Promise<void> {
    const expression = await vscode.window.showInputBox({
      title: "Run and Publish by Tag Expression",
      prompt: "Enter a playwright-bdd tag expression",
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() === "" ? "A tag expression is required." : undefined),
    });
    if (expression === undefined) {return;}
    await this.getPublishCommands().runAndPublishSelection(
      { kind: "tag-expression", expression },
      "palette"
    );
  }
  public publishLastRun(): Promise<void> {return this.getPublishCommands().publishLastRun();}
  public clearLocalRunHistory(): Promise<void> {
    return this.getPublishCommands().clearLocalRunHistory();
  }
  public manageConnection(): Promise<void> {return this.getConnectionCommands().manageConnection();}
  public connect(): Promise<void> {return this.getConnectionCommands().connect();}
  public disconnect(): Promise<void> {return this.getConnectionCommands().disconnect();}
  public testConnection(): Promise<void> {return this.getConnectionCommands().testConnection();}
  public bulkCreateTests(): Promise<void> {return this.getAuthoringCommands().bulkCreateTests();}
  public createTestSet(): Promise<void> {return this.getAuthoringCommands().createTestSet();}
  public createTestPlan(): Promise<void> {return this.getAuthoringCommands().createTestPlan();}
  public createTestExecution(): Promise<void> {return this.getAuthoringCommands().createTestExecution();}

  public openBoard(): void {
    const subsystem = this.deps.subsystem();
    if (!subsystem?.traceabilityPanelActive) {
      vscode.window.showInformationMessage("Enable the Traceability panel to open the Coverage Board.");
      return;
    }
    this.board();
  }

  private board(): BoardPanel {return BoardPanel.open(this.boardDeps());}

  private projectUniverse(adapter: TraceabilityAdapter | undefined): string[] {
    if (!adapter?.keyGrammar.projectOf) {return [];}
    return resolveProjectUniverse({
      directoryProjects: adapter.projectDirectory?.cached().projects.map((project) => project.key),
      ...this.localProjectSources(adapter),
    });
  }

  private localProjectSources(
    adapter: TraceabilityAdapter | undefined
  ): ProjectUniverseSources {
    return {
      tagDerivedKeys: this.deps.subsystem()?.tagDerivedProjectKeys() ?? [],
      syncSettingKeys: this.deps.config.xraySyncProjectKeys,
      catalogueKeys: adapter?.metadata?.snapshot().catalogueProjects ?? [],
      defaultKey: this.deps.config.xrayDefaultProjectKey,
    };
  }

  /** The board's current project scope: undefined is All Projects, never a filter. */
  private selectedProject(): string | undefined {
    const subsystem = this.deps.subsystem();
    return subsystem?.projectScope().get(this.projectUniverse(subsystem.getActiveAdapter()));
  }

  private syncProjectKeys(
    adapter: TraceabilityAdapter | undefined,
    explicitKey?: string
  ): string[] {
    const sources = this.localProjectSources(adapter);
    const selectedKey = explicitKey ?? this.selectedProject();
    return resolveSyncProjectKeys({ ...sources, selectedKey });
  }

  private boardTabIcon(): { light: vscode.Uri; dark: vscode.Uri } | undefined {
    const root = this.deps.extensionUri();
    if (!root) {return undefined;}
    return {
      light: vscode.Uri.joinPath(root, "media", "coverage-board-light.svg"),
      dark: vscode.Uri.joinPath(root, "media", "coverage-board-dark.svg"),
    };
  }

  private boardDeps(): BoardPanelDeps {
    const subsystem = this.deps.subsystem();
    const roots = (vscode.workspace.workspaceFolders ?? []).map(
      (folder) => folder.uri.fsPath
    );
    return {
      providerLabel: subsystem?.getActiveAdapter()?.label ?? "Xray",
      logger: this.logger,
      tabIcon: this.boardTabIcon(),
      buildModel: () => {
        const current = this.deps.subsystem();
        const adapter = current?.getActiveAdapter();
        return buildBoardViewModel(
          current?.getSnapshot(),
          roots,
          adapter?.keyGrammar.testPrefix ?? "",
          this.syncProjectKeys(adapter).length > 0,
          adapter?.keyGrammar.projectOf
        );
      },
      knownProjects: () => {
        const current = this.deps.subsystem();
        return this.projectUniverse(current?.getActiveAdapter());
      },
      projectScope: subsystem?.projectScope() ?? NO_PROJECT_SCOPE,
      mappingPageSize: subsystem?.mappingPageSize() ?? NO_MAPPING_PAGE_SIZE,
      buildExecutions: () =>
        buildExecutionRows(
          this.deps.publishLedger()?.entriesForSite(this.siteUrl()) ?? []
        ),
      onDidChange: subsystem?.onDidChangeSnapshot ?? this.boardChange.event,
      applyDrop: (scenario, key) =>
        this.getLinkCommands().applyBoardDrop(scenario, key),
      applyUnlink: (scenario, key) =>
        this.getLinkCommands().applyBoardUnlink(scenario, key),
      pushText: (scenario, key) => {
        this.getAuthoringCommands()
          .pushScenarioText(scenario, key)
          .catch((error) => {
            this.logger.warn("Push scenario text from the board failed", {
              error: errMsg(error),
            });
          });
      },
      runSync: () => this.syncTraceability(),
      autoSync: (projectKey) => this.autoSyncProject(projectKey),
      openExecution: (key) => {
        const adapter =
          this.deps.subsystem()?.getActiveAdapter() ?? this.deps.fallbackAdapter();
        this.getLinkCommands()
          .browseIssue(adapter, key)
          .catch((error) => {
            this.logger.warn("Opening the execution issue failed", {
              error: errMsg(error),
            });
          });
      },
      bulkCreate: () => {
        this.getAuthoringCommands()
          .bulkCreateTests()
          .catch((error) => {
            this.logger.warn("Bulk create from the board failed", {
              error: errMsg(error),
            });
          });
      },
      createTestSet: () => {
        this.getAuthoringCommands()
          .createTestSet()
          .catch((error) => {
            this.logger.warn("Creating a test set from the board failed", {
              error: errMsg(error),
            });
          });
      },
      createTestPlan: () => {
        this.getAuthoringCommands()
          .createTestPlan()
          .catch((error) => {
            this.logger.warn("Creating a test plan from the board failed", {
              error: errMsg(error),
            });
          });
      },
      createTestExecution: () => {
        this.getAuthoringCommands()
          .createTestExecution()
          .catch((error) => {
            this.logger.warn("Creating a test execution from the board failed", {
              error: errMsg(error),
            });
          });
      },
      describeRunSelected: (testKeys) => {
        const snapshot = this.deps.subsystem()?.getSnapshot();
        if (!snapshot) {return { runnable: 0, skipped: testKeys.length };}
        const resolved = boardBatchSelection(testKeys, snapshot);
        const runnable = resolved.selection.kind === "scenario"
          ? 1
          : resolved.selection.kind === "multi-select"
            ? resolved.selection.scenarios.length
            : 0;
        return { runnable, skipped: resolved.skipped };
      },
      runSelected: (testKeys) => {
        this.getPublishCommands()
          .runAndPublishSelected(testKeys)
          .catch((error) => {
            this.logger.warn("Running selected board tests failed", { error: errMsg(error) });
            if (error instanceof ExecutionAlreadyRunningError) {
              vscode.window.showWarningMessage(error.message);
            } else if (error instanceof ExecutionFailure) {
              const saved = error.completion.artifactId ? " The partial run was saved." : "";
              vscode.window.showErrorMessage(
                `Run stopped before a complete report was available: ${error.message}${saved}`
              );
            }
          });
      },
      publishDelegate: this.getPublishCommands().publishDelegate(),
      startPublish: () => {
        this.getPublishCommands()
          .runPublish()
          .catch((error) => {
            this.logger.warn("Publish from the board tab failed", {
              error: errMsg(error),
            });
          });
      },
    };
  }

  private siteUrl(): string {
    return normalizeSiteUrl(this.deps.config.xraySiteUrl);
  }

  private async credentials(): Promise<XrayCredentials | undefined> {
    const store = this.deps.credentialStore();
    return !store || this.siteUrl() === ""
      ? undefined
      : store.getCredentials(this.deps.config.xraySiteUrl);
  }

  private async jiraCredentials(): Promise<XrayJiraCredentials | undefined> {
    const store = this.deps.credentialStore();
    return !store || this.siteUrl() === ""
      ? undefined
      : store.getJiraCredentials(this.deps.config.xraySiteUrl);
  }

  private async hasJiraCredentials(): Promise<boolean> {
    const store = this.deps.credentialStore();
    return !!store && this.siteUrl() !== ""
      ? store.hasJiraCredentials(this.deps.config.xraySiteUrl)
      : false;
  }

  private async refreshBoard(what: string): Promise<boolean> {
    try {
      await this.deps.subsystem()?.rebuildNow();
      return true;
    } catch (error) {
      this.logger.warn(`Refreshing the board after ${what} failed`, {
        error: errMsg(error),
      });
      return false;
    }
  }

  private async recordCreatedExecution(key: string, summary: string): Promise<void> {
    const credentials = await this.credentials();
    this.deps.publishLedger()?.record({
      artifactId: `${STANDALONE_ARTIFACT_PREFIX}${key}`,
      executionRef: key,
      site: this.siteUrl(),
      account: credentials?.clientId ?? "",
      publishedAt: Date.now(),
      pendingAttachments: [],
      summary,
      mode: "created-empty",
    });
    await this.refreshBoard("creating an execution");
  }

  public syncTraceability(request: SyncRequest = { announce: true }): Promise<void> {
    if (this.syncInFlight) {
      if (request.explicitKey !== undefined) {
        this.pendingLoad = request.explicitKey;
      }
      return this.syncInFlight;
    }
    this.syncInFlight = this.runTraceabilitySyncCommand(request).finally(() => {
      this.syncInFlight = undefined;
      const pending = this.pendingLoad;
      this.pendingLoad = undefined;
      if (pending !== undefined) {
        this.autoSyncProject(pending).catch((error) => {
          this.logger.warn("Follow-up traceability sync failed", {
            error: errMsg(error),
          });
        });
      }
    });
    return this.syncInFlight;
  }

  private autoSyncProject(projectKey: string): Promise<void> {
    const subsystem = this.deps.subsystem();
    if (!subsystem?.connected) {return Promise.resolve();}
    const catalogued =
      subsystem.getActiveAdapter()?.metadata?.snapshot().catalogueProjects ?? [];
    if (catalogued.includes(projectKey)) {return Promise.resolve();}
    return this.syncTraceability({ announce: false, explicitKey: projectKey });
  }

  private async runTraceabilitySyncCommand(request: SyncRequest): Promise<void> {
    const subsystem = this.deps.subsystem();
    const adapter = subsystem?.getActiveAdapter();
    const metadata = adapter?.metadata;
    if (!metadata) {
      if (request.announce) {
        vscode.window.showInformationMessage(
          "Connect to your test tracker before syncing."
        );
      }
      return;
    }
    const scope: SyncScope = {
      testKeys: subsystem?.knownTestKeys() ?? [],
      projectKeys: this.syncProjectKeys(adapter, request.explicitKey),
    };
    const controller = new AbortController();
    const syncedAtBefore = metadata.snapshot().syncedAt;
    let counted = false;
    const result = await vscode.window.withProgress(
      {
        location: { viewId: "playwrightBddRunner.traceability" },
        title: "Syncing traceability…",
      },
      (_progress, token) => {
        token.onCancellationRequested(() => controller.abort());
        return runTraceabilitySync({
          metadata,
          scope,
          signal: controller.signal,
          logger: this.logger,
          onProgress: (event) => {
            counted = true;
            BoardPanel.reportSyncProgress(syncProgressText(event));
          },
        });
      }
    );
    const committed = metadata.snapshot().syncedAt !== syncedAtBefore;
    BoardPanel.reportSyncProgress(
      counted && committed && !result.cancelled && result.ok ? RENDERING_PROGRESS : ""
    );
    if (result.ok) {
      if (request.announce) {
        vscode.window.showInformationMessage(result.message);
      }
      return;
    }
    if (!request.announce) {
      this.logger.warn("A board load's sync failed", { error: result.message });
      return;
    }
    const pick = await vscode.window.showErrorMessage(result.message, "Show Output");
    if (pick === "Show Output") {this.logger.showOutput();}
  }

  public async hideTraceabilityPanel(): Promise<void> {
    const config = vscode.workspace.getConfiguration("playwrightBddRunner");
    const target =
      config.inspect<boolean>("traceability.enablePanel")?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await config.update("traceability.enablePanel", false, target);
  }

  public toggleGrouping(): void {
    const subsystem = this.deps.subsystem();
    // The subsystem exists before its tree does; without the panel the toggle silently does nothing.
    if (!subsystem?.traceabilityPanelActive) {
      vscode.window.showInformationMessage("Enable the Traceability panel to change how it groups.");
      return;
    }
    subsystem.toggleGrouping();
  }

  public async switchDefaultProject(): Promise<void> {
    const current = this.deps.config.xrayDefaultProjectKey;
    const jiraCredentials = await this.jiraCredentials();
    const chosen = jiraCredentials
      ? await this.pickDefaultProjectFromJira(this.siteUrl(), jiraCredentials, current)
      : await this.promptDefaultProjectKey(current);
    if (chosen === undefined) {return;}
    const normalized = chosen.toUpperCase();
    await this.writeDefaultProjectKey(normalized);
    vscode.window.showInformationMessage(
      `Default project set to ${normalized}. It prefills new tests and executions and joins the sync scope.`
    );
  }

  private async pickDefaultProjectFromJira(
    site: string,
    credentials: XrayJiraCredentials,
    current: string
  ): Promise<string | undefined> {
    if (site === "") {return this.promptDefaultProjectKey(current);}
    let projects: JiraProject[];
    try {
      projects = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Loading Jira projects…",
        },
        () => searchJiraProjects({ site, credentials, logger: this.logger })
      ).then((result) => result.projects);
    } catch (error) {
      const message = error instanceof JiraAccessError ? error.message : errMsg(error);
      vscode.window.showWarningMessage(`Could not list Jira projects: ${message}`);
      return this.promptDefaultProjectKey(current);
    }
    if (projects.length === 0) {return this.promptDefaultProjectKey(current);}

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
    picker.placeholder =
      "Select the default Jira project (prefills new tests and executions and joins the sync scope)";
    picker.items = items;
    const currentItem = items.find((item) => item.key === current);
    if (currentItem) {picker.activeItems = [currentItem];}
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
      prompt: "Jira project key. Prefills new tests and executions and joins the sync scope",
      placeHolder: "e.g. CALC",
      value: current,
      validateInput: (value) =>
        (/^[A-Za-z][A-Za-z0-9_]*$/.test(value.trim())
          ? undefined
          : "Enter a project key such as CALC."),
    });
    return input === undefined ? undefined : input.trim();
  }

  private async writeDefaultProjectKey(key: string): Promise<void> {
    const config = vscode.workspace.getConfiguration("playwrightBddRunner");
    const target =
      config.inspect<string>("xray.defaultProjectKey")?.workspaceValue !== undefined
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await config.update("xray.defaultProjectKey", key, target);
  }

  private getConnectionCommands(): XrayConnectionCommands {
    const credentialStore = this.deps.credentialStore();
    const probe = this.deps.xrayProbe();
    if (!credentialStore || !probe) {
      throw new Error(
        "Xray connection commands are unavailable: credential store or probe not wired."
      );
    }
    this.connectionCommands ??= new XrayConnectionCommands(
      this.deps.config,
      credentialStore,
      this.logger,
      () => this.deps.subsystem()?.knownTestKeys() ?? [],
      probe
    );
    return this.connectionCommands;
  }

  private getLinkCommands(): TraceabilityLinkCommands {
    this.linkCommands ??= new TraceabilityLinkCommands(this.logger, {
      config: this.deps.config,
      fallbackAdapter: this.deps.fallbackAdapter,
      activeAdapter: () => this.deps.subsystem()?.getActiveAdapter(),
      snapshot: () => this.deps.subsystem()?.getSnapshot(),
      board: () => this.board(),
      siteUrl: () => this.siteUrl(),
    });
    return this.linkCommands;
  }

  private getPublishCommands(): TraceabilityPublishCommands {
    this.publishCommands ??= new TraceabilityPublishCommands(this.logger, {
      config: this.deps.config,
      fallbackAdapter: this.deps.fallbackAdapter,
      subsystem: this.deps.subsystem,
      board: () => this.board(),
      projectUniverse: (adapter) => this.projectUniverse(adapter),
      rebuild: (what) => this.refreshBoard(what),
      linkScenarioForRef: (scenario) =>
        this.getLinkCommands().linkScenarioForRef(scenario),
      credentials: () => this.credentials(),
      jiraCredentials: () => this.jiraCredentials(),
      hasJiraCredentials: () => this.hasJiraCredentials(),
      publishLedger: this.deps.publishLedger,
      siteUrl: () => this.siteUrl(),
      idleEvent: this.boardChange.event,
      runArtifactStore: this.deps.runArtifactStore,
      executionGateway: this.deps.executionGateway,
      featureParser: this.deps.featureParser,
    });
    return this.publishCommands;
  }

  private getAuthoringCommands(): TraceabilityAuthoringCommands {
    this.authoringCommands ??= new TraceabilityAuthoringCommands(this.logger, {
      snapshot: () => this.deps.subsystem()?.getSnapshot(),
      adapter: () => this.deps.subsystem()?.getActiveAdapter(),
      selectedScenarios: () => BoardPanel.selectedScenarios(),
      selectedTests: () => BoardPanel.selectedTests(),
      targetProject: () => this.selectedProject(),
      credentialsPresent: async () => {
        const store = this.deps.credentialStore();
        return (
          !!store &&
          this.siteUrl() !== "" &&
          (await store.hasCredentials(this.deps.config.xraySiteUrl))
        );
      },
      siteUrl: () => this.siteUrl(),
      merge: (key) => this.getLinkCommands().mergeCreatedKey(key),
      recordExecution: (key, summary) => this.recordCreatedExecution(key, summary),
    });
    return this.authoringCommands;
  }
}
