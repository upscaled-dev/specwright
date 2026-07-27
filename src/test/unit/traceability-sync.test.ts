import { describe, it, expect, vi } from "vitest";
import { runTraceabilitySync } from "../../traceability/traceability-sync";
import { MetadataCapability, RemoteMetadataSnapshot, SyncProgress, SyncScope } from "../../traceability/contracts";
import { Logger, LogLevel } from "../../utils/logger";

function snapshot(overrides: Partial<RemoteMetadataSnapshot> = {}): RemoteMetadataSnapshot {
  return {
    tests: new Map(),
    fetchedScopes: [],
    catalogueProjects: [],
    verifiedAbsentKeys: [],
    stale: false,
    completeness: "unknown",
    errors: [],
    ...overrides,
  };
}

function fakeMetadata(opts: {
  sync?: (scope: SyncScope, signal?: AbortSignal, onProgress?: SyncProgress) => Promise<void>;
  snapshot: RemoteMetadataSnapshot;
}): MetadataCapability {
  return {
    onDidChange: () => ({ dispose: () => {} }),
    snapshot: () => opts.snapshot,
    sync: opts.sync ?? (() => Promise.resolve()),
  };
}

const scope: SyncScope = { testKeys: ["CALC-1"], projectKeys: ["CALC"] };
const logger = Logger.create(undefined, LogLevel.ERROR);

describe("runTraceabilitySync", () => {
  it("reports a success count when the snapshot has no errors", async () => {
    const tests = new Map([["CALC-1", { key: "CALC-1" }], ["CALC-2", { key: "CALC-2" }]]);
    const metadata = fakeMetadata({ snapshot: snapshot({ tests }) });
    const controller = new AbortController();

    const result = await runTraceabilitySync({ metadata, scope, signal: controller.signal, logger });

    expect(result).toEqual({ ok: true, message: "Synced 2 remote tests.", cancelled: false });
  });

  it("passes the scope, the signal and the progress sink through to the capability sync", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const metadata = fakeMetadata({ sync, snapshot: snapshot() });
    const controller = new AbortController();
    const onProgress = vi.fn();

    await runTraceabilitySync({ metadata, scope, signal: controller.signal, logger, onProgress });

    expect(sync).toHaveBeenCalledWith(scope, controller.signal, onProgress);
  });

  it("surfaces a failure when the snapshot records sync errors, without throwing", async () => {
    const metadata = fakeMetadata({ snapshot: snapshot({ errors: ["transport failure"] }) });
    const controller = new AbortController();

    const result = await runTraceabilitySync({ metadata, scope, signal: controller.signal, logger });

    expect(result.ok).toBe(false);
    expect(result.message).toContain("errors");
  });

  it("treats a cancelled sync as a non-error, no-toast outcome", async () => {
    const controller = new AbortController();
    const metadata = fakeMetadata({
      sync: () => { controller.abort(); return Promise.resolve(); },
      snapshot: snapshot(),
    });

    const result = await runTraceabilitySync({ metadata, scope, signal: controller.signal, logger });

    expect(result).toEqual({ ok: true, message: "Sync cancelled.", cancelled: true });
  });

  it("reports a failure when the capability sync itself throws", async () => {
    const metadata = fakeMetadata({ sync: () => Promise.reject(new Error("boom")), snapshot: snapshot() });
    const controller = new AbortController();

    const result = await runTraceabilitySync({ metadata, scope, signal: controller.signal, logger });

    expect(result.ok).toBe(false);
    expect(result.cancelled).toBe(false);
  });
});
