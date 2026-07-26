import {
  PublishOutcome,
  PublishRequest,
  ResultPublishingCapability,
  RunArtifact,
} from "./contracts";
import { LedgerEntry } from "./publish-ledger";
import { knownProjectKeys } from "./project-scope";
import {
  defaultPublishSummary,
  derivePublishProject,
  isPublishable,
  PublishableResult,
  PublishProjectPrefill,
  publishableResults,
  publishDialogSubtitle,
  publishRunLabel,
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

// The already-published banner (§ point 3): the run carries a publish-ledger entry, so the dialog
// states when it was published, the target key, and the mode BEFORE submit. There is no re-confirm
// modal anymore — the banner is the whole notice and submit proceeds directly.
export interface RepublishNotice {
  readonly key: string;
  readonly publishedAt: number;
  readonly mode?: "create-new" | "append" | undefined;
}

// The pending-attachments banner (§ point 4): the run's prior publish left files that failed to
// upload. The banner's action attaches them WITHOUT a reimport (the panel's `attachPending` delegate).
export interface PendingAttachmentsNotice {
  readonly key: string;
  readonly count: number;
}

// One selectable run in the dialog's newest-first dropdown, carrying everything that re-derives when it
// becomes the selection: subtitle, project prefill, default summary, plan prefill, and both banners.
export interface PublishRunOption {
  readonly id: string;
  readonly label: string;
  readonly subtitle: string;
  readonly project: PublishProjectPrefill;
  readonly defaultSummary: string;
  readonly prefillPlanKey?: string | undefined;
  readonly republish?: RepublishNotice | undefined;
  readonly pendingAttachments?: PendingAttachmentsNotice | undefined;
}

// The View 3 dialog's data. `runs` is newest-first; the dialog opens on `selectedRunId` and re-derives
// its project prefill and banners from whichever run the dropdown selects. `attachments` is workspace-
// level (report globs), not per-run, so it lives once at the top.
export interface PublishDialogModel {
  readonly title: string;
  readonly runs: readonly PublishRunOption[];
  readonly selectedRunId: string;
  readonly jiraSearchAvailable: boolean;
  readonly knownProjectKeys: readonly string[];
  readonly attachments: PublishAttachmentsModel;
}

// The dialog's confirmed output: which run was selected, the publish request, and the run-level
// attachment paths the user kept. The request drives the import, the attachments the post-import upload.
export interface PublishDialogResult {
  readonly runId: string;
  readonly request: PublishRequest;
  readonly attachments: readonly string[];
}

export interface PublishFlowDeps {
  publishing: ResultPublishingCapability;
  // Candidate runs, newest-first (the run-artifact store's `list()`). The flow keeps only the publishable
  // ones with something left after reconciliation; that filtered set is the dropdown.
  runs: readonly RunArtifact[];
  // The run to open on: Run Locally and Publish passes the run it just sealed; Publish Last Run omits it
  // and the newest publishable run wins.
  preselectId?: string | undefined;
  // The grammar's project-of-key (Xray: `projectFromKey`); absent when the provider can't derive one.
  projectOf?: ((key: string) => string) | undefined;
  // Publishable results whose source can no longer be resolved (create mode drops them). The command
  // wires this to the FeatureParser step resolver; a test passes a fixed count.
  changedSinceRun(results: readonly PublishableResult[]): number;
  defaultProjectKey: string;
  // The board's persisted project scope, when one is picked. It outranks the run-derived key for the
  // dialog's project prefill; All Projects is the absence of a selection and leaves derivation alone.
  selectedProjectKey?: string | undefined;
  jiraSearchAvailable: boolean;
  // Keys already known locally (sync config, snapshot catalogue) seeding the dialog's project dropdown.
  // The flow normalizes them through the same `knownProjectKeys` the board's scope selector reads.
  knownProjectKeys: readonly string[];
  // Built lazily — only when the dialog is actually about to open (after the no-runs gate), so an
  // empty run list never fires the one allowed pre-confirm call (the `attachment/meta` probe).
  attachments(): Promise<PublishAttachmentsModel>;
  // A prior publish of the given artifact on the current site (or undefined) — the ledger idempotency
  // read, per run, feeding the republish and pending-attachments banners.
  priorEntryFor(artifactId: string): LedgerEntry | undefined;
  // Renders the dialog and returns the user's selected run + request + attachments, or undefined on
  // cancel/close (→ zero transport).
  presentDialog(model: PublishDialogModel): Promise<PublishDialogResult | undefined>;
  // Uploads run-level picks + issue-routed evidence to the execution issue AFTER a successful import,
  // returning which failed. The same routine backs toast-retry and the pending-attachments banner.
  attachFiles(executionKey: string, files: readonly string[]): Promise<{ readonly failed: readonly string[] }>;
  recordPublish(entry: LedgerEntry): void;
  // No publishable run exists — the message/toast the caller shows instead of an empty dialog.
  reportNoRuns(): void;
  reportSuccess(outcome: PublishOutcome, request: PublishRequest, attachedCount: number): void;
  // Import succeeded but some attachments failed — a resumable partial (§8-P3): the toast reports the
  // count and offers Retry off the ledgered pending files (keyed by `artifactId`). An import is never
  // rolled back for this.
  reportPartialAttachments(
    outcome: PublishOutcome,
    request: PublishRequest,
    attachedCount: number,
    failed: readonly string[],
    artifactId: string
  ): void;
  reportFailure(error: unknown): void;
  site: string;
  account: string;
  now(): number;
}

// A run's dialog option plus the project its own test keys derived to. The derived key outlives a
// selection that took over the prefill, so the dropdown can still offer it.
interface BuiltRunOption {
  readonly option: PublishRunOption;
  readonly derivedProject: string;
}

function buildRunOption(artifact: RunArtifact, deps: PublishFlowDeps, scopedProject: string | undefined): BuiltRunOption {
  const reconciled = publishableResults(artifact);
  const summary = summarizePublishable(reconciled);
  const planKey = artifact.selection.kind === "test-plan-derived" ? artifact.selection.planKey : undefined;
  const prior = deps.priorEntryFor(artifact.id);
  const derived = derivePublishProject(reconciled.publishable, deps.defaultProjectKey, deps.projectOf);
  return {
    derivedProject: derived.value,
    option: {
      id: artifact.id,
      label: publishRunLabel(artifact.createdAt, artifact.selection.kind),
      subtitle: publishDialogSubtitle(summary, deps.changedSinceRun(reconciled.publishable)),
      project:
        scopedProject === undefined ? derived : { value: scopedProject, fromDerivation: false, fromScope: true },
      defaultSummary: defaultPublishSummary(artifact.createdAt, reconciled.publishable.length),
      ...(planKey !== undefined && planKey !== "" ? { prefillPlanKey: planKey } : {}),
      ...(prior
        ? {
            republish: {
              key: prior.executionRef,
              publishedAt: prior.publishedAt,
              // The banner describes a prior PUBLISH, and `prior` is looked up by a run's artifact id,
              // which a standalone execution create can never carry (its id is namespaced), so the two
              // publish modes stay exhaustive here.
              ...(prior.mode === "create-new" || prior.mode === "append" ? { mode: prior.mode } : {}),
            },
          }
        : {}),
      ...(prior && prior.pendingAttachments.length > 0
        ? { pendingAttachments: { key: prior.executionRef, count: prior.pendingAttachments.length } }
        : {}),
    },
  };
}

/**
 * The publish flow (vscode-free): filter the runs to the publishable ones with something left after
 * reconciliation, build the multi-run View 3 dialog (newest-first dropdown, per-run project prefill and
 * banners), present it, and — on an explicit confirm — hand the SELECTED run + request to the publishing
 * capability. The capability's single import POST creates the execution WITH results; nothing runs
 * remotely. Only AFTER a successful import are run-level attachments and issue-routed evidence uploaded —
 * a failed upload records the pending files on the ledger and offers Retry, never rolling back the import.
 * A run already on the ledger shows an inline republish banner (no modal); submit proceeds directly.
 * No publishable run, or cancel/close, makes ZERO transport calls.
 */
export async function runPublishFlow(deps: PublishFlowDeps): Promise<void> {
  const runnable = deps.runs.filter(
    (artifact) => isPublishable(artifact) && publishableResults(artifact).publishable.length > 0
  );
  const newest = runnable[0];
  if (newest === undefined) {
    deps.reportNoRuns();
    return;
  }

  // The runs gate passed → the dialog will open, so this is the moment (and only moment) the attachments
  // model + its `attachment/meta` probe are built.
  const attachments = await deps.attachments();
  // Folded through the same normalizer as the dropdown, so a blank or lowercase scope cannot reach the
  // prefill: whatever normalizes to nothing is no selection at all.
  const scopedProject = knownProjectKeys([deps.selectedProjectKey ?? ""])[0];
  const built = runnable.map((artifact) => buildRunOption(artifact, deps, scopedProject));
  const selectedRunId =
    deps.preselectId !== undefined && runnable.some((artifact) => artifact.id === deps.preselectId)
      ? deps.preselectId
      : newest.id;

  const dialog = await deps.presentDialog({
    title: "Publish run results",
    runs: built.map((run) => run.option),
    selectedRunId,
    jiraSearchAvailable: deps.jiraSearchAvailable,
    // Under a selection the run-derived keys are no longer the prefill, so they join the dropdown
    // to stay one pick away.
    knownProjectKeys: knownProjectKeys(
      deps.knownProjectKeys,
      scopedProject === undefined ? [] : built.map((run) => run.derivedProject)
    ),
    attachments,
  });
  if (dialog === undefined) {
    return;
  }
  const artifact = runnable.find((candidate) => candidate.id === dialog.runId);
  if (artifact === undefined) {
    return;
  }

  const summary = summarizePublishable(publishableResults(artifact));
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
    ...(dialog.request.mode === "create-new" ? { summary: dialog.request.summary } : {}),
    mode: dialog.request.mode,
    passed: summary.passed,
    failed: summary.failed,
    skipped: summary.skipped,
    total: summary.total,
  });

  const attachedCount = files.length - failed.length;
  if (failed.length > 0) {
    deps.reportPartialAttachments(outcome, dialog.request, attachedCount, failed, artifact.id);
  } else {
    deps.reportSuccess(outcome, dialog.request, attachedCount);
  }
}
