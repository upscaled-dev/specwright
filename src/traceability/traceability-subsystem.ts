import * as vscode from "vscode";
import { ExtensionConfig } from "../core/extension-config";
import { FeatureParser } from "../parsers/feature-parser";
import { TestDiscoveryManager } from "../core/test-discovery-manager";
import { PlaywrightJsonParser } from "../utils/playwright-json-parser";
import { Logger } from "../utils/logger";
import { REPORT_CANDIDATES, TraceabilityModel } from "./traceability-model";
import { TraceabilityAdapter } from "./traceability-adapter";
import { TraceabilityTreeDataProvider } from "./traceability-tree-data-provider";

const FALLBACK_PROVIDER_ID = "xray";

// One watcher per candidate report path (a brace-glob with a slash inside `{}` does not fire
// reliably in a VS Code FileSystemWatcher). A create/change/delete on any of these refreshes the
// badges — including a delete, so stale badges clear when a report is removed.
const REPORT_WATCH_GLOBS = REPORT_CANDIDATES.map((candidate) => `**/${candidate}`);

/**
 * Sibling to ProviderRegistry: owns the traceability panel with the same idempotent
 * reconcile-on-config-change lifecycle. When `traceability.enablePanel` is off the whole subsystem
 * tears down — tree, model, watchers — with zero residue. Shares nothing with the Steps code. The
 * provider is injected as a TraceabilityAdapter, so a second backend is a one-line map addition.
 */
export class TraceabilitySubsystem implements vscode.Disposable {
  private treeView: vscode.Disposable | undefined;
  private treeProvider: TraceabilityTreeDataProvider | undefined;
  private model: TraceabilityModel | undefined;
  private watcherDisposables: vscode.Disposable[] = [];
  private lastSignature: string | undefined;
  private rebuildTimer: ReturnType<typeof setTimeout> | undefined;
  private rebuildInFlight = false;
  private rebuildPending = false;
  private readonly configChangeDisposable: vscode.Disposable;
  private disposed = false;
  private warnedUnknownProvider = false;

  /** Debounce window for coalescing bursts of watcher events (overridable in tests). */
  public rebuildDebounceMs = 300;

  constructor(
    private readonly config: ExtensionConfig,
    private readonly adapters: Record<string, TraceabilityAdapter>,
    private readonly featureParser: FeatureParser,
    private readonly discoveryManager: TestDiscoveryManager,
    private readonly playwrightJsonParser: PlaywrightJsonParser,
    private readonly logger: Logger
  ) {
    this.configChangeDisposable = config.addChangeListener(() => this.applyCurrent());
  }

  public applyCurrent(): void {
    if (this.disposed) {return;}
    this.reconcileTraceabilityPanel();
  }

  public get traceabilityPanelActive(): boolean {
    return this.treeView !== undefined;
  }

  // Reads config.traceabilityProvider live so switching the provider re-selects here; an unknown id
  // falls back to Xray and warns once (not once per config-change burst).
  private selectAdapter(): TraceabilityAdapter | undefined {
    const id = this.config.traceabilityProvider;
    const adapter = this.adapters[id];
    if (adapter) {return adapter;}
    if (!this.warnedUnknownProvider) {
      this.logger.warn(`Unknown traceability provider "${id}", falling back to "${FALLBACK_PROVIDER_ID}"`);
      this.warnedUnknownProvider = true;
    }
    return this.adapters[FALLBACK_PROVIDER_ID];
  }

  private reconcileTraceabilityPanel(): void {
    if (!this.config.enableTraceabilityPanel) {
      this.teardown();
      return;
    }
    const adapter = this.selectAdapter();
    if (!adapter) {
      this.teardown();
      return;
    }
    const signature = this.signature(adapter);
    if (this.treeView && this.lastSignature === signature) {
      return;
    }
    // A changed signature — provider swap, prefix, or pattern — rebuilds the whole panel so the new
    // adapter's model, label, and watchers all take effect without a window reload.
    this.teardown();
    const model = new TraceabilityModel(
      this.featureParser,
      this.discoveryManager,
      this.playwrightJsonParser,
      adapter,
      this.logger
    );
    this.model = model;
    const provider = new TraceabilityTreeDataProvider(model, adapter.label);
    this.treeProvider = provider;
    this.treeView = vscode.window.createTreeView("playwrightBddRunner.traceability", {
      treeDataProvider: provider,
    });
    this.setupWatchers();
    this.lastSignature = signature;
    this.scheduleRebuild();
    this.logger.info("Traceability panel enabled");
  }

  // The active provider id joins the signature so switching traceability.provider forces a rebuild.
  // The browse URL (siteUrl) is deliberately excluded: it is read live, so editing it must not
  // tear down watchers or trigger a rescan. Only inputs the model actually consumes belong here.
  private signature(adapter: TraceabilityAdapter): string {
    return [
      adapter.id,
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
    for (const d of this.watcherDisposables) {d.dispose();}
    this.watcherDisposables = [];
    this.treeView?.dispose();
    this.treeView = undefined;
    this.treeProvider?.dispose();
    this.treeProvider = undefined;
    this.model?.dispose();
    this.model = undefined;
    this.lastSignature = undefined;
  }

  public dispose(): void {
    this.disposed = true;
    this.configChangeDisposable.dispose();
    this.teardown();
    // The discovery manager is handed to this subsystem for its exclusive use.
    this.discoveryManager.dispose();
  }
}
