import * as vscode from "vscode";
import {
  RunOutcome,
  ScenarioRef,
  TraceabilityModel,
  TraceLink,
  UntracedScenario,
  worstStatus,
} from "../xray/traceability-model";

interface SectionNode {
  kind: "section";
  section: "covered" | "untraced";
}

interface TestKeyNode {
  kind: "testKey";
  testKey: string;
  project: string;
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

export type TraceabilityNode =
  | SectionNode
  | TestKeyNode
  | LinkNode
  | UntracedNode
  | InfoNode;

const NO_MAPPED_MESSAGE = "No scenarios are mapped to an Xray test yet.";
const NO_UNTRACED_MESSAGE = "Every scenario is mapped to an Xray test.";

const OUTCOME_ICON: Record<RunOutcome, string> = {
  passed: "testing-passed-icon",
  failed: "testing-failed-icon",
  skipped: "testing-skipped-icon",
};

function outcomeIcon(outcome: RunOutcome | undefined): vscode.ThemeIcon {
  return new vscode.ThemeIcon(outcome ? OUTCOME_ICON[outcome] : "circle-outline");
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

  constructor(private readonly model: TraceabilityModel) {
    this.subscription = this.model.onDidChange(() =>
      this._onDidChangeTreeData.fire(undefined)
    );
  }

  public dispose(): void {
    this.subscription.dispose();
    this._onDidChangeTreeData.dispose();
  }

  public getTreeItem(node: TraceabilityNode): vscode.TreeItem {
    switch (node.kind) {
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
        item.description = `${node.project} · ${scenarios}`;
        item.contextValue = "xrayTestKey";
        const aggregate = worstStatus(node.links.map((l) => l.lastResult));
        item.iconPath = aggregate ? outcomeIcon(aggregate) : new vscode.ThemeIcon("key");
        item.tooltip = node.testKey;
        return item;
      }
      case "link": {
        const { scenario, reqKeys } = node.link;
        const item = new vscode.TreeItem(scenario.name, vscode.TreeItemCollapsibleState.None);
        item.description = reqDescription(reqKeys);
        item.contextValue = "xrayScenario";
        item.iconPath = outcomeIcon(node.link.lastResult);
        item.command = revealCommand(scenario);
        return item;
      }
      case "untraced": {
        const { scenario, reqKeys } = node.item;
        const item = new vscode.TreeItem(scenario.name, vscode.TreeItemCollapsibleState.None);
        item.description = reqDescription(reqKeys);
        item.contextValue = "xrayUntraced";
        item.iconPath = new vscode.ThemeIcon("warning");
        item.command = revealCommand(scenario);
        return item;
      }
    }
  }

  public getChildren(node?: TraceabilityNode): TraceabilityNode[] {
    const snap = this.model.snapshot;
    if (!node) {
      if (snap.links.length === 0 && snap.untraced.length === 0) {
        return [];
      }
      return [
        { kind: "section", section: "covered" },
        { kind: "section", section: "untraced" },
      ];
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
      return [{ kind: "info", label: NO_MAPPED_MESSAGE }];
    }
    return [...byKey.entries()]
      .sort((a, b) => a[0].localeCompare(b[0]))
      .map(([testKey, links]) => ({
        kind: "testKey",
        testKey,
        project: links[0]?.project ?? "",
        links,
      }));
  }

  private untracedNodes(): TraceabilityNode[] {
    const items = this.model.snapshot.untraced;
    if (items.length === 0) {
      return [{ kind: "info", label: NO_UNTRACED_MESSAGE }];
    }
    return [...items]
      .sort((a, b) => a.scenario.name.localeCompare(b.scenario.name))
      .map((item) => ({ kind: "untraced", item }));
  }
}
