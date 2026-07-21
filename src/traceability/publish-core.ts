import { RunArtifact, RunArtifactOutcome, RunArtifactResult } from "./contracts";
import { sameScenario } from "./scenario-ref";

// A run result cleared for publishing: it survived the preflight-exclusion reconcile and carries a
// remote key. The narrowed `testKey` lets the importers map each result without a non-null assertion.
export type PublishableResult = RunArtifactResult & { readonly testKey: string };

export interface PublishableResults {
  readonly publishable: readonly PublishableResult[];
  readonly excludedCount: number;
  readonly unmappedCount: number;
}

// The publish reconciliation seam (the CONTRACT at preflight-flow.ts): a result being present in the
// artifact is NOT consent to publish it. Drop every result whose scenario carries an `exclude` decision,
// then drop keyless results — nothing maps those to a remote test. Exclusion is checked first so a user's
// explicit exclusion is counted as such, never as merely unmapped.
//
// Exclusion matching uses the contract's fuzzy `sameScenario` (path+name, line-tolerant), NOT strict
// `refIdentity`: preflight records the outline DECLARATION-line ref (`scenarioRefFromScenario`) while the
// capture path records the example-ROW-line ref (run-artifact-store.ts `buildOutlineResult`), so strict
// identity would fail to drop an excluded outline. Exclusion favors recall — over-dropping is safer than
// publishing excluded results; deliberately divergent from 2c's strict duplicate-detection ruling.
export function publishableResults(artifact: RunArtifact): PublishableResults {
  const excludedRefs = artifact.preflight
    .filter((decision) => decision.outcome === "exclude")
    .map((decision) => decision.scenario);
  const publishable: PublishableResult[] = [];
  let excludedCount = 0;
  let unmappedCount = 0;
  for (const result of artifact.results) {
    if (excludedRefs.some((ref) => sameScenario(result.scenario, ref))) {
      excludedCount += 1;
      continue;
    }
    const testKey = result.testKey;
    if (testKey === undefined) {
      unmappedCount += 1;
      continue;
    }
    publishable.push({ ...result, testKey });
  }
  return { publishable, excludedCount, unmappedCount };
}

export interface PublishableSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly timedOut: number;
  readonly interrupted: number;
  readonly flaky: number;
  readonly excludedCount: number;
  readonly unmappedCount: number;
}

// The View 3 dialog numbers: an outcome tally over the publishable set, plus the honest
// not-publishable counts ("N excluded by preflight · M unmapped not publishable").
export function summarizePublishable(reconciled: PublishableResults): PublishableSummary {
  const tally: Record<RunArtifactOutcome, number> = {
    passed: 0,
    failed: 0,
    skipped: 0,
    "timed-out": 0,
    interrupted: 0,
  };
  let flaky = 0;
  for (const result of reconciled.publishable) {
    tally[result.outcome] += 1;
    if (result.flaky) {
      flaky += 1;
    }
  }
  return {
    total: reconciled.publishable.length,
    passed: tally.passed,
    failed: tally.failed,
    skipped: tally.skipped,
    timedOut: tally["timed-out"],
    interrupted: tally.interrupted,
    flaky,
    excludedCount: reconciled.excludedCount,
    unmappedCount: reconciled.unmappedCount,
  };
}
