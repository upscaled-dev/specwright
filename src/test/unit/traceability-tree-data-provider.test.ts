import { describe, it, expect } from "vitest";
import * as vscode from "vscode";
import {
  formatSyncedAgo,
  TraceabilityNode,
  TraceabilityTreeDataProvider,
} from "../../traceability/traceability-tree-data-provider";
import type { TraceabilityModel, TraceabilitySnapshot } from "../../traceability/traceability-model";

const EMPTY: TraceabilitySnapshot = { links: [], untraced: [], orphans: [], stale: false, completeness: "unknown", errors: [] };

function makeModel(snapshot: TraceabilitySnapshot): {
  model: TraceabilityModel;
  fire: () => void;
} {
  const emitter = new vscode.EventEmitter<void>();
  const model = {
    get snapshot(): TraceabilitySnapshot {
      return snapshot;
    },
    onDidChange: emitter.event,
  } as unknown as TraceabilityModel;
  return { model, fire: () => emitter.fire() };
}

function provider(
  snapshot: TraceabilitySnapshot,
  label = "Xray",
  connected = true
): TraceabilityTreeDataProvider {
  const p = new TraceabilityTreeDataProvider(makeModel(snapshot).model, label);
  p.setConnected(connected);
  return p;
}

const SNAPSHOT: TraceabilitySnapshot = {
  links: [
    {
      testKey: "CALC-1043",
      project: "CALC",
      scenario: { filePath: "/ws/a.feature", line: 4, name: "Divide by zero", kind: "scenario" },
      reqKeys: ["CALC-900"],
      lastResult: "passed",
    },
    {
      testKey: "CALC-1051",
      project: "CALC",
      scenario: { filePath: "/ws/a.feature", line: 11, name: "Multiply", kind: "outline", outlineName: "Multiply" },
      reqKeys: [],
      lastResult: "failed",
    },
  ],
  untraced: [
    { scenario: { filePath: "/ws/a.feature", line: 7, name: "Untagged", kind: "scenario" }, reqKeys: [] },
  ],
  orphans: [],
  stale: false,
  completeness: "unknown",
  errors: [],
};

describe("TraceabilityTreeDataProvider", () => {
  it("returns no roots when the snapshot is empty so viewsWelcome renders", () => {
    expect(provider(EMPTY).getChildren()).toEqual([]);
  });

  it("returns no roots while disconnected even with a populated snapshot so the setup welcome shows", () => {
    expect(provider(SNAPSHOT, "Xray", false).getChildren()).toEqual([]);
  });

  it("renders sections once connected, untraced first", () => {
    const p = provider(SNAPSHOT, "Xray", false);
    expect(p.getChildren()).toEqual([]);
    p.setConnected(true);
    expect(p.getChildren().map((n) => (n.kind === "section" ? n.section : n.kind))).toEqual([
      "untraced",
      "covered",
    ]);
  });

  it("fires a tree refresh when the connection state flips", () => {
    const p = provider(EMPTY, "Xray", false);
    let refreshes = 0;
    p.onDidChangeTreeData(() => { refreshes += 1; });
    p.setConnected(true);
    expect(refreshes).toBe(1);
    p.setConnected(true);
    expect(refreshes).toBe(1);
    p.setConnected(false);
    expect(refreshes).toBe(2);
  });

  it("shows the untraced and covered sections with counts", () => {
    const p = provider(SNAPSHOT);
    const roots = p.getChildren();
    expect(roots.map((n) => (n.kind === "section" ? n.section : n.kind))).toEqual([
      "untraced",
      "covered",
    ]);
    expect(p.getTreeItem(roots[0]!).label).toBe("Untraced scenarios");
    expect(p.getTreeItem(roots[0]!).description).toBe("1");
    expect(p.getTreeItem(roots[1]!).label).toBe("Mapped tests");
    expect(p.getTreeItem(roots[1]!).description).toBe("2");
  });

  it("groups links under their test key and renders reveal + badge on the scenario leaf", () => {
    const p = provider(SNAPSHOT);
    const roots = p.getChildren();
    const testKeys = p.getChildren(roots[1]);
    expect(testKeys.map((n) => (n.kind === "testKey" ? n.testKey : n.kind))).toEqual([
      "CALC-1043",
      "CALC-1051",
    ]);

    const keyItem = p.getTreeItem(testKeys[0]!);
    expect(keyItem.contextValue).toBe("traceabilityTestKey");
    expect(keyItem.description).toBe("CALC · 1 scenario");

    const leaves = p.getChildren(testKeys[0]);
    const leaf = p.getTreeItem(leaves[0]!);
    expect(leaf.label).toBe("Divide by zero");
    expect(leaf.description).toBe("REQ CALC-900");
    expect(leaf.contextValue).toBe("traceabilityScenario");
    expect((leaf.iconPath as vscode.ThemeIcon).id).toBe("testing-passed-icon");
    const command = leaf.command as unknown as { command: string; arguments: [unknown, unknown] };
    expect(command.command).toBe("vscode.open");
    expect((command.arguments[1] as { selection: vscode.Range }).selection.start.line).toBe(3);
  });

  it("omits the project segment when a link carries no project", () => {
    const p = provider({
      links: [
        {
          testKey: "T-1",
          scenario: { filePath: "/ws/a.feature", line: 2, name: "A", kind: "scenario" },
          reqKeys: [],
        },
      ],
      untraced: [],
      orphans: [],
      stale: false,
      completeness: "unknown",
      errors: [],
    });
    const testKeys = p.getChildren(p.getChildren()[1]);
    expect(p.getTreeItem(testKeys[0]!).description).toBe("1 scenario");
  });

  it("lists untraced scenarios in the gap bucket", () => {
    const p = provider(SNAPSHOT);
    const roots = p.getChildren();
    const untraced = p.getChildren(roots[0]);
    const item = p.getTreeItem(untraced[0]!);
    expect(item.label).toBe("Untagged");
    expect(item.contextValue).toBe("traceabilityUntraced");
  });

  it("templates the empty-section message with the provider label", () => {
    const p = provider({ links: [], untraced: SNAPSHOT.untraced, orphans: [], stale: false, completeness: "unknown", errors: [] }, "Azure DevOps");
    const covered = p.getChildren(p.getChildren()[1]);
    expect(p.getTreeItem(covered[0]!).label).toBe("No scenarios are mapped to a Azure DevOps test yet.");
  });

  it("renders the snapshot's normalized status on the mapped-test row with providerValue in the tooltip", () => {
    const p = provider({
      links: [
        {
          testKey: "CALC-1",
          scenario: { filePath: "/ws/a.feature", line: 2, name: "A", kind: "scenario" },
          reqKeys: [],
          lastResult: "passed",
          meta: { key: "CALC-1", summary: "A test", status: { category: "failed", providerValue: "In Review" } },
        },
      ],
      untraced: [],
      orphans: [],
      stale: false,
      completeness: "complete",
      errors: [],
    });
    const testKeys = p.getChildren(p.getChildren()[1]);
    const item = p.getTreeItem(testKeys[0]!);
    expect((item.iconPath as vscode.ThemeIcon).id).toBe("testing-failed-icon");
    expect(item.tooltip).toBe("CALC-1 · In Review");
  });

  it("falls back to the aggregate local run badge when the snapshot has no status", () => {
    const p = provider(SNAPSHOT);
    const testKeys = p.getChildren(p.getChildren()[1]);
    const passed = p.getTreeItem(testKeys[0]!);
    expect((passed.iconPath as vscode.ThemeIcon).id).toBe("testing-passed-icon");
    const failed = p.getTreeItem(testKeys[1]!);
    expect((failed.iconPath as vscode.ThemeIcon).id).toBe("testing-failed-icon");
  });

  it("marks a drifting link with a description suffix and an explanatory tooltip", () => {
    const p = provider({
      links: [
        {
          testKey: "CALC-1",
          scenario: { filePath: "/ws/a.feature", line: 2, name: "Divide", kind: "scenario" },
          reqKeys: ["CALC-9"],
          lastResult: "passed",
          meta: { key: "CALC-1", gherkin: "Scenario: Divide\n  Given other" },
          drift: true,
        },
      ],
      untraced: [],
      orphans: [],
      stale: false,
      completeness: "complete",
      errors: [],
    });
    const testKeys = p.getChildren(p.getChildren()[1]);
    const leaf = p.getTreeItem(p.getChildren(testKeys[0])[0]!);
    expect(leaf.description).toBe("REQ CALC-9 · drift");
    expect(String(leaf.tooltip)).toContain("differs");
  });

  it("leaves a non-drifting link with no drift marker", () => {
    const p = provider(SNAPSHOT);
    const testKeys = p.getChildren(p.getChildren()[1]);
    const leaf = p.getTreeItem(p.getChildren(testKeys[0])[0]!);
    expect(leaf.description).toBe("REQ CALC-900");
  });

  it("leads the tree with the connection row when an indicator is set and the snapshot is non-empty", () => {
    const p = provider(SNAPSHOT);
    p.setConnectionIndicator({ state: "ok", label: "acme.atlassian.net", message: "Connected to acme" });
    const roots = p.getChildren();
    expect(roots.map((n) => (n.kind === "section" ? n.section : n.kind))).toEqual([
      "connection",
      "untraced",
      "covered",
    ]);
  });

  it("omits the connection row when no indicator is set", () => {
    const p = provider(SNAPSHOT);
    expect(p.getChildren().map((n) => n.kind)).toEqual(["section", "section"]);
  });

  it("omits the connection row on an empty snapshot so the welcome still shows, even with an indicator", () => {
    const p = provider(EMPTY);
    p.setConnectionIndicator({ state: "ok", label: "acme.atlassian.net", message: "Connected" });
    expect(p.getChildren()).toEqual([]);
  });

  it("renders each connection state with its icon, color, and description", () => {
    const p = provider(SNAPSHOT);
    const rowFor = (state: "checking" | "ok" | "auth-failed" | "unreachable"): vscode.TreeItem => {
      p.setConnectionIndicator({ state, label: "acme.atlassian.net", message: `msg-${state}` });
      return p.getTreeItem(p.getChildren()[0]!);
    };

    const checking = rowFor("checking");
    expect((checking.iconPath as vscode.ThemeIcon).id).toBe("loading~spin");
    expect(checking.description).toBe("Checking…");

    const ok = rowFor("ok");
    expect((ok.iconPath as vscode.ThemeIcon).id).toBe("circle-filled");
    expect(((ok.iconPath as vscode.ThemeIcon).color as vscode.ThemeColor).id).toBe("charts.green");
    expect(ok.description).toBe("Connected");

    const authFailed = rowFor("auth-failed");
    expect((authFailed.iconPath as vscode.ThemeIcon).id).toBe("circle-filled");
    expect(((authFailed.iconPath as vscode.ThemeIcon).color as vscode.ThemeColor).id).toBe("charts.red");
    expect(authFailed.description).toBe("Authentication failed");

    const unreachable = rowFor("unreachable");
    expect((unreachable.iconPath as vscode.ThemeIcon).id).toBe("circle-outline");
    expect((unreachable.iconPath as vscode.ThemeIcon).color).toBeUndefined();
    expect(unreachable.description).toBe("Unreachable");
  });

  it("carries the site host as label, the provider detail in the tooltip, and the setup command on the row", () => {
    const p = provider(SNAPSHOT);
    p.setConnectionIndicator({ state: "ok", label: "acme.atlassian.net", message: "Connected to acme — project CALC" });
    const item = p.getTreeItem(p.getChildren()[0]!);
    expect(item.label).toBe("acme.atlassian.net");
    expect(item.tooltip).toBe("Connected to acme — project CALC");
    expect(item.contextValue).toBe("traceabilityConnection");
    expect((item.command as { command: string }).command).toBe("playwrightBddRunner.traceability.connect");
  });

  it("does not fire a tree refresh when the indicator is set to a shallow-equal value", () => {
    const p = provider(SNAPSHOT);
    let refreshes = 0;
    p.onDidChangeTreeData(() => { refreshes += 1; });
    p.setConnectionIndicator({ state: "ok", label: "acme", message: "up" });
    expect(refreshes).toBe(1);
    p.setConnectionIndicator({ state: "ok", label: "acme", message: "up" });
    expect(refreshes).toBe(1);
    p.setConnectionIndicator({ state: "auth-failed", label: "acme", message: "up" });
    expect(refreshes).toBe(2);
    p.setConnectionIndicator(undefined);
    expect(refreshes).toBe(3);
    p.setConnectionIndicator(undefined);
    expect(refreshes).toBe(3);
  });

  it("fires onDidChangeTreeData when the model changes, until disposed", () => {
    const { model, fire } = makeModel(SNAPSHOT);
    const p = new TraceabilityTreeDataProvider(model, "Xray");
    let refreshes = 0;
    p.onDidChangeTreeData(() => {
      refreshes += 1;
    });
    fire();
    expect(refreshes).toBe(1);
    p.dispose();
    fire();
    expect(refreshes).toBe(1);
  });
});

describe("formatSyncedAgo", () => {
  it("uses just now / minutes / hours / days buckets", () => {
    expect(formatSyncedAgo(5_000)).toBe("just now");
    expect(formatSyncedAgo(12 * 60_000)).toBe("12m ago");
    expect(formatSyncedAgo(2 * 3_600_000)).toBe("2h ago");
    expect(formatSyncedAgo(3 * 86_400_000)).toBe("3d ago");
  });
});

describe("TraceabilityTreeDataProvider connection staleness row", () => {
  function connectionRow(indicator: Parameters<TraceabilityTreeDataProvider["setConnectionIndicator"]>[0]): vscode.TreeItem {
    const p = provider(SNAPSHOT);
    p.setConnectionIndicator(indicator);
    const roots: TraceabilityNode[] = p.getChildren();
    return p.getTreeItem(roots[0]!);
  }

  it("appends 'synced Nm ago' to a fresh connected row and mirrors it in the tooltip", () => {
    const item = connectionRow({
      state: "ok",
      label: "acme.atlassian.net",
      message: "Connected to acme",
      sync: { syncedAt: Date.now() - 12 * 60_000, stale: false },
    });
    expect(item.description).toBe("Connected · synced 12m ago");
    expect(String(item.tooltip)).toBe("Connected to acme · synced 12m ago");
  });

  it("marks a past-TTL sync as stale in the description", () => {
    const item = connectionRow({
      state: "ok",
      label: "acme.atlassian.net",
      message: "Connected to acme",
      sync: { syncedAt: Date.now() - 2 * 3_600_000, stale: true },
    });
    expect(item.description).toBe("Connected · synced 2h ago (stale)");
  });

  it("shows cached data on an unreachable row", () => {
    const item = connectionRow({
      state: "unreachable",
      label: "acme.atlassian.net",
      message: "Could not reach Xray",
      sync: { syncedAt: Date.now() - 2 * 3_600_000, stale: true },
    });
    expect(item.description).toBe("Unreachable · showing data synced 2h ago");
    expect(String(item.tooltip)).toBe("Could not reach Xray · showing cached data synced 2h ago");
  });

  it("re-renders when only the sync freshness changes", () => {
    const p = provider(SNAPSHOT);
    let refreshes = 0;
    p.onDidChangeTreeData(() => { refreshes += 1; });
    p.setConnectionIndicator({ state: "ok", label: "acme", message: "up", sync: { syncedAt: 1000, stale: false } });
    expect(refreshes).toBe(1);
    p.setConnectionIndicator({ state: "ok", label: "acme", message: "up", sync: { syncedAt: 2000, stale: false } });
    expect(refreshes).toBe(2);
  });
});
