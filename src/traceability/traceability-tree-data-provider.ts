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
  section: "covered" | "untraced";
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

interface InfoNode {
  kind: "info";
  label: string;
}

export interface ConnectionIndicator {
  state: "checking" | "ok" | "auth-failed" | "unreachable";
  label: string;
  message: string;
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
  return a.state === b.state && a.label === b.label && a.message === b.message;
}

// The description stays provider-neutral; the provider-specific detail lives in the tooltip. The
// row's command opens the setup panel so a click resolves the connection in place.
function connectionTreeItem(node: ConnectionNode): vscode.TreeItem {
  const item = new vscode.TreeItem(node.label, vscode.TreeItemCollapsibleState.None);
  item.description = CONNECTION_DESCRIPTION[node.state];
  item.tooltip = node.message;
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
      case "section": {
        const snap = this.model.snapshot;
        const covered = node.section === "covered";
        const count = covered ? new Set(snap.links.map((l) => l.testKey)).size : snap.untraced.length;
        const item = new vscode.TreeItem(
          covered ? "Mapped tests" : "Untraced scenarios",
          vscode.TreeItemCollapsibleState.Expanded
        );
        item.description = String(count);
        return item;
      }
      case "testKey": {
        const item = new vscode.TreeItem(node.testKey, vscode.TreeItemCollapsibleState.Collapsed);
        const scenarios = node.links.length === 1 ? "1 scenario" : `${node.links.length} scenarios`;
        item.description = node.project ? `${node.project} · ${scenarios}` : scenarios;
        item.contextValue = "traceabilityTestKey";
        // All links under a key share the same snapshot entry, so the remote status is the test's,
        // not per-scenario. It wins over the aggregate local run result when present (§3.3).
        const status = node.links[0]?.meta?.status;
        if (status) {
          item.iconPath = statusIcon(status);
          item.tooltip = `${node.testKey} · ${status.providerValue}`;
        } else {
          const aggregate = worstStatus(node.links.map((l) => l.lastResult));
          item.iconPath = aggregate ? outcomeIcon(aggregate) : new vscode.ThemeIcon("key");
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
    }
  }

  public getChildren(node?: TraceabilityNode): TraceabilityNode[] {
    const snap = this.model.snapshot;
    if (!node) {
      if (!this.connected || (snap.links.length === 0 && snap.untraced.length === 0)) {
        return [];
      }
      // Untraced first: the gap bucket is the panel's work queue, so it sits above mapped tests.
      const sections: TraceabilityNode[] = [
        { kind: "section", section: "untraced" },
        { kind: "section", section: "covered" },
      ];
      // The verified-connection row leads the tree when a status is set.
      return this.connectionIndicator
        ? [{ kind: "connection", ...this.connectionIndicator }, ...sections]
        : sections;
    }
    if (node.kind === "section") {
      return node.section === "covered" ? this.coveredNodes() : this.untracedNodes();
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
}
