import * as vscode from "vscode";
import { toWorkspaceRelative } from "../utils/workspace-path";
import {
  RunOutcome,
  ScenarioRef,
  TraceabilityModel,
  TraceLink,
  UntracedScenario,
  worstStatus,
} from "./traceability-model";
import { NormalizedStatus } from "./contracts";

// "test" is the default layout (scenarios grouped by their mapped test key); "file" groups the same
// scenarios under their feature file. Persisted per workspace through GroupingModeStore.
export type GroupingMode = "test" | "file";

export interface GroupingModeStore {
  get(): GroupingMode;
  set(mode: GroupingMode): void;
}

interface SectionNode {
  kind: "section";
  section: "covered" | "untraced" | "orphan";
}

interface FileNode {
  kind: "file";
  filePath: string;
  relPath: string;
  untracedCount: number;
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
  // The configured xray.defaultProjectKey, when set, so the row can append "· project KEY". Used
  // only when creating tests or executions, which the tooltip spells out.
  defaultProject?: string | undefined;
}

interface ConnectionNode extends ConnectionIndicator {
  kind: "connection";
}

export type TraceabilityNode =
  | ConnectionNode
  | SectionNode
  | FileNode
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
      return new vscode.ThemeIcon("cloud");
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
  return (
    a.state === b.state &&
    a.label === b.label &&
    a.message === b.message &&
    a.defaultProject === b.defaultProject &&
    sameSync(a.sync, b.sync)
  );
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
  // No provider-display-name lives in the adapter registry (factories carry an `id` only), so the
  // row's label is the literal product name; the provider-specific site host rides the tooltip.
  const item = new vscode.TreeItem("Xray Cloud", vscode.TreeItemCollapsibleState.None);
  const { description, tooltip } = connectionText(node, Date.now());
  const project = node.defaultProject;
  item.description = project ? `${description} · project ${project}` : description;
  item.tooltip = project
    ? `${node.label}\n${tooltip}\nDefault project ${project}, used only when creating tests or executions.`
    : `${node.label}\n${tooltip}`;
  item.contextValue = "traceabilityConnection";
  item.iconPath = connectionIcon(node.state);
  item.command = { command: "playwrightBddRunner.traceability.connect", title: "Set Up Connection" };
  return item;
}

// A feature-file row in the by-file layout: the workspace-relative path labels it, the file icon
// comes from the resourceUri, and the untraced count (when any) flags the coverage gap.
function fileTreeItem(node: FileNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.relPath, vscode.TreeItemCollapsibleState.Expanded);
  item.resourceUri = vscode.Uri.file(node.filePath);
  item.contextValue = "traceabilityFile";
  if (node.untracedCount > 0) {
    item.description = `${node.untracedCount} untraced`;
  }
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
  private grouping: GroupingMode;

  constructor(
    private readonly model: TraceabilityModel,
    private readonly providerLabel: string,
    private readonly groupingStore?: GroupingModeStore
  ) {
    this.grouping = groupingStore?.get() ?? "test";
    this.subscription = this.model.onDidChange(() =>
      this._onDidChangeTreeData.fire(undefined)
    );
  }

  public get groupingMode(): GroupingMode {
    return this.grouping;
  }

  // Flip between the by-test and by-file layouts, persist the choice, and refresh. A recreated
  // provider (panel rebuild, provider swap) reads the persisted mode back through the store.
  public toggleGroupingMode(): void {
    this.grouping = this.grouping === "test" ? "file" : "test";
    this.groupingStore?.set(this.grouping);
    this._onDidChangeTreeData.fire(undefined);
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
      case "file":
        return fileTreeItem(node);
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
        const { scenario, reqKeys, examples } = node.item;
        const item = new vscode.TreeItem(scenario.name, vscode.TreeItemCollapsibleState.None);
        const parts: string[] = [];
        if (scenario.kind === "outline" && examples !== undefined) {
          parts.push(examples === 1 ? "1 example" : `${examples} examples`);
        }
        const req = reqDescription(reqKeys);
        if (req !== "") {parts.push(req);}
        item.description = parts.join(" · ");
        item.contextValue = "traceabilityUntraced";
        item.iconPath = new vscode.ThemeIcon("warning");
        item.command = revealCommand(scenario);
        return item;
      }
      case "orphan": {
        const item = new vscode.TreeItem(node.testKey, vscode.TreeItemCollapsibleState.None);
        if (node.summary) {item.description = node.summary;}
        item.contextValue = "traceabilityOrphan";
        item.iconPath = new vscode.ThemeIcon("warning", new vscode.ThemeColor("problemsWarningIcon.foreground"));
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
      return this.grouping === "file" ? this.fileRoots() : this.testRoots();
    }
    if (node.kind === "file") {
      return this.fileChildren(node);
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

  // The verified-connection row leads the tree when a status is set, in either layout.
  private withConnectionRow(rows: TraceabilityNode[]): TraceabilityNode[] {
    return this.connectionIndicator
      ? [{ kind: "connection", ...this.connectionIndicator }, ...rows]
      : rows;
  }

  // Untraced first (the gap bucket is the work queue), then covered, then orphans last. Orphans
  // render only on a complete catalogue fetch — a partial/unknown snapshot can never distinguish a
  // genuine orphan from a key whose covering scenario simply wasn't fetched (§2).
  private testRoots(): TraceabilityNode[] {
    const sections: TraceabilityNode[] = [
      { kind: "section", section: "untraced" },
      { kind: "section", section: "covered" },
    ];
    if (this.model.snapshot.completeness === "complete") {
      sections.push({ kind: "section", section: "orphan" });
    }
    return this.withConnectionRow(sections);
  }

  // By-file layout: one row per feature file, then the orphan section at the end (orphans have no
  // file). The orphan gate matches the by-test layout's.
  private fileRoots(): TraceabilityNode[] {
    const roots: TraceabilityNode[] = [...this.fileNodes()];
    if (this.model.snapshot.completeness === "complete") {
      roots.push({ kind: "section", section: "orphan" });
    }
    return this.withConnectionRow(roots);
  }

  private fileNodes(): FileNode[] {
    const snap = this.model.snapshot;
    const byFile = new Map<string, { untraced: number; relPath: string }>();
    const touch = (filePath: string, isUntraced: boolean): void => {
      const existing = byFile.get(filePath);
      if (existing) {
        if (isUntraced) {existing.untraced += 1;}
      } else {
        byFile.set(filePath, { untraced: isUntraced ? 1 : 0, relPath: toWorkspaceRelative(filePath) });
      }
    };
    for (const item of snap.untraced) {touch(item.scenario.filePath, true);}
    for (const link of snap.links) {touch(link.scenario.filePath, false);}
    return [...byFile.entries()]
      .map(([filePath, info]): FileNode => ({
        kind: "file",
        filePath,
        relPath: info.relPath,
        untracedCount: info.untraced,
      }))
      // Files with untraced scenarios sort first (coverage gaps), then alphabetically by path.
      .sort((a, b) => {
        const gap = (a.untracedCount > 0 ? 0 : 1) - (b.untracedCount > 0 ? 0 : 1);
        return gap !== 0 ? gap : a.relPath.localeCompare(b.relPath);
      });
  }

  // A file's scenarios: untraced rows above mapped ones, each ordered by source line.
  private fileChildren(node: FileNode): TraceabilityNode[] {
    const snap = this.model.snapshot;
    const untraced: TraceabilityNode[] = snap.untraced
      .filter((item) => item.scenario.filePath === node.filePath)
      .sort((a, b) => a.scenario.line - b.scenario.line)
      .map((item) => ({ kind: "untraced", item }));
    const links: TraceabilityNode[] = snap.links
      .filter((link) => link.scenario.filePath === node.filePath)
      .sort((a, b) => a.scenario.line - b.scenario.line)
      .map((link) => ({ kind: "link", link }));
    return [...untraced, ...links];
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
