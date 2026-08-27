import { describe, expect, it } from "vitest";
import {
  executionTargets,
  treeBatchSelection,
} from "../../commands/run-publish-selection";
import type { TraceabilitySnapshot } from "../../traceability/traceability-model";
import type { ScenarioRef } from "../../traceability/scenario-ref";

const A: ScenarioRef = {
  filePath: "/ws/features/a.feature",
  line: 3,
  name: "A",
  kind: "scenario",
};
const B: ScenarioRef = {
  filePath: "/ws/features/a.feature",
  line: 8,
  name: "B",
  kind: "scenario",
};
const C: ScenarioRef = {
  filePath: "/ws/features/c.feature",
  line: 4,
  name: "C",
  kind: "scenario",
};
const U: ScenarioRef = {
  filePath: "/ws/features/a.feature",
  line: 12,
  name: "Untraced",
  kind: "scenario",
};

const snapshot: TraceabilitySnapshot = {
  links: [
    { testKey: "CALC-1", scenario: A, reqKeys: [] },
    { testKey: "CALC-2", scenario: B, reqKeys: [] },
    { testKey: "CALC-3", scenario: B, reqKeys: [] },
    { testKey: "PAY-1", scenario: C, reqKeys: [] },
  ],
  untraced: [{ scenario: U, reqKeys: [], malformedTags: [] }],
  orphans: [],
  stale: false,
  completeProjects: ["CALC", "PAY"],
  errors: [],
};

describe("treeBatchSelection", () => {
  it("keeps a single feature node as a feature selection", () => {
    expect(treeBatchSelection([
      { kind: "file", filePath: A.filePath },
    ], snapshot)).toEqual({
      selection: { kind: "feature", filePath: A.filePath },
      skipped: 0,
    });
  });

  it("expands mixed files to mapped scenarios, skips untraced rows, and deduplicates", () => {
    const linkNode = { kind: "link", link: snapshot.links[0] };
    const fileNode = { kind: "file", filePath: A.filePath };
    const untracedNode = { kind: "untraced", item: snapshot.untraced[0] };

    expect(treeBatchSelection(
      [linkNode, [linkNode, fileNode, untracedNode]],
      snapshot
    )).toEqual({
      selection: { kind: "multi-select", scenarios: [A, B] },
      skipped: 1,
    });
  });

  it("never widens a nodeless invocation into a whole-suite run", () => {
    expect(treeBatchSelection([], snapshot)).toEqual({
      selection: { kind: "multi-select", scenarios: [] },
      skipped: 0,
    });
    expect(treeBatchSelection([undefined, []], snapshot)).toEqual({
      selection: { kind: "multi-select", scenarios: [] },
      skipped: 0,
    });
  });

  it("preserves host-owned organization identity and exact scenarios without widening", () => {
    const selection = { kind: "test-set" as const, testSetKey: "SHOP-301", scenarios: [A, B] };
    expect(treeBatchSelection([{ kind: "organizationRun", selection }], snapshot)).toEqual({ selection, skipped: 0 });
    expect(treeBatchSelection([{ kind: "organizationRun", selection: { ...selection, scenarios: [] } }], snapshot)).toEqual({
      selection: { kind: "multi-select", scenarios: [] }, skipped: 0,
    });
  });
});

describe("executionTargets", () => {
  it("preserves scenario and path tag intersections", () => {
    expect(executionTargets([
      { kind: "scenario", ref: A, tagExpression: "@smoke" },
      { kind: "path-filter", target: A.filePath, tagExpression: "@smoke" },
    ])).toEqual([
      { kind: "scenario", scenario: A, tagExpression: "@smoke" },
      { kind: "path", path: A.filePath, tagExpression: "@smoke" },
    ]);
  });
});
