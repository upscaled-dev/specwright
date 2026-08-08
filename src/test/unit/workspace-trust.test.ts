import { describe, expect, it, vi } from "vitest";
import {
  WORKSPACE_TRUST_REQUIRED,
  WorkspaceTrust,
  WorkspaceTrustRequiredError,
} from "../../core/workspace-trust";

describe("WorkspaceTrust", () => {
  it("fails closed with one stable typed error", () => {
    const trust = new WorkspaceTrust(() => false);
    expect(() => trust.require()).toThrow(WorkspaceTrustRequiredError);
    try {
      trust.require();
    } catch (error) {
      expect(error).toMatchObject({ code: WORKSPACE_TRUST_REQUIRED });
    }
  });

  it("aborts every active privileged operation on disposal", async () => {
    const trust = new WorkspaceTrust(() => true);
    const sawAbort = vi.fn();
    const running = trust.run((signal) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => {
        sawAbort();
        resolve();
      }, { once: true });
    }));
    await trust.dispose();
    await running;
    expect(sawAbort).toHaveBeenCalledOnce();
    expect(() => trust.require()).toThrow(WorkspaceTrustRequiredError);
  });

  it("combines caller cancellation with trust-owned cancellation", () => {
    const trust = new WorkspaceTrust(() => true);
    const caller = new AbortController();
    const operation = trust.begin(caller.signal);
    caller.abort("stop");
    expect(operation.signal.aborted).toBe(true);
    operation.dispose();
  });

  it("does not invoke an operation when its caller signal is already aborted", async () => {
    const trust = new WorkspaceTrust(() => true);
    const caller = new AbortController();
    const operation = vi.fn(() => Promise.resolve());
    caller.abort(new Error("already cancelled"));

    await expect(trust.run(operation, caller.signal)).rejects.toThrow("already cancelled");
    expect(operation).not.toHaveBeenCalled();
  });

  it("waits for aborted operations to finish their cleanup", async () => {
    const trust = new WorkspaceTrust(() => true);
    let releaseCleanup: (() => void) | undefined;
    const cleanup = new Promise<void>((resolve) => {releaseCleanup = resolve;});
    const running = trust.run((signal) => new Promise<void>((resolve) => {
      signal.addEventListener("abort", () => {
        cleanup.then(resolve);
      }, { once: true });
    }));

    let drained = false;
    const disposal = trust.dispose().then(() => {drained = true;});
    await Promise.resolve();
    expect(drained).toBe(false);

    releaseCleanup?.();
    await Promise.all([running, disposal]);
    expect(drained).toBe(true);
  });
});
