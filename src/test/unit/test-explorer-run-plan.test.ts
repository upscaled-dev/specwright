import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import {
  requestedTestItems,
  testExplorerRunIntent,
} from "../../test-providers/test-explorer-run-plan";
import type { Scenario } from "../../types";
import { FeatureParser } from "../../parsers/feature-parser";
import { pathRunIntent, scenarioRunIntent } from "../../commands/run-intent";
import type { ClientRunIntent } from "../../ui/execution-client-context";
import { OUTLINE_ID_SEPARATOR } from "../../test-providers/constants";
import { FakeTestController, FakeTestItem } from "./helpers/fake-test-controller";

function scenario(filePath: string, name: string, lineNumber: number): Scenario {
  return {
    filePath,
    name,
    line: lineNumber,
    lineNumber,
    range: new vscode.Range(lineNumber - 1, 0, lineNumber - 1, name.length),
    steps: [],
    isScenarioOutline: false,
  };
}

type PlanOptions = Parameters<typeof testExplorerRunIntent>[0];

// The per-file scenario universe is what proves a title names only itself, so a test that does not
// declare one is asserting the unbatched, line-precise shape.
function planIntent(
  options: Omit<PlanOptions, "scenariosInFile"> &
    { scenariosInFile?: PlanOptions["scenariosInFile"] }
): ClientRunIntent {
  return testExplorerRunIntent({ scenariosInFile: () => [], ...options });
}

describe("requestedTestItems", () => {
  it("splits an included ancestor around excluded descendants", () => {
    const controller = new FakeTestController();
    const root = new FakeTestItem("group", "Group");
    const keep = new FakeTestItem("keep", "Keep", { fsPath: "/ws/a.feature" });
    const exclude = new FakeTestItem("exclude", "Exclude", { fsPath: "/ws/b.feature" });
    root.children.add(keep);
    root.children.add(exclude);
    controller.items.add(root);

    expect(requestedTestItems(
      new vscode.TestRunRequest(
        [root as unknown as vscode.TestItem],
        [exclude as unknown as vscode.TestItem]
      ),
      controller as unknown as vscode.TestController
    )).toEqual([keep]);
  });
});

describe("testExplorerRunIntent", () => {
  it("uses one suite target for an unfiltered run and carries the worker bound", () => {
    const request = new vscode.TestRunRequest() as vscode.TestRunRequest;
    const intent = planIntent({
      request,
      roots: [],
      mode: "run",
      scenarioFor: () => undefined,
      isFeatureFile: () => false,
      maxWorkers: 4,
    });

    expect({ ...intent }).toEqual({
      mode: "run",
      targets: [{ kind: "suite" }],
      maxWorkers: 4,
    });
    expect(intent.selection).toEqual({ kind: "suite" });
    expect(intent.metadata).toEqual({ initiatedBy: "test-explorer" });
  });

  it("keeps a debug feature request as a path target", () => {
    const feature = new FakeTestItem("file:/ws/a.feature", "A", { fsPath: "/ws/a.feature" });
    const intent = planIntent({
      request: new vscode.TestRunRequest([feature as unknown as vscode.TestItem]),
      roots: [feature] as unknown as vscode.TestItem[],
      mode: "debug",
      scenarioFor: () => undefined,
      isFeatureFile: (id) => id === feature.id,
    });

    expect(intent.targets).toEqual([{ kind: "path", path: "/ws/a.feature" }]);
    expect(intent.selection).toEqual({ kind: "feature", filePath: "/ws/a.feature" });
  });

  it("deduplicates scenario targets while retaining the described selection", () => {
    const parsed = scenario("/ws/a.feature", "A", 3);
    const first = new FakeTestItem("scenario-a", "A", { fsPath: parsed.filePath });
    const duplicate = new FakeTestItem("scenario-a-copy", "A", { fsPath: parsed.filePath });
    const intent = planIntent({
      request: new vscode.TestRunRequest([
        first as unknown as vscode.TestItem,
        duplicate as unknown as vscode.TestItem,
      ]),
      roots: [first, duplicate] as unknown as vscode.TestItem[],
      mode: "run",
      scenarioFor: (id) => id.startsWith("scenario-a") ? parsed : undefined,
      isFeatureFile: () => false,
    });

    expect(intent.targets).toHaveLength(1);
    expect(intent.targets[0]).toMatchObject({ kind: "scenario" });
    expect(intent.selection).toMatchObject({ kind: "scenario" });
  });

  it("keeps a single feature root identical to command feature intent", () => {
    const feature = new FakeTestItem("file:/ws/a.feature", "A", { fsPath: "/ws/a.feature" });
    const explorer = planIntent({
      request: new vscode.TestRunRequest([feature as unknown as vscode.TestItem]),
      roots: [feature] as unknown as vscode.TestItem[],
      mode: "run",
      scenarioFor: () => undefined,
      isFeatureFile: (id) => id === feature.id,
    });
    const command = pathRunIntent("/ws/a.feature", "feature", "run", "palette");

    expect({ selection: explorer.selection, targets: explorer.targets }).toEqual({
      selection: command.selection,
      targets: command.targets,
    });
  });

  it("expands a lone tag group to its visible descendants instead of a workspace tag run", () => {
    const tagged = new FakeTestItem("tag:@smoke and not @wip", "smoke");
    tagged.children.add(new FakeTestItem("a", "A", { fsPath: "/ws/a.feature" }));
    const hiddenSameTag = scenario("/ws/hidden.feature", "Hidden", 11);
    const explorer = planIntent({
      request: new vscode.TestRunRequest([tagged as unknown as vscode.TestItem]),
      roots: [tagged] as unknown as vscode.TestItem[],
      mode: "run",
      scenarioFor: (id) => id === "a"
        ? scenario("/ws/a.feature", "A", 3)
        : id === "hidden" ? hiddenSameTag : undefined,
      isFeatureFile: () => false,
    });
    expect({ selection: explorer.selection, targets: explorer.targets }).toEqual({
      selection: {
        kind: "scenario",
        scenario: { filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" },
      },
      targets: [{
        kind: "scenario",
        scenario: { filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" },
      }],
    });
  });

  // A group node lists the scenarios that belong to it. Running the file each of them lives in
  // would run the siblings the user did not select.
  it("runs only the scenarios under a selected group, never their whole files", () => {
    const group = new FakeTestItem("group:Smoke", "Smoke");
    const chosen = new FakeTestItem("/ws/a.feature:3", "A", { fsPath: "/ws/a.feature" });
    group.children.add(chosen);
    const parsed = scenario("/ws/a.feature", "A", 3);

    const intent = planIntent({
      request: new vscode.TestRunRequest([group as unknown as vscode.TestItem]),
      roots: [group] as unknown as vscode.TestItem[],
      mode: "run",
      scenarioFor: (id) => (id === chosen.id ? parsed : undefined),
      isFeatureFile: (id) => id === "/ws/a.feature",
    });

    expect(intent.targets).toEqual([{
      kind: "scenario",
      scenario: { filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" },
    }]);
  });

  // Tag membership overlaps: one scenario can sit under both groups, and two tag-filtered passes
  // would run it twice.
  it("runs a case shared by two selected tag groups once", () => {
    const smoke = new FakeTestItem("tag:@smoke", "smoke");
    const regression = new FakeTestItem("tag:@regression", "regression");
    smoke.children.add(new FakeTestItem("a-smoke", "A", { fsPath: "/ws/a.feature" }));
    regression.children.add(new FakeTestItem("a-regression", "A", { fsPath: "/ws/a.feature" }));
    regression.children.add(new FakeTestItem("b", "B", { fsPath: "/ws/b.feature" }));
    const shared = scenario("/ws/a.feature", "A", 3);

    const intent = planIntent({
      request: new vscode.TestRunRequest([
        smoke as unknown as vscode.TestItem,
        regression as unknown as vscode.TestItem,
      ]),
      roots: [smoke, regression] as unknown as vscode.TestItem[],
      mode: "run",
      scenarioFor: (id) => (id.startsWith("a")
        ? shared
        : id === "b" ? scenario("/ws/b.feature", "B", 7) : undefined),
      isFeatureFile: () => false,
    });

    // One target per selected scenario, and the shared case appears in exactly one of them.
    expect(intent.targets).toEqual([
      { kind: "scenario", scenario: { filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" } },
      { kind: "scenario", scenario: { filePath: "/ws/b.feature", line: 7, name: "B", kind: "scenario" } },
    ]);
  });

  it("keeps every case in a multi-file group as an exact line-bearing target", () => {
    const group = new FakeTestItem("group:Smoke", "Smoke");
    const discovered = new Map<string, Scenario[]>([["/ws/a.feature", []], ["/ws/b.feature", []]]);
    const byId = new Map<string, Scenario>();
    for (const [file, line] of [["a", 3], ["a", 9], ["b", 4], ["b", 11]] as const) {
      const filePath = `/ws/${file}.feature`;
      const id = `${filePath}:${line}`;
      const parsed = scenario(filePath, `${file}${line}`, line);
      byId.set(id, parsed);
      discovered.get(filePath)!.push(parsed);
      group.children.add(new FakeTestItem(id, parsed.name, { fsPath: filePath }));
    }
    // One scenario of a.feature stays unselected, so a whole-file target would run it.
    discovered.get("/ws/a.feature")!.push(scenario("/ws/a.feature", "unselected", 15));

    const intent = planIntent({
      request: new vscode.TestRunRequest([group as unknown as vscode.TestItem]),
      roots: [group] as unknown as vscode.TestItem[],
      mode: "run",
      scenarioFor: (id) => byId.get(id),
      scenariosInFile: (filePath) => discovered.get(filePath) ?? [],
      isFeatureFile: (id) => !id.includes(":"),
    });

    expect(intent.targets).toEqual([
      { kind: "scenario", scenario: { filePath: "/ws/a.feature", line: 3, name: "a3", kind: "scenario" } },
      { kind: "scenario", scenario: { filePath: "/ws/a.feature", line: 9, name: "a9", kind: "scenario" } },
      { kind: "scenario", scenario: { filePath: "/ws/b.feature", line: 4, name: "b4", kind: "scenario" } },
      { kind: "scenario", scenario: { filePath: "/ws/b.feature", line: 11, name: "b11", kind: "scenario" } },
    ]);
  });

  // Precision beats batching: a title that also names a sibling of its own file cannot be scoped by
  // a grep, so it keeps the line-precise target a single selection gets.
  it("keeps a title that names a sibling of its file on its own target", () => {
    const group = new FakeTestItem("group:Smoke", "Smoke");
    const unique = scenario("/ws/a.feature", "Checkout", 3);
    const ambiguous = scenario("/ws/a.feature", "Checkout", 9);
    const suffixed = scenario("/ws/a.feature", "Fast Checkout", 21);
    const alsoSelected = scenario("/ws/a.feature", "Refund", 30);
    for (const parsed of [unique, ambiguous, alsoSelected]) {
      group.children.add(new FakeTestItem(
        `/ws/a.feature:${parsed.lineNumber}`,
        parsed.name,
        { fsPath: parsed.filePath }
      ));
    }
    const byLine = new Map([unique, ambiguous, alsoSelected].map((s) => [`/ws/a.feature:${s.lineNumber}`, s]));

    const intent = planIntent({
      request: new vscode.TestRunRequest([group as unknown as vscode.TestItem]),
      roots: [group] as unknown as vscode.TestItem[],
      mode: "run",
      scenarioFor: (id) => byLine.get(id),
      scenariosInFile: () => [unique, ambiguous, suffixed, alsoSelected],
      isFeatureFile: (id) => !id.includes(":"),
    });

    expect(intent.targets).toEqual([
      { kind: "scenario", scenario: { filePath: "/ws/a.feature", line: 3, name: "Checkout", kind: "scenario" } },
      { kind: "scenario", scenario: { filePath: "/ws/a.feature", line: 9, name: "Checkout", kind: "scenario" } },
      { kind: "scenario", scenario: { filePath: "/ws/a.feature", line: 30, name: "Refund", kind: "scenario" } },
    ]);
  });

  it("expands a selected tag root to deduped scenarios for debug without changing selection", () => {
    const tagged = new FakeTestItem("tag:@smoke", "smoke");
    tagged.children.add(new FakeTestItem("a", "A", { fsPath: "/ws/a.feature" }));
    tagged.children.add(new FakeTestItem("a-copy", "A", { fsPath: "/ws/a.feature" }));
    const parsed = scenario("/ws/a.feature", "A", 3);

    const intent = planIntent({
      request: new vscode.TestRunRequest([tagged as unknown as vscode.TestItem]),
      roots: [tagged] as unknown as vscode.TestItem[],
      mode: "debug",
      scenarioFor: (id) => id.startsWith("a") ? parsed : undefined,
      isFeatureFile: () => false,
    });

    expect(intent.selection).toEqual({
      kind: "scenario",
      scenario: { filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" },
    });
    expect(intent.targets).toEqual([{
      kind: "scenarios",
      scenarios: [{ filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" }],
    }]);
  });

  it("debugs all tag groups as one deduped sequential scenario target", () => {
    const smoke = new FakeTestItem("tag:@smoke", "smoke");
    const regression = new FakeTestItem("tag:@regression", "regression");
    smoke.children.add(new FakeTestItem("a-smoke", "A", { fsPath: "/ws/a.feature" }));
    regression.children.add(new FakeTestItem("a-regression", "A", { fsPath: "/ws/a.feature" }));
    regression.children.add(new FakeTestItem("b", "B", { fsPath: "/ws/b.feature" }));

    const intent = planIntent({
      request: new vscode.TestRunRequest(),
      roots: [smoke, regression] as unknown as vscode.TestItem[],
      mode: "debug",
      scenarioFor: (id) => id.startsWith("a")
        ? scenario("/ws/a.feature", "A", 3)
        : id === "b" ? scenario("/ws/b.feature", "B", 7) : undefined,
      isFeatureFile: () => false,
    });

    expect(intent.selection).toEqual({
      kind: "multi-select",
      scenarios: [
        { filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" },
        { filePath: "/ws/b.feature", line: 7, name: "B", kind: "scenario" },
      ],
    });
    expect(intent.targets).toEqual([{
      kind: "scenarios",
      scenarios: expect.arrayContaining([
        expect.objectContaining({ name: "A" }),
        expect.objectContaining({ name: "B" }),
      ]),
    }]);
  });

  describe("exact group targets", () => {
    it("keeps a joined-chain counterexample line-precise", () => {
      const multiWord = scenario("/ws/c.feature", "Add to cart", 7);
      const alsoSelected = scenario("/ws/c.feature", "Refund", 12);
      const sibling = scenario("/ws/c.feature", "cart", 3);
      const group = new FakeTestItem("group:Smoke", "Smoke");
      const byId = new Map<string, Scenario>();
      for (const parsed of [multiWord, alsoSelected]) {
        const id = `/ws/c.feature:${parsed.lineNumber}`;
        byId.set(id, parsed);
        group.children.add(new FakeTestItem(id, parsed.name, { fsPath: "/ws/c.feature" }));
      }

      const intent = planIntent({
        request: new vscode.TestRunRequest([group as unknown as vscode.TestItem]),
        roots: [group] as unknown as vscode.TestItem[],
        mode: "run",
        scenarioFor: (id) => byId.get(id),
        scenariosInFile: () => [sibling, multiWord, alsoSelected],
        isFeatureFile: (id) => !id.includes(":"),
      });

      expect(intent.targets).toEqual([
        {
          kind: "scenario",
          scenario: { filePath: "/ws/c.feature", line: 7, name: "Add to cart", kind: "scenario" },
        },
        {
          kind: "scenario",
          scenario: { filePath: "/ws/c.feature", line: 12, name: "Refund", kind: "scenario" },
        },
      ]);
    });
  });

  describe("populated outline targets", () => {
    const filePath = "/ws/outline.feature";
    const content = [
      "Feature: Calculator",
      "",
      "Scenario Outline: Divide",
      "  Given <n>",
      "",
      "  Examples:",
      "    | n |",
      "    | 1 |",
      "    | 2 |",
    ].join("\n");

    function parseOutline() {
      const parser = FeatureParser.create();
      const parsed = parser.parseFeatureContent(content)!;
      parsed.scenarios.forEach((item) => {item.filePath = filePath;});
      return { parser, parsed };
    }

    function explorerIntent(item: FakeTestItem, scenario: Scenario): ClientRunIntent {
      return planIntent({
        request: new vscode.TestRunRequest([item as unknown as vscode.TestItem]),
        roots: [item] as unknown as vscode.TestItem[],
        mode: "run",
        scenarioFor: (id) => (id === item.id ? scenario : undefined),
        isFeatureFile: () => false,
      });
    }

    it("runs the whole outline with no line from a declaration CodeLens and the outline node", () => {
      const { parser, parsed } = parseOutline();
      const declarationLens = parser.provideScenarioCodeLenses(content, filePath)
        .find((lens) => lens.command?.command === "playwrightBddRunner.runScenario" &&
          lens.command.arguments?.[1] === 3)!;
      const [lensFile, lensLine, lensName] = declarationLens.command!.arguments as [string, number, string];
      const codeLens = scenarioRunIntent(parsed, lensFile, lensLine, lensName, undefined, "run", "code-lens");
      const node = new FakeTestItem(
        `${filePath}${OUTLINE_ID_SEPARATOR}3:Divide`,
        "Scenario Outline: Divide",
        { fsPath: filePath }
      );

      const explorer = explorerIntent(node, parsed.scenarios[0]!);

      // Line 0 is the honest "no generated test on this line", so the runner greps the outline title.
      expect(codeLens.selection).toEqual({
        kind: "scenario",
        scenario: { filePath, line: 0, name: "Divide", kind: "outline", outlineName: "Divide" },
      });
      expect({ selection: explorer.selection, targets: explorer.targets }).toEqual({
        selection: codeLens.selection,
        targets: codeLens.targets,
      });
    });

    it("keeps an example row's own line from the palette and the Test Explorer leaf", () => {
      const { parsed } = parseOutline();
      const firstRow = parsed.scenarios[0]!;
      const palette = scenarioRunIntent(
        parsed,
        filePath,
        firstRow.lineNumber,
        firstRow.name,
        firstRow.isScenarioOutline ? firstRow.outlineName : undefined,
        "run",
        "palette"
      );
      const leaf = new FakeTestItem(`${filePath}:${firstRow.lineNumber}`, firstRow.name, { fsPath: filePath });

      const explorer = explorerIntent(leaf, firstRow);

      expect(palette.targets).toEqual([{
        kind: "scenario",
        scenario: {
          filePath,
          line: firstRow.lineNumber,
          name: "Divide",
          kind: "outline",
          outlineName: "Divide",
        },
      }]);
      expect(explorer.targets).toEqual(palette.targets);
    });

    it("drops a scenario root the selected feature file already runs", () => {
      const { parsed } = parseOutline();
      const firstRow = parsed.scenarios[0]!;
      const file = new FakeTestItem(filePath, "outline.feature", { fsPath: filePath });
      const leaf = new FakeTestItem(`${filePath}:${firstRow.lineNumber}`, firstRow.name, { fsPath: filePath });

      const intent = planIntent({
        request: new vscode.TestRunRequest([file, leaf] as unknown as vscode.TestItem[]),
        roots: [file, leaf] as unknown as vscode.TestItem[],
        mode: "run",
        scenarioFor: (id) => (id === leaf.id ? firstRow : undefined),
        isFeatureFile: (id) => id === filePath,
      });

      expect(intent.targets).toEqual([{ kind: "path", path: filePath }]);
    });

    it("runs an outline node and one of its rows once, not twice", () => {
      const { parsed } = parseOutline();
      const firstRow = parsed.scenarios[0]!;
      const node = new FakeTestItem(
        `${filePath}${OUTLINE_ID_SEPARATOR}3:Divide`,
        "Scenario Outline: Divide",
        { fsPath: filePath }
      );
      const leaf = new FakeTestItem(`${filePath}:${firstRow.lineNumber}`, firstRow.name, { fsPath: filePath });

      const intent = planIntent({
        request: new vscode.TestRunRequest([node, leaf] as unknown as vscode.TestItem[]),
        roots: [node, leaf] as unknown as vscode.TestItem[],
        mode: "run",
        scenarioFor: (id) => (id === node.id ? parsed.scenarios[0] : firstRow),
        isFeatureFile: () => false,
      });

      expect(intent.targets).toEqual([{
        kind: "scenario",
        scenario: { filePath, line: 0, name: "Divide", kind: "outline", outlineName: "Divide" },
      }]);
    });

    it("runs a selected outline node once, not again per row", () => {
      const { parsed } = parseOutline();
      const node = new FakeTestItem(
        `${filePath}${OUTLINE_ID_SEPARATOR}3:Divide`,
        "Scenario Outline: Divide",
        { fsPath: filePath }
      );
      for (const row of parsed.scenarios) {
        node.children.add(new FakeTestItem(`${filePath}:${row.lineNumber}`, row.name, { fsPath: filePath }));
      }
      const byId = new Map(parsed.scenarios.map((row) => [`${filePath}:${row.lineNumber}`, row]));

      const intent = planIntent({
        request: new vscode.TestRunRequest([node as unknown as vscode.TestItem]),
        roots: [node] as unknown as vscode.TestItem[],
        mode: "debug",
        scenarioFor: (id) => (id === node.id ? parsed.scenarios[0] : byId.get(id)),
        isFeatureFile: () => false,
      });

      expect(intent.targets).toEqual([{
        kind: "scenarios",
        scenarios: [{ filePath, line: 0, name: "Divide", kind: "outline", outlineName: "Divide" }],
      }]);
    });
  });
});
