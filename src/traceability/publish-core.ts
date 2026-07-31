import {
  PreflightDecision,
  PublishOutcome,
  PublishRequest,
  RunArtifact,
  RunArtifactOutcome,
  RunArtifactResult,
} from "./contracts";
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

function matchesExclusion(result: RunArtifactResult, decision: PreflightDecision): boolean {
  if (result.testKey !== undefined && decision.testKey !== undefined && result.testKey !== decision.testKey) {
    return false;
  }
  const excluded = decision.scenario;
  if (
    result.testKey !== undefined
    && result.testKey === decision.testKey
    && result.scenario.kind === "outline"
    && excluded.kind === "examplesBlock"
  ) {
    return true;
  }
  if (result.scenario.kind === "scenario" && excluded.kind === "scenario" && result.scenario.line > 0 && excluded.line > 0) {
    return result.scenario.line === excluded.line && sameScenario(result.scenario, excluded);
  }
  return sameScenario(result.scenario, excluded);
}

// The publish reconciliation seam (the CONTRACT at preflight-flow.ts): a result being present in the
// artifact is NOT consent to publish it. Drop every result whose scenario carries an `exclude` decision,
// then drop keyless results; nothing maps those to a remote test. Exclusion is checked first so a user's
// explicit exclusion is counted as such, never as merely unmapped.
//
// A different frozen test key rules out a different mapping first. Plain scenario results retain their
// declaration line, so exclusions cannot take out a same-titled sibling. Outlines stay title-tolerant:
// preflight records the declaration line while capture records an example-row line.
export function publishableResults(artifact: RunArtifact): PublishableResults {
  const exclusions = artifact.preflight.filter((decision) => decision.outcome === "exclude");
  const publishable: PublishableResult[] = [];
  let excludedCount = 0;
  let unmappedCount = 0;
  for (const result of artifact.results) {
    if (exclusions.some((decision) => matchesExclusion(result, decision))) {
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

// An import response that carried neither a key nor an id leaves "" behind, and nothing invents one, so
// this is what every surface asks before it prints a reference, hangs a link on it, or uploads to it.
export function hasExecutionRef(ref: string): boolean {
  return ref !== "";
}

// The one phrase for a reference the provider never named. It reads as a target ("published to …") so
// the toast, the board row, and the dialog's banners can all say the same thing.
export const UNKNOWN_EXECUTION = "an execution with no key";

// What a surface prints in place of the reference: the key when there is one, the phrase when there is not.
export function executionLabel(ref: string): string {
  return hasExecutionRef(ref) ? ref : UNKNOWN_EXECUTION;
}

// The lead of every post-publish toast: what the import did and how much it carried.
export function publishOutcomeLead(outcome: PublishOutcome, request: PublishRequest): string {
  const carried = `${outcome.imported} ${plural(outcome.imported, "result")}`;
  if (request.mode === "append") {
    return `appended to ${outcome.ref.key}: ${carried}`;
  }
  if (!hasExecutionRef(outcome.ref.key)) {
    return `created ${UNKNOWN_EXECUTION}: ${carried} imported`;
  }
  return `${outcome.ref.key} created: ${carried} imported`;
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
