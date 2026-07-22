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

// One discovered/picked run-level report bundle (an HTML report folder zip, a trace zip). `size` lets
// the dialog pre-check against the Jira upload limit before the file is ever read.
export interface AttachmentSuggestion {
  readonly path: string;
  readonly name: string;
  readonly size: number;
}

// The Publish dialog's run-level attachments section. `available` is false without Jira credentials —
// the section renders disabled with the honest `reason`. `evidenceStream` mirrors `xray.attachTo` so
// the wording can distinguish the always-to-issue run-level picks from the per-result evidence stream.
export interface PublishAttachmentsModel {
  readonly available: boolean;
  readonly reason?: string | undefined;
  readonly suggestions: readonly AttachmentSuggestion[];
  readonly uploadLimitBytes: number;
  readonly evidenceStream: "evidence" | "issue" | "both";
}

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
  readonly attachments: PublishAttachmentsModel;
}

// The dialog's confirmed output: the publish request plus the run-level attachment paths the user
// kept. Both feed the flow — the request drives the import, the attachments the post-import upload.
export interface PublishDialogResult {
  readonly request: PublishRequest;
  readonly attachments: readonly string[];
}

export interface PublishFlowDeps {
  publishing: ResultPublishingCapability;
  // Publishable results whose source can no longer be resolved (create mode drops them). The command
  // wires this to the FeatureParser step resolver; a test passes a fixed count.
  changedSinceRun(results: readonly PublishableResult[]): number;
  defaultProjectKey: string;
  jiraSearchAvailable: boolean;
  // Built lazily — only when the dialog is actually about to open (after the publishability gates), so
  // a blocked/empty run never fires the one allowed pre-confirm call (the `attachment/meta` probe).
  attachments(): Promise<PublishAttachmentsModel>;
  // A prior publish of THIS artifact on the current site (or undefined) — the ledger idempotency read.
  priorEntry: LedgerEntry | undefined;
  // Renders the dialog and returns the user's request + attachments, or undefined on cancel/close
  // (→ zero transport).
  presentDialog(model: PublishDialogModel): Promise<PublishDialogResult | undefined>;
  // The explicit re-confirm for an already-published artifact; false leaves the transport untouched.
  confirmRepublish(entry: LedgerEntry): Promise<boolean>;
  // Uploads run-level picks + issue-routed evidence to the execution issue AFTER a successful import,
  // returning which failed. The same routine backs toast-retry and publishLastRun resume.
  attachFiles(executionKey: string, files: readonly string[]): Promise<{ readonly failed: readonly string[] }>;
  recordPublish(entry: LedgerEntry): void;
  reportBlocked(reason: string): void;
  reportSuccess(outcome: PublishOutcome, request: PublishRequest, attachedCount: number): void;
  // Import succeeded but some attachments failed — a resumable partial (§8-P3): the toast reports the
  // count and offers Retry off the ledgered pending files. An import is never rolled back for this.
  reportPartialAttachments(
    outcome: PublishOutcome,
    request: PublishRequest,
    attachedCount: number,
    failed: readonly string[]
  ): void;
  reportFailure(error: unknown): void;
  site: string;
  account: string;
  now(): number;
}

/**
 * The publish flow (vscode-free): gate on a publishable artifact, reconcile to the publishable set,
 * present the View 3 dialog, and — only after an explicit confirm (plus a re-confirm when the
 * artifact was already published) — hand the artifact + request to the publishing capability. The
 * capability's single import POST creates the execution WITH results; nothing runs remotely. Only
 * AFTER a successful import are run-level attachments and issue-routed evidence uploaded — a failed
 * upload records the pending files on the ledger and offers Retry, never rolling back the import.
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
  // Gates passed → the dialog will open, so this is the moment (and the only moment) the attachments
  // model + its `attachment/meta` probe are built.
  const attachments = await deps.attachments();
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
    attachments,
  };

  const dialog = await deps.presentDialog(model);
  if (dialog === undefined) {
    return;
  }
  if (deps.priorEntry !== undefined && !(await deps.confirmRepublish(deps.priorEntry))) {
    return;
  }

  let outcome: PublishOutcome;
  try {
    outcome = await deps.publishing.publish(artifact, dialog.request);
  } catch (error) {
    deps.reportFailure(error);
    return;
  }

  // Dedupe by absolute path (exact match, mirroring the dialog's own `seenPaths`) so a run-level pick
  // that also happens to be an issue-routed evidence file uploads exactly once.
  const files = [...new Set([...dialog.attachments, ...(outcome.issueEvidenceFiles ?? [])])];
  let failed: readonly string[] = [];
  if (files.length > 0) {
    try {
      failed = (await deps.attachFiles(outcome.ref.key, files)).failed;
    } catch {
      // The import already landed — an upload fault is recoverable, never a rollback. Treat every file
      // as pending so Retry/resume can replay them.
      failed = files;
    }
  }

  deps.recordPublish({
    artifactId: artifact.id,
    executionRef: outcome.ref.key,
    site: deps.site,
    account: deps.account,
    publishedAt: deps.now(),
    pendingAttachments: [...failed],
  });

  const attachedCount = files.length - failed.length;
  if (failed.length > 0) {
    deps.reportPartialAttachments(outcome, dialog.request, attachedCount, failed);
  } else {
    deps.reportSuccess(outcome, dialog.request, attachedCount);
  }
}
