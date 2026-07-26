import { describe, it, expect, vi } from "vitest";
import type * as vscode from "vscode";
import { knownProjectKeys, projectScopeStore } from "../../traceability/project-scope";

const KEY = "playwrightBddRunner.board.projectScope";

// A workspaceState stand-in: the same read-your-write behaviour the real memento has, plus a hook for
// the rejected update the store routes to its error callback.
function memento(seed: Record<string, unknown> = {}): vscode.Memento & { values: Record<string, unknown> } {
  const store = {
    values: { ...seed },
    get: <T>(key: string): T | undefined => store.values[key] as T | undefined,
    update: (key: string, value: unknown): Promise<void> => {
      store.values[key] = value;
      return Promise.resolve();
    },
    keys: () => Object.keys(store.values),
  };
  return store as unknown as vscode.Memento & { values: Record<string, unknown> };
}

describe("knownProjectKeys", () => {
  it("unions the three sources, uppercases, trims, drops empties, dedupes and sorts", () => {
    expect(knownProjectKeys(["calc", " shop "], ["SHOP", "math"], " pay ")).toEqual(["CALC", "MATH", "PAY", "SHOP"]);
  });

  it("normalizes a single list when the other sources are absent", () => {
    expect(knownProjectKeys(["SHOP", "CALC", "CALC", "", "PAY"])).toEqual(["CALC", "PAY", "SHOP"]);
  });

  it("returns nothing when every source is empty", () => {
    expect(knownProjectKeys([], [], "   ")).toEqual([]);
  });
});

describe("projectScopeStore", () => {
  const noop = (): void => undefined;

  it("reads All Projects when nothing has been selected", () => {
    expect(projectScopeStore(memento(), noop).get(["CALC"])).toBeUndefined();
  });

  it("round-trips a selection through the memento", () => {
    const state = memento();
    const store = projectScopeStore(state, noop);

    store.set("CALC");

    expect(state.values[KEY]).toBe("CALC");
    expect(store.get(["CALC", "PAY"])).toBe("CALC");
  });

  it("clears the selection back to All Projects", () => {
    const state = memento({ [KEY]: "CALC" });
    const store = projectScopeStore(state, noop);

    store.set(undefined);

    expect(store.get(["CALC"])).toBeUndefined();
  });

  it("reads a key that has left the known set as All Projects without erasing it, so re-adding restores it", () => {
    const state = memento({ [KEY]: "PAY" });
    const store = projectScopeStore(state, noop);

    expect(store.get(["CALC"])).toBeUndefined();
    expect(state.values[KEY]).toBe("PAY");
    expect(store.get(["CALC", "PAY"])).toBe("PAY");
  });

  it("reports a failed write instead of throwing at the caller", async () => {
    const state = memento();
    const failure = new Error("state is read-only");
    vi.spyOn(state, "update").mockReturnValue(Promise.reject(failure));
    const onError = vi.fn();

    projectScopeStore(state, onError).set("CALC");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(onError).toHaveBeenCalledWith(failure);
  });
});
