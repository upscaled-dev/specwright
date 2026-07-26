import { describe, it, expect } from "vitest";
import * as vscode from "vscode";
import {
  StepsTreeDataProvider,
  StepsNode,
  StepDefinitionNode,
  UnmatchedFileNode,
} from "../../providers/steps-tree-data-provider";
import type { StepUsage, StepUsageIndex } from "../../providers/step-usage-index";
import type { ParsedStepDefWithFile, UnmatchedStep } from "../../providers/step-resolver";
import type { ExtensionConfig } from "../../core/extension-config";

function def(
  pattern: string,
  opts: {
    keyword?: "Given" | "When" | "Then" | "Step" | undefined;
    isRegex?: boolean;
    filePath?: string;
    line?: number;
  } = {}
): ParsedStepDefWithFile {
  return {
    line: opts.line ?? 0,
    regex: /x/,
    pattern,
    isRegex: opts.isRegex ?? false,
    keyword: opts.keyword,
    filePath: opts.filePath ?? "/ws/steps/app.steps.ts",
  };
}

function usages(count: number): StepUsage[] {
  return Array.from({ length: count }, (_, i) => ({
    featurePath: "/ws/features/a.feature",
    line: i,
    stepText: "x",
    keyword: "Given" as const,
  }));
}

function unmatched(text: string, line: number, keyword = "Given"): UnmatchedStep {
  return { line, keyword, effectiveKeyword: "Given", text };
}

function makeIndex(opts: {
  usages?: Array<[ParsedStepDefWithFile, StepUsage[]]>;
  unmatched?: Array<[string, UnmatchedStep[]]>;
}): { index: StepUsageIndex; fire: () => void } {
  const emitter = new vscode.EventEmitter<void>();
  const index = {
    getAllUsages: () => Promise.resolve(new Map(opts.usages ?? [])),
    getUnmatchedSteps: () => Promise.resolve(new Map(opts.unmatched ?? [])),
    onDidChangeUsages: emitter.event,
  } as unknown as StepUsageIndex;
  return { index, fire: () => emitter.fire(undefined as never) };
}

function makeConfig(enabled = true): { config: ExtensionConfig; set: (v: boolean) => void } {
  let value = enabled;
  return {
    config: {
      get enableStepsPanel(): boolean { return value; },
    } as unknown as ExtensionConfig,
    set: (v) => { value = v; },
  };
}

async function definitionsChildren(
  provider: StepsTreeDataProvider
): Promise<StepsNode[]> {
  const roots = await provider.getChildren();
  return provider.getChildren(roots[0]);
}

async function unmatchedChildren(provider: StepsTreeDataProvider): Promise<StepsNode[]> {
  const roots = await provider.getChildren();
  return provider.getChildren(roots[1]);
}

describe("StepsTreeDataProvider", () => {
  it("shows the two top-level sections when enabled", async () => {
    const provider = new StepsTreeDataProvider(makeIndex({}).index, makeConfig().config);
    const roots = await provider.getChildren();
    expect(roots.map((n) => n.kind)).toEqual(["section", "section"]);
    expect(provider.getTreeItem(roots[0]!).label).toBe("Step definitions");
    expect(provider.getTreeItem(roots[1]!).label).toBe("Unmatched steps");
  });

  it("shows a single info node when the panel is disabled via setting", async () => {
    const provider = new StepsTreeDataProvider(makeIndex({}).index, makeConfig(false).config);
    const roots = await provider.getChildren();
    expect(roots).toHaveLength(1);
    expect(roots[0]!.kind).toBe("info");
    expect(provider.getTreeItem(roots[0]!).label).toContain("enableStepsPanel");
  });

  it("groups definitions by keyword and fans out Step/undefined keywords into all three", async () => {
    const { index } = makeIndex({
      usages: [
        [def("only given", { keyword: "Given" }), []],
        [def("shared step", { keyword: "Step", line: 1 }), []],
        [def("no keyword", { line: 2 }), []],
      ],
    });
    const provider = new StepsTreeDataProvider(index, makeConfig().config);
    const groups = await definitionsChildren(provider);
    expect(groups.map((g) => (g.kind === "keyword" ? g.keyword : g.kind))).toEqual([
      "Given",
      "When",
      "Then",
    ]);

    const givenLeaves = await provider.getChildren(groups[0]);
    expect(givenLeaves.map((l) => (l as StepDefinitionNode).humanized)).toEqual([
      "no keyword",
      "only given",
      "shared step",
    ]);
    const whenLeaves = await provider.getChildren(groups[1]);
    expect(whenLeaves.map((l) => (l as StepDefinitionNode).humanized)).toEqual([
      "no keyword",
      "shared step",
    ]);
    const thenLeaves = await provider.getChildren(groups[2]);
    expect(thenLeaves.map((l) => (l as StepDefinitionNode).humanized)).toEqual([
      "no keyword",
      "shared step",
    ]);
  });

  it("omits empty keyword groups", async () => {
    const { index } = makeIndex({
      usages: [[def("only when", { keyword: "When" }), []]],
    });
    const provider = new StepsTreeDataProvider(index, makeConfig().config);
    const groups = await definitionsChildren(provider);
    expect(groups.map((g) => (g.kind === "keyword" ? g.keyword : g.kind))).toEqual(["When"]);
  });

  it("shows the stepDefinitionPaths hint when no definitions exist", async () => {
    const provider = new StepsTreeDataProvider(makeIndex({}).index, makeConfig().config);
    const groups = await definitionsChildren(provider);
    expect(groups).toHaveLength(1);
    expect(provider.getTreeItem(groups[0]!).label).toBe(
      "No step definitions found: check playwrightBddRunner.stepDefinitionPaths."
    );
  });

  it("renders a definition leaf with humanized label, usage description, and navigation", async () => {
    const { index } = makeIndex({
      usages: [
        [
          def("^the count is (\\d+)$", {
            keyword: "Then",
            isRegex: true,
            filePath: "/ws/steps/count.steps.ts",
            line: 7,
          }),
          usages(2),
        ],
      ],
    });
    const provider = new StepsTreeDataProvider(index, makeConfig().config);
    const groups = await definitionsChildren(provider);
    const leaves = await provider.getChildren(groups[0]);
    const item = provider.getTreeItem(leaves[0]!);

    expect(item.label).toBe("the count is {int}");
    expect(item.description).toBe("2 uses · count.steps.ts");
    expect(item.contextValue).toBe("stepDefinition");
    expect((item.iconPath as vscode.ThemeIcon).id).toBe("symbol-method");
    const command = item.command as unknown as { command: string; arguments: [unknown, unknown] };
    expect(command.command).toBe("vscode.open");
    expect((command.arguments[0] as { fsPath: string }).fsPath).toBe("/ws/steps/count.steps.ts");
    expect(
      (command.arguments[1] as { selection: vscode.Range }).selection.start.line
    ).toBe(7);
  });

  it("marks zero-usage definitions with a warning icon and singular/plural counts", async () => {
    const { index } = makeIndex({
      usages: [
        [def("unused one", { keyword: "Given" }), []],
        [def("used once", { keyword: "Given", line: 1 }), usages(1)],
      ],
    });
    const provider = new StepsTreeDataProvider(index, makeConfig().config);
    const groups = await definitionsChildren(provider);
    const leaves = await provider.getChildren(groups[0]);

    const unused = provider.getTreeItem(leaves[0]!);
    expect(unused.description).toBe("0 uses · app.steps.ts");
    expect((unused.iconPath as vscode.ThemeIcon).id).toBe("warning");

    const usedOnce = provider.getTreeItem(leaves[1]!);
    expect(usedOnce.description).toBe("1 use · app.steps.ts");
    expect((usedOnce.iconPath as vscode.ThemeIcon).id).toBe("symbol-method");
  });

  it("groups unmatched steps per feature file, sorted, and navigates to the feature line", async () => {
    const { index } = makeIndex({
      unmatched: [
        ["/ws/features/b.feature", [unmatched("missing b", 5)]],
        ["/ws/features/a.feature", [unmatched("missing a1", 2, "And"), unmatched("missing a2", 9)]],
      ],
    });
    const provider = new StepsTreeDataProvider(index, makeConfig().config);
    const files = await unmatchedChildren(provider);
    expect(files.map((f) => (f as UnmatchedFileNode).featurePath)).toEqual([
      "/ws/features/a.feature",
      "/ws/features/b.feature",
    ]);

    const fileItem = provider.getTreeItem(files[0]!);
    expect(fileItem.label).toBe("a.feature");
    expect(fileItem.contextValue).toBe("unmatchedFile");

    const steps = await provider.getChildren(files[0]);
    expect(steps).toHaveLength(2);
    const stepItem = provider.getTreeItem(steps[0]!);
    expect(stepItem.label).toBe("missing a1");
    expect(stepItem.description).toBe("And · line 3");
    expect(stepItem.contextValue).toBe("unmatchedStep");
    const command = stepItem.command as unknown as { command: string; arguments: [unknown, unknown] };
    expect(command.command).toBe("vscode.open");
    expect((command.arguments[0] as { fsPath: string }).fsPath).toBe("/ws/features/a.feature");
    expect(
      (command.arguments[1] as { selection: vscode.Range }).selection.start.line
    ).toBe(2);
  });

  it("shows an explicit empty state when there are no unmatched steps", async () => {
    const provider = new StepsTreeDataProvider(makeIndex({}).index, makeConfig().config);
    const nodes = await unmatchedChildren(provider);
    expect(nodes).toHaveLength(1);
    expect(provider.getTreeItem(nodes[0]!).label).toBe("No unmatched steps.");
  });

  it("fires onDidChangeTreeData when the index reports changes, until disposed", () => {
    const { index, fire } = makeIndex({});
    const provider = new StepsTreeDataProvider(index, makeConfig().config);
    let refreshes = 0;
    provider.onDidChangeTreeData(() => { refreshes += 1; });

    fire();
    expect(refreshes).toBe(1);

    provider.dispose();
    fire();
    expect(refreshes).toBe(1);
  });
});
