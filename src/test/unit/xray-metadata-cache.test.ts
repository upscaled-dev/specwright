import { describe, it, expect } from "vitest";
import type * as vscode from "vscode";
import {
  CachedMetadata,
  cacheStorageKey,
  CACHE_SCHEMA_VERSION,
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
    fetchedScopes: ["CALC"],
    catalogueProjects: ["CALC"],
    completeProjects: ["CALC"],
    verifiedAbsentKeys: ["CALC-404"],
    errors: [],
    tests: [{ key: "CALC-1", summary: "one" }],
    pages: [{ fetchedAt: 1, query: 'project = "CALC"', start: 0, total: 1 }],
  };
}

describe("cacheStorageKey", () => {
  // Byte-exact, both namespaces: these are the slots existing installs already store under, so the
  // literals stay spelled out rather than rebuilt from the constants they must agree with.
  it("emits the §7 identity format per namespace with the schema version last", () => {
    const site: XrayCacheIdentity = {
      endpoint: "eu.xray.cloud.getxray.app",
      account: () => Promise.resolve("client-42"),
      workspaceId: "wsh",
    };

    expect(cacheStorageKey(site, "xray", 5, "client-42"))
      .toBe("traceability:xray:eu.xray.cloud.getxray.app:client-42:wsh:5");
    expect(cacheStorageKey(site, "xray-organization", 1, "client-42"))
      .toBe("traceability:xray-organization:eu.xray.cloud.getxray.app:client-42:wsh:1");
  });

  it("has no key at all without an account", () => {
    expect(cacheStorageKey(identity(undefined), "xray", CACHE_SCHEMA_VERSION, undefined)).toBeUndefined();
  });

  it("is at schema version 5: the bump that adds repository folder placement", () => {
    expect(CACHE_SCHEMA_VERSION).toBe(5);
  });
});

describe("XrayMetadataCache", () => {
  it("round-trips a snapshot under the account-scoped key", async () => {
    const { memento, store } = fakeMemento();
    const cache = new XrayMetadataCache(memento, identity("client-a"));

    await cache.save(sample());

    expect(store.has(`traceability:xray:xray.cloud.getxray.app:client-a:ws-hash:${CACHE_SCHEMA_VERSION}`)).toBe(true);
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
    expect(reloaded?.completeProjects).toEqual(["CALC"]);
    expect(reloaded?.tests[0]?.summary).toBe("one");
  });

  it("ignores an entry whose schema version does not match", async () => {
    const { memento, store } = fakeMemento();
    const key = `traceability:xray:xray.cloud.getxray.app:client-a:ws-hash:${CACHE_SCHEMA_VERSION}`;
    store.set(key, { ...sample(), schemaVersion: CACHE_SCHEMA_VERSION + 99 });

    expect(await new XrayMetadataCache(memento, identity("client-a")).load()).toBeUndefined();
  });

  it("does not read a pre-catalogueProjects entry stored under the previous schema version's key", async () => {
    const { memento, store } = fakeMemento();
    // Schema version is the last key segment, so an entry written under the old version lives in a
    // different slot: key-segment isolation hides it even before the inner version guard runs.
    const oldKey = `traceability:xray:xray.cloud.getxray.app:client-a:ws-hash:${CACHE_SCHEMA_VERSION - 1}`;
    store.set(oldKey, { ...sample(), schemaVersion: CACHE_SCHEMA_VERSION - 1 });
    const currentKey = `traceability:xray:xray.cloud.getxray.app:client-a:ws-hash:${CACHE_SCHEMA_VERSION}`;

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
