import * as vscode from "vscode";
import {
  RunOutcome,
  ScenarioRef,
  TraceabilityModel,
  TraceLink,
  UntracedScenario,
  worstStatus,
} from "./traceability-model";
import { NormalizedStatus } from "./contracts";

interface SectionNode {
  kind: "section";
  section: "covered" | "untraced" | "orphan";
}

interface TestKeyNode {
  kind: "testKey";
  testKey: string;
  project?: string | undefined;
  links: TraceLink[];
}

interface LinkNode {
  kind: "link";
  link: TraceLink;
}

interface UntracedNode {
  kind: "untraced";
  item: UntracedScenario;
}

// Carries `testKey` at the top level so the shared openIssue/copyKey handlers read it the same way
// they read a TestKeyNode.
interface OrphanNode {
  kind: "orphan";
  testKey: string;
  summary?: string | undefined;
}

interface InfoNode {
  kind: "info";
  label: string;
}

export interface ConnectionSyncStatus {
  syncedAt: number;
  stale: boolean;
}

export interface ConnectionIndicator {
  state: "checking" | "ok" | "auth-failed" | "unreachable";
  label: string;
  message: string;
  // Present once a sync has produced cached data; drives the "synced Nm ago" description (§7,
  // display-only). Absent before the first sync so the row shows the bare connection state.
  sync?: ConnectionSyncStatus | undefined;
}

interface ConnectionNode extends ConnectionIndicator {
  kind: "connection";
}

export type TraceabilityNode =
  | ConnectionNode
  | SectionNode
  | TestKeyNode
  | LinkNode
  | UntracedNode
  | OrphanNode
  | InfoNode;

const CONNECTION_DESCRIPTION: Record<ConnectionIndicator["state"], string> = {
  checking: "Checking…",
  ok: "Connected",
  "auth-failed": "Authentication failed",
  unreachable: "Unreachable",
};

function connectionIcon(state: ConnectionIndicator["state"]): vscode.ThemeIcon {
  switch (state) {
    case "checking":
      return new vscode.ThemeIcon("loading~spin");
    case "ok":
      return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.green"));
    case "auth-failed":
      return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("charts.red"));
    case "unreachable":
      return new vscode.ThemeIcon("circle-outline");
  }
}

function sameSync(a: ConnectionSyncStatus | undefined, b: ConnectionSyncStatus | undefined): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return a.syncedAt === b.syncedAt && a.stale === b.stale;
}

function sameIndicator(
  a: ConnectionIndicator | undefined,
  b: ConnectionIndicator | undefined
): boolean {
  if (a === b) {
    return true;
  }
  if (!a || !b) {
    return false;
  }
  return a.state === b.state && a.label === b.label && a.message === b.message && sameSync(a.sync, b.sync);
}

// Coarse "time ago" for the sync staleness suffix (§7). Minutes below an hour, hours below a day,
// then days — enough resolution for a manually-triggered sync.
export function formatSyncedAgo(elapsedMs: number): string {
  const minutes = Math.floor(elapsedMs / 60_000);
  if (minutes < 1) {
    return "just now";
  }
  if (minutes < 60) {
    return `${minutes}m ago`;
  }
  const hours = Math.floor(minutes / 60);
  if (hours < 24) {
    return `${hours}h ago`;
  }
  return `${Math.floor(hours / 24)}d ago`;
}

// Display-only staleness text (§7): fresh → "Connected · synced 12m ago"; past the TTL →
// "… (stale)"; unreachable but holding cached data → "Unreachable · showing data synced 2h ago".
// The full sentence rides in the tooltip.
function connectionText(node: ConnectionNode, nowMs: number): { description: string; tooltip: string } {
  const base = CONNECTION_DESCRIPTION[node.state];
  if (!node.sync) {
    return { description: base, tooltip: node.message };
  }
  const ago = formatSyncedAgo(nowMs - node.sync.syncedAt);
  if (node.state === "unreachable") {
    return {
      description: `Unreachable · showing data synced ${ago}`,
      tooltip: `${node.message} · showing cached data synced ${ago}`,
    };
  }
  const staleSuffix = node.sync.stale ? " (stale)" : "";
  return {
    description: `${base} · synced ${ago}${staleSuffix}`,
    tooltip: `${node.message} · synced ${ago}${staleSuffix}`,
  };
}

// The description stays provider-neutral; the provider-specific detail lives in the tooltip. The
// row's command opens the setup panel so a click resolves the connection in place.
function connectionTreeItem(node: ConnectionNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
  const { description, tooltip } = connectionText(node, Date.now());
  item.description = description;
  item.tooltip = tooltip;
  item.contextValue = "traceabilityConnection";
  item.iconPath = connectionIcon(node.state);
  item.command = { command: "playwrightBddRunner.traceability.connect", title: "Set Up Connection" };
  return item;
}

const OUTCOME_ICON: Record<RunOutcome, string> = {
  passed: "testing-passed-icon",
  failed: "testing-failed-icon",
  skipped: "testing-skipped-icon",
};

const STATUS_ICON: Record<NormalizedStatus["category"], string> = {
  passed: "testing-passed-icon",
  failed: "testing-failed-icon",
  pending: "testing-queued-icon",
  unknown: "testing-unset-icon",
};

function outcomeIcon(outcome: RunOutcome | undefined): vscode.ThemeIcon {
  return new vscode.ThemeIcon(outcome ? OUTCOME_ICON[outcome] : "circle-outline");
}

function statusIcon(status: NormalizedStatus): vscode.ThemeIcon {
  return new vscode.ThemeIcon(STATUS_ICON[status.category]);
}

function reqDescription(reqKeys: readonly string[]): string {
  return reqKeys.length > 0 ? `REQ ${reqKeys.join(", ")}` : "";
}

// Sum the passed/total iterations of a key's data-driven links so a mapped-test row shows a single
// "N/M". Non-outline links carry no iterations, so a plain scenario key returns undefined (no badge).
function aggregateIterations(links: readonly TraceLink[]): { passed: number; total: number } | undefined {
  let passed = 0;
  let total = 0;
  let any = false;
  for (const link of links) {
    if (link.iterations) {
      passed += link.iterations.passed;
      total += link.iterations.total;
      any = true;
    }
  }
  return any ? { passed, total } : undefined;
}

// The mapped-test row's description: the remote summary once synced (mockup parity: "CALC-1042 Add
// two positive numbers"), the offline project/scenario-count text before that, plus the "N/M"
// iteration badge on data-driven rows.
function testKeyDescription(node: TestKeyNode): string {
  const scenarios = node.links.length === 1 ? "1 scenario" : `${node.links.length} scenarios`;
  const countText = node.project ? `${node.project} · ${scenarios}` : scenarios;
  const summary = node.links[0]?.meta?.summary;
  const parts = [summary && summary !== "" ? summary : countText];
  const iterations = aggregateIterations(node.links);
  if (iterations) {
    parts.push(`${iterations.passed}/${iterations.total}`);
  }
  return parts.join(" · ");
}

function revealCommand(ref: ScenarioRef): vscode.Command {
  return {
    command: "vscode.open",
    title: "Open",
    arguments: [
      vscode.Uri.file(ref.filePath),
      { selection: new vscode.Range(ref.line - 1, 0, ref.line - 1, 0) },
    ],
  };
}

export class TraceabilityTreeDataProvider
  implements vscode.TreeDataProvider<TraceabilityNode>, vscode.Disposable
{
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<TraceabilityNode | undefined>();
  public readonly onDidChangeTreeData = this._onDidChangeTreeData.event;
  private readonly subscription: vscode.Disposable;
  private connected = false;
  private connectionIndicator: ConnectionIndicator | undefined;

  constructor(
    private readonly model: TraceabilityModel,
    private readonly providerLabel: string
  ) {
    this.subscription = this.model.onDidChange(() =>
      this._onDidChangeTreeData.fire(undefined)
    );
  }

  // Until a provider connection exists the offline tag tree stays empty so the setup welcome shows
  // instead (§4.1); the subsystem drives this off the credential store's connection state.
  public setConnected(connected: boolean): void {
    if (this.connected === connected) {
      return;
    }
    this.connected = connected;
    this._onDidChangeTreeData.fire(undefined);
  }

  // `undefined` means "no status row". A no-op on a shallow-equal value keeps a repeated probe from
  // collapsing the tree's expansion state.
  public setConnectionIndicator(indicator: ConnectionIndicator | undefined): void {
    if (sameIndicator(this.connectionIndicator, indicator)) {
      return;
    }
    this.connectionIndicator = indicator;
    this._onDidChangeTreeData.fire(undefined);
  }

  public dispose(): void {
    this.subscription.dispose();
    this._onDidChangeTreeData.dispose();
  }

  public getTreeItem(node: TraceabilityNode): vscode.TreeItem {
    switch (node.kind) {
      case "connection":
        return connectionTreeItem(node);
      case "info": {
        const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
        item.iconPath = new vscode.ThemeIcon("info");
        return item;
      }
      case "section":
        return this.sectionTreeItem(node);
      case "testKey": {
        const item = new vscode.TreeItem(node.testKey, vscode.TreeItemCollapsibleState.Collapsed);
        const description = testKeyDescription(node);
        item.description = description;
        item.contextValue = "traceabilityTestKey";
        // All links under a key share the same snapshot entry, so the verdict and remote status are
        // the test's, not per-scenario. It wins over the aggregate local run result when present (§3.3).
        const first = node.links[0];
        const status = first?.meta?.status;
        if (first?.remoteMissing) {
          // A provably-absent key: the warning outranks any local pass so a green tick can never
          // vouch for a test the complete remote catalogue proved missing. No summary exists here,
          // so `description` is the offline count text.
          item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"));
          item.description = `${description} · not found on remote`;
          const where = first.project ? ` in project ${first.project}` : "";
          item.tooltip = `${node.testKey} was not found${where} on the connected site. The tag may be stale, mistyped, or reference a Jira issue that is not a test.`;
        } else if (status) {
          item.iconPath = statusIcon(status);
          item.tooltip = `${node.testKey} · ${status.providerValue}`;
        } else {
          const aggregate = worstStatus(node.links.map((l) => l.lastResult));
          // A mapped test with no result anywhere renders the amber "no run" dash; outcome icons
          // take precedence once a run lands.
          item.iconPath = aggregate ? outcomeIcon(aggregate) : new vscode.ThemeIcon("do-not-disturb", new vscode.ThemeColor("problemsWarningIcon.foreground"));
          item.tooltip = node.testKey;
        }
        return item;
      }
      case "link": {
        const { scenario, reqKeys } = node.link;
        const item = new vscode.TreeItem(scenario.name, vscode.TreeItemCollapsibleState.None);
        const parts = [reqDescription(reqKeys)];
        if (node.link.drift) {parts.push("drift");}
        item.description = parts.filter((p) => p !== "").join(" · ");
        item.contextValue = "traceabilityScenario";
        item.iconPath = outcomeIcon(node.link.lastResult);
        item.command = revealCommand(scenario);
        if (node.link.drift) {
          item.tooltip = `${scenario.name}\nThe remote test text differs from this scenario (display only; reconcile arrives in a later release).`;
        }
        return item;
      }
      case "untraced": {
        const { scenario, reqKeys } = node.item;
        const item = new vscode.TreeItem(scenario.name, vscode.TreeItemCollapsibleState.None);
        item.description = reqDescription(reqKeys);
        item.contextValue = "traceabilityUntraced";
        item.iconPath = new vscode.ThemeIcon("warning");
        item.command = revealCommand(scenario);
        return item;
      }
      case "orphan": {
        const item = new vscode.TreeItem(node.testKey, vscode.TreeItemCollapsibleState.None);
        if (node.summary) {item.description = node.summary;}
        item.contextValue = "traceabilityOrphan";
        item.iconPath = new vscode.ThemeIcon("link-external");
        item.tooltip = node.summary ? `${node.testKey} · ${node.summary}` : node.testKey;
        // A click opens the remote issue; the same key rides the node for openIssue/copyKey.
        item.command = {
          command: "playwrightBddRunner.traceability.openIssue",
          title: "Open Issue in Tracker",
          arguments: [node],
        };
        return item;
      }
    }
  }

  private sectionTreeItem(node: SectionNode): vscode.TreeItem {
    const snap = this.model.snapshot;
    const labels: Record<SectionNode["section"], string> = {
      untraced: "Untraced scenarios",
      covered: "Mapped tests",
      orphan: `Orphan ${this.providerLabel} tests`,
    };
    const counts: Record<SectionNode["section"], number> = {
      untraced: snap.untraced.length,
      covered: new Set(snap.links.map((l) => l.testKey)).size,
      orphan: snap.orphans.length,
    };
    const item = new vscode.TreeItem(labels[node.section], vscode.TreeItemCollapsibleState.Expanded);
    item.description = String(counts[node.section]);
    return item;
  }

  public getChildren(node?: TraceabilityNode): TraceabilityNode[] {
    const snap = this.model.snapshot;
    if (!node) {
      if (!this.connected || (snap.links.length === 0 && snap.untraced.length === 0)) {
        return [];
      }
      // Untraced first (the gap bucket is the work queue), then covered, then orphans last. Orphans
      // render only on a complete catalogue fetch — a partial/unknown snapshot can never distinguish
      // a genuine orphan from a key whose covering scenario simply wasn't fetched (§2).
      const sections: TraceabilityNode[] = [
        { kind: "section", section: "untraced" },
        { kind: "section", section: "covered" },
      ];
      if (snap.completeness === "complete") {
        sections.push({ kind: "section", section: "orphan" });
      }
      // The verified-connection row leads the tree when a status is set.
      return this.connectionIndicator
        ? [{ kind: "connection", ...this.connectionIndicator }, ...sections]
        : sections;
    }
    if (node.kind === "section") {
      if (node.section === "covered") {return this.coveredNodes();}
      if (node.section === "orphan") {return this.orphanNodes();}
      return this.untracedNodes();
    }
    if (node.kind === "testKey") {
      return node.links.map((link) => ({ kind: "link", link }));
    }
    return [];
  }

  private coveredNodes(): TraceabilityNode[] {
    const byKey = new Map<string, TraceLink[]>();
    for (const link of this.model.snapshot.links) {
      const list = byKey.get(link.testKey) ?? [];
      list.push(link);
      byKey.set(link.testKey, list);
    }
    if (byKey.size === 0) {
      return [{ kind: "info", label: `No scenarios are mapped to a ${this.providerLabel} test yet.` }];
    }
    return [...byKey.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([testKey, links]) => ({
        kind: "testKey",
        testKey,
        project: links[0]?.project,
        links,
      }));
  }

  private untracedNodes(): TraceabilityNode[] {
    const items = this.model.snapshot.untraced;
    if (items.length === 0) {
      return [{ kind: "info", label: `Every scenario is mapped to a ${this.providerLabel} test.` }];
    }
    return [...items]
      .sort((a, b) => a.scenario.name.localeCompare(b.scenario.name))
      .map((item) => ({ kind: "untraced", item }));
  }

  private orphanNodes(): TraceabilityNode[] {
    const orphans = this.model.snapshot.orphans;
    if (orphans.length === 0) {
      return [{ kind: "info", label: `No orphan ${this.providerLabel} tests in the synced scope.` }];
    }
    return [...orphans]
      .sort((a, b) => a.testKey.localeCompare(b.testKey))
      .map((orphan) => ({ kind: "orphan", testKey: orphan.testKey, summary: orphan.meta.summary }));
  }
}
