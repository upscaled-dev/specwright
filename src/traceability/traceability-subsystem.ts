import * as vscode from "vscode";
import { ExtensionConfig } from "../core/extension-config";
import { FeatureParser } from "../parsers/feature-parser";
import { TestDiscoveryManager } from "../core/test-discovery-manager";
import { PlaywrightJsonParser } from "../utils/playwright-json-parser";
import { Logger } from "../utils/logger";
import {
  REPORT_CANDIDATES,
  TraceabilityModel,
  TraceabilitySnapshot,
  findLinkForScenario,
} from "./traceability-model";
import { ArtifactKeyResolver } from "./run-artifact-store";
import { ConnectionVerifyResult, TraceabilityAdapter } from "./contracts";
import { TraceabilityAdapterRegistry } from "./adapter-registry";
import {
  ConnectionIndicator,
  GroupingMode,
  GroupingModeStore,
  TraceabilityNode,
  TraceabilityTreeDataProvider,
} from "./traceability-tree-data-provider";
import { TagDiagnosticsProvider } from "./tag-diagnostics";
import { TagDecorationProvider } from "./tag-decoration";
import { RunResultStore } from "./run-result-store";
import { ProjectScopeStore, projectScopeStore } from "./project-scope";

const FALLBACK_PROVIDER_ID = "xray";
const CONNECTED_CONTEXT_KEY = "playwrightBddRunner.traceability.connected";
const GROUPING_MODE_KEY = "playwrightBddRunner.traceability.groupingMode";

// One watcher per candidate report path (a brace-glob with a slash inside `{}` does not fire
// reliably in a VS Code FileSystemWatcher). A create/change/delete on any of these refreshes the
// badges — including a delete, so stale badges clear when a report is removed.
const REPORT_WATCH_GLOBS = REPORT_CANDIDATES.map((candidate) => `**/${candidate}`);

/**
 * Sibling to ProviderRegistry: owns the traceability panel with the same idempotent
 * reconcile-on-config-change lifecycle. When `traceability.enablePanel` is off the whole subsystem
 * tears down — tree, model, watchers, adapter — with zero residue. Shares nothing with the Steps
 * code. Adapters are built through the injected registry, so a `traceability.provider` change swaps
 * the whole capability stack at runtime without a window reload.
 */
export class TraceabilitySubsystem implements vscode.Disposable {
  private treeView: vscode.TreeView<TraceabilityNode> | undefined;
  private treeProvider: TraceabilityTreeDataProvider | undefined;
  private model: TraceabilityModel | undefined;
  private tagDiagnostics: TagDiagnosticsProvider | undefined;
  private tagDecorations: TagDecorationProvider | undefined;
  private activeAdapter: TraceabilityAdapter | undefined;
  private activeAdapterId: string | undefined;
  private watcherDisposables: vscode.Disposable[] = [];
  private adapterSubscriptions: vscode.Disposable[] = [];
  private lastSignature: string | undefined;
  private rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  private rebuildInFlight = false;
  private rebuildPending = false;
  // Bumped whenever connection state is (re)committed — teardown, rebuild, or a fresh probe. An
  // async probe captures the epoch at entry and only commits if it is still current, so a late
  // resolution (panel already torn down, or a newer probe already landed) discards silently.
  private connectionEpoch = 0;
  // The last committed verify state, recomposed with fresh sync staleness on every metadata change
  // so "synced Nm ago" updates without re-running the (network) verify.
  private lastConnection: { state: ConnectionIndicator["state"]; label: string; message: string } | undefined;
  private readonly configChangeDisposable: vscode.Disposable;
  private disposed = false;
  private warnedUnknownProvider = false;

  // Forwards the active model's rebuilds (and teardown) to the Coverage Board, which — unlike the
  // tree's data provider — outlives model swaps, so it subscribes to the subsystem rather than to a
  // model instance it would otherwise pin.
  private readonly _onDidChangeSnapshot = new vscode.EventEmitter<void>();
  public readonly onDidChangeSnapshot = this._onDidChangeSnapshot.event;

  /** Debounce window for coalescing bursts of watcher events (overridable in tests). */
  public rebuildDebounceMs = 300;

  private readonly runResultSubscription: vscode.Disposable;

  constructor(
    private readonly config: ExtensionConfig,
    private readonly registry: TraceabilityAdapterRegistry,
    private readonly featureParser: FeatureParser,
    private readonly discoveryManager: TestDiscoveryManager,
    private readonly playwrightJsonParser: PlaywrightJsonParser,
    private readonly runResultStore: RunResultStore,
    private readonly logger: Logger,
    private readonly workspaceState: vscode.Memento
  ) {
    this.configChangeDisposable = config.addChangeListener(() => this.applyCurrent());
    // The store outlives model rebuilds and provider swaps, so subscribe once here: a Test Explorer
    // run's fresh badges land without a workspace report on disk (P1 exit criterion).
    this.runResultSubscription = this.runResultStore.onDidChange(() => this.scheduleRebuild());
  }

  public applyCurrent(): void {
    if (this.disposed) {return;}
    this.reconcileTraceabilityPanel();
  }

  public get traceabilityPanelActive(): boolean {
    return this.treeView !== undefined;
  }

  // Flip the tree between the by-test and by-file layouts. The provider persists the choice through
  // the memento-backed store, so a recreated provider restores it. No-op when the panel is off.
  public toggleGrouping(): void {
    this.treeProvider?.toggleGroupingMode();
  }

  // Reads/writes the grouping mode in workspaceState. The read coerces any stored value to a valid
  // mode (boundary), defaulting to the by-test layout.
  private groupingStore(): GroupingModeStore {
    return {
      get: (): GroupingMode =>
        (this.workspaceState.get<string>(GROUPING_MODE_KEY) === "file" ? "file" : "test"),
      set: (mode) => {
        Promise.resolve(this.workspaceState.update(GROUPING_MODE_KEY, mode)).catch((error) => {
          this.logger.warn("Persisting the traceability grouping mode failed", { error: String(error) });
        });
      },
    };
  }

  // The board's project scope, persisted per workspace alongside the grouping mode. The board owns when
  // to read and write it; the coercion of a key that has left the known set lives in the store.
  public projectScope(): ProjectScopeStore {
    return projectScopeStore(this.workspaceState, (error) => {
      this.logger.warn("Persisting the board project scope failed", { error: String(error) });
    });
  }

  // The linkScenario command reads the live adapter's metadata snapshot from here — the browse-URL
  // adapter the command context holds is a separate instance and is never synced.
  public getActiveAdapter(): TraceabilityAdapter | undefined {
    return this.activeAdapter;
  }

  // The current joined snapshot (undefined when the panel is off or still building). The batch
  // preflight flow resolves scopes and classifies against it.
  public getSnapshot(): TraceabilitySnapshot | undefined {
    return this.model?.snapshot;
  }

  // A testKey resolver frozen over the snapshot's links AS THEY STAND NOW. The artifact store calls
  // this at `beginBatch` so one artifact keys off a single consistent snapshot even if a sync lands
  // mid-batch (the model swaps `current` wholesale on rebuild, so the captured array never mutates).
  public captureKeyResolver(): ArtifactKeyResolver {
    const links = this.model?.snapshot.links ?? [];
    return (scenario) => findLinkForScenario(links, scenario)?.testKey;
  }

  // A synchronous, awaitable rebuild — the debounced watcher path can't be awaited, so the preflight
  // `repair` outcome uses this to guarantee the snapshot reflects the just-inserted tag before it
  // re-classifies.
  public async rebuildNow(): Promise<void> {
    await this.model?.rebuild();
  }

  // Deduped test keys from the offline `@TEST_` tag scan; empty when no model exists (panel off or
  // still building). Feeds the connection test's workspace-derived probes so it never prompts.
  public knownTestKeys(): string[] {
    const seen = new Set<string>();
    for (const link of this.model?.snapshot.links ?? []) {
      seen.add(link.testKey);
    }
    return [...seen];
  }

  // Reads config.traceabilityProvider live so switching the provider re-selects here; an unknown id
  // falls back to Xray and warns once (not once per config-change burst).
  private resolveProviderId(): string | undefined {
    const id = this.config.traceabilityProvider;
    if (this.registry.has(id)) {return id;}
    if (!this.warnedUnknownProvider) {
      this.logger.warn(`Unknown traceability provider "${id}", falling back to "${FALLBACK_PROVIDER_ID}"`);
      this.warnedUnknownProvider = true;
    }
    return this.registry.has(FALLBACK_PROVIDER_ID) ? FALLBACK_PROVIDER_ID : undefined;
  }

  private reconcileTraceabilityPanel(): void {
    if (!this.config.enableTraceabilityPanel) {
      this.teardown();
      return;
    }
    const id = this.resolveProviderId();
    if (!id) {
      this.teardown();
      return;
    }
    // Compute the signature against the still-active adapter when the id is unchanged, so an
    // unrelated config edit doesn't force a throwaway adapter construction. A changed id always
    // rebuilds.
    const signature =
      this.activeAdapter && this.activeAdapterId === id
        ? this.signature(id, this.activeAdapter)
        : undefined;
    if (this.treeView && signature !== undefined && this.lastSignature === signature) {
      this.queueConnectionRefresh();
      return;
    }
    // A changed signature — provider swap, prefix, or pattern — rebuilds the whole panel so the new
    // adapter's model, capabilities, label, and watchers all take effect without a window reload.
    this.teardown();
    const adapter = this.registry.create(id, { config: this.config, logger: this.logger });
    if (!adapter) {
      return;
    }
    this.activeAdapter = adapter;
    this.activeAdapterId = id;
    const model = new TraceabilityModel(
      this.featureParser,
      this.discoveryManager,
      this.playwrightJsonParser,
      adapter,
      this.runResultStore,
      this.logger
    );
    this.model = model;
    const provider = new TraceabilityTreeDataProvider(model, adapter.label, this.groupingStore());
    this.treeProvider = provider;
    this.adapterSubscriptions.push(model.onDidChange(() => this._onDidChangeSnapshot.fire()));
    this.treeView = vscode.window.createTreeView("playwrightBddRunner.traceability", {
      treeDataProvider: provider,
    });
    // Grammar-driven tag diagnostics are offline (no connection needed) and rebuild with the panel
    // on any prefix/provider change, so they always lint against the active adapter's grammar.
    this.tagDiagnostics = new TagDiagnosticsProvider(adapter.keyGrammar);
    this.tagDiagnostics.start();
    // The tag-line decoration is gated and grammar-sourced the same way, so it lives and dies with
    // the panel and always washes the active provider's prefixes.
    this.tagDecorations = new TagDecorationProvider(adapter.keyGrammar);
    this.tagDecorations.start();
    if (adapter.connection) {
      this.adapterSubscriptions.push(
        adapter.connection.onDidChange(() => this.queueConnectionRefresh())
      );
    }
    if (adapter.metadata) {
      this.adapterSubscriptions.push(
        adapter.metadata.onDidChange(() => {
          this.scheduleRebuild();
          // Recompose the status row's "synced Nm ago" off the new snapshot — no re-verify.
          this.commitConnectionIndicator();
        })
      );
    }
    this.setupWatchers();
    this.lastSignature = this.signature(id, adapter);
    this.scheduleRebuild();
    this.queueConnectionRefresh();
    this.logger.info("Traceability panel enabled");
  }

  private queueConnectionRefresh(): void {
    this.refreshConnectionState().catch((error) => {
      this.logger.warn("Traceability connection refresh failed", { error: String(error) });
    });
  }

  // Connection state is async (a credential-store read), so context key, tree gating, and the
  // connected indicator all update here off the same probe. An adapter with no connection capability
  // is treated as always available (offline tag-only view). The epoch captured at entry is the
  // newest, so any older in-flight probe discards when it resolves.
  private async refreshConnectionState(): Promise<void> {
    const epoch = ++this.connectionEpoch;
    if (this.disposed) {
      return;
    }
    const connection = this.activeAdapter?.connection;
    const connected = connection ? await connection.isConnected() : true;
    if (this.disposed || epoch !== this.connectionEpoch) {
      return;
    }
    this.commitConnectedContext(connected);
    this.treeProvider?.setConnected(connected);

    if (!connected || !connection?.verify) {
      this.lastConnection = undefined;
      this.treeProvider?.setConnectionIndicator(undefined);
      return;
    }
    const project = this.defaultProjectKey();
    this.treeProvider?.setConnectionIndicator({
      state: "checking",
      label: connection.label,
      message: "Checking connection…",
      ...(project ? { defaultProject: project } : {}),
    });
    let result: ConnectionVerifyResult;
    try {
      result = await connection.verify();
    } catch (error) {
      result = { status: "unreachable", message: String(error) };
    }
    if (this.disposed || epoch !== this.connectionEpoch) {
      return;
    }
    this.lastConnection = { state: result.status, label: connection.label, message: result.message };
    this.commitConnectionIndicator();
  }

  // Composes the status row from the last verify plus the current metadata staleness (§7). Sync
  // info is omitted until the first sync produces a `syncedAt`, so a connection with no metadata
  // capability commits the bare `{state, label, message}` row.
  private commitConnectionIndicator(): void {
    if (!this.treeProvider || !this.lastConnection) {
      return;
    }
    const snapshot = this.activeAdapter?.metadata?.snapshot();
    const indicator: ConnectionIndicator = { ...this.lastConnection };
    if (snapshot?.syncedAt !== undefined) {
      indicator.sync = { syncedAt: snapshot.syncedAt, stale: snapshot.stale };
    }
    const project = this.defaultProjectKey();
    if (project) {
      indicator.defaultProject = project;
    }
    this.treeProvider.setConnectionIndicator(indicator);
  }

  // The configured create-time default project, or undefined when unset. Undefined-safe so a hand-
  // built config fake that omits the getter never throws here.
  private defaultProjectKey(): string | undefined {
    return this.config.xrayDefaultProjectKey || undefined;
  }

  private commitConnectedContext(connected: boolean): void {
    Promise.resolve(
      vscode.commands.executeCommand("setContext", CONNECTED_CONTEXT_KEY, connected)
    ).catch((error) => {
      this.logger.warn("Traceability connection context update failed", { error: String(error) });
    });
  }

  // The active provider id joins the signature so switching traceability.provider forces a rebuild.
  // The browse URL (siteUrl) is deliberately excluded: it is read live, so editing it must not
  // tear down watchers or trigger a rescan. Only inputs the model actually consumes belong here.
  private signature(id: string, adapter: TraceabilityAdapter): string {
    return [
      id,
      this.config.testFilePattern,
      adapter.keyGrammar.testPrefix,
      adapter.keyGrammar.reqPrefix,
    ].join("|");
  }

  private scheduleRebuild(): void {
    if (this.rebuildTimer) {clearTimeout(this.rebuildTimer);}
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = undefined;
      this.runRebuild().catch((error) => {
        this.logger.warn("Traceability rebuild failed", { error: String(error) });
      });
    }, this.rebuildDebounceMs);
  }

  // Serialize rebuilds: at most one in flight with a single pending re-run. Because each rebuild is
  // awaited before the next starts, the final snapshot is always the newest — a stale run can never
  // overwrite a fresher one.
  private async runRebuild(): Promise<void> {
    if (this.rebuildInFlight) {
      this.rebuildPending = true;
      return;
    }
    this.rebuildInFlight = true;
    try {
      do {
        this.rebuildPending = false;
        if (this.disposed || !this.model) {return;}
        await this.model.rebuild();
      } while (this.rebuildPending && !this.disposed);
    } finally {
      this.rebuildInFlight = false;
    }
  }

  private setupWatchers(): void {
    const rebuild = (): void => this.scheduleRebuild();
    const featureWatcher = vscode.workspace.createFileSystemWatcher(this.config.testFilePattern);
    this.watcherDisposables.push(
      featureWatcher,
      featureWatcher.onDidCreate(rebuild),
      featureWatcher.onDidChange(rebuild),
      featureWatcher.onDidDelete(rebuild)
    );
    for (const glob of REPORT_WATCH_GLOBS) {
      const reportWatcher = vscode.workspace.createFileSystemWatcher(glob);
      this.watcherDisposables.push(
        reportWatcher,
        reportWatcher.onDidCreate(rebuild),
        reportWatcher.onDidChange(rebuild),
        reportWatcher.onDidDelete(rebuild)
      );
    }
  }

  private teardown(): void {
    if (this.rebuildTimer) {
      clearTimeout(this.rebuildTimer);
      this.rebuildTimer = undefined;
    }
    this.rebuildPending = false;
    for (const d of this.adapterSubscriptions) {d.dispose();}
    this.adapterSubscriptions = [];
    for (const d of this.watcherDisposables) {d.dispose();}
    this.watcherDisposables = [];
    this.treeView?.dispose();
    this.treeView = undefined;
    this.treeProvider?.dispose();
    this.treeProvider = undefined;
    this.tagDiagnostics?.dispose();
    this.tagDiagnostics = undefined;
    this.tagDecorations?.dispose();
    this.tagDecorations = undefined;
    this.model?.dispose();
    this.model = undefined;
    this.activeAdapter?.dispose?.();
    this.activeAdapter = undefined;
    this.activeAdapterId = undefined;
    this.lastConnection = undefined;
    this.lastSignature = undefined;
    // Bump before committing so an in-flight probe captured under the old epoch can't overwrite
    // this false with a stale true when it later resolves.
    this.connectionEpoch += 1;
    this.commitConnectedContext(false);
    // An open board reads getSnapshot() (now undefined) — signal it so it clears rather than holding
    // the torn-down model's last view.
    this._onDidChangeSnapshot.fire();
  }

  public dispose(): void {
    this.disposed = true;
    this.configChangeDisposable.dispose();
    this.runResultSubscription.dispose();
    this.teardown();
    this._onDidChangeSnapshot.dispose();
    // The discovery manager is handed to this subsystem for its exclusive use.
    this.discoveryManager.dispose();
  }
}
