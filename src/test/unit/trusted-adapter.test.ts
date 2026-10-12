import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { WorkspaceTrust, WorkspaceTrustRequiredError } from "../../core/workspace-trust";
import { trustedAdapter } from "../../traceability/trusted-adapter";
import type { TraceabilityAdapter } from "../../traceability/contracts";

function adapterWithCreate(createTest: NonNullable<TraceabilityAdapter["testAuthoring"]>["createTest"]): TraceabilityAdapter {
  return {
    id: "test",
    label: "Test",
    keyGrammar: {
      testPrefix: "TEST_",
      reqPrefix: "REQ_",
      keyShape: /^T-\d+$/,
      canonicalizeKey: (key) => key,
    },
    browseUrl: () => undefined,
    connection: {
      onDidChange: new vscode.EventEmitter<void>().event,
      label: "site",
      isConnected: async () => true,
    },
    testAuthoring: { createTest },
  };
}

describe("trustedAdapter", () => {
  it("retains passive shapes but starts no remote work when untrusted", async () => {
    const createTest = vi.fn().mockResolvedValue({ warnings: [] });
    const adapter = trustedAdapter(adapterWithCreate(createTest), new WorkspaceTrust(() => false));
    expect(adapter.keyGrammar.testPrefix).toBe("TEST_");
    await expect(adapter.connection!.isConnected()).resolves.toBe(false);
    await expect(adapter.testAuthoring!.createTest({ project: "T", summary: "s", gherkin: "g" }))
      .rejects.toBeInstanceOf(WorkspaceTrustRequiredError);
    expect(createTest).not.toHaveBeenCalled();
  });

  it("aborts an in-flight remote mutation when trust ownership is disposed", async () => {
    const trust = new WorkspaceTrust(() => true);
    const createTest = vi.fn((_spec, signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(new Error("outcome-unknown")), { once: true });
    }));
    const adapter = trustedAdapter(adapterWithCreate(createTest), trust);
    const creating = adapter.testAuthoring!.createTest({ project: "T", summary: "s", gherkin: "g" });
    trust.dispose();
    await expect(creating).rejects.toThrow("outcome-unknown");
    expect(createTest).toHaveBeenCalledOnce();
  });

  it("passes a trust-owned signal to connection verification", async () => {
    const trust = new WorkspaceTrust(() => true);
    const verify = vi.fn((signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const raw = adapterWithCreate(vi.fn());
    const adapter = trustedAdapter({
      ...raw,
      connection: { ...raw.connection!, verify },
    }, trust);

    const pending = adapter.connection!.verify!();
    await vi.waitFor(() => expect(verify).toHaveBeenCalledOnce());
    const disposal = trust.dispose();

    await expect(pending).rejects.toThrow("Workspace trust was revoked");
    await disposal;
  });

  it("owns cached project refresh and starts none after trust disposal", async () => {
    const trust = new WorkspaceTrust(() => true);
    const list = vi.fn((signal?: AbortSignal) => new Promise<never>((_resolve, reject) => {
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
    }));
    const raw = adapterWithCreate(vi.fn());
    const adapter = trustedAdapter({
      ...raw,
      projectDirectory: {
        cached: () => ({ projects: [], truncated: false }),
        list,
      },
    }, trust);

    expect(adapter.projectDirectory!.cached()).toEqual({ projects: [], truncated: false });
    await vi.waitFor(() => expect(list).toHaveBeenCalledOnce());
    await trust.dispose();
    adapter.projectDirectory!.cached();

    expect(list).toHaveBeenCalledOnce();
  });
});

describe("trusted adapter capability forwarding", () => {
  it.each([true, false])("admits every remote capability only while trusted (%s)", async available => {
    const trust = new WorkspaceTrust(() => available);
    const event = new vscode.EventEmitter<void>();
    const read = () => vi.fn().mockResolvedValue(undefined);
    const remote = {
      sync: read(), coverage: read(), bind: read(), search: read(), merge: read(), list: read(),
      organizationSync: read(), refresh: read(), create: read(), createSet: read(), createPlan: read(),
      resolve: read(), add: read(), createExecution: read(), push: read(), targets: read(), attach: read(),
    };
    const raw: TraceabilityAdapter = {
      ...adapterWithCreate(remote.create),
      metadata: { onDidChange: event.event, snapshot: () => ({ tests: new Map(), stale: false, completeProjects: [], fetchedScopes: [], catalogueProjects: [], verifiedAbsentKeys: [], errors: [] }), sync: remote.sync },
      coverage: { coverageFor: remote.coverage },
      automationBinding: { classify: () => "unknown", bind: remote.bind },
      remoteSearch: { search: remote.search, mergeKeys: remote.merge },
      projectDirectory: { cached: () => ({ projects: [], truncated: false }), list: remote.list },
      organization: { onDidChange: event.event, snapshot: () => ({ repositories: [], testSetProjects: [], stale: false,
        omittedRepositoryProjectCount: 0, omittedTestSetProjectCount: 0 }), sync: remote.organizationSync, refreshTestSet: remote.refresh },
      testAuthoring: { createTest: remote.create, createTestSet: remote.createSet, createTestPlan: remote.createPlan,
        resolveTestContainer: remote.resolve, addTestsToContainer: remote.add, createTestExecution: remote.createExecution, pushGherkin: remote.push },
      resultPublishing: { searchTargets: remote.targets, publish: vi.fn() },
      attachments: { attach: remote.attach },
    };
    const adapter = trustedAdapter(raw, trust);
    const caller = new AbortController();
    const test = { project: "T", summary: "Checkout", gherkin: "Scenario: Checkout" };
    const container = { project: "T", summary: "Smoke", testIssueIds: ["123"] };
    const ref = { kind: "testCase" as const, key: "T-1" };
    const progress = vi.fn();
    const calls = [
      () => adapter.metadata!.sync({ projectKeys: ["T"] }, caller.signal, progress),
      () => adapter.coverage!.coverageFor(ref, caller.signal),
      () => adapter.automationBinding!.bind(ref, caller.signal),
      () => adapter.remoteSearch!.search("checkout", caller.signal),
      () => adapter.remoteSearch!.mergeKeys(["T-1"], caller.signal),
      () => adapter.projectDirectory!.list(caller.signal),
      () => adapter.organization!.sync(["T"], caller.signal),
      () => adapter.organization!.refreshTestSet("T-10", caller.signal),
      () => adapter.testAuthoring!.createTest(test, caller.signal),
      () => adapter.testAuthoring!.createTestSet!(container, caller.signal),
      () => adapter.testAuthoring!.createTestPlan!(container, caller.signal),
      () => adapter.testAuthoring!.resolveTestContainer!("test-set", "T-10", caller.signal),
      () => adapter.testAuthoring!.addTestsToContainer!("test-plan", "456", ["123"], caller.signal),
      () => adapter.testAuthoring!.createTestExecution!({ project: "T", summary: "Run" }, caller.signal),
      () => adapter.testAuthoring!.pushGherkin!("123", "Scenario: Changed", caller.signal),
      () => adapter.resultPublishing!.searchTargets("execution", "Run", caller.signal),
      () => adapter.attachments!.attach({ kind: "execution", key: "T-20" }, ["/tmp/evidence.json"], caller.signal),
    ];
    try {
      for (const call of calls) {
        if (available) { await call(); }
        else { await expect(call()).rejects.toBeInstanceOf(WorkspaceTrustRequiredError); }
      }
      for (const method of Object.values(remote)) {
        expect(method).toHaveBeenCalledTimes(available ? 1 : 0);
        if (available) {
          const signal = method.mock.calls[0]!.find(arg => arg instanceof AbortSignal);
          expect(signal).toBeInstanceOf(AbortSignal);
          expect(signal).not.toBe(caller.signal);
          expect(signal?.aborted).toBe(false);
        }
      }
      if (available) {
        expect(remote.sync).toHaveBeenCalledWith({ projectKeys: ["T"] }, expect.any(AbortSignal), progress);
        expect(remote.add).toHaveBeenCalledWith("test-plan", "456", ["123"], expect.any(AbortSignal));
        expect(remote.attach).toHaveBeenCalledWith({ kind: "execution", key: "T-20" }, ["/tmp/evidence.json"], expect.any(AbortSignal));
      }
      expect(adapter.metadata!.snapshot()).toEqual(raw.metadata!.snapshot());
      expect(adapter.organization!.snapshot()).toEqual(raw.organization!.snapshot());
      expect(adapter.automationBinding!.classify(undefined)).toBe("unknown");
      expect(adapter.connection!.label).toBe("site");
    } finally { await trust.dispose(); event.dispose(); }
  });
});
