import { describe, it, expect, vi } from "vitest";
import { PublishDialogModel, PublishFlowDeps, runPublishFlow } from "../../traceability/publish-flow";
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

function deps(over: Partial<PublishFlowDeps> = {}): PublishFlowDeps {
  const publishing = over.publishing ?? spyPublishing().capability;
  return {
    publishing,
    changedSinceRun: () => 0,
    defaultProjectKey: "",
    jiraSearchAvailable: false,
    priorEntry: undefined,
    presentDialog: vi.fn<(m: PublishDialogModel) => Promise<PublishRequest | undefined>>(() => Promise.resolve(undefined)),
    confirmRepublish: vi.fn(() => Promise.resolve(true)),
    recordPublish: vi.fn(),
    reportBlocked: vi.fn(),
    reportSuccess: vi.fn(),
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
      presentDialog: vi.fn(() => Promise.resolve(CREATE_REQUEST)),
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
    });
    expect(d.reportSuccess).toHaveBeenCalledWith(OUTCOME, CREATE_REQUEST);
  });

  it("reports failure and records nothing when the import rejects", async () => {
    const publish = vi.fn(() => Promise.reject(new Error("HTTP 400: no results")));
    const d = deps({
      publishing: { publish, searchTargets: vi.fn(() => Promise.resolve([])) },
      presentDialog: vi.fn(() => Promise.resolve(CREATE_REQUEST)),
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
      presentDialog: vi.fn(() => Promise.resolve(CREATE_REQUEST)),
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
      presentDialog: vi.fn(() => Promise.resolve(CREATE_REQUEST)),
      confirmRepublish: vi.fn(() => Promise.resolve(true)),
    });

    await runPublishFlow(artifact("complete", [mapped("a", "CALC-1")]), d);

    expect(publishing.publish).toHaveBeenCalledTimes(1);
    expect(d.recordPublish).toHaveBeenCalledTimes(1);
  });
});
