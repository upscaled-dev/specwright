import { describe, it, expect } from "vitest";
import * as vscode from "vscode";
import { TraceabilityTreeDataProvider } from "../../traceability/traceability-tree-data-provider";
import type { TraceabilityModel, TraceabilitySnapshot } from "../../traceability/traceability-model";

const EMPTY: TraceabilitySnapshot = { links: [], untraced: [], orphans: [], stale: false };

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
};

describe("TraceabilityTreeDataProvider", () => {
  it("returns no roots when the snapshot is empty so viewsWelcome renders", () => {
    expect(provider(EMPTY).getChildren()).toEqual([]);
  });

  it("returns no roots while disconnected even with a populated snapshot so the setup welcome shows", () => {
    expect(provider(SNAPSHOT, "Xray", false).getChildren()).toEqual([]);
  });

  it("renders sections once connected", () => {
    const p = provider(SNAPSHOT, "Xray", false);
    expect(p.getChildren()).toEqual([]);
    p.setConnected(true);
    expect(p.getChildren().map((n) => (n.kind === "section" ? n.section : n.kind))).toEqual([
      "covered",
      "untraced",
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

  it("shows the covered and untraced sections with counts", () => {
    const p = provider(SNAPSHOT);
    const roots = p.getChildren();
    expect(roots.map((n) => (n.kind === "section" ? n.section : n.kind))).toEqual([
      "covered",
      "untraced",
    ]);
    expect(p.getTreeItem(roots[0]!).label).toBe("Mapped tests");
    expect(p.getTreeItem(roots[0]!).description).toBe("2");
    expect(p.getTreeItem(roots[1]!).label).toBe("Untraced scenarios");
    expect(p.getTreeItem(roots[1]!).description).toBe("1");
  });

  it("groups links under their test key and renders reveal + badge on the scenario leaf", () => {
    const p = provider(SNAPSHOT);
    const roots = p.getChildren();
    const testKeys = p.getChildren(roots[0]);
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
    });
    const testKeys = p.getChildren(p.getChildren()[0]);
    expect(p.getTreeItem(testKeys[0]!).description).toBe("1 scenario");
  });

  it("lists untraced scenarios in the gap bucket", () => {
    const p = provider(SNAPSHOT);
    const roots = p.getChildren();
    const untraced = p.getChildren(roots[1]);
    const item = p.getTreeItem(untraced[0]!);
    expect(item.label).toBe("Untagged");
    expect(item.contextValue).toBe("traceabilityUntraced");
  });

  it("templates the empty-section message with the provider label", () => {
    const p = provider({ links: [], untraced: SNAPSHOT.untraced, orphans: [], stale: false }, "Azure DevOps");
    const covered = p.getChildren(p.getChildren()[0]);
    expect(p.getTreeItem(covered[0]!).label).toBe("No scenarios are mapped to a Azure DevOps test yet.");
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
