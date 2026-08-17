import { describe, expect, it, vi } from "vitest";
import { BoardOperationState } from "../../traceability/board-operation-state";

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

describe("BoardOperationState", () => {
  it("keeps mutation activity owned until the final overlapping token settles", async () => {
    const state = new BoardOperationState();
    const changed = vi.fn();
    state.onDidChange(changed);
    const first = deferred<void>();
    const second = deferred<void>();

    const a = state.mutation(() => first.promise);
    const b = state.mutation(() => second.promise);
    expect(state.mutationActive).toBe(true);

    first.resolve();
    await a;
    expect(state.mutationActive).toBe(true);

    second.resolve();
    await b;
    expect(state.mutationActive).toBe(false);
    expect(changed).toHaveBeenCalledTimes(4);
  });

  it("retires failed and cancelled work without confusing sync activity", async () => {
    const state = new BoardOperationState();
    const sync = deferred<void>();
    const syncRun = state.sync(() => sync.promise);

    await expect(state.mutation(() => Promise.reject(new Error("cancelled")))).rejects.toThrow("cancelled");
    expect(state.mutationActive).toBe(false);
    expect(state.syncActive).toBe(true);

    sync.resolve();
    await syncRun;
    expect(state.syncActive).toBe(false);
  });
});
