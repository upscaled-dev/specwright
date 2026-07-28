import { describe, it, expect, vi } from "vitest";
import type * as vscode from "vscode";
import {
  normalizeProjectKeys,
  projectScopeStore,
  resolveProjectUniverse,
  resolveSyncProjectKeys,
} from "../../traceability/project-scope";

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

describe("normalizeProjectKeys", () => {
  it("uppercases, trims, drops empties, dedupes and sorts", () => {
    expect(normalizeProjectKeys(["calc", " shop ", "SHOP", "", "  "])).toEqual(["CALC", "SHOP"]);
  });
});

describe("resolveProjectUniverse", () => {
  it("lists the provider directory, still unioned with the workspace's own keys", () => {
    expect(
      resolveProjectUniverse({
        directoryProjects: ["ops", "PAY"],
        tagDerivedKeys: ["CALC"],
        syncSettingKeys: ["shop"],
        catalogueKeys: ["MATH"],
        defaultKey: " pay ",
      })
    ).toEqual(["CALC", "MATH", "OPS", "PAY", "SHOP"]);
  });

  it("falls back to the workspace's own keys when there is no directory to enumerate", () => {
    expect(
      resolveProjectUniverse({ tagDerivedKeys: ["calc"], syncSettingKeys: ["SHOP"], defaultKey: "pay" })
    ).toEqual(["CALC", "PAY", "SHOP"]);
  });

  it("keeps requirement-derived keys, so a workspace that tags only requirements is never empty", () => {
    expect(resolveProjectUniverse({ tagDerivedKeys: ["REQ", "REQ", "calc"] })).toEqual(["CALC", "REQ"]);
  });

  it("offers the setting and the default key with no tags at all", () => {
    expect(resolveProjectUniverse({ syncSettingKeys: ["shop"], defaultKey: "pay" })).toEqual(["PAY", "SHOP"]);
  });

  // The sync scope is this resolver minus the directory, so the board's selection is the rung that puts a
  // project nobody has tagged or configured into the next sync.
  it("takes the board's selection as a rung of its own, deduped and uppercased with the rest", () => {
    expect(resolveProjectUniverse({ selectedKey: " pay " })).toEqual(["PAY"]);
    expect(resolveProjectUniverse({ tagDerivedKeys: ["PAY"], selectedKey: "pay" })).toEqual(["PAY"]);
    expect(resolveProjectUniverse({ selectedKey: "  " })).toEqual([]);
  });

  it("returns nothing when every source is empty", () => {
    expect(resolveProjectUniverse({ tagDerivedKeys: [], syncSettingKeys: [], defaultKey: "   " })).toEqual([]);
  });
});

describe("resolveSyncProjectKeys", () => {
  // Same ladder, one rung short: a sync fetches a whole catalogue per project, so the directory can
  // never reach it, however the caller assembled the sources.
  it("drops the provider directory and keeps every other rung", () => {
    expect(
      resolveSyncProjectKeys({
        directoryProjects: ["ops"],
        tagDerivedKeys: ["CALC"],
        syncSettingKeys: ["shop"],
        catalogueKeys: ["MATH"],
        defaultKey: "pay",
        selectedKey: "calc",
      })
    ).toEqual(["CALC", "MATH", "PAY", "SHOP"]);
  });

  it("returns nothing when the workspace names no project at all", () => {
    expect(resolveSyncProjectKeys({ directoryProjects: ["OPS", "PAY"] })).toEqual([]);
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
