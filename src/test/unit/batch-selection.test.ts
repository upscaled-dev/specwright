import { describe, it, expect } from "vitest";
import { resolveBatchSelection } from "../../traceability/batch-selection";
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
  completeness: "complete",
  errors: [],
};

const ROOTS = ["/ws"];

describe("resolveBatchSelection", () => {
  it("scenario → that scenario, one grep invocation", () => {
    const resolved = resolveBatchSelection({ kind: "scenario", scenario: A1 }, SNAP, { roots: ROOTS });
    expect(resolved.scenarios).toEqual([A1]);
    expect(resolved.invocations).toEqual([{ kind: "scenario", ref: A1 }]);
  });

  it("multi-select → each scenario, one grep invocation apiece", () => {
    const resolved = resolveBatchSelection({ kind: "multi-select", scenarios: [A1, B1] }, SNAP, { roots: ROOTS });
    expect(resolved.scenarios).toEqual([A1, B1]);
    expect(resolved.invocations).toEqual([
      { kind: "scenario", ref: A1 },
      { kind: "scenario", ref: B1 },
    ]);
  });

  it("feature → every scenario in the file and one path-filter invocation relative to the root", () => {
    const resolved = resolveBatchSelection({ kind: "feature", filePath: "/ws/features/a.feature" }, SNAP, { roots: ROOTS });
    expect(resolved.scenarios).toEqual([A1, A2, UNTAGGED]);
    expect(resolved.invocations).toEqual([
      { kind: "path-filter", pathFilter: "features/a\\.feature", workingDir: "/ws" },
    ]);
  });

  it("folder → every scenario under the folder and one path-filter invocation", () => {
    const resolved = resolveBatchSelection({ kind: "folder", folderPath: "/ws/features/sub" }, SNAP, { roots: ROOTS });
    expect(resolved.scenarios).toEqual([B1]);
    expect(resolved.invocations).toEqual([
      { kind: "path-filter", pathFilter: "features/sub", workingDir: "/ws" },
    ]);
  });

  it("all-mapped → only the mapped scenarios, one grep invocation apiece", () => {
    const resolved = resolveBatchSelection({ kind: "all-mapped" }, SNAP, { roots: ROOTS });
    expect(resolved.scenarios).toEqual([A1, A2, B1]);
    expect(resolved.invocations.map((i) => i.kind)).toEqual(["scenario", "scenario", "scenario"]);
  });

  it("tag-expression → routes the expression through the tags invocation, no offline scenario set", () => {
    const resolved = resolveBatchSelection({ kind: "tag-expression", expression: "@smoke and not @wip" }, SNAP);
    expect(resolved.scenarios).toEqual([]);
    expect(resolved.invocations).toEqual([{ kind: "tags", expression: "@smoke and not @wip" }]);
  });

  it("test-plan-derived resolves to nothing until slice 2d's plan lookup lands", () => {
    const resolved = resolveBatchSelection({ kind: "test-plan-derived", planKey: "CALC-100" }, SNAP);
    expect(resolved.scenarios).toEqual([]);
    expect(resolved.invocations).toEqual([]);
  });

  it("regex-escapes and forward-slashes the emitted path filter (v0.3.9 gotcha)", () => {
    const snap: TraceabilitySnapshot = { ...SNAP, links: [], untraced: [] };
    // No root match → the target is used as-is: backslashes become forward slashes and every regex
    // metacharacter (the dots) is escaped, so Playwright reads it as a literal path, not a pattern.
    const resolved = resolveBatchSelection({ kind: "feature", filePath: "features\\a.b.feature" }, snap);
    expect(resolved.invocations).toEqual([{ kind: "path-filter", pathFilter: "features/a\\.b\\.feature" }]);
  });
});
