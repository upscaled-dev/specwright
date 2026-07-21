import { describe, it, expect } from "vitest";
import * as vscode from "vscode";
import { publishableResults, summarizePublishable } from "../../traceability/publish-core";
import { buildArtifactResults } from "../../traceability/run-artifact-store";
import { refIdentity, sameScenario, scenarioRefFromScenario } from "../../traceability/scenario-ref";
import type {
  BatchSelection,
  PreflightDecision,
  RunArtifact,
  RunArtifactResult,
} from "../../traceability/contracts";
import type { ScenarioRef } from "../../traceability/scenario-ref";
import type { ScenarioResult } from "../../utils/playwright-json-parser";
import type { OutlineStub } from "../../types";

function ref(filePath: string, line: number, name: string, kind: ScenarioRef["kind"] = "scenario"): ScenarioRef {
  return { filePath, line, name, kind };
}

function makeResult(scenario: ScenarioRef, over: Partial<RunArtifactResult> = {}): RunArtifactResult {
  return { outcome: "passed", durationMs: 1000, attempts: 1, flaky: false, evidenceRefs: [], ...over, scenario };
}

const SELECTION: BatchSelection = { kind: "all-mapped" };

function artifact(results: RunArtifactResult[], preflight: PreflightDecision[] = []): RunArtifact {
  return { id: "run-1", createdAt: 0, results, shards: [], selection: SELECTION, preflight, state: "complete" };
}

describe("publishableResults", () => {
  it("keeps mapped, non-excluded results with a narrowed string testKey", () => {
    const result = publishableResults(
      artifact([
        makeResult(ref("features/calc.feature", 3, "Add"), { testKey: "CALC-1" }),
        makeResult(ref("features/calc.feature", 8, "Sub"), { testKey: "CALC-2" }),
      ])
    );
    expect(result.publishable.map((r) => r.testKey)).toEqual(["CALC-1", "CALC-2"]);
    expect(result.excludedCount).toBe(0);
    expect(result.unmappedCount).toBe(0);
  });

  it("drops a result whose scenario carries an exclude decision (the reconciliation contract)", () => {
    const kept = ref("features/calc.feature", 3, "Add");
    const excluded = ref("features/calc.feature", 8, "Sub");
    const result = publishableResults(
      artifact(
        [makeResult(kept, { testKey: "CALC-1" }), makeResult(excluded, { testKey: "CALC-2" })],
        [{ scenario: excluded, testKey: "CALC-2", state: "duplicate-mapping", outcome: "exclude" }]
      )
    );
    expect(result.publishable.map((r) => r.testKey)).toEqual(["CALC-1"]);
    expect(result.excludedCount).toBe(1);
    expect(result.unmappedCount).toBe(0);
  });

  it("drops keyless results as unmapped, never as publishable", () => {
    const result = publishableResults(
      artifact([
        makeResult(ref("features/calc.feature", 3, "Add"), { testKey: "CALC-1" }),
        makeResult(ref("features/calc.feature", 8, "Sub")),
      ])
    );
    expect(result.publishable.map((r) => r.testKey)).toEqual(["CALC-1"]);
    expect(result.unmappedCount).toBe(1);
    expect(result.excludedCount).toBe(0);
  });

  it("counts a result that is both excluded and keyless as excluded, not unmapped (exclusion wins)", () => {
    const target = ref("features/calc.feature", 8, "Sub");
    const result = publishableResults(
      artifact([makeResult(target)], [{ scenario: target, state: "unmapped", outcome: "exclude" }])
    );
    expect(result.publishable).toEqual([]);
    expect(result.excludedCount).toBe(1);
    expect(result.unmappedCount).toBe(0);
  });

  it("exclusion favors recall (fuzzy sameScenario): a same-name row on a different line is dropped, a different-name row is kept", () => {
    const sameName = ref("features/calc.feature", 12, "Add", "scenario");
    const otherName = ref("features/calc.feature", 20, "Multiply", "scenario");
    const decisionRef = ref("features/calc.feature", 3, "Add", "outline");
    const result = publishableResults(
      artifact(
        [makeResult(sameName, { testKey: "CALC-1" }), makeResult(otherName, { testKey: "CALC-2" })],
        [{ scenario: decisionRef, testKey: "CALC-1", state: "incompatible-test-type", outcome: "exclude" }]
      )
    );
    expect(result.publishable.map((r) => r.testKey)).toEqual(["CALC-2"]);
    expect(result.excludedCount).toBe(1);
  });

  it("ignores local-only decisions — only an exclude decision drops a result", () => {
    const localOnly = ref("features/calc.feature", 3, "Add");
    const result = publishableResults(
      artifact(
        [makeResult(localOnly, { testKey: "CALC-1" })],
        [{ scenario: localOnly, testKey: "CALC-1", state: "incompatible-test-type", outcome: "local-only" }]
      )
    );
    expect(result.publishable.map((r) => r.testKey)).toEqual(["CALC-1"]);
    expect(result.excludedCount).toBe(0);
  });
});

describe("publishableResults — outline exclusion (capture-path faithful)", () => {
  it("drops an excluded outline even though the captured ref and the preflight ref differ by line", () => {
    const feature = "/repo/features/math.feature";
    const declLine = 5;
    const exampleRowLine = 11;

    // Capture path: buildOutlineResult keys the result ref off the first example ROW line.
    const details: ScenarioResult[] = [
      { featurePath: feature, lineNumber: exampleRowLine, scenarioName: "Example #1", outlineName: "Divide", status: "passed" },
      { featurePath: feature, lineNumber: exampleRowLine + 1, scenarioName: "Example #2", outlineName: "Divide", status: "passed" },
    ];
    const captured = buildArtifactResults(details, undefined, () => "MATH-1");
    expect(captured).toHaveLength(1);
    const capturedRef = captured[0]!.scenario;

    // Preflight path: the model/resolveBatchSelection ref is keyed off the outline DECLARATION line.
    const outline: OutlineStub = {
      name: "Divide",
      line: declLine,
      range: new vscode.Range(new vscode.Position(0, 0), new vscode.Position(0, 0)),
      lineNumber: declLine,
      steps: [],
      filePath: feature,
      isScenarioOutline: true,
      outlineLineNumber: declLine,
      outlineName: "Divide",
    };
    const excludeRef = scenarioRefFromScenario(outline);

    // The mismatch that motivates fuzzy matching: strict identity misses it, fuzzy sameScenario catches it.
    expect(refIdentity(capturedRef)).not.toBe(refIdentity(excludeRef));
    expect(sameScenario(capturedRef, excludeRef)).toBe(true);

    const result = publishableResults(
      artifact(captured, [{ scenario: excludeRef, testKey: "MATH-1", state: "duplicate-mapping", outcome: "exclude" }])
    );
    expect(result.publishable).toEqual([]);
    expect(result.excludedCount).toBe(1);
  });
});

describe("summarizePublishable", () => {
  it("tallies the publishable set by outcome and carries the honest not-publishable counts", () => {
    const reconciled = publishableResults(
      artifact(
        [
          makeResult(ref("f", 1, "a"), { testKey: "C-1", outcome: "passed" }),
          makeResult(ref("f", 2, "b"), { testKey: "C-2", outcome: "passed", flaky: true, attempts: 2 }),
          makeResult(ref("f", 3, "c"), { testKey: "C-3", outcome: "failed" }),
          makeResult(ref("f", 4, "d"), { testKey: "C-4", outcome: "timed-out" }),
          makeResult(ref("f", 5, "e"), { testKey: "C-5", outcome: "interrupted" }),
          makeResult(ref("f", 6, "g"), { testKey: "C-6", outcome: "skipped" }),
          makeResult(ref("f", 7, "h")),
          makeResult(ref("f", 8, "i"), { testKey: "C-8" }),
        ],
        [{ scenario: ref("f", 8, "i"), testKey: "C-8", state: "duplicate-mapping", outcome: "exclude" }]
      )
    );
    expect(summarizePublishable(reconciled)).toEqual({
      total: 6,
      passed: 2,
      failed: 1,
      skipped: 1,
      timedOut: 1,
      interrupted: 1,
      flaky: 1,
      excludedCount: 1,
      unmappedCount: 1,
    });
  });
});
