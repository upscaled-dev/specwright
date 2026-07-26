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

  it("all-mapped → the mapped scenarios, collapsed to one combined-grep invocation", () => {
    const resolved = resolveBatchSelection({ kind: "all-mapped" }, SNAP);
    expect(resolved.scenarios).toEqual([A1, A2, B1]);
    // One bddgen+playwright pass for the whole set, not one per scenario (the N× regeneration fix).
    expect(resolved.invocations).toEqual([{ kind: "grep", refs: [A1, A2, B1] }]);
  });

  it("all-mapped → no invocation when nothing is mapped", () => {
    const resolved = resolveBatchSelection({ kind: "all-mapped" }, { ...SNAP, links: [] });
    expect(resolved.invocations).toEqual([]);
  });

  it("tag-expression → routes the expression through the tags invocation, no offline scenario set", () => {
    const resolved = resolveBatchSelection({ kind: "tag-expression", expression: "@smoke and not @wip" }, SNAP);
    expect(resolved.scenarios).toEqual([]);
    expect(resolved.invocations).toEqual([{ kind: "tags", expression: "@smoke and not @wip" }]);
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
