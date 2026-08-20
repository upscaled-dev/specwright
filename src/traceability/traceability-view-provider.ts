import * as vscode from "vscode";
import { Logger } from "../utils/logger";
import { createNonce } from "../utils/webview";
import {
  TRACEABILITY_CHUNK_BYTES,
  TRACEABILITY_CHUNK_ROWS,
  TRACEABILITY_VIEW_PROTOCOL_VERSION,
  parseTraceabilityClientEnvelope,
  type TraceabilityEnvelope,
  type TraceabilityHostBody,
  type TraceabilityWireRow,
} from "../webview/traceability-view-protocol";
import { renderTraceabilityViewDocument } from "./traceability-view-document";
import {
  projectTraceabilityTree,
  type ConnectionIndicator,
  type GroupingMode,
  type TraceabilityActionId,
  type TraceabilityNode,
  type TraceabilityProjection,
} from "./traceability-tree-projection";
import type { TraceabilityModel } from "./traceability-model";

export const TRACEABILITY_VIEW_ID = "playwrightBddRunner.traceability";
export type TraceabilityClientSignal = "ready" | "focused";
type Delivery = "sent" | "failed" | "interrupted";

/** Extension-lifetime owner for the Traceability WebviewView. The subsystem only attaches live data. */
export class TraceabilityViewProvider implements vscode.WebviewViewProvider, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private session = "";
  private revision = 0;
  private generation = 0;
  private model: TraceabilityModel | undefined;
  private modelSubscription: vscode.Disposable | undefined;
  private providerLabel = "Xray";
  private grouping: GroupingMode = "test";
  private connected = false;
  private indicator: ConnectionIndicator | undefined;
  private trusted = true;
  private projection: TraceabilityProjection = { state: "empty", rows: [], nodes: new Map() };
  private advertisedActions = new Map<string, ReadonlySet<string>>();
  private transfer: Promise<void> | undefined;
  private queued = false;
  private ready = false;
  // A false/rejected post never retries itself. A later external invalidation or ready is a recovery edge.
  private deliveryFailed = false;
  private viewEpoch = 0;
  private visibilityEpoch = 0;
  private focusRequested = false;
  private focusAcknowledgements = 0;
  private readonly clientSignalEmitter = new vscode.EventEmitter<TraceabilityClientSignal>();
  public readonly onDidReceiveClientSignal = this.clientSignalEmitter.event;
  private disposed = false;

  constructor(private readonly assetRoot: vscode.Uri, private readonly logger: Logger) {}

  public get clientReady(): boolean { return this.ready; }
  public get acknowledgedFocusCount(): number { return this.focusAcknowledgements; }
  public get currentProjection(): { readonly state: TraceabilityProjection["state"]; readonly total: number; readonly labels: readonly string[] } {
    return { state: this.projection.state, total: this.projection.rows.length, labels: this.projection.rows.map((row) => row.label) };
  }

  public resolveWebviewView(view: vscode.WebviewView): void {
    this.viewEpoch += 1;
    this.view = view;
    this.session = createNonce();
    this.revision = 0;
    this.ready = false;
    view.webview.options = { enableScripts: true, localResourceRoots: [this.assetRoot] };
    view.webview.html = renderTraceabilityViewDocument(view.webview, this.assetRoot, this.session);
    view.onDidDispose(() => {
      if (this.view === view) {
        this.view = undefined;
        this.ready = false;
        this.visibilityEpoch += 1;
        this.queued = true;
      }
    });
    view.onDidChangeVisibility(() => {
      if (this.view !== view) { return; }
      this.visibilityEpoch += 1;
      this.scheduleFlush();
    });
    view.webview.onDidReceiveMessage((message) => this.receive(message));
  }

  public attach(model: TraceabilityModel, providerLabel: string, grouping: GroupingMode): void {
    this.modelSubscription?.dispose();
    this.model = model;
    this.providerLabel = providerLabel;
    this.grouping = grouping;
    this.modelSubscription = model.onDidChange(() => this.invalidate());
    this.invalidate();
  }

  public detach(): void {
    this.modelSubscription?.dispose();
    this.modelSubscription = undefined;
    this.model = undefined;
    this.connected = false;
    this.indicator = undefined;
    this.invalidate();
  }

  public setGrouping(grouping: GroupingMode): void { if (this.grouping !== grouping) { this.grouping = grouping; this.invalidate(); } }
  public setConnected(connected: boolean): void { if (this.connected !== connected) { this.connected = connected; this.invalidate(); } }
  public setConnectionIndicator(indicator: ConnectionIndicator | undefined): void {
    if (sameIndicator(this.indicator, indicator)) { return; }
    this.indicator = indicator;
    this.invalidate();
  }
  public setTrusted(trusted: boolean): void { if (this.trusted !== trusted) { this.trusted = trusted; this.invalidate(); } }
  public focusFilter(): void {
    this.focusRequested = true;
    this.scheduleFlush();
  }

  private invalidate(): void {
    // A model or view-state change is an external recovery edge. Keep a visible failed post from
    // spinning, but do not freeze a retained client behind an old committed generation forever.
    this.deliveryFailed = false;
    this.generation += 1;
    this.projection = projectTraceabilityTree(this.model, this.providerLabel, this.grouping, this.connected, this.indicator, this.trusted);
    this.advertisedActions = new Map(this.projection.rows.map((row) => [row.id, new Set(row.actions.map((action) => action.id))]));
    this.scheduleTransfer();
  }

  private scheduleTransfer(): void {
    this.queued = true;
    this.scheduleFlush();
  }

  private scheduleFlush(): void {
    if (!this.view || !this.visible() || !this.ready || this.disposed || this.deliveryFailed) { return; }
    this.transfer ??= this.flush();
  }

  // A failed post or a newer model never accumulates work: one in-flight transfer plus one latest retry.
  private async flush(): Promise<void> {
    try {
      while (!this.disposed && !this.deliveryFailed) {
        if (this.queued) {
          this.queued = false;
          const generation = this.generation;
          const projection = this.projection;
          const epoch = this.viewEpoch;
          const visibility = this.visibilityEpoch;
          const delivery = await this.sendGeneration(generation, projection, epoch, visibility);
          // A pending old post belongs to its captured generation. Its failure cannot strand the
          // newer projection that invalidated it while it was in flight.
          if (generation !== this.generation) {
            this.queued = true;
            continue;
          }
          if (delivery !== "sent") {
            if (delivery === "failed") { this.deliveryFailed = true; }
            else { this.queued = true; }
            return;
          }
        }
        if (this.focusRequested) {
          const generation = this.generation;
          const epoch = this.viewEpoch;
          const visibility = this.visibilityEpoch;
          const delivery = await this.post({ type: "focus-filter", generation }, epoch, visibility);
          if (generation !== this.generation) {
            this.queued = true;
            continue;
          }
          if (delivery !== "sent") {
            if (delivery === "failed") { this.deliveryFailed = true; }
            return;
          }
          this.focusRequested = false;
          continue;
        }
        break;
      }
    } finally {
      this.transfer = undefined;
      if ((this.queued || this.focusRequested) && this.view && this.visible() && this.ready && !this.disposed && !this.deliveryFailed) {
        this.transfer = this.flush();
      }
    }
  }

  private async sendGeneration(generation: number, projection: TraceabilityProjection, epoch: number, visibility: number): Promise<Delivery> {
    const begin = await this.post({ type: "begin", generation, state: projection.state, total: projection.rows.length }, epoch, visibility);
    if (begin !== "sent") { return begin; }
    let chunk: TraceabilityWireRow[] = [];
    let bytes = 0;
    let rowsSent = 0;
    for (const row of projection.rows) {
      if (generation !== this.generation) { return "sent"; }
      const wire = row as TraceabilityWireRow;
      // Byte length, rather than UTF-16 code units, is the transport boundary: emoji and CJK labels
      // must not allow a chunk beyond the webview message budget.
      const size = Buffer.byteLength(JSON.stringify(wire), "utf8") + 256;
      if (chunk.length && (chunk.length >= TRACEABILITY_CHUNK_ROWS || bytes + size > TRACEABILITY_CHUNK_BYTES)) {
        const delivery = await this.post({ type: "chunk", generation, offset: rowsSent, rows: chunk }, epoch, visibility);
        if (delivery !== "sent") { return delivery; }
        rowsSent += chunk.length;
        chunk = []; bytes = 0;
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
      chunk.push(wire); bytes += size;
    }
    if (chunk.length) {
      const delivery = await this.post({ type: "chunk", generation, offset: rowsSent, rows: chunk }, epoch, visibility);
      if (delivery !== "sent") { return delivery; }
    }
    return generation !== this.generation ? "sent" : this.post({ type: "end", generation }, epoch, visibility);
  }

  private post(body: TraceabilityHostBody, epoch = this.viewEpoch, visibility = this.visibilityEpoch): Promise<Delivery> {
    if (!this.view || !this.visible() || epoch !== this.viewEpoch || visibility !== this.visibilityEpoch) { return Promise.resolve("interrupted"); }
    const revision = this.revision + 1;
    const message: TraceabilityEnvelope<TraceabilityHostBody> = { version: TRACEABILITY_VIEW_PROTOCOL_VERSION, session: this.session, revision, surface: "traceability", body };
    return Promise.resolve(this.view.webview.postMessage(message)).then(
      (sent) => {
        if (sent && epoch === this.viewEpoch) { this.revision = revision; return "sent"; }
        if (this.view && this.visible() && epoch === this.viewEpoch && visibility === this.visibilityEpoch) { return "failed"; }
        return "interrupted";
      },
      (error: unknown) => {
        if (this.view && this.visible() && epoch === this.viewEpoch && visibility === this.visibilityEpoch) {
          this.logger.warn("Traceability view post failed", { error: String(error) });
          return "failed";
        }
        return "interrupted";
      }
    );
  }

  private visible(): boolean {
    return this.view?.visible !== false;
  }

  private receive(value: unknown): void {
    const envelope = parseTraceabilityClientEnvelope(value);
    if (this.disposed || envelope?.session !== this.session) { return; }
    const body = envelope.body;
    if (body.type === "ready") {
      if (!this.ready || this.deliveryFailed) {
        const firstReady = !this.ready;
        this.ready = true;
        this.deliveryFailed = false;
        this.scheduleTransfer();
        if (firstReady) { this.clientSignalEmitter.fire("ready"); }
      }
      return;
    }
    if (envelope.revision !== this.revision) { return; }
    if (body.generation !== this.generation) { return; }
    if (body.type === "focused") {
      this.focusAcknowledgements += 1;
      this.clientSignalEmitter.fire("focused");
      return;
    }
    const node = this.projection.nodes.get(body.id);
    if (!node || !this.actionAllowed(body.id, body.action)) { return; }
    const selection = [...new Set(body.selection)].map((id) => this.projection.nodes.get(id));
    if (selection.some((item) => item === undefined)) { return; }
    Promise.resolve(this.execute(body.action as TraceabilityActionId, node, selection as TraceabilityNode[])).catch((error: unknown) => this.logger.warn("Traceability view action failed", { error: String(error) }));
  }

  private actionAllowed(id: string, action: string): boolean {
    return this.advertisedActions.get(id)?.has(action) ?? false;
  }

  private execute(action: TraceabilityActionId, node: TraceabilityNode, selection: readonly TraceabilityNode[]): Thenable<unknown> {
    switch (action) {
      case "open":
        if (node.kind === "link" || node.kind === "untraced") {
          const scenario = node.kind === "link" ? node.link.scenario : node.item.scenario;
          const line = scenario.line - 1;
          return vscode.commands.executeCommand(resolveActionCommand(action, node), vscode.Uri.file(scenario.filePath), { selection: new vscode.Range(line, 0, line, 0) });
        }
        return vscode.commands.executeCommand(resolveActionCommand(action, node), node);
      case "run":
        return vscode.commands.executeCommand(resolveActionCommand(action, node), node, selection);
      case "copy":
      case "link":
      case "switch-project":
        return vscode.commands.executeCommand(resolveActionCommand(action, node), node);
      case "connect":
      case "select-sync-projects":
      case "hide":
      case "manage-trust":
        return vscode.commands.executeCommand(resolveActionCommand(action, node));
    }
  }

  public dispose(): void {
    this.disposed = true;
    this.modelSubscription?.dispose();
    this.modelSubscription = undefined;
    this.view = undefined;
    this.ready = false;
    this.clientSignalEmitter.dispose();
  }
}

function sameIndicator(a: ConnectionIndicator | undefined, b: ConnectionIndicator | undefined): boolean {
  if (!a || !b) { return a === b; }
  return a.state === b.state && a.label === b.label && a.message === b.message && a.defaultProject === b.defaultProject && a.sync?.syncedAt === b.sync?.syncedAt && a.sync?.stale === b.sync?.stale;
}

function resolveActionCommand(action: TraceabilityActionId, node: TraceabilityNode): string {
  switch (action) {
    case "open": return node.kind === "link" || node.kind === "untraced"
      ? "vscode.open"
      : "playwrightBddRunner.traceability.openIssue";
    case "copy": return "playwrightBddRunner.traceability.copyKey";
    case "link": return "playwrightBddRunner.traceability.linkScenario";
    case "run": return "playwrightBddRunner.traceability.runAndPublish";
    case "connect": return "playwrightBddRunner.traceability.connect";
    case "switch-project": return "playwrightBddRunner.traceability.switchDefaultProject";
    case "select-sync-projects": return "playwrightBddRunner.traceability.selectSyncProjects";
    case "hide": return "playwrightBddRunner.traceability.hidePanel";
    case "manage-trust": return "workbench.trust.manage";
  }
}
