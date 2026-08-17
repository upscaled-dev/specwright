import { describe, expect, it, vi } from "vitest";
import { WorkspaceTrust } from "../../core/workspace-trust";
import type { TraceabilityAdapter } from "../../traceability/contracts";
import { trustedAdapter } from "../../traceability/trusted-adapter";
import { validatedAdapter } from "../../traceability/validated-adapter";

function rawAdapter(over: Partial<NonNullable<TraceabilityAdapter["testAuthoring"]>>): TraceabilityAdapter {
  return {
    id: "test",
    label: "Test",
    keyGrammar: {
      testPrefix: "TEST_",
      reqPrefix: "REQ_",
      keyShape: /^T-\d+$/,
      canonicalizeKey: (key) => key.toUpperCase(),
      projectOf: () => "T",
    },
    browseUrl: () => undefined,
    testAuthoring: {
      createTest: () => Promise.resolve({ warnings: [] }),
      ...over,
    },
  };
}

describe("existing-container adapter boundaries", () => {
  it("threads trust-owned signals through both resolve and add seams", async () => {
    const resolve = vi.fn((_kind, key, signal?: AbortSignal) =>
      Promise.resolve({ kind: "test-set" as const, key, issueId: "5000", aborted: signal?.aborted })
    );
    const add = vi.fn((_kind, _issueId, ids: readonly string[], signal?: AbortSignal) =>
      Promise.resolve({ addedTests: ids, aborted: signal?.aborted })
    );
    const adapter = trustedAdapter(
      rawAdapter({ resolveTestContainer: resolve, addTestsToContainer: add }),
      new WorkspaceTrust(() => true)
    );

    await expect(adapter.testAuthoring!.resolveTestContainer!("test-set", "T-1")).resolves.toMatchObject({
      issueId: "5000",
      aborted: false,
    });
    await expect(adapter.testAuthoring!.addTestsToContainer!("test-set", "5000", ["1"])).resolves.toMatchObject({
      addedTests: ["1"],
      aborted: false,
    });
    expect(resolve.mock.calls[0]?.[2]).toBeInstanceOf(AbortSignal);
    expect(add.mock.calls[0]?.[3]).toBeInstanceOf(AbortSignal);
  });

  it("accepts a missing target and a readable optional added count", async () => {
    const adapter = validatedAdapter(
      rawAdapter({
        resolveTestContainer: () => Promise.resolve(undefined),
        addTestsToContainer: () => Promise.resolve({ addedTests: [], warning: "already present" }),
      }),
      () => Promise.resolve(),
      () => undefined
    );

    await expect(adapter.testAuthoring!.resolveTestContainer!("test-plan", "T-2")).resolves.toBeUndefined();
    await expect(adapter.testAuthoring!.addTestsToContainer!("test-plan", "6000", ["1"])).resolves.toEqual({
      addedTests: [],
      warning: "already present",
    });
  });

  it("rejects malformed target and add responses at the validated boundary", async () => {
    const adapter = validatedAdapter(
      rawAdapter({
        resolveTestContainer: () => Promise.resolve({ kind: "test-set", key: "T-1" } as never),
        addTestsToContainer: () => Promise.resolve({ addedTests: [1] } as never),
      }),
      () => Promise.resolve(),
      () => undefined
    );

    await expect(adapter.testAuthoring!.resolveTestContainer!("test-set", "T-1")).rejects.toMatchObject({
      code: "malformed-response",
    });
    await expect(adapter.testAuthoring!.addTestsToContainer!("test-set", "5000", ["1"])).rejects.toMatchObject({
      code: "malformed-response",
    });
  });
});
