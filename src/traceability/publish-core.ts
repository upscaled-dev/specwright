import { RunArtifact, RunArtifactOutcome, RunArtifactResult } from "./contracts";
import { plural } from "../utils/text";
import { sameScenario } from "./scenario-ref";

// Only a `complete` run is publishable; a cancelled or partial run never reaches the publish dialog
// as a publishable payload (§8-P2 exit criterion).
export function isPublishable(artifact: RunArtifact): boolean {
  return artifact.state === "complete";
}

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
// then drop keyless results; nothing maps those to a remote test. Exclusion is checked first so a user's
// explicit exclusion is counted as such, never as merely unmapped.
//
// Exclusion matching uses the contract's fuzzy `sameScenario` (path+name, line-tolerant), NOT strict
// `refIdentity`: preflight records the outline DECLARATION-line ref (`scenarioRefFromScenario`) while the
// capture path records the example-ROW-line ref (run-artifact-store.ts `buildOutlineResult`), so strict
// identity would fail to drop an excluded outline. Exclusion favors recall; over-dropping is safer than
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

// The View 3 subtitle: the publishable-set outcome tally, then the honest not-publishable notes
// ("N excluded by preflight · M unmapped not publishable · K changed since run (create mode)").
// `changedSinceRun` is create-mode-only (scenarios whose source no longer resolves), surfaced as a
// note because the radio can still switch to append, which publishes everything.
export function publishDialogSubtitle(summary: PublishableSummary, changedSinceRun: number): string {
  const head = [
    `${summary.total} ${plural(summary.total, "scenario")}`,
    `${summary.passed} passed`,
    `${summary.failed} failed`,
  ];
  if (summary.skipped > 0) {
    head.push(`${summary.skipped} skipped`);
  }
  if (summary.timedOut > 0) {
    head.push(`${summary.timedOut} timed out`);
  }
  if (summary.interrupted > 0) {
    head.push(`${summary.interrupted} interrupted`);
  }
  if (summary.flaky > 0) {
    head.push(`${summary.flaky} flaky`);
  }
  const notes: string[] = [];
  if (summary.excludedCount > 0) {
    notes.push(`${summary.excludedCount} excluded by preflight`);
  }
  if (summary.unmappedCount > 0) {
    notes.push(`${summary.unmappedCount} unmapped not publishable`);
  }
  if (changedSinceRun > 0) {
    notes.push(`${changedSinceRun} changed since run (create mode)`);
  }
  return [...head, ...notes].join(" · ");
}

// The editable Summary field's default: "Specwright run <date> (N scenarios)" (date is the run's
// creation day, ISO for determinism).
export function defaultPublishSummary(createdAt: number, publishableCount: number): string {
  const date = new Date(createdAt).toISOString().slice(0, 10);
  return `Specwright run ${date} (${publishableCount} ${plural(publishableCount, "scenario")})`;
}

// One run's label in the dialog's newest-first dropdown: its local time and batch scope.
export function publishRunLabel(createdAt: number, selectionKind: string): string {
  return `${new Date(createdAt).toLocaleString()} · ${selectionKind}`;
}

// Create-mode Project prefill (§ point 2). Priority: (a) the single distinct project the run's own
// publishable test keys resolve to, via the grammar's `projectOf`; carries `fromDerivation: true` so
// the dialog shows the "from this run's test keys" hint; (b) the `xray.defaultProjectKey` setting when
// the run yields zero or multiple projects; (c) empty. Only (a) is a derivation. The publish flow can
// outrank all three with the board's project scope, which hints on `fromScope` instead.
export interface PublishProjectPrefill {
  readonly value: string;
  readonly fromDerivation: boolean;
  // Set instead of `fromDerivation` when the board's project scope supplied the value, so the dialog
  // hints where the prefill came from rather than silently outranking the run's own keys.
  readonly fromScope?: boolean | undefined;
}

export function derivePublishProject(
  results: readonly PublishableResult[],
  defaultProjectKey: string,
  projectOf: ((key: string) => string) | undefined
): PublishProjectPrefill {
  if (projectOf) {
    const projects = new Set(results.map((result) => projectOf(result.testKey)));
    const only = projects.size === 1 ? [...projects][0] : undefined;
    if (only !== undefined) {
      return { value: only, fromDerivation: true };
    }
  }
  return { value: defaultProjectKey, fromDerivation: false };
}
