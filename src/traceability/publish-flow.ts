import {
  PublishOutcome,
  PublishRequest,
  ResultPublishingCapability,
  RunArtifact,
} from "./contracts";
import { LedgerEntry } from "./publish-ledger";
import {
  defaultPublishSummary,
  isPublishable,
  publishableResults,
  publishDialogSubtitle,
  PublishableResult,
  summarizePublishable,
} from "./publish-core";

// The View 3 dialog's data — assembled from the reconciled publishable set, never from the raw
// artifact. `alreadyPublished` drives the in-dialog idempotency banner; the flow still enforces an
// explicit modal re-confirm before any transport (informed duplicate — never silent, §2).
export interface PublishDialogModel {
  readonly title: string;
  readonly subtitle: string;
  readonly defaultProjectKey: string;
  readonly defaultSummary: string;
  readonly prefillPlanKey?: string | undefined;
  readonly jiraSearchAvailable: boolean;
  readonly alreadyPublished?: { readonly key: string; readonly publishedAt: number } | undefined;
}

export interface PublishFlowDeps {
  publishing: ResultPublishingCapability;
  // Publishable results whose source can no longer be resolved (create mode drops them). The command
  // wires this to the FeatureParser step resolver; a test passes a fixed count.
  changedSinceRun(results: readonly PublishableResult[]): number;
  defaultProjectKey: string;
  jiraSearchAvailable: boolean;
  // A prior publish of THIS artifact on the current site (or undefined) — the ledger idempotency read.
  priorEntry: LedgerEntry | undefined;
  // Renders the dialog and returns the user's request, or undefined on cancel/close (→ zero transport).
  presentDialog(model: PublishDialogModel): Promise<PublishRequest | undefined>;
  // The explicit re-confirm for an already-published artifact; false leaves the transport untouched.
  confirmRepublish(entry: LedgerEntry): Promise<boolean>;
  recordPublish(entry: LedgerEntry): void;
  reportBlocked(reason: string): void;
  reportSuccess(outcome: PublishOutcome, request: PublishRequest): void;
  reportFailure(error: unknown): void;
  site: string;
  account: string;
  now(): number;
}

/**
 * The publish flow (vscode-free): gate on a publishable artifact, reconcile to the publishable set,
 * present the View 3 dialog, and — only after an explicit confirm (plus a re-confirm when the
 * artifact was already published) — hand the artifact + request to the publishing capability. The
 * capability's single import POST creates the execution WITH results; nothing runs remotely.
 * Cancel/close, an empty publishable set, or a declined re-confirm all make ZERO transport calls.
 */
export async function runPublishFlow(artifact: RunArtifact, deps: PublishFlowDeps): Promise<void> {
  if (!isPublishable(artifact)) {
    deps.reportBlocked(`This run is ${artifact.state} — only a complete run can be published.`);
    return;
  }
  const reconciled = publishableResults(artifact);
  if (reconciled.publishable.length === 0) {
    deps.reportBlocked("Nothing to publish — every result was excluded by preflight or is unmapped.");
    return;
  }

  const summary = summarizePublishable(reconciled);
  const planKey = artifact.selection.kind === "test-plan-derived" ? artifact.selection.planKey : undefined;
  const model: PublishDialogModel = {
    title: "Publish run results",
    subtitle: publishDialogSubtitle(summary, deps.changedSinceRun(reconciled.publishable)),
    defaultProjectKey: deps.defaultProjectKey,
    defaultSummary: defaultPublishSummary(artifact.createdAt, reconciled.publishable.length),
    ...(planKey !== undefined && planKey !== "" ? { prefillPlanKey: planKey } : {}),
    jiraSearchAvailable: deps.jiraSearchAvailable,
    ...(deps.priorEntry
      ? { alreadyPublished: { key: deps.priorEntry.executionRef, publishedAt: deps.priorEntry.publishedAt } }
      : {}),
  };

  const request = await deps.presentDialog(model);
  if (request === undefined) {
    return;
  }
  if (deps.priorEntry !== undefined && !(await deps.confirmRepublish(deps.priorEntry))) {
    return;
  }

  let outcome: PublishOutcome;
  try {
    outcome = await deps.publishing.publish(artifact, request);
  } catch (error) {
    deps.reportFailure(error);
    return;
  }
  deps.recordPublish({
    artifactId: artifact.id,
    executionRef: outcome.ref.key,
    site: deps.site,
    account: deps.account,
    publishedAt: deps.now(),
    pendingAttachments: [],
  });
  deps.reportSuccess(outcome, request);
}
