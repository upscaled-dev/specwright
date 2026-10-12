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
  it("validates authored containers, executions, and pushed Gherkin before callers use them", async () => {
    const adapter = validatedAdapter(rawAdapter({
      createTestSet: () => Promise.resolve({ key: "T-4", issueId: "4004", warnings: [] }),
      createTestPlan: () => Promise.resolve({ key: "T-5", issueId: "4005", warnings: ["One remote warning"] }),
      createTestExecution: () => Promise.resolve({ key: "T-6", issueId: "4006", warnings: [] }),
      pushGherkin: () => Promise.resolve("Feature: Checkout\nScenario: pay\n  Given a cart\n"),
    }), () => Promise.resolve(), () => undefined);
    const container = { project: "T", summary: "Checkout", testIssueIds: ["4001", "4002"] };

    await expect(adapter.testAuthoring!.createTestSet!(container)).resolves.toMatchObject({ key: "T-4", issueId: "4004" });
    await expect(adapter.testAuthoring!.createTestPlan!(container)).resolves.toMatchObject({ key: "T-5", warnings: ["One remote warning"] });
    await expect(adapter.testAuthoring!.createTestExecution!({ project: "T", summary: "Nightly" })).resolves.toMatchObject({ key: "T-6" });
    await expect(adapter.testAuthoring!.pushGherkin!("4001", "Feature: Checkout")).resolves.toContain("Scenario: pay");
  });

  it("rejects malformed optional authoring results before treating the write as confirmed", async () => {
    const adapter = validatedAdapter(rawAdapter({
      createTestSet: () => Promise.resolve({ key: "T-4", warnings: [1] } as never),
      createTestPlan: () => Promise.resolve({ key: "T-5" } as never),
      createTestExecution: () => Promise.resolve({ warnings: ["ok"], issueId: 4006 } as never),
      pushGherkin: () => Promise.resolve(42 as never),
    }), () => Promise.resolve(), () => undefined);
    const container = { project: "T", summary: "Checkout", testIssueIds: ["4001"] };

    await expect(adapter.testAuthoring!.createTestSet!(container)).rejects.toMatchObject({ code: "malformed-response" });
    await expect(adapter.testAuthoring!.createTestPlan!(container)).rejects.toMatchObject({ code: "malformed-response" });
    await expect(adapter.testAuthoring!.createTestExecution!({ project: "T", summary: "Nightly" })).rejects.toMatchObject({ code: "malformed-response" });
    await expect(adapter.testAuthoring!.pushGherkin!("4001", "Feature: Checkout")).rejects.toMatchObject({ code: "malformed-response" });
  });
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
