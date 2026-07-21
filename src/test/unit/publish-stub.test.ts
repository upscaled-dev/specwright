import { describe, it, expect, vi } from "vitest";
import {
  buildPublishStubModal,
  isPublishable,
  PublishStubModal,
  PUBLISH_STUB_OPTIONS,
  runPublishStub,
  summarizeArtifact,
} from "../../traceability/publish-stub";
import {
  PublishResult,
  PublishTarget,
  ResultPublishingCapability,
  RunArtifact,
  RunArtifactOutcome,
  RunArtifactResult,
  RunArtifactState,
} from "../../traceability/contracts";
import { ScenarioRef } from "../../traceability/scenario-ref";

function scenario(name: string): ScenarioRef {
  return { filePath: "/ws/a.feature", line: 3, name, kind: "scenario" };
}

function result(name: string, outcome: RunArtifactOutcome, flaky = false): RunArtifactResult {
  return { scenario: scenario(name), outcome, durationMs: 10, attempts: 1, flaky, evidenceRefs: [] };
}

function artifact(state: RunArtifactState, results: RunArtifactResult[]): RunArtifact {
  return {
    id: "id-1",
    createdAt: 1_700_000_000_000,
    results,
    shards: [],
    selection: { kind: "all-mapped" },
    preflight: [],
    state,
  };
}

describe("summarizeArtifact", () => {
  it("tallies every outcome plus the flaky count", () => {
    const summary = summarizeArtifact(
      artifact("complete", [
        result("a", "passed"),
        result("b", "passed", true),
        result("c", "failed"),
        result("d", "skipped"),
        result("e", "timed-out"),
        result("f", "interrupted"),
      ])
    );
    expect(summary).toEqual({
      total: 6,
      passed: 2,
      failed: 1,
      skipped: 1,
      timedOut: 1,
      interrupted: 1,
      flaky: 1,
    });
  });
});

describe("isPublishable", () => {
  it("is true only for a complete run — cancelled and partial runs are not publishable", () => {
    expect(isPublishable(artifact("complete", []))).toBe(true);
    expect(isPublishable(artifact("cancelled", []))).toBe(false);
    expect(isPublishable(artifact("partial", []))).toBe(false);
  });
});

describe("buildPublishStubModal", () => {
  it("renders the P2 subset: title, run-summary line, the two radio options, and the P3 notice", () => {
    const modal = buildPublishStubModal(artifact("complete", [result("a", "passed"), result("b", "failed")]));
    expect(modal.title).toBe("Publish run results");
    expect(modal.summary).toBe("2 results: 1 passed · 1 failed · 0 skipped");
    expect(modal.options).toEqual(PUBLISH_STUB_OPTIONS);
    expect(modal.options).toEqual(["Create new execution", "Add to existing execution"]);
    expect(modal.notice).toMatch(/P3/);
  });
});

// A publishing capability whose transport methods must never be called by the P2 stub.
function spyPublishing(): { capability: ResultPublishingCapability; publish: ReturnType<typeof vi.fn>; listTargets: ReturnType<typeof vi.fn> } {
  const publish = vi.fn<(artifact: RunArtifact, target: PublishTarget) => Promise<PublishResult>>(() =>
    Promise.resolve({ targetId: "t" })
  );
  const listTargets = vi.fn<() => Promise<readonly PublishTarget[]>>(() => Promise.resolve([]));
  return { capability: { publish, listTargets }, publish, listTargets };
}

describe("runPublishStub", () => {
  it("shows the modal for a complete run and NEVER touches the transport", async () => {
    const presentModal = vi.fn<(modal: PublishStubModal) => Promise<string | undefined>>(() =>
      Promise.resolve("Create new execution")
    );
    const reportBlocked = vi.fn<(reason: string) => void>();
    const transport = spyPublishing();

    await runPublishStub(artifact("complete", [result("a", "passed")]), {
      presentModal,
      reportBlocked,
      publishing: transport.capability,
    });

    expect(presentModal).toHaveBeenCalledTimes(1);
    expect(presentModal.mock.calls[0]![0].title).toBe("Publish run results");
    expect(reportBlocked).not.toHaveBeenCalled();
    // The transport-free invariant (§8-P2): no remote write, no target enumeration.
    expect(transport.publish).not.toHaveBeenCalled();
    expect(transport.listTargets).not.toHaveBeenCalled();
  });

  it("blocks a cancelled run — no modal, no transport", async () => {
    const presentModal = vi.fn<(modal: PublishStubModal) => Promise<string | undefined>>();
    const reportBlocked = vi.fn<(reason: string) => void>();
    const transport = spyPublishing();

    await runPublishStub(artifact("cancelled", [result("a", "passed")]), {
      presentModal,
      reportBlocked,
      publishing: transport.capability,
    });

    expect(presentModal).not.toHaveBeenCalled();
    expect(reportBlocked).toHaveBeenCalledTimes(1);
    expect(reportBlocked.mock.calls[0]![0]).toMatch(/cancelled/);
    expect(transport.publish).not.toHaveBeenCalled();
  });

  it("blocks a partial run — no modal, no transport", async () => {
    const presentModal = vi.fn<(modal: PublishStubModal) => Promise<string | undefined>>();
    const reportBlocked = vi.fn<(reason: string) => void>();
    const transport = spyPublishing();

    await runPublishStub(artifact("partial", []), {
      presentModal,
      reportBlocked,
      publishing: transport.capability,
    });

    expect(presentModal).not.toHaveBeenCalled();
    expect(reportBlocked).toHaveBeenCalledTimes(1);
    expect(transport.publish).not.toHaveBeenCalled();
  });
});
