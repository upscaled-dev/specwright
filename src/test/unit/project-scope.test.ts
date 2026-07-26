import { describe, it, expect, vi } from "vitest";
import type * as vscode from "vscode";
import { normalizeProjectKeys, projectScopeStore, resolveProjectUniverse } from "../../traceability/project-scope";

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
  it("lists the provider directory on the jira tier, still unioned with the workspace's own keys", () => {
    const universe = resolveProjectUniverse({
      directoryProjects: ["ops", "PAY"],
      tagDerivedKeys: ["CALC"],
      syncSettingKeys: ["shop"],
      catalogueKeys: ["MATH"],
      defaultKey: " pay ",
    });

    expect(universe.tier).toBe("jira");
    expect(universe.projects).toEqual(["CALC", "MATH", "OPS", "PAY", "SHOP"]);
  });

  it("falls back to the xray-only tier when there is no directory to enumerate", () => {
    const universe = resolveProjectUniverse({
      tagDerivedKeys: ["calc"],
      syncSettingKeys: ["SHOP"],
      defaultKey: "pay",
    });

    expect(universe.tier).toBe("xray-only");
    expect(universe.projects).toEqual(["CALC", "PAY", "SHOP"]);
  });

  // A token that legitimately reaches nothing is still the jira tier, so the surface can say so instead
  // of sending the user to the sync setting.
  it("stays on the jira tier when the directory enumerated zero projects", () => {
    expect(resolveProjectUniverse({ directoryProjects: [] })).toEqual({ projects: [], tier: "jira" });
  });

  it("keeps requirement-derived keys, so a workspace that tags only requirements is never empty", () => {
    expect(resolveProjectUniverse({ tagDerivedKeys: ["REQ", "REQ", "calc"] })).toEqual({
      projects: ["CALC", "REQ"],
      tier: "xray-only",
    });
  });

  it("offers the setting and the default key with no tags at all", () => {
    expect(resolveProjectUniverse({ syncSettingKeys: ["shop"], defaultKey: "pay" }).projects).toEqual(["PAY", "SHOP"]);
  });

  it("returns nothing when every source is empty", () => {
    expect(resolveProjectUniverse({ tagDerivedKeys: [], syncSettingKeys: [], defaultKey: "   " })).toEqual({
      projects: [],
      tier: "xray-only",
    });
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
