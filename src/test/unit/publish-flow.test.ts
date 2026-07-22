import { describe, it, expect, vi } from "vitest";
import {
  PublishAttachmentsModel,
  PublishDialogModel,
  PublishDialogResult,
  PublishFlowDeps,
  runPublishFlow,
} from "../../traceability/publish-flow";
import { LedgerEntry } from "../../traceability/publish-ledger";
import {
  BatchSelection,
  PublishOutcome,
  PublishRequest,
  ResultPublishingCapability,
  RunArtifact,
  RunArtifactOutcome,
  RunArtifactResult,
  RunArtifactState,
} from "../../traceability/contracts";
import { ScenarioRef } from "../../traceability/scenario-ref";

const CREATED_AT = Date.UTC(2026, 6, 22, 9, 0, 0);

function scenario(name: string): ScenarioRef {
  return { filePath: "/ws/a.feature", line: 3, name, kind: "scenario" };
}

function result(name: string, over: Partial<RunArtifactResult> = {}): RunArtifactResult {
  return { scenario: scenario(name), outcome: "passed", durationMs: 10, attempts: 1, flaky: false, evidenceRefs: [], ...over };
}

function mapped(name: string, testKey: string, outcome: RunArtifactOutcome = "passed"): RunArtifactResult {
  return { ...result(name, { outcome }), testKey };
}

function artifact(
  state: RunArtifactState,
  results: RunArtifactResult[],
  selection: BatchSelection = { kind: "all-mapped" }
): RunArtifact {
  return { id: "run-1", createdAt: CREATED_AT, results, shards: [], selection, preflight: [], state };
}

const OUTCOME: PublishOutcome = { ref: { kind: "execution", key: "XNP-100" }, imported: 1, warnings: [] };

function spyPublishing(outcome: PublishOutcome = OUTCOME): {
  capability: ResultPublishingCapability;
  publish: ReturnType<typeof vi.fn>;
  searchTargets: ReturnType<typeof vi.fn>;
} {
  const publish = vi.fn<(a: RunArtifact, r: PublishRequest) => Promise<PublishOutcome>>(() => Promise.resolve(outcome));
  const searchTargets = vi.fn(() => Promise.resolve([]));
  return { capability: { publish, searchTargets }, publish, searchTargets };
}

const CREATE_REQUEST: PublishRequest = { mode: "create-new", project: "CALC", summary: "s" };

const ATTACHMENTS_MODEL: PublishAttachmentsModel = {
  available: false,
  suggestions: [],
  uploadLimitBytes: 5 * 1024 * 1024,
  evidenceStream: "evidence",
};

// Wrap a bare request as the dialog's confirmed result (no run-level attachments picked by default).
function dialogResult(request: PublishRequest, attachments: readonly string[] = []): PublishDialogResult {
  return { request, attachments };
}

function deps(over: Partial<PublishFlowDeps> = {}): PublishFlowDeps {
  const publishing = over.publishing ?? spyPublishing().capability;
  return {
    publishing,
    changedSinceRun: () => 0,
    defaultProjectKey: "",
    jiraSearchAvailable: false,
    attachments: () => Promise.resolve(ATTACHMENTS_MODEL),
    priorEntry: undefined,
    presentDialog: vi.fn<(m: PublishDialogModel) => Promise<PublishDialogResult | undefined>>(() =>
      Promise.resolve(undefined)
    ),
    confirmRepublish: vi.fn(() => Promise.resolve(true)),
    attachFiles: vi.fn(() => Promise.resolve({ failed: [] })),
    recordPublish: vi.fn(),
    reportBlocked: vi.fn(),
    reportSuccess: vi.fn(),
    reportPartialAttachments: vi.fn(),
    reportFailure: vi.fn(),
    site: "acme.atlassian.net",
    account: "client-1",
    now: () => 1_700_000_000_000,
    ...over,
  };
}

describe("runPublishFlow — gating", () => {
  it("blocks a cancelled run: no dialog, no transport", async () => {
    const publishing = spyPublishing();
    const presentDialog = vi.fn(() => Promise.resolve(undefined));
    const d = deps({ publishing: publishing.capability, presentDialog });

    await runPublishFlow(artifact("cancelled", [mapped("a", "CALC-1")]), d);

    expect(d.reportBlocked).toHaveBeenCalledTimes(1);
    expect(presentDialog).not.toHaveBeenCalled();
    expect(publishing.publish).not.toHaveBeenCalled();
  });

  it("blocks a partial run", async () => {
    const publishing = spyPublishing();
    const d = deps({ publishing: publishing.capability });
    await runPublishFlow(artifact("partial", [mapped("a", "CALC-1")]), d);
    expect(d.reportBlocked).toHaveBeenCalledTimes(1);
    expect(publishing.publish).not.toHaveBeenCalled();
  });

  it("blocks when nothing survives reconciliation (all unmapped)", async () => {
    const publishing = spyPublishing();
    const presentDialog = vi.fn(() => Promise.resolve(undefined));
    const d = deps({ publishing: publishing.capability, presentDialog });
    await runPublishFlow(artifact("complete", [result("a"), result("b")]), d);
    expect(d.reportBlocked).toHaveBeenCalledTimes(1);
    expect(presentDialog).not.toHaveBeenCalled();
    expect(publishing.publish).not.toHaveBeenCalled();
  });

  it("never builds the attachments model (nor its attachment/meta probe) for a blocked run", async () => {
    const attachmentsSpy = vi.fn(() => Promise.resolve(ATTACHMENTS_MODEL));
    const presentDialog = vi.fn(() => Promise.resolve(undefined));
    // A cancelled run is blocked before the dialog; the lazy attachments build must not fire.
    await runPublishFlow(artifact("cancelled", [mapped("a", "CALC-1")]), deps({ attachments: attachmentsSpy, presentDialog }));
    // The empty publishable set is also blocked pre-dialog.
    await runPublishFlow(artifact("complete", [result("a")]), deps({ attachments: attachmentsSpy, presentDialog }));
    expect(attachmentsSpy).not.toHaveBeenCalled();
    expect(presentDialog).not.toHaveBeenCalled();
  });

  it("builds the attachments model exactly once, only when the dialog opens", async () => {
    const attachmentsSpy = vi.fn(() => Promise.resolve(ATTACHMENTS_MODEL));
    const presentDialog = vi.fn(() => Promise.resolve(undefined));
    await runPublishFlow(artifact("complete", [mapped("a", "CALC-1")]), deps({ attachments: attachmentsSpy, presentDialog }));
    expect(attachmentsSpy).toHaveBeenCalledTimes(1);
    expect(presentDialog).toHaveBeenCalledTimes(1);
  });
});

describe("runPublishFlow — cancelled/closed dialog", () => {
  it("makes provably zero transport calls when the dialog is dismissed", async () => {
    const publishing = spyPublishing();
    const d = deps({
      publishing: publishing.capability,
      presentDialog: vi.fn(() => Promise.resolve(undefined)),
    });

    await runPublishFlow(artifact("complete", [mapped("a", "CALC-1")]), d);

    expect(publishing.publish).not.toHaveBeenCalled();
    expect(publishing.searchTargets).not.toHaveBeenCalled();
    expect(d.recordPublish).not.toHaveBeenCalled();
    expect(d.reportSuccess).not.toHaveBeenCalled();
  });
});

describe("runPublishFlow — publish", () => {
  it("hands the artifact + request to the capability and records + reports success", async () => {
    const publishing = spyPublishing();
    const run = artifact("complete", [mapped("a", "CALC-1")]);
    const d = deps({
      publishing: publishing.capability,
      presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST))),
    });

    await runPublishFlow(run, d);

    // The single import POST is the ONLY remote call — the flow has no runner and never triggers one.
    expect(publishing.publish).toHaveBeenCalledTimes(1);
    expect(publishing.publish.mock.calls[0]).toEqual([run, CREATE_REQUEST]);
    expect(d.recordPublish).toHaveBeenCalledTimes(1);
    expect(d.recordPublish).toHaveBeenCalledWith({
      artifactId: "run-1",
      executionRef: "XNP-100",
      site: "acme.atlassian.net",
      account: "client-1",
      publishedAt: 1_700_000_000_000,
      pendingAttachments: [],
      summary: "s",
      mode: "create-new",
      passed: 1,
      failed: 0,
      skipped: 0,
      total: 1,
    });
    // No attachments picked and none issue-routed → attachedCount 0, no upload attempted.
    expect(d.attachFiles).not.toHaveBeenCalled();
    expect(d.reportSuccess).toHaveBeenCalledWith(OUTCOME, CREATE_REQUEST, 0);
  });

  it("threads the publishable pass/fail/skip counts and total to the ledger append", async () => {
    const run = artifact("complete", [
      mapped("a", "CALC-1", "passed"),
      mapped("b", "CALC-2", "failed"),
      mapped("c", "CALC-3", "skipped"),
      mapped("d", "CALC-4", "passed"),
    ]);
    const d = deps({ presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST))) });

    await runPublishFlow(run, d);

    expect(d.recordPublish).toHaveBeenCalledWith(expect.objectContaining({ passed: 2, failed: 1, skipped: 1, total: 4 }));
  });

  it("records a total that exceeds pass/fail/skip when a result timed out", async () => {
    const run = artifact("complete", [mapped("a", "CALC-1", "passed"), mapped("b", "CALC-2", "timed-out")]);
    const d = deps({ presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST))) });

    await runPublishFlow(run, d);

    expect(d.recordPublish).toHaveBeenCalledWith(expect.objectContaining({ passed: 1, failed: 0, skipped: 0, total: 2 }));
  });

  it("records the append mode without a summary when appending to an existing execution", async () => {
    const append: PublishRequest = { mode: "append", executionKey: "XNP-9" };
    const d = deps({ presentDialog: vi.fn(() => Promise.resolve(dialogResult(append))) });

    await runPublishFlow(artifact("complete", [mapped("a", "CALC-1")]), d);

    const entry = (d.recordPublish as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LedgerEntry;
    expect(entry.mode).toBe("append");
    expect(entry.summary).toBeUndefined();
  });

  it("reports failure and records nothing when the import rejects", async () => {
    const publish = vi.fn(() => Promise.reject(new Error("HTTP 400: no results")));
    const d = deps({
      publishing: { publish, searchTargets: vi.fn(() => Promise.resolve([])) },
      presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST))),
    });

    await runPublishFlow(artifact("complete", [mapped("a", "CALC-1")]), d);

    expect(d.reportFailure).toHaveBeenCalledTimes(1);
    expect(d.recordPublish).not.toHaveBeenCalled();
    expect(d.reportSuccess).not.toHaveBeenCalled();
  });
});

describe("runPublishFlow — dialog model", () => {
  it("builds the subtitle from the publishable set with honest not-publishable notes", async () => {
    const captured: PublishDialogModel[] = [];
    const run = artifact("complete", [
      mapped("a", "CALC-1", "passed"),
      mapped("b", "CALC-2", "failed"),
      result("c"), // unmapped → not publishable
    ]);
    const d = deps({
      defaultProjectKey: "CALC",
      changedSinceRun: () => 1,
      presentDialog: vi.fn((m: PublishDialogModel) => {
        captured.push(m);
        return Promise.resolve(undefined);
      }),
    });

    await runPublishFlow(run, d);

    expect(captured).toHaveLength(1);
    const model = captured[0]!;
    expect(model.subtitle).toBe(
      "2 scenarios · 1 passed · 1 failed · 1 unmapped not publishable · 1 changed since run (create mode)"
    );
    expect(model.defaultProjectKey).toBe("CALC");
    expect(model.defaultSummary).toBe("Specwright run 2026-07-22 — 2 scenarios");
    expect(model.alreadyPublished).toBeUndefined();
    expect(model.prefillPlanKey).toBeUndefined();
  });

  it("prefills the plan key from a test-plan-derived selection", async () => {
    const captured: PublishDialogModel[] = [];
    const run = artifact("complete", [mapped("a", "CALC-1")], { kind: "test-plan-derived", planKey: "CALC-500" });
    const d = deps({
      presentDialog: vi.fn((m: PublishDialogModel) => {
        captured.push(m);
        return Promise.resolve(undefined);
      }),
    });
    await runPublishFlow(run, d);
    expect(captured[0]!.prefillPlanKey).toBe("CALC-500");
  });
});

describe("runPublishFlow — attachments", () => {
  it("uploads run-level picks after a successful import and reports the attached count", async () => {
    const publishing = spyPublishing();
    const attachFiles = vi.fn(() => Promise.resolve({ failed: [] as string[] }));
    const d = deps({
      publishing: publishing.capability,
      presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST, ["/ws/report.zip"]))),
      attachFiles,
    });

    await runPublishFlow(artifact("complete", [mapped("a", "CALC-1")]), d);

    expect(publishing.publish).toHaveBeenCalledTimes(1);
    // Upload runs AFTER the import, keyed off the created execution.
    expect(attachFiles).toHaveBeenCalledWith("XNP-100", ["/ws/report.zip"]);
    expect(d.recordPublish).toHaveBeenCalledWith(expect.objectContaining({ pendingAttachments: [] }));
    expect(d.reportSuccess).toHaveBeenCalledWith(OUTCOME, CREATE_REQUEST, 1);
    expect(d.reportPartialAttachments).not.toHaveBeenCalled();
  });

  it("merges issue-routed evidence files from the outcome with the dialog's run-level picks", async () => {
    const outcome: PublishOutcome = { ...OUTCOME, issueEvidenceFiles: ["/ws/test-results/shot.png"] };
    const publishing = spyPublishing(outcome);
    const attachFiles = vi.fn(() => Promise.resolve({ failed: [] as string[] }));
    const d = deps({
      publishing: publishing.capability,
      presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST, ["/ws/report.zip"]))),
      attachFiles,
    });

    await runPublishFlow(artifact("complete", [mapped("a", "CALC-1")]), d);

    expect(attachFiles).toHaveBeenCalledWith("XNP-100", ["/ws/report.zip", "/ws/test-results/shot.png"]);
  });

  it("dedupes an overlapping run-level pick and issue-routed evidence file (uploads once)", async () => {
    const shared = "/ws/test-results/shot.png";
    const outcome: PublishOutcome = { ...OUTCOME, issueEvidenceFiles: [shared] };
    const publishing = spyPublishing(outcome);
    const attachFiles = vi.fn(() => Promise.resolve({ failed: [] as string[] }));
    const d = deps({
      publishing: publishing.capability,
      presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST, ["/ws/report.zip", shared]))),
      attachFiles,
    });

    await runPublishFlow(artifact("complete", [mapped("a", "CALC-1")]), d);

    expect(attachFiles).toHaveBeenCalledWith("XNP-100", ["/ws/report.zip", shared]);
    expect(d.reportSuccess).toHaveBeenCalledWith(outcome, CREATE_REQUEST, 2);
  });

  it("records failed uploads as pendingAttachments and reports a partial (never rolls back the import)", async () => {
    const publishing = spyPublishing();
    const attachFiles = vi.fn(() => Promise.resolve({ failed: ["/ws/report.zip"] }));
    const d = deps({
      publishing: publishing.capability,
      presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST, ["/ws/report.zip", "/ws/trace.zip"]))),
      attachFiles,
    });

    await runPublishFlow(artifact("complete", [mapped("a", "CALC-1")]), d);

    // The import stands — recordPublish still fires, carrying the pending files.
    expect(d.recordPublish).toHaveBeenCalledWith(expect.objectContaining({ pendingAttachments: ["/ws/report.zip"] }));
    expect(d.reportPartialAttachments).toHaveBeenCalledWith(OUTCOME, CREATE_REQUEST, 1, ["/ws/report.zip"]);
    expect(d.reportSuccess).not.toHaveBeenCalled();
  });

  it("treats a thrown attach routine as every file pending (import already landed)", async () => {
    const publishing = spyPublishing();
    const attachFiles = vi.fn(() => Promise.reject(new Error("Jira down")));
    const d = deps({
      publishing: publishing.capability,
      presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST, ["/ws/a.zip", "/ws/b.zip"]))),
      attachFiles,
    });

    await runPublishFlow(artifact("complete", [mapped("a", "CALC-1")]), d);

    expect(d.recordPublish).toHaveBeenCalledWith(expect.objectContaining({ pendingAttachments: ["/ws/a.zip", "/ws/b.zip"] }));
    expect(d.reportPartialAttachments).toHaveBeenCalledWith(OUTCOME, CREATE_REQUEST, 0, ["/ws/a.zip", "/ws/b.zip"]);
  });

  it("skips the upload entirely when there are no files (no attach call)", async () => {
    const publishing = spyPublishing();
    const attachFiles = vi.fn(() => Promise.resolve({ failed: [] as string[] }));
    const d = deps({
      publishing: publishing.capability,
      presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST))),
      attachFiles,
    });

    await runPublishFlow(artifact("complete", [mapped("a", "CALC-1")]), d);

    expect(attachFiles).not.toHaveBeenCalled();
    expect(d.reportSuccess).toHaveBeenCalledWith(OUTCOME, CREATE_REQUEST, 0);
  });
});

describe("runPublishFlow — idempotency re-confirm", () => {
  const priorEntry: LedgerEntry = {
    artifactId: "run-1",
    executionRef: "XNP-9",
    site: "acme.atlassian.net",
    account: "client-1",
    publishedAt: 1_699_000_000_000,
    pendingAttachments: [],
  };

  it("surfaces the already-published banner in the dialog model", async () => {
    const captured: PublishDialogModel[] = [];
    const d = deps({
      priorEntry,
      presentDialog: vi.fn((m: PublishDialogModel) => {
        captured.push(m);
        return Promise.resolve(undefined);
      }),
    });
    await runPublishFlow(artifact("complete", [mapped("a", "CALC-1")]), d);
    expect(captured[0]!.alreadyPublished).toEqual({ key: "XNP-9", publishedAt: 1_699_000_000_000 });
  });

  it("requires the explicit re-confirm — a declined re-confirm makes zero transport calls", async () => {
    const publishing = spyPublishing();
    const confirmRepublish = vi.fn(() => Promise.resolve(false));
    const d = deps({
      publishing: publishing.capability,
      priorEntry,
      presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST))),
      confirmRepublish,
    });

    await runPublishFlow(artifact("complete", [mapped("a", "CALC-1")]), d);

    expect(confirmRepublish).toHaveBeenCalledWith(priorEntry);
    expect(publishing.publish).not.toHaveBeenCalled();
    expect(d.recordPublish).not.toHaveBeenCalled();
  });

  it("publishes once the re-confirm is granted", async () => {
    const publishing = spyPublishing();
    const d = deps({
      publishing: publishing.capability,
      priorEntry,
      presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST))),
      confirmRepublish: vi.fn(() => Promise.resolve(true)),
    });

    await runPublishFlow(artifact("complete", [mapped("a", "CALC-1")]), d);

    expect(publishing.publish).toHaveBeenCalledTimes(1);
    expect(d.recordPublish).toHaveBeenCalledTimes(1);
  });
});
