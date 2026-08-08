import { describe, it, expect } from "vitest";
import { artifactCaptureTarget, batchSelectionFromScenarios, resolveBatchSelection } from "../../traceability/batch-selection";
import type { OutlineExampleRow } from "../../types";
import { ScenarioRef, TraceLink, TraceabilitySnapshot } from "../../traceability/traceability-model";

function ref(over: Partial<ScenarioRef> = {}): ScenarioRef {
  return { filePath: "/ws/features/a.feature", line: 3, name: "S", kind: "scenario", ...over };
}

function link(scenario: ScenarioRef, testKey: string): TraceLink {
  return { testKey, scenario, reqKeys: [] };
}

// Two mapped scenarios in a.feature, one mapped in b.feature, one untraced in a.feature.
const A1 = ref({ name: "A1", line: 3 });
const A2 = ref({ name: "A2", line: 8 });
const B1 = ref({ filePath: "/ws/features/sub/b.feature", name: "B1", line: 4 });
const UNTAGGED = ref({ name: "Untagged", line: 12 });

const SNAP: TraceabilitySnapshot = {
  links: [link(A1, "CALC-1"), link(A2, "CALC-2"), link(B1, "CALC-3")],
  untraced: [{ scenario: UNTAGGED, reqKeys: [], malformedTags: [] }],
  orphans: [],
  stale: false,
  completeProjects: ["CALC"],
  errors: [],
};

describe("resolveBatchSelection", () => {
  it("scenario → that scenario, one grep invocation", () => {
    const resolved = resolveBatchSelection({ kind: "scenario", scenario: A1 }, SNAP);
    expect(resolved.scenarios).toEqual([A1]);
    expect(resolved.invocations).toEqual([{ kind: "scenario", ref: A1 }]);
  });

  it("multi-select → each scenario, one grep invocation apiece", () => {
    const resolved = resolveBatchSelection({ kind: "multi-select", scenarios: [A1, B1] }, SNAP);
    expect(resolved.scenarios).toEqual([A1, B1]);
    expect(resolved.invocations).toEqual([
      { kind: "scenario", ref: A1 },
      { kind: "scenario", ref: B1 },
    ]);
  });

  it("canonicalizes a same-named scenario by exact identity before title fallback", () => {
    const first = ref({ name: "Duplicate", line: 3 });
    const second = ref({ name: "Duplicate", line: 8 });
    const snapshot = { ...SNAP, links: [link(first, "CALC-1"), link(second, "CALC-2")] };

    expect(resolveBatchSelection({ kind: "multi-select", scenarios: [second] }, snapshot)).toEqual({
      scenarios: [second],
      invocations: [{ kind: "scenario", ref: second }],
    });
  });

  it("feature → every scenario in the file and one path-filter invocation carrying the source file", () => {
    const resolved = resolveBatchSelection({ kind: "feature", filePath: "/ws/features/a.feature" }, SNAP);
    expect(resolved.scenarios).toEqual([A1, A2, UNTAGGED]);
    // The executor resolves the working dir from the target and relativizes the filter; the
    // invocation stays FS-free (pure resolution), monorepo-correctness lives in the executor.
    expect(resolved.invocations).toEqual([{ kind: "path-filter", target: "/ws/features/a.feature" }]);
  });

  it("folder → every scenario under the folder and one path-filter invocation", () => {
    const resolved = resolveBatchSelection({ kind: "folder", folderPath: "/ws/features/sub" }, SNAP);
    expect(resolved.scenarios).toEqual([B1]);
    expect(resolved.invocations).toEqual([{ kind: "path-filter", target: "/ws/features/sub" }]);
  });

  it("all-mapped → one exact invocation per mapped scenario", () => {
    const resolved = resolveBatchSelection({ kind: "all-mapped" }, SNAP);
    expect(resolved.scenarios).toEqual([A1, A2, B1]);
    expect(resolved.invocations).toEqual([
      { kind: "scenario", ref: A1 },
      { kind: "scenario", ref: A2 },
      { kind: "scenario", ref: B1 },
    ]);
  });

  it("all-mapped with a project keeps only links in that project", () => {
    const snapshot = {
      ...SNAP,
      links: [link(A1, "CALC-1"), link(A2, "PAY-2"), link(B1, "CALC-3")],
    };
    const projectOf = (key: string): string => key.split("-")[0] ?? "";

    expect(resolveBatchSelection(
      { kind: "all-mapped", project: "CALC" },
      snapshot,
      { projectOf }
    )).toEqual({
      scenarios: [A1, B1],
      invocations: [
        { kind: "scenario", ref: A1 },
        { kind: "scenario", ref: B1 },
      ],
    });
    expect(resolveBatchSelection({ kind: "all-mapped" }, snapshot, { projectOf }))
      .toEqual(resolveBatchSelection({ kind: "all-mapped" }, snapshot));
  });

  it("refuses a suite scope instead of promising a run it cannot make", () => {
    expect(() => resolveBatchSelection({ kind: "suite" }, SNAP))
      .toThrow(/suite selection cannot be resolved/);
  });

  it("all-mapped → no invocation when nothing is mapped", () => {
    const resolved = resolveBatchSelection({ kind: "all-mapped" }, { ...SNAP, links: [] });
    expect(resolved.invocations).toEqual([]);
  });

  it("all-mapped keeps outline-shaped mappings in separate invocations", () => {
    const outline = ref({ line: 20, name: "Outline", kind: "outline", outlineName: "Outline" });
    const block = ref({
      line: 25,
      name: "Outline · edge cases",
      kind: "examplesBlock",
      outlineName: "Outline",
      examplesBlockName: "edge cases",
    });
    const snapshot = { ...SNAP, links: [link(A1, "CALC-1"), link(outline, "CALC-2"), link(block, "CALC-3")] };

    expect(resolveBatchSelection({ kind: "all-mapped" }, snapshot).invocations).toEqual([
      { kind: "scenario", ref: A1 },
      { kind: "scenario", ref: outline },
      { kind: "scenario", ref: block },
    ]);
  });

  it("all-mapped never collapses duplicate titles or a joined-chain counterexample", () => {
    const sameFileFirst = ref({ name: "Duplicate", line: 3 });
    const sameFileSecond = ref({ name: "Duplicate", line: 8 });
    const otherFile = ref({ filePath: "/ws/features/b.feature", name: "Duplicate", line: 4 });
    const joined = ref({ name: "Add to cart", line: 12 });
    const snapshot = {
      ...SNAP,
      links: [sameFileFirst, sameFileSecond, otherFile, joined]
        .map((scenario, index) => link(scenario, `CALC-${index + 1}`)),
    };

    expect(resolveBatchSelection({ kind: "all-mapped" }, snapshot).invocations).toEqual(
      [sameFileFirst, sameFileSecond, otherFile, joined]
        .map((scenario) => ({ kind: "scenario", ref: scenario }))
    );
  });

  it("does not canonicalize a shifted Examples block to its same-named outline", () => {
    const outline = ref({ line: 20, name: "Outline", kind: "outline", outlineName: "Outline" });
    const block = ref({
      line: 25,
      name: "Outline",
      kind: "examplesBlock",
      outlineName: "Outline",
    });
    const staleBlock = { ...block, line: 24 };
    const snapshot = { ...SNAP, links: [link(outline, "CALC-1"), link(block, "CALC-2")] };

    expect(resolveBatchSelection({ kind: "scenario", scenario: staleBlock }, snapshot).scenarios).toEqual([block]);
  });

  it("tag-expression → routes the expression through the tags invocation, no offline scenario set", () => {
    const resolved = resolveBatchSelection({ kind: "tag-expression", expression: "@smoke and not @wip" }, SNAP);
    expect(resolved.scenarios).toEqual([]);
    expect(resolved.invocations).toEqual([{ kind: "tags", expression: "@smoke and not @wip" }]);
  });

  it("preserves tag intersections on scenario and feature selections", () => {
    expect(resolveBatchSelection({
      kind: "scenario",
      scenario: A1,
      tagExpression: "@smoke",
    }, SNAP).invocations).toEqual([
      { kind: "scenario", ref: A1, tagExpression: "@smoke" },
    ]);
    expect(resolveBatchSelection({
      kind: "feature",
      filePath: A1.filePath,
      tagExpression: "@smoke",
    }, SNAP).invocations).toEqual([
      { kind: "path-filter", target: A1.filePath, tagExpression: "@smoke" },
    ]);
  });

  it("test-plan-derived resolves to nothing without the plan's test keys", () => {
    const resolved = resolveBatchSelection({ kind: "test-plan-derived", planKey: "CALC-100" }, SNAP);
    expect(resolved.scenarios).toEqual([]);
    expect(resolved.invocations).toEqual([]);
  });

  it("test-plan-derived → the mapped scenarios whose key is in the plan, one grep invocation apiece", () => {
    const resolved = resolveBatchSelection({ kind: "test-plan-derived", planKey: "CALC-100" }, SNAP, {
      planTestKeys: ["CALC-1", "CALC-3", "CALC-999"],
    });
    // CALC-1 (A1) and CALC-3 (B1) are in the plan; CALC-2 (A2) is not; CALC-999 has no local scenario.
    expect(resolved.scenarios).toEqual([A1, B1]);
    expect(resolved.invocations).toEqual([
      { kind: "scenario", ref: A1 },
      { kind: "scenario", ref: B1 },
    ]);
  });
});

describe("batchSelectionFromScenarios", () => {
  // Nothing selected must stay nothing. Answering `all-mapped` here would turn any caller that forgot
  // a guard into a whole-suite run nobody asked for.
  it("maps an empty selection to an empty multi-select, never to all-mapped", () => {
    expect(batchSelectionFromScenarios([])).toEqual({ kind: "multi-select", scenarios: [] });
    expect(resolveBatchSelection(batchSelectionFromScenarios([]), SNAP)).toEqual({
      scenarios: [],
      invocations: [],
    });
  });

  it("collapses one scenario to a scenario selection and several to a multi-select", () => {
    expect(batchSelectionFromScenarios([A1])).toEqual({ kind: "scenario", scenario: A1 });
    expect(batchSelectionFromScenarios([A1, A2, A1])).toEqual({
      kind: "multi-select",
      scenarios: [A1, A2],
    });
  });
});

describe("artifactCaptureTarget", () => {
  const filePath = "/ws/features/a.feature";
  const row = (lineNumber: number, examplesBlockLineNumber: number): OutlineExampleRow => ({
    name: `Example #${lineNumber}`,
    line: lineNumber,
    lineNumber,
    range: {} as never,
    steps: [],
    filePath,
    isScenarioOutline: true,
    outlineLineNumber: 3,
    outlineName: "Divide",
    examplesBlockLineNumber,
  });
  const rows = [row(8, 6), row(9, 6)];
  const outline = { filePath, name: "Divide", kind: "outline" as const, outlineName: "Divide" };

  it("captures only the row an outline ref names by its own line", () => {
    expect(artifactCaptureTarget({ ...outline, line: 8 }, rows, [])).toEqual({
      scenario: { ...outline, line: 8 },
      resultLines: [8],
    });
  });

  it("leaves a separately mapped Examples block to its own key", () => {
    const split = { filePath, line: 6, name: "Divide edge cases", kind: "examplesBlock" as const };

    // Rows of the mapped block belong to CALC-2, so the outline's own capture must not claim them.
    expect(() => artifactCaptureTarget({ ...outline, line: 3 }, rows, [split]))
      .toThrow("owns no parsed rows");
    expect(artifactCaptureTarget(split, rows, [split]).resultLines).toEqual([8, 9]);
  });

  it("fails closed when the feature no longer parses", () => {
    expect(() => artifactCaptureTarget({ ...outline, line: 3 }, [], []))
      .toThrow("Could not resolve exact example rows");
    expect(() => artifactCaptureTarget(
      { filePath, line: 6, name: "Divide edge cases", kind: "examplesBlock" },
      [],
      []
    )).toThrow("Could not resolve exact example rows");
  });

  it("captures every row for an outline named by declaration line or by title alone", () => {
    expect(artifactCaptureTarget({ ...outline, line: 3 }, rows, []).resultLines).toEqual([8, 9]);
    expect(artifactCaptureTarget({ ...outline, line: 0 }, rows, []).resultLines).toEqual([8, 9]);
  });
});
