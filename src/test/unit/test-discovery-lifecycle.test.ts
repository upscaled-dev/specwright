import { describe, expect, it, vi } from "vitest";
import { TestDiscoveryLifecycle } from "../../test-providers/test-discovery-lifecycle";

describe("TestDiscoveryLifecycle", () => {
  it("coalesces concurrent admission and retains one later refresh", async () => {
    let releaseFirst!: () => void;
    const first = new Promise<void>((resolve) => {releaseFirst = resolve;});
    let calls = 0;
    const discover = vi.fn(async () => {
      calls += 1;
      if (calls === 1) {await first;}
      return true;
    });
    const lifecycle = new TestDiscoveryLifecycle(discover);

    const resolve = lifecycle.ensure();
    const run = lifecycle.ensure();
    await Promise.resolve();
    const refresh = lifecycle.refresh();
    expect(discover).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.all([resolve, run, refresh]);

    expect(discover).toHaveBeenCalledTimes(2);
    expect(lifecycle.hasCanonicalSnapshot).toBe(true);
  });

  it("retries an invalidated failed snapshot after trust is granted", async () => {
    const discover = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    const lifecycle = new TestDiscoveryLifecycle(discover);

    expect(await lifecycle.ensure()).toBe(false);
    expect(lifecycle.hasCanonicalSnapshot).toBe(false);
    expect(await lifecycle.retryAfterTrustGrant()).toBe(true);
    expect(lifecycle.hasCanonicalSnapshot).toBe(true);
  });

  it("publishes the in-flight promise before a synchronous reentrant refresh", async () => {
    const discover = vi.fn(async () => {
      if (discover.mock.calls.length === 1) {void lifecycle.refresh();}
      return true;
    });
    const lifecycle = new TestDiscoveryLifecycle(discover);

    await lifecycle.ensure();

    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("retains one queued refresh after a rejected discovery callback", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {release = resolve;});
    const discover = vi.fn(async () => {
      if (discover.mock.calls.length === 1) {
        await pending;
        throw new Error("transient");
      }
      return true;
    });
    const lifecycle = new TestDiscoveryLifecycle(discover);

    const first = lifecycle.ensure();
    await Promise.resolve();
    const refresh = lifecycle.refresh();
    release();

    await expect(Promise.all([first, refresh])).resolves.toEqual([true, true]);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("bounds a refresh burst to one follow-up pass", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {release = resolve;});
    const discover = vi.fn(async () => {
      if (discover.mock.calls.length === 1) {await pending;}
      return true;
    });
    const lifecycle = new TestDiscoveryLifecycle(discover);

    const first = lifecycle.ensure();
    await Promise.resolve();
    const burst = Array.from({ length: 20 }, () => lifecycle.refresh());
    release();

    await Promise.all([first, ...burst]);
    expect(discover).toHaveBeenCalledTimes(2);
  });

  it("queues a third canonical pass when another invalidation lands during the first follow-up", async () => {
    let releaseFirst!: () => void;
    let releaseSecond!: () => void;
    const first = new Promise<void>((resolve) => {releaseFirst = resolve;});
    const second = new Promise<void>((resolve) => {releaseSecond = resolve;});
    const commits: number[] = [];
    let calls = 0;
    const discover = async (): Promise<boolean> => {
      const ticket = lifecycle.beginCanonical();
      calls += 1;
      if (calls === 1) {await first;}
      if (calls === 2) {await second;}
      return lifecycle.commitCanonical(ticket, () => commits.push(calls));
    };
    const lifecycle = new TestDiscoveryLifecycle(discover);

    const pending = lifecycle.ensure();
    await Promise.resolve();
    void lifecycle.invalidate();
    releaseFirst();
    await vi.waitFor(() => expect(calls).toBe(2));
    void lifecycle.invalidate();
    releaseSecond();

    await expect(pending).resolves.toBe(true);
    expect(calls).toBe(3);
    expect(commits).toEqual([3]);
  });

  it("suppresses an in-flight canonical commit after disposal", async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {release = resolve;});
    const lifecycle = new TestDiscoveryLifecycle(async () => {
      await pending;
      return true;
    });

    const pendingEnsure = lifecycle.ensure();
    await Promise.resolve();
    lifecycle.dispose();
    release();

    await expect(pendingEnsure).resolves.toBe(false);
    expect(lifecycle.hasCanonicalSnapshot).toBe(false);
  });
});
