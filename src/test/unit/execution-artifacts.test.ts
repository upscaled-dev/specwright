import { describe, expect, it } from "vitest";
import type { Memento } from "vscode";
import {
  CORE_SCHEMA_PROFILE,
  ExecutionSelectionOwner,
  LEGACY_SCHEMA_PROFILE,
} from "../../core/execution-engine";
import { RunArtifactStore } from "../../traceability/run-artifact-store";
import { SelectedArtifactCatalog } from "../../ui/execution-artifacts";
import { Logger } from "../../utils/logger";

function memento(): Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: (key: string, fallback?: unknown) => values.get(key) ?? fallback,
    update: (key: string, value: unknown) => {
      values.set(key, value);
      return Promise.resolve();
    },
  } as Memento;
}

describe("SelectedArtifactCatalog", () => {
  it("never exposes or clears a legacy artifact under a Core selection", () => {
    let engine: "legacy-direct" | "core-client" = "legacy-direct";
    const selection = new ExecutionSelectionOwner({ userProfile: () => engine });
    const legacy = new RunArtifactStore(memento(), Logger.create());
    legacy.sealBatch(legacy.beginBatch({ kind: "suite" }), "complete");
    const catalog = new SelectedArtifactCatalog(selection, new Map([
      [`legacy-direct:${LEGACY_SCHEMA_PROFILE}`, legacy],
    ]));

    expect(catalog.list()).toHaveLength(1);
    engine = "core-client";
    expect(catalog.list()).toEqual([]);
    expect(catalog.latest()).toBeUndefined();
    expect(catalog.clear()).toBe(0);
    engine = "legacy-direct";
    expect(catalog.list()).toHaveLength(1);

    catalog.dispose();
  });

  it("requires an exact engine and schema-profile store match", () => {
    const selection = new ExecutionSelectionOwner({ administratorPolicy: () => "core-client" });
    const wrongProfile = new RunArtifactStore(memento(), Logger.create());
    wrongProfile.sealBatch(wrongProfile.beginBatch({ kind: "suite" }), "complete");
    const catalog = new SelectedArtifactCatalog(selection, new Map([
      [`core-client:${LEGACY_SCHEMA_PROFILE}`, wrongProfile],
    ]));

    expect(CORE_SCHEMA_PROFILE).not.toBe(LEGACY_SCHEMA_PROFILE);
    expect(catalog.latest()).toBeUndefined();

    catalog.dispose();
  });
});
