import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { ExtensionConfig } from "../core/extension-config";
import type { ExecutionGateway, RunInitiator } from "../core/run-contracts";
import { FeatureParser } from "../parsers/feature-parser";
import {
  BatchInvocation,
  resolveBatchSelection,
} from "../traceability/batch-selection";
import { BoardPanel } from "../traceability/board-panel";
import {
  BatchSelection,
  PreflightDecision,
  PreflightItem,
  PreflightState,
  PublishOutcome,
  PublishRequest,
  RunArtifact,
  TraceabilityAdapter,
} from "../traceability/contracts";
import { PreflightChoice, runPreflightFlow } from "../traceability/preflight-flow";
import {
  hasExecutionRef,
  isPublishable,
  publishableResults,
  publishOutcomeLead,
  UNKNOWN_EXECUTION,
} from "../traceability/publish-core";
import { PendingAttachmentsResult, PublishDialogDelegate } from "../traceability/publish-dialog-panel";
import {
  AttachmentSuggestion,
  PublishAttachmentsModel,
  PublishRunSources,
  publishRunOptions,
  runnableRuns,
  runPublishFlow,
} from "../traceability/publish-flow";
import { PublishLedger } from "../traceability/publish-ledger";
import { RunArtifactStore } from "../traceability/run-artifact-store";
import type { ScenarioRef } from "../traceability/scenario-ref";
import type { TraceabilitySubsystem } from "../traceability/traceability-subsystem";
import { Logger } from "../utils/logger";
import { plural } from "../utils/text";
import { makeFeatureStepResolver } from "../xray/feature-step-resolver";
import { XrayImportError } from "../xray/execution-importers";
import { fetchJiraAttachmentMeta, uploadJiraAttachments } from "../xray/jira-attachments";
import { buildAttachmentsModel } from "../xray/publish-attachment-support";
import type { XrayCredentials, XrayJiraCredentials } from "../xray/xray-credential-store";
import { boardBatchSelection, treeBatchSelection } from "./run-publish-selection";
import { runPublishBatch } from "./run-publish-execution";
import { logCapturedRunOutput } from "./captured-run-progress";

const PREFLIGHT_STATE_LABEL: Record<PreflightState, string> = {
  "ready": "ready",
  "unmapped": "no @TEST_ tag",
  "invalid-key": "broken test tag",
  "duplicate-mapping": "duplicate mapping",
  "incompatible-test-type": "not a Gherkin test",
  "automation-binding-required": "automation binding required",
  "not-in-target-plan": "not in the target plan",
};

const NO_PUBLISHABLE_RUNS_MESSAGE = "No local runs to publish yet. Run mapped scenarios first.";

function clearedHistoryMessage(runs: number, entries: number): string {
  const parts: string[] = [];
  if (runs > 0) {parts.push(`${runs} local ${plural(runs, "run")}`);}
  if (entries > 0) {parts.push(`${entries} ledger ${plural(entries, "entry", "entries")}`);}
  return parts.length === 0 ? "Local run history is already empty." : `Cleared ${parts.join(" and ")}.`;
}

export interface TraceabilityPublishCommandDeps {
  readonly config: ExtensionConfig;
  readonly fallbackAdapter: () => TraceabilityAdapter;
  readonly subsystem: () => TraceabilitySubsystem | undefined;
  readonly board: () => BoardPanel;
  readonly projectUniverse: (adapter: TraceabilityAdapter | undefined) => string[];
  readonly rebuild: (what: string) => Promise<boolean>;
  readonly linkScenarioForRef: (scenario: ScenarioRef) => Promise<void>;
  readonly credentials: () => Promise<XrayCredentials | undefined>;
  readonly jiraCredentials: () => Promise<XrayJiraCredentials | undefined>;
  readonly hasJiraCredentials: () => Promise<boolean>;
  readonly publishLedger: () => PublishLedger | undefined;
  readonly siteUrl: () => string;
  readonly idleEvent: vscode.Event<void>;
  readonly runArtifactStore: RunArtifactStore | undefined;
  readonly executionGateway: ExecutionGateway;
  readonly featureParser: FeatureParser;
}

export class TraceabilityPublishCommands {
  constructor(private readonly logger: Logger, private readonly deps: TraceabilityPublishCommandDeps) {}

  public async runAndPublish(...args: unknown[]): Promise<void> {
    const subsystem = this.deps.subsystem();
    const snapshot = subsystem?.getSnapshot();
    if (!subsystem || !snapshot) {
      vscode.window.showInformationMessage("Enable and sync the Traceability panel before running a batch.");
      return;
    }
    const resolved = treeBatchSelection(args, snapshot);
    if (resolved.skipped > 0) {
      vscode.window.showInformationMessage(
        `${resolved.skipped} untraced ${plural(resolved.skipped, "scenario was", "scenarios were")} skipped.`
      );
    }
    if (resolved.selection.kind === "multi-select" && resolved.selection.scenarios.length === 0) {
      vscode.window.showInformationMessage("No mapped scenarios were selected. Nothing was run.");
      return;
    }
    await this.runAndPublishSelection(resolved.selection, "traceability-tree");
  }

  public async runAndPublishSelected(selectedTestKeys: readonly string[]): Promise<void> {
    const snapshot = this.deps.subsystem()?.getSnapshot();
    if (!snapshot) {
      vscode.window.showInformationMessage("Enable and sync the Traceability panel before running a batch.");
      return;
    }
    const resolved = boardBatchSelection(selectedTestKeys, snapshot);
    if (resolved.skipped > 0) {
      vscode.window.showInformationMessage(
        `${resolved.skipped} checked ${plural(resolved.skipped, "test has", "tests have")} no mapped scenario and will be skipped.`
      );
    }
    if (resolved.selection.kind === "multi-select" && resolved.selection.scenarios.length === 0) {
      vscode.window.showInformationMessage("No mapped scenarios were selected. Nothing was run.");
      return;
    }
    await this.runAndPublishSelection(resolved.selection, "coverage-board");
  }

  public async runAndPublishSelection(
    selection: BatchSelection,
    initiatedBy: RunInitiator = "traceability-tree"
  ): Promise<void> {
    const subsystem = this.deps.subsystem();
    const snapshot = subsystem?.getSnapshot();
    if (!subsystem || !snapshot) {
      vscode.window.showInformationMessage("Enable and sync the Traceability panel before running a batch.");
      return;
    }
    const binding = subsystem.getActiveAdapter()?.automationBinding;
    const projectOf = subsystem.getActiveAdapter()?.keyGrammar.projectOf;

    let sealed: RunArtifact | undefined;
    const ran = await runPreflightFlow(selection, {
      resolve: (selected) => resolveBatchSelection(
        selected,
        subsystem.getSnapshot() ?? snapshot,
        { projectOf }
      ),
      snapshot: () => subsystem.getSnapshot() ?? snapshot,
      classifyBinding: binding ? (meta) => binding.classify(meta) : undefined,
      ui: {
        choose: (items) => this.choosePreflight(items),
        repair: async (ref) => {
          await this.deps.linkScenarioForRef(ref);
          await subsystem.rebuildNow();
        },
      },
      runner: {
        run: async (selected, invocations, decisions) => {
          sealed = await this.runResolvedBatch(selected, invocations, decisions, initiatedBy);
        },
      },
    });
    if (!ran) {
      vscode.window.showInformationMessage("Preflight cancelled. Nothing was run.");
      return;
    }
    if (!sealed) {return;}
    if (!isPublishable(sealed)) {
      vscode.window.showWarningMessage(`This run is ${sealed.state}. Only a complete run can be published.`);
    } else if (publishableResults(sealed).publishable.length === 0) {
      vscode.window.showWarningMessage("Nothing to publish. Every result was excluded by preflight or is unmapped.");
    } else {
      await this.runPublish(sealed.id);
    }
  }

  public async publishLastRun(): Promise<void> {await this.runPublish();}

  public async runPublish(preselectId?: string): Promise<void> {
    const subsystem = this.deps.subsystem();
    const adapter = subsystem?.getActiveAdapter();
    const publishing = adapter?.resultPublishing;
    if (!subsystem || !adapter || !publishing) {
      vscode.window.showInformationMessage("Connect to your test tracker before publishing.");
      return;
    }
    if (runnableRuns(this.deps.runArtifactStore?.list() ?? []).length === 0) {
      vscode.window.showInformationMessage(NO_PUBLISHABLE_RUNS_MESSAGE);
      return;
    }

    const board = this.deps.board();
    const controller = new AbortController();
    const cancelOnClose = board.onDidDispose(() => controller.abort());
    const site = this.deps.siteUrl();
    const credentials = await this.deps.credentials();
    const jiraSearchAvailable = await this.deps.hasJiraCredentials();
    let published = false;
    let succeeded = false;
    try {
      await runPublishFlow({
        ...this.publishRunSources(),
        publishing,
        ...(preselectId !== undefined ? { preselectId } : {}),
        jiraSearchAvailable,
        knownProjectKeys: this.deps.projectUniverse(adapter),
        attachments: () => this.buildPublishAttachments(),
        presentDialog: (model) => board.publish.present(model),
        presentRetry: (selectedRunId) => board.publish.presentRetry(selectedRunId),
        attachFiles: (executionKey, files, signal) =>
          this.attachFiles(executionKey, files, signal),
        recordPublish: (entry) => {
          published = true;
          this.deps.publishLedger()?.record(entry);
        },
        reportNoRuns: () => {
          vscode.window.showInformationMessage(NO_PUBLISHABLE_RUNS_MESSAGE);
        },
        reportSuccess: (outcome, request, attachedCount) => {
          succeeded = true;
          this.reportPublishSuccess(outcome, request, attachedCount);
        },
        reportPartialAttachments: (outcome, request, attachedCount, failed, artifactId) =>
          this.reportPartialAttachments(
            artifactId,
            site,
            outcome,
            request,
            attachedCount,
            failed
          ),
        reportFailure: (error) => this.reportPublishFailure(error),
        reportCancelled: (landed) => {
          if (landed === undefined) {
            vscode.window.showInformationMessage("Publish cancelled.");
            return;
          }
          const note = `Publish cancelled · ${landed.pending.length} ${plural(
            landed.pending.length,
            "attachment"
          )} pending`;
          this.showBrowseToast(
            `${publishOutcomeLead(landed.outcome, landed.request)} · ${note}`,
            landed.outcome,
            "info"
          );
        },
        site,
        account: credentials?.clientId ?? "",
        now: () => Date.now(),
        signal: controller.signal,
      });
    } finally {
      cancelOnClose.dispose();
      const settled = board.publish.markSettled();
      const refreshed = published && (await this.deps.rebuild("publishing"));
      if (succeeded && settled && refreshed) {
        board.showExecutions();
      }
    }
  }

  public async clearLocalRunHistory(): Promise<void> {
    const choice = await vscode.window.showWarningMessage(
      "Clear this workspace's local run history?",
      {
        modal: true,
        detail:
          "Local runs feed the Publish tab. The publish ledger drives the Executions tab and warns you before republishing a run. Clearing the ledger forfeits those warnings for past executions.",
      },
      "Clear runs",
      "Clear runs and ledger"
    );
    if (choice !== "Clear runs" && choice !== "Clear runs and ledger") {return;}

    const runs = this.deps.runArtifactStore?.clear() ?? 0;
    const entries =
      choice === "Clear runs and ledger" ? (this.deps.publishLedger()?.clear() ?? 0) : 0;
    vscode.window.showInformationMessage(clearedHistoryMessage(runs, entries));
    if (runs === 0 && entries === 0) {return;}
    await this.deps.rebuild("clearing run history");
  }

  private async attachPendingForRun(
    artifactId: string,
    site: string
  ): Promise<PendingAttachmentsResult> {
    const ledger = this.deps.publishLedger();
    const entry = ledger?.find(artifactId, site);
    if (entry === undefined || entry.pendingAttachments.length === 0) {
      return { remaining: 0 };
    }
    if (!this.canReplayAttachments(entry.executionRef)) {
      return { remaining: entry.pendingAttachments.length };
    }
    const { failed, cancelled } = await this.attachFiles(
      entry.executionRef,
      entry.pendingAttachments
    );
    const pending = [...failed, ...cancelled];
    ledger?.setPendingAttachments(artifactId, site, pending);
    const attached = entry.pendingAttachments.length - pending.length;
    if (pending.length === 0) {
      vscode.window.showInformationMessage(
        `${entry.executionRef}: ${attached} pending attachment(s) uploaded.`
      );
    } else {
      vscode.window.showWarningMessage(
        `${entry.executionRef}: ${pending.length} attachment(s) still failed.`
      );
    }
    return { remaining: pending.length };
  }

  private async buildPublishAttachments(): Promise<PublishAttachmentsModel> {
    const credentials = await this.deps.jiraCredentials();
    return buildAttachmentsModel({
      reportGlobs: this.deps.config.xrayReportGlob,
      attachTo: this.deps.config.xrayAttachTo,
      jiraAvailable: credentials !== undefined,
      findFiles: async (glob) =>
        (await vscode.workspace.findFiles(glob, undefined, 50)).map((uri) => uri.fsPath),
      fileSize: (filePath) => this.fileSizeOrUndefined(filePath),
      baseName: (filePath) => path.basename(filePath),
      attachmentMeta: () =>
        (credentials === undefined
          ? Promise.resolve({ enabled: true })
          : fetchJiraAttachmentMeta({
              site: this.deps.siteUrl(),
              credentials,
              logger: this.logger,
            })),
    });
  }

  private fileSizeOrUndefined(filePath: string): number | undefined {
    try {
      return fs.statSync(filePath).size;
    } catch {
      return undefined;
    }
  }

  private async browsePublishFiles(): Promise<readonly AttachmentSuggestion[]> {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: true,
      openLabel: "Attach",
    });
    if (!picked) {return [];}
    return picked.map((uri) => ({
      path: uri.fsPath,
      name: path.basename(uri.fsPath),
      size: this.fileSizeOrUndefined(uri.fsPath) ?? 0,
    }));
  }

  private async attachFiles(
    executionKey: string,
    files: readonly string[],
    signal?: AbortSignal
  ): Promise<{ readonly failed: readonly string[]; readonly cancelled: readonly string[] }> {
    const credentials = await this.deps.jiraCredentials();
    if (credentials === undefined) {
      return { failed: files, cancelled: [] };
    }
    const result = await uploadJiraAttachments({
      site: this.deps.siteUrl(),
      credentials,
      issueKey: executionKey,
      files,
      logger: this.logger,
      ...(signal !== undefined ? { signal } : {}),
    });
    return { failed: result.failed, cancelled: result.cancelled };
  }

  private canReplayAttachments(executionRef: string): boolean {
    if (hasExecutionRef(executionRef)) {return true;}
    this.logger.warn(
      "Pending attachments cannot be replayed: the ledger entry names no execution"
    );
    vscode.window.showWarningMessage(
      `Cannot upload the pending files: they were published to ${UNKNOWN_EXECUTION}.`
    );
    return false;
  }

  private async retryAttachments(
    artifactId: string,
    site: string,
    executionKey: string,
    files: readonly string[]
  ): Promise<void> {
    if (!this.canReplayAttachments(executionKey)) {return;}
    const { failed, cancelled } = await this.attachFiles(executionKey, files);
    const pending = [...failed, ...cancelled];
    this.deps.publishLedger()?.setPendingAttachments(artifactId, site, pending);
    const attached = files.length - pending.length;
    if (pending.length === 0) {
      vscode.window.showInformationMessage(
        `${executionKey}: ${attached} pending attachment(s) uploaded.`
      );
      return;
    }
    Promise.resolve(
      vscode.window.showWarningMessage(
        `${executionKey}: ${pending.length} attachment(s) still failed.`,
        "Retry"
      )
    )
      .then((choice) =>
        (choice === "Retry"
          ? this.retryAttachments(artifactId, site, executionKey, pending)
          : undefined)
      )
      .catch(() => undefined);
  }

  private reportPublishSuccess(
    outcome: PublishOutcome,
    request: PublishRequest,
    attachedCount: number
  ): void {
    const base = publishOutcomeLead(outcome, request);
    const notes = [...outcome.warnings];
    if (attachedCount > 0) {
      notes.unshift(`${attachedCount} ${plural(attachedCount, "file")} attached`);
    }
    this.showBrowseToast(
      notes.length > 0 ? `${base} · ${notes.join(" · ")}` : base,
      outcome,
      "info"
    );
  }

  private reportPartialAttachments(
    artifactId: string,
    site: string,
    outcome: PublishOutcome,
    request: PublishRequest,
    attachedCount: number,
    failed: readonly string[]
  ): void {
    const base = publishOutcomeLead(outcome, request);
    const attachedNote =
      attachedCount > 0
        ? ` · ${attachedCount} ${plural(attachedCount, "file")} attached`
        : "";
    const message = `${base}${attachedNote} · ${failed.length} ${plural(
      failed.length,
      "attachment"
    )} failed`;
    const adapter = this.deps.subsystem()?.getActiveAdapter() ?? this.deps.fallbackAdapter();
    const url = adapter.browseUrl(outcome.ref);
    const buttons = url ? ["Retry", "Open in Jira"] : ["Retry"];
    Promise.resolve(vscode.window.showWarningMessage(message, ...buttons))
      .then(async (choice) => {
        if (choice === "Retry") {
          await this.retryAttachments(artifactId, site, outcome.ref.key, failed);
        } else if (choice === "Open in Jira" && url) {
          await vscode.env.openExternal(vscode.Uri.parse(url));
        }
      })
      .catch(() => undefined);
  }

  private showBrowseToast(
    message: string,
    outcome: PublishOutcome,
    level: "info" | "warn"
  ): void {
    const adapter = this.deps.subsystem()?.getActiveAdapter() ?? this.deps.fallbackAdapter();
    const url = adapter.browseUrl(outcome.ref);
    const buttons = url ? ["Open in Jira"] : [];
    const show =
      level === "info"
        ? vscode.window.showInformationMessage
        : vscode.window.showWarningMessage;
    Promise.resolve(show(message, ...buttons))
      .then((choice) =>
        (choice === "Open in Jira" && url
          ? vscode.env.openExternal(vscode.Uri.parse(url))
          : undefined)
      )
      .catch(() => undefined);
  }

  private reportPublishFailure(error: unknown): void {
    if (error instanceof XrayImportError) {
      this.logger.error("Publish failed", {
        status: error.status,
        message: error.serverMessage ?? error.message,
      });
      vscode.window.showErrorMessage(
        `Publish failed: ${error.serverMessage ?? `HTTP ${error.status}`}`
      );
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error("Publish failed", { message });
    vscode.window.showErrorMessage(`Publish failed: ${message}`);
  }

  private async choosePreflight(items: readonly PreflightItem[]): Promise<PreflightChoice> {
    const flagged = items.filter((item) => item.state !== "ready");
    const readyCount = items.length - flagged.length;
    interface Row extends vscode.QuickPickItem {
      choice?: PreflightChoice | undefined;
    }
    const rows: Row[] = [
      {
        label: "$(play) Run all locally",
        description: `${readyCount} ready · ${flagged.length} flagged`,
        choice: { kind: "run", outcome: "local-only" },
      },
    ];
    if (flagged.length > 0) {
      rows.push({
        label: "$(circle-slash) Exclude flagged and run the rest",
        description: `${flagged.length} excluded`,
        choice: { kind: "run", outcome: "exclude" },
      });
      rows.push({ label: "Repair", kind: vscode.QuickPickItemKind.Separator });
      for (const item of flagged) {
        rows.push({
          label: `$(tools) ${item.scenario.name}`,
          description: PREFLIGHT_STATE_LABEL[item.state],
          ...(item.detail ? { detail: item.detail } : {}),
          choice: { kind: "repair", scenario: item.scenario },
        });
      }
    }
    const picked = await vscode.window.showQuickPick(rows, {
      placeHolder: "Preflight: resolve flagged scenarios before the batch runs",
      ignoreFocusOut: true,
    });
    return picked?.choice ?? { kind: "cancel" };
  }

  private async runResolvedBatch(
    selection: BatchSelection,
    invocations: readonly BatchInvocation[],
    decisions: readonly PreflightDecision[],
    initiatedBy: RunInitiator
  ): Promise<RunArtifact | undefined> {
    const artifactId = await runPublishBatch(
      this.deps.executionGateway,
      selection,
      invocations,
      decisions,
      initiatedBy,
      (output, failure) => logCapturedRunOutput(this.logger, "Traceability batch", output, failure)
    );
    return artifactId === undefined
      ? undefined
      : this.deps.runArtifactStore?.list().find((artifact) => artifact.id === artifactId);
  }

  public publishDelegate(): PublishDialogDelegate {
    return {
      searchTargets: (kind, query, signal) => {
        const publishing = this.deps.subsystem()?.getActiveAdapter()?.resultPublishing;
        return publishing
          ? publishing.searchTargets(kind, query, signal)
          : Promise.reject(new Error("Connect to your test tracker to search."));
      },
      browseFiles: () => this.browsePublishFiles(),
      attachPending: (runId) => this.attachPendingForRun(runId, this.deps.siteUrl()),
      onDidChangeRuns: this.deps.runArtifactStore?.onDidChange ?? this.deps.idleEvent,
      runOptions: () => publishRunOptions(this.publishRunSources()),
    };
  }

  private publishRunSources(): PublishRunSources {
    const subsystem = this.deps.subsystem();
    const adapter = subsystem?.getActiveAdapter();
    const site = this.deps.siteUrl();
    const resolveSteps = makeFeatureStepResolver(this.deps.featureParser);
    return {
      runs: () => this.deps.runArtifactStore?.list() ?? [],
      projectOf: adapter?.keyGrammar.projectOf,
      changedSinceRun: (results) =>
        results.filter((result) => resolveSteps(result.scenario) === undefined).length,
      defaultProjectKey: this.deps.config.xrayDefaultProjectKey,
      selectedProjectKey: subsystem
        ?.projectScope()
        .get(this.deps.projectUniverse(adapter)),
      priorEntryFor: (artifactId) => this.deps.publishLedger()?.find(artifactId, site),
    };
  }
}
