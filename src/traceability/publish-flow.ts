import {
  PublishOutcome,
  PublishRequest,
  ResultPublishingCapability,
  RunArtifact,
} from "./contracts";
import { LedgerEntry } from "./publish-ledger";
import { normalizeProjectKeys } from "./project-scope";
import {
  defaultPublishSummary,
  derivePublishProject,
  executionLabel,
  hasExecutionRef,
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

// The Publish dialog's run-level attachments section. `available` is false without Jira credentials;
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
// states when it was published, the target, and the mode BEFORE submit. There is no re-confirm
// modal anymore; the banner is the whole notice and submit proceeds directly. `target` is the reference
// AS PRINTED (the phrase, for an entry the import response never named), so the webview only paints it.
export interface RepublishNotice {
  readonly target: string;
  readonly publishedAt: number;
  readonly mode?: "create-new" | "append" | undefined;
}

// The pending-attachments banner (§ point 4): the run's prior publish left files that failed to
// upload. The banner's action attaches them WITHOUT a reimport (the panel's `attachPending` delegate).
export interface PendingAttachmentsNotice {
  readonly target: string;
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

// Everything one row of the dialog's run dropdown is derived from. Split out because the dropdown outlives
// the moment the flow builds it: the Publish surface re-derives the list in place whenever the local run
// history changes under an open dialog, and it has no business holding the rest of the flow's seams.
export interface PublishRunSources {
  // Candidate runs, newest-first (the run-artifact store's `list()`). Only the publishable ones with
  // something left after reconciliation become the dropdown. Read fresh on every call, never snapshotted:
  // the dialog outlives the moment it opened, and a run recorded while it sat there is publishable too.
  runs(): readonly RunArtifact[];
  // The grammar's project-of-key (Xray: `projectFromKey`); absent when the provider can't derive one.
  projectOf?: ((key: string) => string) | undefined;
  // Publishable results whose source can no longer be resolved (create mode drops them). The command
  // wires this to the FeatureParser step resolver; a test passes a fixed count.
  changedSinceRun(results: readonly PublishableResult[]): number;
  defaultProjectKey: string;
  // The board's persisted project scope, when one is picked. It outranks the run-derived key for the
  // dialog's project prefill; All Projects is the absence of a selection and leaves derivation alone.
  selectedProjectKey?: string | undefined;
  // A prior publish of the given artifact on the current site (or undefined); the ledger idempotency
  // read, per run, feeding the republish and pending-attachments banners.
  priorEntryFor(artifactId: string): LedgerEntry | undefined;
}

export interface PublishFlowDeps extends PublishRunSources {
  publishing: ResultPublishingCapability;
  // The run to open on: Run Locally and Publish passes the run it just sealed; Publish Last Run omits it
  // and the newest publishable run wins.
  preselectId?: string | undefined;
  jiraSearchAvailable: boolean;
  // The resolved project universe seeding the dialog's project dropdown. The flow normalizes it through
  // the same `normalizeProjectKeys` the board's scope selector reads.
  knownProjectKeys: readonly string[];
  // Built lazily, only when the dialog is actually about to open (after the no-runs gate), so an
  // empty run list never fires the one allowed pre-confirm call (the `attachment/meta` probe).
  attachments(): Promise<PublishAttachmentsModel>;
  // Renders the dialog and returns the user's selected run + request + attachments, or undefined on
  // cancel/close (→ zero transport).
  presentDialog(model: PublishDialogModel): Promise<PublishDialogResult | undefined>;
  // The same wait after a failed publish, over the form the user already filled in: the surface clears the
  // busy state on the model it is CURRENTLY showing (amendments and all), so this only names the run they
  // picked. Undefined on cancel/close/supersede/closed board, exactly like `presentDialog`.
  presentRetry(selectedRunId: string): Promise<PublishDialogResult | undefined>;
  // Uploads run-level picks + issue-routed evidence to the execution issue AFTER a successful import,
  // returning which failed and which the signal stopped. The same routine backs toast-retry and the
  // pending-attachments banner.
  attachFiles(
    executionKey: string,
    files: readonly string[],
    signal?: AbortSignal
  ): Promise<{ readonly failed: readonly string[]; readonly cancelled: readonly string[] }>;
  recordPublish(entry: LedgerEntry): void;
  // No publishable run exists; the message/toast the caller shows instead of an empty dialog.
  reportNoRuns(): void;
  reportSuccess(outcome: PublishOutcome, request: PublishRequest, attachedCount: number): void;
  // Import succeeded but some attachments failed, a resumable partial (§8-P3): the toast reports the
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
  // `landed` is present once the import has succeeded: the execution exists on the server whatever the
  // cancel did next, and `pending` is what the upload never got to (on the ledger, replayable from the
  // banner).
  reportCancelled(landed?: { outcome: PublishOutcome; request: PublishRequest; pending: readonly string[] }): void;
  site: string;
  account: string;
  now(): number;
  // Cancels the transport: the import POST and the attachment uploads. The dialog wait is not driven by it.
  signal?: AbortSignal | undefined;
}

// A run's dialog option plus the project its own test keys derived to. The derived key outlives a
// selection that took over the prefill, so the dropdown can still offer it.
interface BuiltRunOption {
  readonly option: PublishRunOption;
  readonly derivedProject: string;
}

function buildRunOption(
  artifact: RunArtifact,
  deps: PublishRunSources,
  scopedProject: string | undefined
): BuiltRunOption {
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
              target: executionLabel(prior.executionRef),
              publishedAt: prior.publishedAt,
              // The banner describes a prior PUBLISH, and `prior` is looked up by a run's artifact id,
              // which a standalone execution create can never carry (its id is namespaced), so the two
              // publish modes stay exhaustive here.
              ...(prior.mode === "create-new" || prior.mode === "append" ? { mode: prior.mode } : {}),
            },
          }
        : {}),
      ...(prior && prior.pendingAttachments.length > 0
        ? { pendingAttachments: { target: executionLabel(prior.executionRef), count: prior.pendingAttachments.length } }
        : {}),
    },
  };
}

// The runs the dialog can offer: publishable, and with something left after reconciliation. Exported so
// the command layer's pre-open gate asks exactly what the dropdown will answer.
export function runnableRuns(runs: readonly RunArtifact[]): readonly RunArtifact[] {
  return runs.filter((artifact) => isPublishable(artifact) && publishableResults(artifact).publishable.length > 0);
}

// Folded through the same normalizer as the dropdown, so a blank or lowercase scope cannot reach the
// prefill: whatever normalizes to nothing is no selection at all.
function scopedProjectOf(deps: PublishRunSources): string | undefined {
  return normalizeProjectKeys([deps.selectedProjectKey ?? ""])[0];
}

/**
 * The dialog's run dropdown, newest-first. The flow builds it once when it presents; the Publish surface
 * calls this again whenever the local run history changes under an open dialog, so a run recorded while
 * the user was away lands in the list without a reopen.
 */
export function publishRunOptions(deps: PublishRunSources): readonly PublishRunOption[] {
  const scopedProject = scopedProjectOf(deps);
  return runnableRuns(deps.runs()).map((artifact) => buildRunOption(artifact, deps, scopedProject).option);
}

// The run the user confirmed, together with what publishing it returned.
interface ConfirmedPublish {
  readonly artifact: RunArtifact;
  readonly dialog: PublishDialogResult;
  readonly outcome: PublishOutcome;
}

// Present, publish, and on a failure come back to the same dialog instead of dropping the user on an idle
// tab: the retry keeps the run they picked and the form they filled in, so a bad key or a transient 500 is
// one more click rather than a re-pick. Undefined once they cancel, or once the run they picked is gone.
//
// The confirmed id is resolved against the runs AS THEY STAND, not against the list the dialog opened on:
// the dropdown refreshes itself while it sits there, so the newest run is exactly the one the opening
// snapshot would refuse. A pick that is in neither is a run the history lost meanwhile, and it is reported
// rather than dropped, since the user pressed Publish and is owed an answer.
async function confirmAndPublish(
  deps: PublishFlowDeps,
  model: PublishDialogModel
): Promise<ConfirmedPublish | undefined> {
  let answer = await deps.presentDialog(model);
  while (answer !== undefined) {
    const dialog = answer;
    if (deps.signal?.aborted) {
      deps.reportCancelled();
      return undefined;
    }
    const artifact = runnableRuns(deps.runs()).find((candidate) => candidate.id === dialog.runId);
    if (artifact === undefined) {
      deps.reportFailure(new Error("That run is no longer in this workspace's run history, so it cannot be published."));
      return undefined;
    }
    try {
      return { artifact, dialog, outcome: await deps.publishing.publish(artifact, dialog.request, deps.signal) };
    } catch (error) {
      // A cancelled import rejects like any other failure; only the signal separates the two.
      if (deps.signal?.aborted) {
        deps.reportCancelled();
        return undefined;
      }
      deps.reportFailure(error);
      answer = await deps.presentRetry(dialog.runId);
    }
  }
  return undefined;
}

/**
 * The publish flow (vscode-free): filter the runs to the publishable ones with something left after
 * reconciliation, build the multi-run View 3 dialog (newest-first dropdown, per-run project prefill and
 * banners), present it, and, on an explicit confirm, hand the SELECTED run + request to the publishing
 * capability. The capability's single import POST creates the execution WITH results; nothing runs
 * remotely. Only AFTER a successful import are run-level attachments and issue-routed evidence uploaded;
 * a failed upload records the pending files on the ledger and offers Retry, never rolling back the import.
 * A run already on the ledger shows an inline republish banner (no modal); submit proceeds directly.
 * A failed import keeps the dialog on the picked run for a retry rather than settling the tab.
 * No publishable run, or cancel/close, makes ZERO transport calls.
 * An aborted `signal` stops the transport at the next boundary; that is reported as cancelled, and never
 * re-offers the dialog.
 */
export async function runPublishFlow(deps: PublishFlowDeps): Promise<void> {
  const runnable = runnableRuns(deps.runs());
  const newest = runnable[0];
  if (newest === undefined) {
    deps.reportNoRuns();
    return;
  }

  // The runs gate passed → the dialog will open, so this is the moment (and only moment) the attachments
  // model + its `attachment/meta` probe are built.
  const attachments = await deps.attachments();
  const scopedProject = scopedProjectOf(deps);
  const built = runnable.map((artifact) => buildRunOption(artifact, deps, scopedProject));
  const selectedRunId =
    deps.preselectId !== undefined && runnable.some((artifact) => artifact.id === deps.preselectId)
      ? deps.preselectId
      : newest.id;

  const confirmed = await confirmAndPublish(
    deps,
    {
      title: "Publish run results",
      runs: built.map((run) => run.option),
      selectedRunId,
      jiraSearchAvailable: deps.jiraSearchAvailable,
      // Under a selection the run-derived keys are no longer the prefill, so they join the dropdown
      // to stay one pick away.
      knownProjectKeys: normalizeProjectKeys([
        ...deps.knownProjectKeys,
        ...(scopedProject === undefined ? [] : built.map((run) => run.derivedProject)),
      ]),
      attachments,
    }
  );
  if (confirmed === undefined) {
    return;
  }
  const { artifact, dialog, outcome } = confirmed;
  const summary = summarizePublishable(publishableResults(artifact));

  // Dedupe by absolute path (exact match, mirroring the dialog's own `seenPaths`) so a run-level pick
  // that also happens to be an issue-routed evidence file uploads exactly once.
  const files = [...new Set([...dialog.attachments, ...(outcome.issueEvidenceFiles ?? [])])];
  // An unnamed execution has no issue to upload to, and files recorded as pending against it could never
  // be replayed, so the upload is skipped whole rather than attempted and ledgered as unrecoverable work.
  const uploadable = hasExecutionRef(outcome.ref.key);
  let failed: readonly string[] = [];
  let cancelled: readonly string[] = [];
  if (uploadable && files.length > 0) {
    try {
      const upload = await deps.attachFiles(outcome.ref.key, files, deps.signal);
      failed = upload.failed;
      cancelled = upload.cancelled;
    } catch {
      // The import already landed; an upload fault is recoverable, never a rollback. Treat every file
      // as pending so Retry/resume can replay them. A cancelled upload can surface as a throw too, and
      // only the signal separates the two.
      if (deps.signal?.aborted) {
        cancelled = files;
      } else {
        failed = files;
      }
    }
  }
  const pending = [...failed, ...cancelled];

  deps.recordPublish({
    artifactId: artifact.id,
    executionRef: outcome.ref.key,
    site: deps.site,
    account: deps.account,
    publishedAt: deps.now(),
    // A cancelled file is pending exactly like a failed one; the banner replays both.
    pendingAttachments: pending,
    ...(dialog.request.mode === "create-new" ? { summary: dialog.request.summary } : {}),
    mode: dialog.request.mode,
    passed: summary.passed,
    failed: summary.failed,
    skipped: summary.skipped,
    total: summary.total,
  });

  const attachedCount = uploadable ? files.length - pending.length : 0;
  // A cancel that also left a failure behind is still one interrupted upload, so it reports once, over
  // the whole pending set the ledger took.
  if (cancelled.length > 0) {
    deps.reportCancelled({ outcome, request: dialog.request, pending });
    return;
  }
  if (failed.length > 0) {
    deps.reportPartialAttachments(outcome, dialog.request, attachedCount, failed, artifact.id);
    return;
  }
  // The skip rides the outcome's own notes channel, which is where the toast already reads its honest
  // asides from, so a publish that quietly kept the user's files cannot look like a clean one. The lead
  // has already named the missing reference, so the note only has to say what it cost.
  const skipped = !uploadable && files.length > 0;
  deps.reportSuccess(
    skipped
      ? { ...outcome, warnings: [...outcome.warnings, "attachments not uploaded: there is no issue to attach them to"] }
      : outcome,
    dialog.request,
    attachedCount
  );
}
