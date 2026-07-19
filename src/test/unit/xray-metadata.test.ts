import { describe, it, expect, vi } from "vitest";
import * as vscode from "vscode";
import { Logger, LogLevel } from "../../utils/logger";
import { ExtensionConfig } from "../../core/extension-config";
import { XrayFetchOutcome, XrayTestRecord, XrayClient } from "../../xray/xray-client";
import { CachedMetadata, CACHE_SCHEMA_VERSION, XrayMetadataCache } from "../../xray/xray-metadata-cache";
import { XrayMetadataCapability } from "../../xray/xray-metadata";
import { TestCaseMetadata } from "../../traceability/contracts";

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function fakeMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    get: <T>(key: string, dflt?: T): T | undefined => (store.has(key) ? (store.get(key) as T) : dflt),
    update: (key: string, value: unknown): Promise<void> => {
      store.set(key, value);
      return Promise.resolve();
    },
    keys: (): readonly string[] => [...store.keys()],
  } as unknown as vscode.Memento;
}

function cacheFor(memento: vscode.Memento, account = "account-a"): XrayMetadataCache {
  return new XrayMetadataCache(memento, {
    endpoint: "xray.cloud.getxray.app",
    account: () => Promise.resolve(account),
    workspaceId: "ws",
  });
}

function fakeConfig(ttlMinutes = 15): ExtensionConfig {
  return { get xrayCacheTtlMinutes(): number { return ttlMinutes; } } as unknown as ExtensionConfig;
}

function silentLogger(): Logger {
  return Logger.create(undefined, LogLevel.ERROR);
}

function outcome(tests: XrayTestRecord[], opts: { complete?: boolean; errors?: string[] } = {}): XrayFetchOutcome {
  return { tests, pages: [], complete: opts.complete ?? true, errors: opts.errors ?? [] };
}

interface FakeClient {
  fetchProjectCatalogue?: (projectKey: string, signal?: AbortSignal) => Promise<XrayFetchOutcome>;
  fetchTestsByKeys?: (keys: readonly string[], signal?: AbortSignal) => Promise<XrayFetchOutcome>;
  invalidateAuth?: () => void;
}

function fakeClient(impl: FakeClient): XrayClient {
  return {
    fetchProjectCatalogue: impl.fetchProjectCatalogue ?? (() => Promise.resolve(outcome([]))),
    fetchTestsByKeys: impl.fetchTestsByKeys ?? (() => Promise.resolve(outcome([]))),
    invalidateAuth: impl.invalidateAuth ?? (() => { /* no-op */ }),
  } as unknown as XrayClient;
}

interface CapabilityOptions {
  client: XrayClient;
  memento?: vscode.Memento;
  config?: ExtensionConfig;
  logger?: Logger;
  account?: () => Promise<string | undefined>;
  onCredentialsChange?: vscode.Event<void>;
  now?: () => number;
}

function makeCapability(options: CapabilityOptions): XrayMetadataCapability {
  return new XrayMetadataCapability({
    client: options.client,
    cache: cacheFor(options.memento ?? fakeMemento()),
    config: options.config ?? fakeConfig(),
    logger: options.logger ?? silentLogger(),
    account: options.account ?? (() => Promise.resolve("account-a")),
    onCredentialsChange: options.onCredentialsChange ?? new vscode.EventEmitter<void>().event,
    now: options.now ?? ((): number => 10_000),
  });
}

describe("XrayMetadataCapability sync", () => {
  it("marks a full project-catalogue fetch complete and merges the tests", async () => {
    const capability = makeCapability({
      client: fakeClient({
        fetchProjectCatalogue: () =>
          Promise.resolve(outcome([{ key: "CALC-1", summary: "one" }, { key: "CALC-2", summary: "two" }])),
      }),
    });
    let fired = 0;
    capability.onDidChange(() => { fired += 1; });

    await capability.sync({ projectKeys: ["CALC"] });

    const snap = capability.snapshot();
    expect(snap.completeness).toBe("complete");
    expect(snap.syncedAt).toBe(10_000);
    expect([...snap.tests.keys()].sort()).toEqual(["CALC-1", "CALC-2"]);
    expect(snap.errors).toEqual([]);
    expect(fired).toBeGreaterThan(0);
  });

  it("stays partial for a test-key-only fetch so orphans are never authoritative", async () => {
    const capability = makeCapability({
      client: fakeClient({
        fetchTestsByKeys: () => Promise.resolve(outcome([{ key: "CALC-1" }])),
      }),
    });

    await capability.sync({ testKeys: ["CALC-1"] });
    expect(capability.snapshot().completeness).toBe("partial");
  });

  it("demotes to partial when the catalogue fetch reports it is incomplete", async () => {
    const capability = makeCapability({
      client: fakeClient({
        fetchProjectCatalogue: () => Promise.resolve(outcome([{ key: "CALC-1" }], { complete: false })),
      }),
    });

    await capability.sync({ projectKeys: ["CALC"] });
    expect(capability.snapshot().completeness).toBe("partial");
  });

  it("keeps previous data and completeness on a total fetch failure, surfacing only the errors", async () => {
    const memento = fakeMemento();
    const capability = makeCapability({
      client: fakeClient({
        fetchProjectCatalogue: () => Promise.resolve(outcome([{ key: "CALC-1", summary: "kept" }])),
      }),
      memento,
    });
    await capability.sync({ projectKeys: ["CALC"] });
    expect(capability.snapshot().completeness).toBe("complete");

    // Re-sync with a client that returns no data plus an error: the previous complete snapshot stands.
    const failing = new XrayMetadataCapability({
      client: fakeClient({
        fetchProjectCatalogue: () => Promise.resolve(outcome([], { complete: false, errors: ["transport failure"] })),
      }),
      cache: cacheFor(memento),
      config: fakeConfig(),
      logger: silentLogger(),
      account: () => Promise.resolve("account-a"),
      onCredentialsChange: new vscode.EventEmitter<void>().event,
      now: () => 20_000,
    });
    await flush(); // let the constructor's cache load settle first
    await failing.sync({ projectKeys: ["CALC"] });

    const snap = failing.snapshot();
    expect(snap.completeness).toBe("complete");
    expect(snap.tests.get("CALC-1")?.summary).toBe("kept");
    expect(snap.errors).toContain("transport failure");
  });

  it("does not touch the snapshot when the sync is aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const fetchSpy = vi.fn(() => Promise.resolve(outcome([{ key: "CALC-1" }])));
    const capability = makeCapability({ client: fakeClient({ fetchProjectCatalogue: fetchSpy }) });

    await capability.sync({ projectKeys: ["CALC"] }, controller.signal);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(capability.snapshot().tests.size).toBe(0);
  });
});

describe("XrayMetadataCapability staleness", () => {
  it("marks the snapshot stale once the TTL elapses since the last sync", async () => {
    let now = 0;
    const capability = makeCapability({
      client: fakeClient({ fetchProjectCatalogue: () => Promise.resolve(outcome([{ key: "CALC-1" }])) }),
      config: fakeConfig(15),
      now: () => now,
    });

    now = 1_000;
    await capability.sync({ projectKeys: ["CALC"] });
    expect(capability.snapshot().stale).toBe(false);

    now = 1_000 + 16 * 60_000;
    expect(capability.snapshot().stale).toBe(true);
  });
});

describe("XrayMetadataCapability offline cache load", () => {
  it("renders last-known state from the cache and fires onDidChange on load", async () => {
    const memento = fakeMemento();
    const seeded = makeCapability({
      client: fakeClient({ fetchProjectCatalogue: () => Promise.resolve(outcome([{ key: "CALC-1", summary: "cached" }])) }),
      memento,
    });
    await seeded.sync({ projectKeys: ["CALC"] });

    // A fresh capability over the same memento, with a client that would never be reached offline.
    const offline = new XrayMetadataCapability({
      client: fakeClient({
        fetchProjectCatalogue: () => Promise.reject(new Error("network down")),
        fetchTestsByKeys: () => Promise.reject(new Error("network down")),
      }),
      cache: cacheFor(memento),
      config: fakeConfig(),
      logger: silentLogger(),
      account: () => Promise.resolve("account-a"),
      onCredentialsChange: new vscode.EventEmitter<void>().event,
    });
    let fired = 0;
    offline.onDidChange(() => { fired += 1; });
    await flush();

    expect(fired).toBe(1);
    expect(offline.snapshot().tests.get("CALC-1")?.summary).toBe("cached");
    expect(offline.snapshot().completeness).toBe("complete");
  });
});

describe("XrayMetadataCapability drift-basis diagnostic", () => {
  it("logs only booleans and counts for each stored gherkin, never the gherkin text", async () => {
    const lines: string[] = [];
    const channel = {
      name: "t",
      append: () => { /* no-op */ },
      appendLine: (line: string): void => { lines.push(line); },
      replace: () => { /* no-op */ },
      clear: () => { /* no-op */ },
      show: () => { /* no-op */ },
      hide: () => { /* no-op */ },
      dispose: () => { /* no-op */ },
    } as unknown as vscode.OutputChannel;

    const gherkin = "@TEST_CALC-1\nScenario: secret business rule\n  Given a confidential precondition";
    const capability = makeCapability({
      client: fakeClient({
        fetchProjectCatalogue: () => Promise.resolve(outcome([{ key: "CALC-1", gherkin }])),
      }),
      logger: Logger.create(channel, LogLevel.DEBUG),
    });

    await capability.sync({ projectKeys: ["CALC"] });

    const emitted = lines.join("\n");
    expect(emitted).toContain("drift-basis CALC-1:");
    expect(emitted).toContain("startsWithKeyword=false");
    expect(emitted).toContain("tagLines=1");
    expect(emitted).toContain("lines=3");
    expect(emitted).toContain("leadingIndent=true");
    expect(emitted).not.toContain("secret business rule");
    expect(emitted).not.toContain("confidential");
  });
});

describe("XrayMetadataCapability empty scope", () => {
  it("leaves a previously-good snapshot untouched when there is nothing to fetch", async () => {
    const capability = makeCapability({
      client: fakeClient({ fetchProjectCatalogue: () => Promise.resolve(outcome([{ key: "CALC-1" }])) }),
    });
    await capability.sync({ projectKeys: ["CALC"] });
    const before = capability.snapshot();
    let fired = 0;
    capability.onDidChange(() => { fired += 1; });

    await capability.sync({ projectKeys: [], testKeys: [] });

    const after = capability.snapshot();
    expect(after.completeness).toBe(before.completeness);
    expect(after.syncedAt).toBe(before.syncedAt);
    expect([...after.tests.keys()]).toEqual([...before.tests.keys()]);
    expect(fired).toBe(0);
  });
});

describe("XrayMetadataCapability account isolation", () => {
  const ENDPOINT = "xray.cloud.getxray.app";

  function harness(clientImpl: FakeClient) {
    const memento = fakeMemento();
    let account: string | undefined = "acct-A";
    const accountProvider = (): Promise<string | undefined> => Promise.resolve(account);
    const creds = new vscode.EventEmitter<void>();
    const invalidateAuth = vi.fn();
    const client = fakeClient({ ...clientImpl, invalidateAuth });
    const cache = new XrayMetadataCache(memento, { endpoint: ENDPOINT, account: accountProvider, workspaceId: "ws" });
    const capability = new XrayMetadataCapability({
      client,
      cache,
      config: fakeConfig(),
      logger: silentLogger(),
      account: accountProvider,
      onCredentialsChange: creds.event,
      now: () => 10_000,
    });
    return {
      capability,
      memento,
      invalidateAuth,
      setAccount: (next: string | undefined): void => { account = next; },
      fireCreds: (): void => creds.fire(),
    };
  }

  async function seedCache(memento: vscode.Memento, account: string, tests: TestCaseMetadata[]): Promise<void> {
    const cached: CachedMetadata = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      syncedAt: 5,
      completeness: "complete",
      fetchedScopes: [],
      errors: [],
      tests,
      pages: [],
    };
    await new XrayMetadataCache(memento, { endpoint: ENDPOINT, account: () => Promise.resolve(account), workspaceId: "ws" }).save(cached);
  }

  function loadCacheFor(memento: vscode.Memento, account: string): Promise<CachedMetadata | undefined> {
    return new XrayMetadataCache(memento, { endpoint: ENDPOINT, account: () => Promise.resolve(account), workspaceId: "ws" }).load();
  }

  it("resets in-memory state, drops the JWT, and reloads the new account's cache on a same-site switch", async () => {
    const h = harness({ fetchProjectCatalogue: () => Promise.resolve(outcome([{ key: "CALC-1", summary: "A only" }])) });
    await seedCache(h.memento, "acct-B", [{ key: "MATH-9", summary: "B only" }]);

    await h.capability.sync({ projectKeys: ["CALC"] });
    expect([...h.capability.snapshot().tests.keys()]).toEqual(["CALC-1"]);

    h.setAccount("acct-B");
    h.fireCreds();
    await flush();

    expect(h.invalidateAuth).toHaveBeenCalled();
    const snap = h.capability.snapshot();
    expect(snap.tests.has("CALC-1")).toBe(false);
    expect(snap.tests.get("MATH-9")?.summary).toBe("B only");
  });

  it("never serves the prior account's data after switching to an account with no cache", async () => {
    const h = harness({ fetchProjectCatalogue: () => Promise.resolve(outcome([{ key: "CALC-1" }])) });
    await h.capability.sync({ projectKeys: ["CALC"] });
    expect(h.capability.snapshot().tests.size).toBe(1);

    h.setAccount("acct-C");
    h.fireCreds();
    await flush();

    expect(h.capability.snapshot().tests.size).toBe(0);
  });

  it("discards a sync that straddles an account switch — nothing committed or persisted for the new account", async () => {
    let resolveFetch!: (value: XrayFetchOutcome) => void;
    const h = harness({
      fetchProjectCatalogue: () => new Promise<XrayFetchOutcome>((resolve) => { resolveFetch = resolve; }),
    });

    const syncPromise = h.capability.sync({ projectKeys: ["CALC"] });
    await flush();

    h.setAccount("acct-B");
    h.fireCreds();
    await flush();

    resolveFetch(outcome([{ key: "CALC-1", summary: "A straddled" }]));
    await syncPromise;

    expect(h.capability.snapshot().tests.size).toBe(0);
    expect(await loadCacheFor(h.memento, "acct-B")).toBeUndefined();
  });

  it("keeps in-memory state on a same-account secret rotation while still dropping the JWT", async () => {
    const h = harness({ fetchProjectCatalogue: () => Promise.resolve(outcome([{ key: "CALC-1" }])) });
    await h.capability.sync({ projectKeys: ["CALC"] });

    h.fireCreds();
    await flush();

    expect(h.invalidateAuth).toHaveBeenCalled();
    expect(h.capability.snapshot().tests.size).toBe(1);
  });

  it("persists under the account captured at sync entry, not a live read at write time (TOCTOU)", async () => {
    let resolveFetch!: (value: XrayFetchOutcome) => void;
    const h = harness({
      fetchProjectCatalogue: () => new Promise<XrayFetchOutcome>((resolve) => { resolveFetch = resolve; }),
    });
    await flush(); // loadFromCache stamps the account as "acct-A"

    const syncPromise = h.capability.sync({ projectKeys: ["CALC"] });
    await flush(); // sync has captured "acct-A" and is parked on the fetch

    // Cross-window rotation: account() now returns B, but no onDidChange fired (epoch unchanged), so
    // the sync legitimately passes its epoch guard and reaches persist.
    h.setAccount("acct-B");
    resolveFetch(outcome([{ key: "CALC-1", summary: "A data" }]));
    await syncPromise;

    // The data lands under the captured account (A); nothing is ever written under the live one (B).
    expect(await loadCacheFor(h.memento, "acct-B")).toBeUndefined();
    expect((await loadCacheFor(h.memento, "acct-A"))?.tests[0]?.key).toBe("CALC-1");
  });

  it("discards a sync that entered after the epoch bump but captured the pre-restamp account", async () => {
    const memento = fakeMemento();
    let accountValue: string | undefined = "acct-A";
    let deferNext = false;
    let releaseAccount: (() => void) | undefined;
    const accountProvider = (): Promise<string | undefined> => {
      if (deferNext) {
        deferNext = false;
        return new Promise<string | undefined>((resolve) => { releaseAccount = () => resolve(accountValue); });
      }
      return Promise.resolve(accountValue);
    };

    let resolveFetch!: (value: XrayFetchOutcome) => void;
    const client = fakeClient({
      fetchProjectCatalogue: () => new Promise<XrayFetchOutcome>((resolve) => { resolveFetch = resolve; }),
    });
    const cache = new XrayMetadataCache(memento, { endpoint: ENDPOINT, account: accountProvider, workspaceId: "ws" });
    const capability = new XrayMetadataCapability({
      client,
      cache,
      config: fakeConfig(),
      logger: silentLogger(),
      account: accountProvider,
      onCredentialsChange: new vscode.EventEmitter<void>().event,
      now: () => 10_000,
    });
    await flush(); // loadFromCache stamps "acct-A"

    // The switch target, with reconcile's account() read deferred so it parks before restamping.
    accountValue = "acct-B";
    deferNext = true;
    capability.onCredentialsChanged(); // epoch bump now; reconcile parks on the deferred account()

    // Sync enters IN THE GAP: it captures the post-bump epoch and the still-old stamp ("acct-A"),
    // then parks on its own fetch.
    const syncPromise = capability.sync({ projectKeys: ["CALC"] });
    await flush();

    releaseAccount?.(); // let reconcile restamp to "acct-B"
    await flush();

    let fired = 0;
    capability.onDidChange(() => { fired += 1; });
    resolveFetch(outcome([{ key: "MATH-1", summary: "B data" }]));
    await syncPromise;

    // Full discard: no state commit, no persist under either key, no fire from the sync.
    expect(capability.snapshot().tests.size).toBe(0);
    expect(await loadCacheFor(memento, "acct-A")).toBeUndefined();
    expect(await loadCacheFor(memento, "acct-B")).toBeUndefined();
    expect(fired).toBe(0);
  });
});
