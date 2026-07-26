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
import { projectFromKey } from "../../xray/xray-adapter";

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

interface ArtifactOptions {
  id?: string;
  createdAt?: number;
  state?: RunArtifactState;
  results?: RunArtifactResult[];
  selection?: BatchSelection;
}

function artifact(opts: ArtifactOptions = {}): RunArtifact {
  return {
    id: opts.id ?? "run-1",
    createdAt: opts.createdAt ?? CREATED_AT,
    results: opts.results ?? [mapped("a", "CALC-1")],
    shards: [],
    selection: opts.selection ?? { kind: "all-mapped" },
    preflight: [],
    state: opts.state ?? "complete",
  };
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

// Wrap a bare request as the dialog's confirmed result (no run-level attachments picked by default,
// and the single-run "run-1" selected).
function dialogResult(request: PublishRequest, attachments: readonly string[] = [], runId = "run-1"): PublishDialogResult {
  return { runId, request, attachments };
}

function deps(runs: readonly RunArtifact[], over: Partial<PublishFlowDeps> = {}): PublishFlowDeps {
  const publishing = over.publishing ?? spyPublishing().capability;
  return {
    publishing,
    runs,
    projectOf: projectFromKey,
    changedSinceRun: () => 0,
    defaultProjectKey: "",
    jiraSearchAvailable: false,
    knownProjectKeys: [],
    attachments: () => Promise.resolve(ATTACHMENTS_MODEL),
    priorEntryFor: () => undefined,
    presentDialog: vi.fn<(m: PublishDialogModel) => Promise<PublishDialogResult | undefined>>(() =>
      Promise.resolve(undefined)
    ),
    attachFiles: vi.fn(() => Promise.resolve({ failed: [] })),
    recordPublish: vi.fn(),
    reportNoRuns: vi.fn(),
    reportSuccess: vi.fn(),
    reportPartialAttachments: vi.fn(),
    reportFailure: vi.fn(),
    site: "acme.atlassian.net",
    account: "client-1",
    now: () => 1_700_000_000_000,
    ...over,
  };
}

// Capture the single model the dialog was shown.
function captureModel(over: Partial<PublishFlowDeps> = {}): { models: PublishDialogModel[]; over: Partial<PublishFlowDeps> } {
  const models: PublishDialogModel[] = [];
  return {
    models,
    over: {
      ...over,
      presentDialog: vi.fn((m: PublishDialogModel) => {
        models.push(m);
        return Promise.resolve(undefined);
      }),
    },
  };
}

describe("runPublishFlow — no publishable runs", () => {
  it("reports no runs and opens no dialog for a cancelled-only list", async () => {
    const publishing = spyPublishing();
    const presentDialog = vi.fn(() => Promise.resolve(undefined));
    const d = deps([artifact({ state: "cancelled" })], { publishing: publishing.capability, presentDialog });

    await runPublishFlow(d);

    expect(d.reportNoRuns).toHaveBeenCalledTimes(1);
    expect(presentDialog).not.toHaveBeenCalled();
    expect(publishing.publish).not.toHaveBeenCalled();
  });

  it("filters out a partial run", async () => {
    const publishing = spyPublishing();
    const d = deps([artifact({ state: "partial" })], { publishing: publishing.capability });
    await runPublishFlow(d);
    expect(d.reportNoRuns).toHaveBeenCalledTimes(1);
    expect(publishing.publish).not.toHaveBeenCalled();
  });

  it("filters out a complete run with nothing left after reconciliation (all unmapped)", async () => {
    const publishing = spyPublishing();
    const presentDialog = vi.fn(() => Promise.resolve(undefined));
    const d = deps([artifact({ results: [result("a"), result("b")] })], {
      publishing: publishing.capability,
      presentDialog,
    });
    await runPublishFlow(d);
    expect(d.reportNoRuns).toHaveBeenCalledTimes(1);
    expect(presentDialog).not.toHaveBeenCalled();
    expect(publishing.publish).not.toHaveBeenCalled();
  });

  it("never builds the attachments model (nor its probe) when no run is publishable", async () => {
    const attachmentsSpy = vi.fn(() => Promise.resolve(ATTACHMENTS_MODEL));
    const presentDialog = vi.fn(() => Promise.resolve(undefined));
    await runPublishFlow(
      deps([artifact({ state: "cancelled" }), artifact({ results: [result("a")] })], {
        attachments: attachmentsSpy,
        presentDialog,
      })
    );
    expect(attachmentsSpy).not.toHaveBeenCalled();
    expect(presentDialog).not.toHaveBeenCalled();
  });

  it("builds the attachments model exactly once, only when the dialog opens", async () => {
    const attachmentsSpy = vi.fn(() => Promise.resolve(ATTACHMENTS_MODEL));
    const presentDialog = vi.fn(() => Promise.resolve(undefined));
    await runPublishFlow(deps([artifact()], { attachments: attachmentsSpy, presentDialog }));
    expect(attachmentsSpy).toHaveBeenCalledTimes(1);
    expect(presentDialog).toHaveBeenCalledTimes(1);
  });
});

describe("runPublishFlow — dropdown ordering and preselection", () => {
  it("keeps the runs newest-first as passed and defaults the selection to the newest", async () => {
    const cap = captureModel();
    const runs = [artifact({ id: "new", createdAt: CREATED_AT + 1000 }), artifact({ id: "old", createdAt: CREATED_AT })];
    await runPublishFlow(deps(runs, cap.over));
    const model = cap.models[0]!;
    expect(model.runs.map((r) => r.id)).toEqual(["new", "old"]);
    expect(model.selectedRunId).toBe("new");
  });

  it("preselects the requested run (Run Locally and Publish hand-off)", async () => {
    const cap = captureModel({ preselectId: "old" });
    const runs = [artifact({ id: "new", createdAt: CREATED_AT + 1000 }), artifact({ id: "old", createdAt: CREATED_AT })];
    await runPublishFlow(deps(runs, cap.over));
    expect(cap.models[0]!.selectedRunId).toBe("old");
  });

  it("falls back to the newest run when the preselected id is not publishable", async () => {
    const cap = captureModel({ preselectId: "gone" });
    await runPublishFlow(deps([artifact({ id: "new" })], cap.over));
    expect(cap.models[0]!.selectedRunId).toBe("new");
  });

  it("drops non-publishable runs from the dropdown", async () => {
    const cap = captureModel();
    const runs = [artifact({ id: "good" }), artifact({ id: "bad", state: "cancelled" })];
    await runPublishFlow(deps(runs, cap.over));
    expect(cap.models[0]!.runs.map((r) => r.id)).toEqual(["good"]);
  });
});

describe("runPublishFlow — project prefill derivation", () => {
  it("derives the single distinct project from the run's own keys and marks it a derivation", async () => {
    const cap = captureModel({ defaultProjectKey: "PAY" });
    const run = artifact({ results: [mapped("a", "CALC-1"), mapped("b", "CALC-2")] });
    await runPublishFlow(deps([run], cap.over));
    expect(cap.models[0]!.runs[0]!.project).toEqual({ value: "CALC", fromDerivation: true });
  });

  it("falls back to xray.defaultProjectKey (no hint) when the run spans multiple projects", async () => {
    const cap = captureModel({ defaultProjectKey: "PAY" });
    const run = artifact({ results: [mapped("a", "CALC-1"), mapped("b", "SHOP-2")] });
    await runPublishFlow(deps([run], cap.over));
    expect(cap.models[0]!.runs[0]!.project).toEqual({ value: "PAY", fromDerivation: false });
  });

  it("leaves the project empty (no hint) when multiple projects and no default setting", async () => {
    const cap = captureModel({ defaultProjectKey: "" });
    const run = artifact({ results: [mapped("a", "CALC-1"), mapped("b", "SHOP-2")] });
    await runPublishFlow(deps([run], cap.over));
    expect(cap.models[0]!.runs[0]!.project).toEqual({ value: "", fromDerivation: false });
  });

  it("lets the board's project selection outrank the derived key, hinting the scope not a derivation", async () => {
    const cap = captureModel({ selectedProjectKey: "SHOP", defaultProjectKey: "PAY" });
    const run = artifact({ results: [mapped("a", "CALC-1"), mapped("b", "CALC-2")] });
    await runPublishFlow(deps([run], cap.over));
    expect(cap.models[0]!.runs[0]!.project).toEqual({ value: "SHOP", fromDerivation: false, fromScope: true });
  });

  it("normalizes the selection the way the dropdown does before it becomes the prefill", async () => {
    const cap = captureModel({ selectedProjectKey: " shop " });
    await runPublishFlow(deps([artifact()], cap.over));
    expect(cap.models[0]!.runs[0]!.project).toEqual({ value: "SHOP", fromDerivation: false, fromScope: true });
  });

  it("treats a selection that normalizes to nothing as no selection at all", async () => {
    const cap = captureModel({ selectedProjectKey: "  ", defaultProjectKey: "PAY" });
    await runPublishFlow(deps([artifact()], cap.over));
    expect(cap.models[0]!.runs[0]!.project).toEqual({ value: "CALC", fromDerivation: true });
    expect(cap.models[0]!.knownProjectKeys).toEqual([]);
  });

  it("keeps the derived key in the dropdown when the selection took the prefill", async () => {
    const cap = captureModel({ selectedProjectKey: "SHOP", knownProjectKeys: ["SHOP"] });
    const runs = [artifact({ id: "one", results: [mapped("a", "CALC-1")] }), artifact({ id: "two", results: [mapped("b", "MATH-1")] })];
    await runPublishFlow(deps(runs, cap.over));
    expect(cap.models[0]!.knownProjectKeys).toEqual(["CALC", "MATH", "SHOP"]);
  });
});

describe("runPublishFlow: known project keys", () => {
  it("drops empties, dedupes and sorts the seeded keys onto the model, leaving casing to the caller", async () => {
    const cap = captureModel({ knownProjectKeys: ["SHOP", "CALC", "CALC", "", "PAY"] });
    await runPublishFlow(deps([artifact()], cap.over));
    expect(cap.models[0]!.knownProjectKeys).toEqual(["CALC", "PAY", "SHOP"]);
  });

  it("passes an empty list through when nothing is known locally", async () => {
    const cap = captureModel({ knownProjectKeys: [] });
    await runPublishFlow(deps([artifact()], cap.over));
    expect(cap.models[0]!.knownProjectKeys).toEqual([]);
  });
});

describe("runPublishFlow — banners", () => {
  const priorEntry: LedgerEntry = {
    artifactId: "run-1",
    executionRef: "XNP-9",
    site: "acme.atlassian.net",
    account: "client-1",
    publishedAt: 1_699_000_000_000,
    pendingAttachments: [],
    mode: "append",
  };

  it("surfaces the republish banner (target, time, mode) when the run is on the ledger", async () => {
    const cap = captureModel({ priorEntryFor: () => priorEntry });
    await runPublishFlow(deps([artifact()], cap.over));
    expect(cap.models[0]!.runs[0]!.republish).toEqual({ key: "XNP-9", publishedAt: 1_699_000_000_000, mode: "append" });
  });

  it("surfaces the pending-attachments banner only when files are pending", async () => {
    const cap = captureModel({ priorEntryFor: () => ({ ...priorEntry, pendingAttachments: ["/ws/a.zip", "/ws/b.zip"] }) });
    await runPublishFlow(deps([artifact()], cap.over));
    expect(cap.models[0]!.runs[0]!.pendingAttachments).toEqual({ key: "XNP-9", count: 2 });
  });

  it("shows no banners for a run that was never published", async () => {
    const cap = captureModel();
    await runPublishFlow(deps([artifact()], cap.over));
    expect(cap.models[0]!.runs[0]!.republish).toBeUndefined();
    expect(cap.models[0]!.runs[0]!.pendingAttachments).toBeUndefined();
  });
});

describe("runPublishFlow — dialog model", () => {
  it("builds the subtitle, summary default, and plan prefill per run", async () => {
    const cap = captureModel({ defaultProjectKey: "CALC", changedSinceRun: () => 1 });
    const run = artifact({
      results: [mapped("a", "CALC-1", "passed"), mapped("b", "CALC-2", "failed"), result("c")],
      selection: { kind: "test-plan-derived", planKey: "CALC-500" },
    });
    await runPublishFlow(deps([run], cap.over));
    const option = cap.models[0]!.runs[0]!;
    expect(option.subtitle).toBe(
      "2 scenarios · 1 passed · 1 failed · 1 unmapped not publishable · 1 changed since run (create mode)"
    );
    expect(option.defaultSummary).toBe("Specwright run 2026-07-22 — 2 scenarios");
    expect(option.prefillPlanKey).toBe("CALC-500");
  });

  it("omits the plan prefill when the selection is not test-plan-derived", async () => {
    const cap = captureModel();
    await runPublishFlow(deps([artifact()], cap.over));
    expect(cap.models[0]!.runs[0]!.prefillPlanKey).toBeUndefined();
  });
});

describe("runPublishFlow — cancelled/closed dialog", () => {
  it("makes provably zero transport calls when the dialog is dismissed", async () => {
    const publishing = spyPublishing();
    const d = deps([artifact()], {
      publishing: publishing.capability,
      presentDialog: vi.fn(() => Promise.resolve(undefined)),
    });

    await runPublishFlow(d);

    expect(publishing.publish).not.toHaveBeenCalled();
    expect(publishing.searchTargets).not.toHaveBeenCalled();
    expect(d.recordPublish).not.toHaveBeenCalled();
    expect(d.reportSuccess).not.toHaveBeenCalled();
  });
});

describe("runPublishFlow — publish", () => {
  it("publishes the selected run and records + reports success (no re-confirm modal)", async () => {
    const publishing = spyPublishing();
    const run = artifact();
    const d = deps([run], {
      publishing: publishing.capability,
      presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST))),
    });

    await runPublishFlow(d);

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
    expect(d.attachFiles).not.toHaveBeenCalled();
    expect(d.reportSuccess).toHaveBeenCalledWith(OUTCOME, CREATE_REQUEST, 0);
  });

  it("publishes the run the dropdown selected, not merely the newest", async () => {
    const publishing = spyPublishing();
    const newer = artifact({ id: "new", createdAt: CREATED_AT + 1000, results: [mapped("a", "NEW-1")] });
    const older = artifact({ id: "old", createdAt: CREATED_AT, results: [mapped("b", "OLD-1")] });
    const d = deps([newer, older], {
      publishing: publishing.capability,
      presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST, [], "old"))),
    });

    await runPublishFlow(d);

    expect(publishing.publish.mock.calls[0]![0]).toBe(older);
    expect(d.recordPublish).toHaveBeenCalledWith(expect.objectContaining({ artifactId: "old" }));
  });

  it("threads the publishable pass/fail/skip counts and total to the ledger append", async () => {
    const run = artifact({
      results: [
        mapped("a", "CALC-1", "passed"),
        mapped("b", "CALC-2", "failed"),
        mapped("c", "CALC-3", "skipped"),
        mapped("d", "CALC-4", "passed"),
      ],
    });
    const d = deps([run], { presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST))) });

    await runPublishFlow(d);

    expect(d.recordPublish).toHaveBeenCalledWith(expect.objectContaining({ passed: 2, failed: 1, skipped: 1, total: 4 }));
  });

  it("records a total that exceeds pass/fail/skip when a result timed out", async () => {
    const run = artifact({ results: [mapped("a", "CALC-1", "passed"), mapped("b", "CALC-2", "timed-out")] });
    const d = deps([run], { presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST))) });

    await runPublishFlow(d);

    expect(d.recordPublish).toHaveBeenCalledWith(expect.objectContaining({ passed: 1, failed: 0, skipped: 0, total: 2 }));
  });

  it("records the append mode without a summary when appending to an existing execution", async () => {
    const append: PublishRequest = { mode: "append", executionKey: "XNP-9" };
    const d = deps([artifact()], { presentDialog: vi.fn(() => Promise.resolve(dialogResult(append))) });

    await runPublishFlow(d);

    const entry = (d.recordPublish as ReturnType<typeof vi.fn>).mock.calls[0]![0] as LedgerEntry;
    expect(entry.mode).toBe("append");
    expect(entry.summary).toBeUndefined();
  });

  it("publishes directly for an already-published run — no re-confirm gate", async () => {
    const publishing = spyPublishing();
    const priorEntry: LedgerEntry = {
      artifactId: "run-1",
      executionRef: "XNP-9",
      site: "acme.atlassian.net",
      account: "client-1",
      publishedAt: 1_699_000_000_000,
      pendingAttachments: [],
    };
    const d = deps([artifact()], {
      publishing: publishing.capability,
      priorEntryFor: () => priorEntry,
      presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST))),
    });

    await runPublishFlow(d);

    expect(publishing.publish).toHaveBeenCalledTimes(1);
    expect(d.recordPublish).toHaveBeenCalledTimes(1);
  });

  it("reports failure and records nothing when the import rejects", async () => {
    const publish = vi.fn(() => Promise.reject(new Error("HTTP 400: no results")));
    const d = deps([artifact()], {
      publishing: { publish, searchTargets: vi.fn(() => Promise.resolve([])) },
      presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST))),
    });

    await runPublishFlow(d);

    expect(d.reportFailure).toHaveBeenCalledTimes(1);
    expect(d.recordPublish).not.toHaveBeenCalled();
    expect(d.reportSuccess).not.toHaveBeenCalled();
  });
});

describe("runPublishFlow — attachments", () => {
  it("uploads run-level picks after a successful import and reports the attached count", async () => {
    const publishing = spyPublishing();
    const attachFiles = vi.fn(() => Promise.resolve({ failed: [] as string[] }));
    const d = deps([artifact()], {
      publishing: publishing.capability,
      presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST, ["/ws/report.zip"]))),
      attachFiles,
    });

    await runPublishFlow(d);

    expect(publishing.publish).toHaveBeenCalledTimes(1);
    expect(attachFiles).toHaveBeenCalledWith("XNP-100", ["/ws/report.zip"]);
    expect(d.recordPublish).toHaveBeenCalledWith(expect.objectContaining({ pendingAttachments: [] }));
    expect(d.reportSuccess).toHaveBeenCalledWith(OUTCOME, CREATE_REQUEST, 1);
    expect(d.reportPartialAttachments).not.toHaveBeenCalled();
  });

  it("merges issue-routed evidence files from the outcome with the dialog's run-level picks", async () => {
    const outcome: PublishOutcome = { ...OUTCOME, issueEvidenceFiles: ["/ws/test-results/shot.png"] };
    const publishing = spyPublishing(outcome);
    const attachFiles = vi.fn(() => Promise.resolve({ failed: [] as string[] }));
    const d = deps([artifact()], {
      publishing: publishing.capability,
      presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST, ["/ws/report.zip"]))),
      attachFiles,
    });

    await runPublishFlow(d);

    expect(attachFiles).toHaveBeenCalledWith("XNP-100", ["/ws/report.zip", "/ws/test-results/shot.png"]);
  });

  it("dedupes an overlapping run-level pick and issue-routed evidence file (uploads once)", async () => {
    const shared = "/ws/test-results/shot.png";
    const outcome: PublishOutcome = { ...OUTCOME, issueEvidenceFiles: [shared] };
    const publishing = spyPublishing(outcome);
    const attachFiles = vi.fn(() => Promise.resolve({ failed: [] as string[] }));
    const d = deps([artifact()], {
      publishing: publishing.capability,
      presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST, ["/ws/report.zip", shared]))),
      attachFiles,
    });

    await runPublishFlow(d);

    expect(attachFiles).toHaveBeenCalledWith("XNP-100", ["/ws/report.zip", shared]);
    expect(d.reportSuccess).toHaveBeenCalledWith(outcome, CREATE_REQUEST, 2);
  });

  it("records failed uploads as pendingAttachments and reports a partial (never rolls back the import)", async () => {
    const publishing = spyPublishing();
    const attachFiles = vi.fn(() => Promise.resolve({ failed: ["/ws/report.zip"] }));
    const d = deps([artifact()], {
      publishing: publishing.capability,
      presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST, ["/ws/report.zip", "/ws/trace.zip"]))),
      attachFiles,
    });

    await runPublishFlow(d);

    expect(d.recordPublish).toHaveBeenCalledWith(expect.objectContaining({ pendingAttachments: ["/ws/report.zip"] }));
    expect(d.reportPartialAttachments).toHaveBeenCalledWith(OUTCOME, CREATE_REQUEST, 1, ["/ws/report.zip"], "run-1");
    expect(d.reportSuccess).not.toHaveBeenCalled();
  });

  it("treats a thrown attach routine as every file pending (import already landed)", async () => {
    const publishing = spyPublishing();
    const attachFiles = vi.fn(() => Promise.reject(new Error("Jira down")));
    const d = deps([artifact()], {
      publishing: publishing.capability,
      presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST, ["/ws/a.zip", "/ws/b.zip"]))),
      attachFiles,
    });

    await runPublishFlow(d);

    expect(d.recordPublish).toHaveBeenCalledWith(expect.objectContaining({ pendingAttachments: ["/ws/a.zip", "/ws/b.zip"] }));
    expect(d.reportPartialAttachments).toHaveBeenCalledWith(OUTCOME, CREATE_REQUEST, 0, ["/ws/a.zip", "/ws/b.zip"], "run-1");
  });

  it("skips the upload entirely when there are no files (no attach call)", async () => {
    const publishing = spyPublishing();
    const attachFiles = vi.fn(() => Promise.resolve({ failed: [] as string[] }));
    const d = deps([artifact()], {
      publishing: publishing.capability,
      presentDialog: vi.fn(() => Promise.resolve(dialogResult(CREATE_REQUEST))),
      attachFiles,
    });

    await runPublishFlow(d);

    expect(attachFiles).not.toHaveBeenCalled();
    expect(d.reportSuccess).toHaveBeenCalledWith(OUTCOME, CREATE_REQUEST, 0);
  });
});
