import { ResultPublishingCapability, RunArtifact, RunArtifactOutcome } from "./contracts";

export interface ArtifactSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
  readonly timedOut: number;
  readonly interrupted: number;
  readonly flaky: number;
}

export function summarizeArtifact(artifact: RunArtifact): ArtifactSummary {
  const tally: Record<RunArtifactOutcome, number> = {
    passed: 0,
    failed: 0,
    skipped: 0,
    "timed-out": 0,
    interrupted: 0,
  };
  let flaky = 0;
  for (const result of artifact.results) {
    tally[result.outcome] += 1;
    if (result.flaky) {
      flaky += 1;
    }
  }
  return {
    total: artifact.results.length,
    passed: tally.passed,
    failed: tally.failed,
    skipped: tally.skipped,
    timedOut: tally["timed-out"],
    interrupted: tally.interrupted,
    flaky,
  };
}

// Only a `complete` run is publishable — a cancelled or partial run never reaches the stub as a
// publishable payload (§8-P2 exit criterion).
export function isPublishable(artifact: RunArtifact): boolean {
  return artifact.state === "complete";
}

function summaryLine(summary: ArtifactSummary): string {
  const parts = [
    `${summary.passed} passed`,
    `${summary.failed} failed`,
    `${summary.skipped} skipped`,
  ];
  if (summary.timedOut > 0) {
    parts.push(`${summary.timedOut} timed out`);
  }
  if (summary.interrupted > 0) {
    parts.push(`${summary.interrupted} interrupted`);
  }
  if (summary.flaky > 0) {
    parts.push(`${summary.flaky} flaky`);
  }
  return `${summary.total} result${summary.total === 1 ? "" : "s"}: ${parts.join(" · ")}`;
}

// The two P2 radio choices, in order. No execution picker (P3), so both are inert affordances here.
export const PUBLISH_STUB_OPTIONS: readonly string[] = ["Create new execution", "Add to existing execution"];
const PUBLISH_STUB_NOTICE = "Publishing lands in P3 — nothing was sent to the tracker.";

export interface PublishStubModal {
  readonly title: string;
  readonly summary: string;
  readonly options: readonly string[];
  readonly notice: string;
}

export function buildPublishStubModal(artifact: RunArtifact): PublishStubModal {
  return {
    title: "Publish run results",
    summary: summaryLine(summarizeArtifact(artifact)),
    options: PUBLISH_STUB_OPTIONS,
    notice: PUBLISH_STUB_NOTICE,
  };
}

export interface PublishStubDeps {
  // Renders the modal and returns the chosen radio option (or undefined on dismiss). Caller wires it
  // to a vscode modal; the stub never inspects the choice — publishing is a P3 concern.
  presentModal(modal: PublishStubModal): Promise<string | undefined>;
  // Shown when the artifact isn't in a publishable state (cancelled/partial).
  reportBlocked(reason: string): void;
  // The P3 write path. Present in the deps so a test can prove the P2 stub NEVER reaches for it; the
  // stub must not call it under any branch.
  publishing?: ResultPublishingCapability | undefined;
}

/**
 * The View 3 §12 P2 publish stub: gate on a publishable (complete) artifact, then show the modal
 * (title + run-summary + Create/Add-to-existing radio + "lands in P3" notice) and return. It performs
 * NO remote write — a cancelled or partial run is reported as blocked instead, and even a complete run
 * only renders the modal; `deps.publishing` is never invoked until the P3 write path lands.
 */
export async function runPublishStub(artifact: RunArtifact, deps: PublishStubDeps): Promise<void> {
  if (!isPublishable(artifact)) {
    deps.reportBlocked(`This run is ${artifact.state} — only a complete run can be published.`);
    return;
  }
  await deps.presentModal(buildPublishStubModal(artifact));
}
