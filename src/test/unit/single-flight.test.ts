import { describe, it, expect } from "vitest";
import { singleFlight } from "../../utils/single-flight";

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void; reject: (reason: unknown) => void } {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("singleFlight", () => {
  it("runs fn once for concurrent calls with the same key and shares the result", async () => {
    let calls = 0;
    const gate = deferred<string>();
    const wrapped = singleFlight(
      (id: string) => id,
      (_id: string) => { calls += 1; return gate.promise; }
    );

    const a = wrapped("k");
    const b = wrapped("k");
    const c = wrapped("k");
    gate.resolve("value");

    expect(await Promise.all([a, b, c])).toEqual(["value", "value", "value"]);
    expect(calls).toBe(1);
  });

  it("keys independently so different keys each run fn", async () => {
    let calls = 0;
    const wrapped = singleFlight(
      (id: string) => id,
      (id: string) => { calls += 1; return Promise.resolve(id); }
    );

    await Promise.all([wrapped("a"), wrapped("b"), wrapped("a")]);
    expect(calls).toBe(2);
  });

  it("drops the entry once settled so a later call re-runs fn", async () => {
    let calls = 0;
    const wrapped = singleFlight(
      (id: string) => id,
      (id: string) => { calls += 1; return Promise.resolve(id); }
    );

    await wrapped("k");
    await wrapped("k");
    expect(calls).toBe(2);
  });

  it("shares a rejection with every coincident caller and re-runs after it settles", async () => {
    let calls = 0;
    const wrapped = singleFlight(
      (id: string) => id,
      (_id: string) => { calls += 1; return Promise.reject(new Error(`boom ${calls}`)); }
    );

    const a = wrapped("k");
    const b = wrapped("k");
    await expect(a).rejects.toThrow("boom 1");
    await expect(b).rejects.toThrow("boom 1");
    expect(calls).toBe(1);

    // The failed entry cleared, so a later call runs fn again rather than replaying the first failure.
    await expect(wrapped("k")).rejects.toThrow("boom 2");
    expect(calls).toBe(2);
  });
});
