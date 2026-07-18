import { describe, it, expect } from "vitest";
import * as vscode from "vscode";
import { TraceabilityTreeDataProvider } from "../../providers/traceability-tree-data-provider";
import type { TraceabilityModel, TraceabilitySnapshot } from "../../xray/traceability-model";

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
    const provider = new TraceabilityTreeDataProvider(makeModel(EMPTY).model);
    expect(provider.getChildren()).toEqual([]);
  });

  it("shows the covered and untraced sections with counts", () => {
    const provider = new TraceabilityTreeDataProvider(makeModel(SNAPSHOT).model);
    const roots = provider.getChildren();
    expect(roots.map((n) => (n.kind === "section" ? n.section : n.kind))).toEqual([
      "covered",
      "untraced",
    ]);
    expect(provider.getTreeItem(roots[0]!).label).toBe("Mapped tests");
    expect(provider.getTreeItem(roots[0]!).description).toBe("2");
    expect(provider.getTreeItem(roots[1]!).label).toBe("Untraced scenarios");
    expect(provider.getTreeItem(roots[1]!).description).toBe("1");
  });

  it("groups links under their test key and renders reveal + badge on the scenario leaf", () => {
    const provider = new TraceabilityTreeDataProvider(makeModel(SNAPSHOT).model);
    const roots = provider.getChildren();
    const testKeys = provider.getChildren(roots[0]);
    expect(testKeys.map((n) => (n.kind === "testKey" ? n.testKey : n.kind))).toEqual([
      "CALC-1043",
      "CALC-1051",
    ]);

    const keyItem = provider.getTreeItem(testKeys[0]!);
    expect(keyItem.contextValue).toBe("xrayTestKey");
    expect(keyItem.description).toBe("CALC · 1 scenario");

    const leaves = provider.getChildren(testKeys[0]);
    const leaf = provider.getTreeItem(leaves[0]!);
    expect(leaf.label).toBe("Divide by zero");
    expect(leaf.description).toBe("REQ CALC-900");
    expect((leaf.iconPath as vscode.ThemeIcon).id).toBe("testing-passed-icon");
    const command = leaf.command as unknown as { command: string; arguments: [unknown, unknown] };
    expect(command.command).toBe("vscode.open");
    expect((command.arguments[1] as { selection: vscode.Range }).selection.start.line).toBe(3);
  });

  it("lists untraced scenarios in the gap bucket", () => {
    const provider = new TraceabilityTreeDataProvider(makeModel(SNAPSHOT).model);
    const roots = provider.getChildren();
    const untraced = provider.getChildren(roots[1]);
    const item = provider.getTreeItem(untraced[0]!);
    expect(item.label).toBe("Untagged");
    expect(item.contextValue).toBe("xrayUntraced");
  });

  it("fires onDidChangeTreeData when the model changes, until disposed", () => {
    const { model, fire } = makeModel(SNAPSHOT);
    const provider = new TraceabilityTreeDataProvider(model);
    let refreshes = 0;
    provider.onDidChangeTreeData(() => {
      refreshes += 1;
    });
    fire();
    expect(refreshes).toBe(1);
    provider.dispose();
    fire();
    expect(refreshes).toBe(1);
  });
});
