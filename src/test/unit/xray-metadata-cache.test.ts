import { describe, it, expect } from "vitest";
import type * as vscode from "vscode";
import {
  CachedMetadata,
  CACHE_SCHEMA_VERSION,
  metadataCacheStorageKey,
  XrayCacheIdentity,
  XrayMetadataCache,
} from "../../xray/xray-metadata-cache";

function fakeMemento(): { memento: vscode.Memento; store: Map<string, unknown> } {
  const store = new Map<string, unknown>();
  const memento = {
    get: <T>(key: string, dflt?: T): T | undefined => (store.has(key) ? (store.get(key) as T) : dflt),
    update: (key: string, value: unknown): Promise<void> => {
      if (value === undefined) {
        store.delete(key);
      } else {
        store.set(key, value);
      }
      return Promise.resolve();
    },
    keys: (): readonly string[] => [...store.keys()],
  } as unknown as vscode.Memento;
  return { memento, store };
}

function identity(account: string | undefined): XrayCacheIdentity {
  return {
    endpoint: "xray.cloud.getxray.app",
    account: () => Promise.resolve(account),
    workspaceId: "ws-hash",
  };
}

function sample(): CachedMetadata {
  return {
    schemaVersion: CACHE_SCHEMA_VERSION,
    syncedAt: 1234,
    completeness: "complete",
    fetchedScopes: ["CALC"],
    catalogueProjects: ["CALC"],
    verifiedAbsentKeys: ["CALC-404"],
    errors: [],
    tests: [{ key: "CALC-1", summary: "one" }],
    pages: [{ fetchedAt: 1, query: "project = CALC", start: 0, total: 1 }],
  };
}

describe("metadataCacheStorageKey", () => {
  it("emits the §7 identity format with schema version last", () => {
    expect(
      metadataCacheStorageKey({ endpoint: "eu.xray.cloud.getxray.app", account: "client-42", workspaceId: "wsh" })
    ).toBe(`traceability:xray:eu.xray.cloud.getxray.app:client-42:wsh:${CACHE_SCHEMA_VERSION}`);
  });

  it("is at schema version 3: the bump that orphans v2 entries stored before issueId was added", () => {
    expect(CACHE_SCHEMA_VERSION).toBe(3);
  });
});

describe("XrayMetadataCache", () => {
  it("round-trips a snapshot under the account-scoped key", async () => {
    const { memento, store } = fakeMemento();
    const cache = new XrayMetadataCache(memento, identity("client-a"));

    await cache.save(sample());

    const key = metadataCacheStorageKey({
      endpoint: "xray.cloud.getxray.app",
      account: "client-a",
      workspaceId: "ws-hash",
    });
    expect(store.has(key)).toBe(true);
    const loaded = await cache.load();
    expect(loaded?.tests[0]?.key).toBe("CALC-1");
    expect(loaded?.catalogueProjects).toEqual(["CALC"]);
    expect(loaded?.verifiedAbsentKeys).toEqual(["CALC-404"]);
  });

  it("never surfaces another account's cache when credentials switch", async () => {
    const { memento } = fakeMemento();
    await new XrayMetadataCache(memento, identity("client-a")).save(sample());

    const other = new XrayMetadataCache(memento, identity("client-b"));
    expect(await other.load()).toBeUndefined();
  });

  it("loads last-known state from a fresh instance (offline activation)", async () => {
    const { memento } = fakeMemento();
    await new XrayMetadataCache(memento, identity("client-a")).save(sample());

    const reloaded = await new XrayMetadataCache(memento, identity("client-a")).load();
    expect(reloaded?.completeness).toBe("complete");
    expect(reloaded?.tests[0]?.summary).toBe("one");
  });

  it("ignores an entry whose schema version does not match", async () => {
    const { memento, store } = fakeMemento();
    const key = metadataCacheStorageKey({
      endpoint: "xray.cloud.getxray.app",
      account: "client-a",
      workspaceId: "ws-hash",
    });
    store.set(key, { ...sample(), schemaVersion: CACHE_SCHEMA_VERSION + 99 });

    expect(await new XrayMetadataCache(memento, identity("client-a")).load()).toBeUndefined();
  });

  it("does not read a pre-catalogueProjects entry stored under the previous schema version's key", async () => {
    const { memento, store } = fakeMemento();
    // Schema version is the last key segment, so an entry written under the old version lives in a
    // different slot: key-segment isolation hides it even before the inner version guard runs.
    const oldKey = `traceability:xray:xray.cloud.getxray.app:client-a:ws-hash:${CACHE_SCHEMA_VERSION - 1}`;
    store.set(oldKey, { ...sample(), schemaVersion: CACHE_SCHEMA_VERSION - 1 });
    const currentKey = metadataCacheStorageKey({
      endpoint: "xray.cloud.getxray.app",
      account: "client-a",
      workspaceId: "ws-hash",
    });

    expect(await new XrayMetadataCache(memento, identity("client-a")).load()).toBeUndefined();
    expect(store.has(oldKey)).toBe(true);
    expect(store.has(currentKey)).toBe(false);
  });

  it("is a no-op when there is no account to key on", async () => {
    const { memento, store } = fakeMemento();
    const cache = new XrayMetadataCache(memento, identity(undefined));

    await cache.save(sample());
    expect(store.size).toBe(0);
    expect(await cache.load()).toBeUndefined();
  });
});
