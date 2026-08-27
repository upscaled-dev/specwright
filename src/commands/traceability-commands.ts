import * as vscode from "vscode";
import { configurationTarget, ExtensionConfig } from "../core/extension-config";
import { FeatureParser } from "../parsers/feature-parser";
import {
  buildBoardViewModel,
  buildExecutionRows,
  RENDERING_PROGRESS,
  syncProgressText,
} from "../traceability/board-data";
import { affectsBoard, BoardPanel, BoardPanelDeps } from "../traceability/board-panel";
import { ProjectDirectoryCapability, SyncScope, TraceabilityAdapter } from "../traceability/contracts";
import { NO_MAPPING_PAGE_SIZE } from "../traceability/mapping-page-size";
import {
  NO_PROJECT_SCOPE,
  ProjectUniverseSources,
  projectProvenance,
  resolveProjectUniverse,
  resolveSyncProjectKeys,
} from "../traceability/project-scope";
import { PublishLedger, STANDALONE_ARTIFACT_PREFIX } from "../traceability/publish-ledger";
import { AttachmentSpool } from "../traceability/attachment-spool";
import type { ExecutionArtifactCatalog } from "../ui/execution-artifacts";
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
import { commandArgFsPath } from "./run-commands";
import type { ExecutionGateway } from "../core/run-contracts";
import type { WorkspaceTrust } from "../core/workspace-trust";
import { explainWorkspaceTrust } from "../ui/workspace-trust";
import { BoardOperationState } from "../traceability/board-operation-state";
import { hasReindexDiagnostic } from "../traceability/provider-warnings";
import { ProjectSyncScheduler } from "./project-sync-scheduler";

interface SyncRequest {
  readonly announce: boolean;
  readonly explicitKey?: string | undefined;
  readonly forceProject?: boolean | undefined;
}

export interface TraceabilityCommandDeps {
  readonly config: ExtensionConfig;
  readonly fallbackAdapter: () => TraceabilityAdapter;
  readonly credentialStore: () => XrayCredentialStore | undefined;
  readonly xrayProbe: () => XrayProbe | undefined;
  readonly subsystem: () => TraceabilitySubsystem | undefined;
  readonly publishLedger: () => PublishLedger | undefined;
  readonly extensionUri: () => vscode.Uri | undefined;
  readonly attachmentSpoolRoot: () => string | undefined;
  readonly runArtifactStore: ExecutionArtifactCatalog | undefined;
  readonly executionGateway: ExecutionGateway;
  readonly featureParser: FeatureParser;
  readonly workspaceTrust: WorkspaceTrust;
}

export class TraceabilityCommands {
  private linkCommands: TraceabilityLinkCommands | undefined;
  private publishCommands: TraceabilityPublishCommands | undefined;
  private authoringCommands: TraceabilityAuthoringCommands | undefined;
  private connectionCommands: XrayConnectionCommands | undefined;
  private syncInFlight: Promise<void> | undefined;
  private readonly boardChange = new vscode.EventEmitter<void>();
  private readonly operations = new BoardOperationState();
  private readonly projectSyncs: ProjectSyncScheduler;

  constructor(private readonly logger: Logger, private readonly deps: TraceabilityCommandDeps) {
    this.projectSyncs = new ProjectSyncScheduler({
      onDidChangeActivity: this.operations.onDidChange,
      canStart: () => !this.operations.mutationActive && this.syncInFlight === undefined,
      run: (project, force) => {
        if (force) {
          return this.syncTraceability({ announce: false, explicitKey: project, forceProject: true });
        }
        return this.autoSyncProject(project);
      },
      onError: (project, error) => {
        this.logger.warn("Follow-up traceability sync failed", { project, error: errMsg(error) });
      },
    });
  }

  public registerBoardSerializer(context: vscode.ExtensionContext): void {
    context.subscriptions.push(
      this.operations,
      this.projectSyncs,
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
    return this.mutating(() => this.getLinkCommands().linkScenario(...args));
  }
  public runAndPublish(...args: unknown[]): Promise<void> {
    return this.mutating((signal) => this.getPublishCommands().runAndPublishTrusted(signal, ...args));
  }
  // The view-title button's own command: it names the whole mapped set, which the node command must
  // never infer from an empty argument list. "Whole" means whole within the board's working project,
  // the same project the board shows and creates in.
  public runAndPublishAllMapped(): Promise<void> {
    const project = this.selectedProject();
    return this.mutating((signal) => this.getPublishCommands().runAndPublishSelection({
      kind: "all-mapped",
      ...(project ? { project } : {}),
    }, "traceability-tree", signal));
  }
  public runAndPublishFeature(arg?: unknown): Promise<void> {
    const filePath = commandArgFsPath(arg);
    return filePath
      ? this.mutating((signal) => this.getPublishCommands().runAndPublishSelection(
          { kind: "feature", filePath },
          "explorer",
          signal
        ))
      : Promise.resolve();
  }
  public runAndPublishFolder(arg?: unknown): Promise<void> {
    const folderPath = commandArgFsPath(arg);
    return folderPath
      ? this.mutating((signal) => this.getPublishCommands().runAndPublishSelection(
          { kind: "folder", folderPath },
          "explorer",
          signal
        ))
      : Promise.resolve();
  }
  public runAndPublishByTagExpression(): Promise<void> {
    return this.mutating((signal) => this.runAndPublishTagExpression(signal));
  }

  private async runAndPublishTagExpression(signal: AbortSignal): Promise<void> {
    const expression = await vscode.window.showInputBox({
      title: "Run and Publish by Tag Expression",
      prompt: "Enter a playwright-bdd tag expression",
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() === "" ? "A tag expression is required." : undefined),
    });
    if (expression === undefined) {return;}
    await this.getPublishCommands().runAndPublishSelection(
      { kind: "tag-expression", expression },
      "palette",
      signal
    );
  }
  public publishLastRun(): Promise<void> {
    return this.mutating((signal) => this.getPublishCommands().publishLastRun(signal));
  }
  public clearLocalRunHistory(): Promise<void> {
    return this.getPublishCommands().clearLocalRunHistory();
  }
  public manageConnection(): Promise<void> {return this.privileged(() => this.getConnectionCommands().manageConnection());}
  public connect(): Promise<void> {return this.privileged(() => this.getConnectionCommands().connect());}
  public disconnect(): Promise<void> {return this.privileged(() => this.getConnectionCommands().disconnect());}
  public testConnection(): Promise<void> {
    return this.privileged((signal) => this.getConnectionCommands().testConnection(signal));
  }
  public bulkCreateTests(): Promise<void> {return this.mutating(() => this.getAuthoringCommands().bulkCreateTests());}
  public createTestSet(): Promise<void> {return this.mutating(() => this.getAuthoringCommands().createTestSet());}
  public addToTestSet(): Promise<void> {return this.mutating(() => this.getAuthoringCommands().addToTestSet());}
  public createTestPlan(): Promise<void> {return this.mutating(() => this.getAuthoringCommands().createTestPlan());}
  public addToTestPlan(): Promise<void> {return this.mutating(() => this.getAuthoringCommands().addToTestPlan());}
  public createTestExecution(): Promise<void> {return this.mutating(() => this.getAuthoringCommands().createTestExecution());}

  private async privileged(run: (signal: AbortSignal) => Promise<void>): Promise<void> {
    await this.deps.workspaceTrust.run(run);
  }

  private mutating(run: (signal: AbortSignal) => Promise<void>): Promise<void> {
    return this.operations.mutation(() => this.privileged(run));
  }

  private async boardPrivileged(run: (signal: AbortSignal) => Promise<void>): Promise<void> {
    try {
      await this.privileged(run);
    } catch (error) {
      if (!(await explainWorkspaceTrust(error))) {throw error;}
    }
  }

  private async boardMutation(run: (signal: AbortSignal) => Promise<void>): Promise<void> {
    await this.operations.mutation(() => this.boardPrivileged(run));
  }

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

  /** The project the board is working in: undefined is All projects. */
  private selectedProject(): string | undefined {
    const subsystem = this.deps.subsystem();
    return subsystem?.projectScope().get(this.projectUniverse(subsystem.getActiveAdapter()));
  }

  // `explicitKey` is what one call asks for by name, so it survives an explicit sync setting. The board's
  // working project reaches this resolver that way on every sync (see `syncTraceability`); only Select
  // Projects to Sync changes the standing list.
  private syncProjectKeys(
    adapter: TraceabilityAdapter | undefined,
    explicitKey?: string
  ): string[] {
    return resolveSyncProjectKeys({
      ...this.localProjectSources(adapter),
      explicitKey,
    });
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
    const extensionUri = this.deps.extensionUri();
    if (!extensionUri) {throw new Error("Coverage Board assets are unavailable.");}
    const roots = (vscode.workspace.workspaceFolders ?? []).map(
      (folder) => folder.uri.fsPath
    );
    return {
      providerLabel: subsystem?.getActiveAdapter()?.label ?? "Xray",
      logger: this.logger,
      tabIcon: this.boardTabIcon(),
      webviewAssetRoot: vscode.Uri.joinPath(extensionUri, "dist"),
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
      onDidChangeActivity: this.operations.onDidChange,
      mutationActive: () => this.operations.mutationActive,
      syncActive: () => this.operations.syncActive,
      applyDrop: (scenario, key) =>
        this.boardMutation(() => this.getLinkCommands().applyBoardDrop(scenario, key)),
      applyUnlink: (scenario, key) =>
        this.boardMutation(() => this.getLinkCommands().applyBoardUnlink(scenario, key)),
      pushText: (scenario, key) => {
        this.boardMutation(() => this.getAuthoringCommands().pushScenarioText(scenario, key))
          .catch((error) => {
            this.logger.warn("Push scenario text from the board failed", {
              error: errMsg(error),
            });
          });
      },
      runSync: () => this.boardPrivileged(() => this.syncTraceability()),
      selectSyncProjects: () => {
        this.boardPrivileged((signal) => this.selectSyncProjectsTrusted(signal))
          .catch((error) => {
            this.logger.warn("Selecting sync projects from the board failed", {
              error: errMsg(error),
            });
          });
      },
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
        this.boardMutation(() => this.getAuthoringCommands().bulkCreateTests())
          .catch((error) => {
            this.logger.warn("Bulk create from the board failed", {
              error: errMsg(error),
            });
          });
      },
      createTestSet: () => {
        this.boardMutation(() => this.getAuthoringCommands().createTestSet())
          .catch((error) => {
            this.logger.warn("Creating a test set from the board failed", {
              error: errMsg(error),
            });
          });
      },
      addToTestSet: () => {
        this.boardMutation(() => this.getAuthoringCommands().addToTestSet())
          .catch((error) => {
            this.logger.warn("Adding tests to a test set from the board failed", {
              error: errMsg(error),
            });
          });
      },
      createTestPlan: () => {
        this.boardMutation(() => this.getAuthoringCommands().createTestPlan())
          .catch((error) => {
            this.logger.warn("Creating a test plan from the board failed", {
              error: errMsg(error),
            });
          });
      },
      addToTestPlan: () => {
        this.boardMutation(() => this.getAuthoringCommands().addToTestPlan())
          .catch((error) => {
            this.logger.warn("Adding tests to a test plan from the board failed", {
              error: errMsg(error),
            });
          });
      },
      createTestExecution: () => {
        this.boardMutation(() => this.getAuthoringCommands().createTestExecution())
          .catch((error) => {
            this.logger.warn("Creating a test execution from the board failed", {
              error: errMsg(error),
            });
          });
      },
      publishDelegate: this.getPublishCommands().publishDelegate(),
      startPublish: () => {
        this.boardMutation((signal) => this.getPublishCommands().runPublish(undefined, signal))
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
    const evicted = await this.deps.publishLedger()?.record({
      artifactId: `${STANDALONE_ARTIFACT_PREFIX}${key}`,
      executionRef: key,
      site: this.siteUrl(),
      account: credentials?.clientId ?? "",
      publishedAt: Date.now(),
      pendingAttachments: [],
      summary,
      mode: "created-empty",
    }) ?? [];
    const spoolRoot = this.deps.attachmentSpoolRoot();
    if (spoolRoot !== undefined) {new AttachmentSpool(spoolRoot, this.logger).discard(evicted);}
    await this.refreshBoard("creating an execution");
  }

  // Every sync fetches the standing Sync scope list plus the project the board is working in, named for
  // that run. Defaulted here rather than at each entry point, so the palette, the view title, and the
  // board's Sync now cannot drift, and a selection on no rung is never stranded by a failed load. A call
  // that already names a project keeps its own.
  public syncTraceability(request: SyncRequest = { announce: true }): Promise<void> {
    this.deps.workspaceTrust.require();
    const working = request.explicitKey ?? this.selectedProject();
    const scoped: SyncRequest = { ...request, ...(working ? { explicitKey: working } : {}) };
    if (this.syncInFlight) {
      if (scoped.explicitKey !== undefined) {
        this.projectSyncs.enqueue(scoped.explicitKey, scoped.forceProject === true);
      }
      return this.syncInFlight;
    }
    this.syncInFlight = this.operations.sync(() => this.runTraceabilitySyncCommand(scoped)).finally(() => {
      this.syncInFlight = undefined;
      this.projectSyncs.poke();
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

  private scheduleProjectSync(project: string, diagnostics?: Iterable<string>): void {
    if (diagnostics !== undefined && !hasReindexDiagnostic(diagnostics)) {return;}
    this.projectSyncs.defer(project, true);
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
    await config.update(
      "traceability.enablePanel",
      false,
      configurationTarget(config, "traceability.enablePanel")
    );
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

  public switchDefaultProject(): Promise<void> {
    return this.deps.workspaceTrust.run((signal) => this.switchDefaultProjectTrusted(signal));
  }

  private async switchDefaultProjectTrusted(signal: AbortSignal): Promise<void> {
    const current = this.deps.config.xrayDefaultProjectKey;
    const jiraCredentials = await this.jiraCredentials();
    const chosen = jiraCredentials
      ? await this.pickDefaultProjectFromJira(this.siteUrl(), jiraCredentials, current, signal)
      : await this.promptDefaultProjectKey(current);
    if (chosen === undefined) {return;}
    const normalized = chosen.toUpperCase();
    await this.writeDefaultProjectKey(normalized);
    vscode.window.showInformationMessage(
      `Default project set to ${normalized}. It prefills new tests and executions, and joins the sync scope while no sync project list is set.`
    );
  }

  private async pickDefaultProjectFromJira(
    site: string,
    credentials: XrayJiraCredentials,
    current: string,
    signal: AbortSignal
  ): Promise<string | undefined> {
    if (site === "") {return this.promptDefaultProjectKey(current);}
    let projects: JiraProject[];
    try {
      projects = await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: "Loading Jira projects…",
        },
        () => searchJiraProjects({ site, credentials, logger: this.logger, signal })
      ).then((result) => result.projects);
    } catch (error) {
      if (signal.aborted) {throw signal.reason ?? error;}
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
      "Select the default Jira project (prefills new tests and executions, and joins the sync scope while no sync project list is set)";
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
      prompt: "Jira project key. Prefills new tests and executions, and joins the sync scope while no sync project list is set",
      placeHolder: "e.g. CALC",
      value: current,
      validateInput: (value) =>
        (/^[A-Za-z][A-Za-z0-9_]*$/.test(value.trim())
          ? undefined
          : "Enter a project key such as CALC."),
    });
    return input === undefined ? undefined : input.trim();
  }

  public selectSyncProjects(): Promise<void> {
    return this.privileged((signal) => this.selectSyncProjectsTrusted(signal));
  }

  private async selectSyncProjectsTrusted(signal: AbortSignal): Promise<void> {
    const adapter = this.deps.subsystem()?.getActiveAdapter();
    // One bag per invocation: the offered list, the boxes to check, and each row's reason all read the
    // same sources, so the picker cannot contradict itself or the next sync.
    const listed: ProjectUniverseSources = adapter?.keyGrammar.projectOf
      ? {
        directoryProjects: await this.siteProjects(adapter.projectDirectory, signal),
        ...this.localProjectSources(adapter),
      }
      : {};
    const universe = resolveProjectUniverse(listed);
    if (universe.length === 0) {
      vscode.window.showInformationMessage(
        "No projects to choose from yet. Connect to your tracker, set a default project, or tag a scenario first."
      );
      return;
    }
    const scoped = new Set(resolveSyncProjectKeys(listed));
    const provenance = projectProvenance(listed);
    const picked = await vscode.window.showQuickPick(
      universe.map((key) => ({
        label: key,
        description: provenance.get(key) ?? "",
        picked: scoped.has(key),
      })),
      {
        title: "Select Projects to Sync",
        placeHolder: "Projects every sync fetches, alongside the board's working project. Check none to scope it automatically.",
        canPickMany: true,
        ignoreFocusOut: true,
      }
    );
    if (picked === undefined) {return;}
    const keys = picked.map((item) => item.label);
    // The write is the refresh: the config listeners rebuild the panel and repaint an open board.
    await this.writeSyncProjectKeys(keys);
    vscode.window.showInformationMessage(
      keys.length === 0
        ? "Sync scope cleared. Tagged projects, the default project, and projects synced earlier are in scope again."
        : `Sync scope set to ${keys.join(", ")}.`
    );
  }

  // Enumerated live, because a cold directory cache would offer only the projects this workspace has
  // already touched. A failed enumeration is not a dead end: the last known list plus the workspace's
  // own rungs still open the picker, the same degrade the default-project picker takes.
  private async siteProjects(
    directory: ProjectDirectoryCapability | undefined,
    signal: AbortSignal
  ): Promise<string[] | undefined> {
    if (!directory) {return undefined;}
    try {
      const listed = await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: "Loading projects…" },
        () => directory.list(signal)
      );
      return listed.projects.map((project) => project.key);
    } catch (error) {
      if (signal.aborted) {throw signal.reason ?? error;}
      this.logger.warn("Listing projects for the sync picker failed", { error: errMsg(error) });
      return directory.cached().projects.map((project) => project.key);
    }
  }

  // Per repo by construction: which projects this workspace syncs is not an answer to carry into the
  // next one. A window with no folder open has nowhere to write that, so there it lands in user settings.
  private async writeSyncProjectKeys(keys: readonly string[]): Promise<void> {
    const target =
      vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
        ? vscode.ConfigurationTarget.Workspace
        : vscode.ConfigurationTarget.Global;
    await vscode.workspace
      .getConfiguration("playwrightBddRunner")
      .update("xray.syncProjectKeys", keys, target);
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
    const extensionUri = this.deps.extensionUri();
    if (!extensionUri) {
      throw new Error("Xray setup assets are unavailable: extension root not wired.");
    }
    this.connectionCommands ??= new XrayConnectionCommands(
      this.deps.config,
      credentialStore,
      this.logger,
      () => this.deps.subsystem()?.knownTestKeys() ?? [],
      probe,
      this.deps.workspaceTrust,
      vscode.Uri.joinPath(extensionUri, "dist")
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
      workspaceTrust: this.deps.workspaceTrust,
      scheduleProjectSync: (project, diagnostics) => this.scheduleProjectSync(project, diagnostics),
      trackReconciliation: (run) => {
        this.operations.mutation(run).catch((error) => {
          this.logger.warn("Created-test metadata reconciliation failed", { error: errMsg(error) });
        });
      },
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
      workspaceTrust: this.deps.workspaceTrust,
      attachmentSpoolRoot: this.deps.attachmentSpoolRoot,
      mutation: (run) => this.operations.mutation(run),
    });
    return this.publishCommands;
  }

  private getAuthoringCommands(): TraceabilityAuthoringCommands {
    this.authoringCommands ??= new TraceabilityAuthoringCommands(this.logger, {
      workspaceTrust: this.deps.workspaceTrust,
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
      scheduleProjectSync: (project, diagnostics) => this.scheduleProjectSync(project, diagnostics),
    });
    return this.authoringCommands;
  }
}
