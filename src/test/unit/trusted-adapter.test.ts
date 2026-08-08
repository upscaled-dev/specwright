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
