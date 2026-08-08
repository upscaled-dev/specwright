import { describe, expect, it, vi } from "vitest";
import type { AdmissionRecord, AdmissionStore } from "../../core/execution-admission";
import {
  executionStateKey,
  executionStorageRoot,
  ExecutionNamespaceMigration,
  CompatibleAdmissionStore,
  NamespacedStateStore,
  type StateStore,
} from "../../core/execution-namespace";
import type { ExecutionIdentity } from "../../core/run-contracts";

const legacy: ExecutionIdentity = { engine: "legacy-direct", schemaProfile: "legacy-v1" };
const core: ExecutionIdentity = { engine: "core-client", schemaProfile: "client-v1" };

class MemoryState implements StateStore {
  public readonly values = new Map<string, unknown>();
  public keys(): readonly string[] {return [...this.values.keys()];}
  public get<T>(key: string): T | undefined;
  public get<T>(key: string, defaultValue: T): T;
  public get<T>(key: string, defaultValue?: T): T | undefined {
    return (this.values.has(key) ? this.values.get(key) : defaultValue) as T | undefined;
  }
  public update(key: string, value: unknown): PromiseLike<void> {
    this.values.set(key, value);
    return Promise.resolve();
  }
}

class MemoryAdmission implements AdmissionStore {
  public readonly records = new Map<string, unknown>();
  public readonly writes = vi.fn();
  public readAll(): Promise<readonly AdmissionRecord[]> {
    return Promise.resolve([...this.records].map(([id, value]) => ({ id, value })));
  }
  public write(record: AdmissionRecord): Promise<void> {
    this.writes(record);
    this.records.set(record.id, record.value);
    return Promise.resolve();
  }
  public remove(id: string): Promise<void> {
    this.records.delete(id);
    return Promise.resolve();
  }
}

describe("execution namespaces", () => {
  it("isolates state keys and filesystem roots by engine and schema profile", async () => {
    const state = new MemoryState();
    const legacyState = new NamespacedStateStore(state, legacy);
    const coreState = new NamespacedStateStore(state, core);
    await legacyState.update("artifacts", ["legacy"]);

    expect(legacyState.get("artifacts")).toEqual(["legacy"]);
    expect(coreState.get("artifacts")).toBeUndefined();
    expect(executionStorageRoot("/storage", legacy)).not.toBe(executionStorageRoot("/storage", core));
  });

  it("copies an old artifact key exactly once and never exposes it to Core", async () => {
    const state = new MemoryState();
    state.values.set("specwright.runArtifacts", ["old"]);
    const migration = new ExecutionNamespaceMigration(state, legacy);

    await migration.stateKeys(["specwright.runArtifacts"]);
    state.values.set("specwright.runArtifacts", ["changed"]);
    await migration.stateKeys(["specwright.runArtifacts"]);

    expect(state.get(executionStateKey(legacy, "specwright.runArtifacts"))).toEqual(["old"]);
    expect(new NamespacedStateStore(state, core).get("specwright.runArtifacts")).toBeUndefined();
  });

  it("keeps old and new admission stores mutually visible during rollback", async () => {
    const primary = new MemoryAdmission();
    const old = new MemoryAdmission();
    old.records.set("old-lease", { kind: "debug-session", failure: "unknown" });
    const store = new CompatibleAdmissionStore(primary, old);

    await expect(store.readAll()).resolves.toEqual([
      { id: "old-lease", value: { kind: "debug-session", failure: "unknown" } },
    ]);
    old.records.set("late-legacy-lease", { kind: "debug-session", failure: "late" });
    expect((await store.readAll()).map(({ id }) => id)).toEqual([
      "old-lease",
      "late-legacy-lease",
    ]);
    await store.write({ id: "new-lease", value: { kind: "debug-session", failure: "new" } });

    expect(primary.records.has("new-lease")).toBe(true);
    expect(old.records.has("new-lease")).toBe(true);
    expect(primary.writes).toHaveBeenCalledOnce();
    await store.remove("new-lease");
    expect(primary.records.has("new-lease")).toBe(false);
    expect(old.records.has("new-lease")).toBe(false);
  });

  it("fails closed when either compatibility store cannot persist", async () => {
    const primary = new MemoryAdmission();
    const old = new MemoryAdmission();
    old.write = vi.fn(() => Promise.reject(new Error("legacy unavailable")));
    const store = new CompatibleAdmissionStore(primary, old);

    await expect(store.write({ id: "lease", value: {} })).rejects.toThrow("legacy unavailable");
    expect(primary.records.has("lease")).toBe(false);

    const availableOld = new MemoryAdmission();
    const unavailablePrimary = new MemoryAdmission();
    unavailablePrimary.write = vi.fn(() => Promise.reject(new Error("namespaced unavailable")));
    const rollbackSafe = new CompatibleAdmissionStore(unavailablePrimary, availableOld);

    await expect(rollbackSafe.write({ id: "visible-to-old", value: {} }))
      .rejects.toThrow("namespaced unavailable");
    expect(availableOld.records.has("visible-to-old")).toBe(true);
    await expect(rollbackSafe.readAll()).resolves.toEqual([{ id: "visible-to-old", value: {} }]);
  });
});
