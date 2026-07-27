import { describe, it, expect, vi } from "vitest";
import * as vscode from "vscode";
import { Logger, LogLevel } from "../../utils/logger";
import { ExtensionConfig } from "../../core/extension-config";
import { XrayFetchOutcome, XrayPageProgress, XrayTestRecord, XrayClient } from "../../xray/xray-client";
import { CachedMetadata, CACHE_SCHEMA_VERSION, XrayMetadataCache } from "../../xray/xray-metadata-cache";
import { XrayMetadataCapability } from "../../xray/xray-metadata";
import { JiraProjectSearchResult } from "../../xray/jira-project-search";
import { SyncProgressEvent, TestCaseMetadata } from "../../traceability/contracts";

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

function fakeConfig(ttlMinutes = 15, projectKeys: string[] = []): ExtensionConfig {
  return {
    get xrayCacheTtlMinutes(): number { return ttlMinutes; },
    get xraySyncProjectKeys(): string[] { return projectKeys; },
  } as unknown as ExtensionConfig;
}

function silentLogger(): Logger {
  return Logger.create(undefined, LogLevel.ERROR);
}

function outcome(tests: XrayTestRecord[], opts: { complete?: boolean; errors?: string[] } = {}): XrayFetchOutcome {
  return { tests, pages: [], complete: opts.complete ?? true, errors: opts.errors ?? [] };
}

interface FakeClient {
  fetchProjectCatalogue?: (
    projectKey: string,
    signal?: AbortSignal,
    onPage?: XrayPageProgress
  ) => Promise<XrayFetchOutcome>;
  fetchTestsByKeys?: (keys: readonly string[], signal?: AbortSignal) => Promise<XrayFetchOutcome>;
  searchTests?: (jql: string, signal?: AbortSignal) => Promise<XrayFetchOutcome>;
  invalidateAuth?: () => void;
}

function fakeClient(impl: FakeClient): XrayClient {
  return {
    fetchProjectCatalogue: impl.fetchProjectCatalogue ?? (() => Promise.resolve(outcome([]))),
    fetchTestsByKeys: impl.fetchTestsByKeys ?? (() => Promise.resolve(outcome([]))),
    searchTests: impl.searchTests ?? (() => Promise.resolve(outcome([]))),
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
  listProjects?: (signal?: AbortSignal) => Promise<JiraProjectSearchResult | undefined>;
  now?: () => number;
}

// A connection with no Jira access: the project directory stays empty without failing.
const noProjects = (): Promise<JiraProjectSearchResult | undefined> => Promise.resolve(undefined);

function makeCapability(options: CapabilityOptions): XrayMetadataCapability {
  return new XrayMetadataCapability({
    client: options.client,
    cache: cacheFor(options.memento ?? fakeMemento()),
    config: options.config ?? fakeConfig(),
    logger: options.logger ?? silentLogger(),
    account: options.account ?? (() => Promise.resolve("account-a")),
    onCredentialsChange: options.onCredentialsChange ?? new vscode.EventEmitter<void>().event,
    listProjects: options.listProjects ?? noProjects,
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
    expect(snap.catalogueProjects).toEqual(["CALC"]);
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

  it("reaches complete on the production combined scope (project catalogue + tag-derived key batch)", async () => {
    const capability = makeCapability({
      client: fakeClient({
        fetchProjectCatalogue: () => Promise.resolve(outcome([{ key: "CALC-1", summary: "one" }])),
        fetchTestsByKeys: () => Promise.resolve(outcome([{ key: "CALC-1", summary: "one" }])),
      }),
    });

    await capability.sync({ projectKeys: ["CALC"], testKeys: ["CALC-1"] });
    expect(capability.snapshot().completeness).toBe("complete");
  });

  it("stays complete when the supplemental key batch errors, surfacing the error without demoting", async () => {
    const capability = makeCapability({
      client: fakeClient({
        fetchProjectCatalogue: () => Promise.resolve(outcome([{ key: "CALC-1", summary: "one" }])),
        fetchTestsByKeys: () => Promise.resolve(outcome([], { errors: ["key batch failed"] })),
      }),
    });

    await capability.sync({ projectKeys: ["CALC"], testKeys: ["CALC-9"] });
    const snap = capability.snapshot();
    expect(snap.completeness).toBe("complete");
    expect(snap.errors).toEqual(["key batch failed"]);
  });

  it("stays unknown for a test-key-only fetch that returns no data", async () => {
    const capability = makeCapability({
      client: fakeClient({ fetchTestsByKeys: () => Promise.resolve(outcome([])) }),
    });

    await capability.sync({ testKeys: ["CALC-1"] });
    expect(capability.snapshot().completeness).toBe("unknown");
  });

  it("demotes to partial when a catalogue page errors even with a key batch present", async () => {
    const capability = makeCapability({
      client: fakeClient({
        fetchProjectCatalogue: () => Promise.resolve(outcome([{ key: "CALC-1" }], { errors: ["page 2 failed"] })),
        fetchTestsByKeys: () => Promise.resolve(outcome([{ key: "CALC-1" }])),
      }),
    });

    await capability.sync({ projectKeys: ["CALC"], testKeys: ["CALC-1"] });
    expect(capability.snapshot().completeness).toBe("partial");
  });

  it("records a queried key the successful batch did not return as verified-absent", async () => {
    const capability = makeCapability({
      client: fakeClient({
        fetchTestsByKeys: () => Promise.resolve(outcome([{ key: "CALC-1", summary: "one" }])),
      }),
    });

    await capability.sync({ testKeys: ["CALC-1", "demo-9"] });
    const snap = capability.snapshot();
    expect(snap.verifiedAbsentKeys).toEqual(["DEMO-9"]);
    expect(snap.verifiedAbsentKeys).not.toContain("CALC-1");
  });

  it("records nothing when the key batch reported errors", async () => {
    const capability = makeCapability({
      client: fakeClient({
        fetchTestsByKeys: () => Promise.resolve(outcome([{ key: "CALC-1" }], { errors: ["boom"] })),
      }),
    });

    await capability.sync({ testKeys: ["CALC-1", "DEMO-9"] });
    expect(capability.snapshot().verifiedAbsentKeys).toEqual([]);
  });

  it("records nothing when the key batch was incomplete", async () => {
    const capability = makeCapability({
      client: fakeClient({
        fetchTestsByKeys: () => Promise.resolve(outcome([{ key: "CALC-1" }], { complete: false })),
      }),
    });

    await capability.sync({ testKeys: ["CALC-1", "DEMO-9"] });
    expect(capability.snapshot().verifiedAbsentKeys).toEqual([]);
  });

  it("wholly replaces the verified-absent set when a later sync returns a previously-absent key", async () => {
    let returnDemo = false;
    const capability = makeCapability({
      client: fakeClient({
        fetchTestsByKeys: () =>
          Promise.resolve(outcome(returnDemo ? [{ key: "DEMO-9", summary: "now exists" }] : [])),
      }),
    });

    await capability.sync({ testKeys: ["DEMO-9"] });
    expect(capability.snapshot().verifiedAbsentKeys).toEqual(["DEMO-9"]);

    returnDemo = true;
    await capability.sync({ testKeys: ["DEMO-9"] });
    expect(capability.snapshot().verifiedAbsentKeys).toEqual([]);
    expect(capability.snapshot().tests.has("DEMO-9")).toBe(true);
  });

  it("wipes a prior verified-absent set when a later committing sync has an untrustworthy batch", async () => {
    let batchFails = false;
    const capability = makeCapability({
      client: fakeClient({
        fetchProjectCatalogue: () => Promise.resolve(outcome([{ key: "CALC-1", summary: "one" }])),
        fetchTestsByKeys: () =>
          Promise.resolve(batchFails ? outcome([], { errors: ["boom"] }) : outcome([])),
      }),
    });

    await capability.sync({ projectKeys: ["CALC"], testKeys: ["DEMO-9"] });
    expect(capability.snapshot().verifiedAbsentKeys).toEqual(["DEMO-9"]);

    // The catalogue still returns data so this sync commits, but its key batch can no longer vouch
    // for the prior absence claim, so the set is wiped, not carried.
    batchFails = true;
    await capability.sync({ projectKeys: ["CALC"], testKeys: ["DEMO-9"] });
    const snap = capability.snapshot();
    expect(snap.verifiedAbsentKeys).toEqual([]);
    expect(snap.errors).toEqual(["boom"]);
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
      listProjects: noProjects,
      now: () => 20_000,
    });
    await flush(); // let the constructor's cache load settle first
    await failing.sync({ projectKeys: ["CALC"] });

    const snap = failing.snapshot();
    expect(snap.completeness).toBe("complete");
    expect(snap.tests.get("CALC-1")?.summary).toBe("kept");
    expect(snap.errors).toContain("transport failure");
  });

  it("stamps each catalogue's pages with its project key on the way to the progress sink", async () => {
    const capability = makeCapability({
      client: fakeClient({
        fetchProjectCatalogue: (projectKey, _signal, onPage) => {
          onPage?.(50, 120);
          onPage?.(120, 120);
          return Promise.resolve(outcome([{ key: `${projectKey}-1` }]));
        },
      }),
    });
    const events: SyncProgressEvent[] = [];

    await capability.sync({ projectKeys: ["CALC", "PAY"] }, undefined, (event) => events.push(event));

    expect(events).toEqual([
      { projectKey: "CALC", fetched: 50, total: 120 },
      { projectKey: "CALC", fetched: 120, total: 120 },
      { projectKey: "PAY", fetched: 50, total: 120 },
      { projectKey: "PAY", fetched: 120, total: 120 },
    ]);
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
      listProjects: noProjects,
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
      listProjects: noProjects,
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
      catalogueProjects: [],
      verifiedAbsentKeys: [],
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

  it("discards a sync that straddles an account switch: nothing committed or persisted for the new account", async () => {
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
      listProjects: noProjects,
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

  it("discards a merge that entered after the epoch bump but captured the pre-restamp account", async () => {
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
      fetchTestsByKeys: () => new Promise<XrayFetchOutcome>((resolve) => { resolveFetch = resolve; }),
    });
    const cache = new XrayMetadataCache(memento, { endpoint: ENDPOINT, account: accountProvider, workspaceId: "ws" });
    const capability = new XrayMetadataCapability({
      client,
      cache,
      config: fakeConfig(),
      logger: silentLogger(),
      account: accountProvider,
      onCredentialsChange: new vscode.EventEmitter<void>().event,
      listProjects: noProjects,
      now: () => 10_000,
    });
    await flush(); // loadFromCache stamps "acct-A"

    // Switch target, with reconcile's account() read deferred so it parks before restamping.
    accountValue = "acct-B";
    deferNext = true;
    capability.onCredentialsChanged(); // epoch bump now; reconcile parks on the deferred account()

    // Merge enters IN THE GAP: post-bump epoch, still-old stamp ("acct-A"), then parks on its fetch.
    const mergePromise = capability.mergeKeys(["CALC-1"]);
    await flush();

    releaseAccount?.(); // let reconcile restamp to "acct-B"
    await flush();

    let fired = 0;
    capability.onDidChange(() => { fired += 1; });
    resolveFetch(outcome([{ key: "CALC-1", summary: "B data fetched with B creds" }]));
    await mergePromise;

    // The stamp drifted from the captured account, so the merge is discarded; nothing under either
    // key, no fire. Without the captured-account guard this would persist B's data under "acct-A".
    expect(capability.snapshot().tests.size).toBe(0);
    expect(await loadCacheFor(memento, "acct-A")).toBeUndefined();
    expect(await loadCacheFor(memento, "acct-B")).toBeUndefined();
    expect(fired).toBe(0);
  });

  it("resurrects a merged key: a found key is dropped from verifiedAbsentKeys", async () => {
    const fetchTestsByKeys = vi
      .fn<(keys: readonly string[]) => Promise<XrayFetchOutcome>>()
      .mockResolvedValueOnce(outcome([])) // sync key-batch: CALC-1 queried, not returned → absent
      .mockResolvedValueOnce(outcome([{ key: "CALC-1", summary: "found now" }])); // merge finds it
    const h = harness({ fetchProjectCatalogue: () => Promise.resolve(outcome([])), fetchTestsByKeys });
    await flush();

    await h.capability.sync({ projectKeys: ["CALC"], testKeys: ["CALC-1"] });
    expect(h.capability.snapshot().verifiedAbsentKeys).toContain("CALC-1");

    await h.capability.mergeKeys(["CALC-1"]);
    const snap = h.capability.snapshot();
    expect(snap.verifiedAbsentKeys).not.toContain("CALC-1");
    expect(snap.tests.get("CALC-1")?.summary).toBe("found now");
  });
});

describe("XrayMetadataCapability.search", () => {
  it("builds project-scoped JQL and returns the matched tests", async () => {
    const seen: string[] = [];
    const capability = makeCapability({
      config: fakeConfig(15, ["CALC"]),
      client: fakeClient({
        searchTests: (jql) => {
          seen.push(jql);
          return Promise.resolve(outcome([{ key: "CALC-9", summary: "login flow" }]));
        },
      }),
    });

    const result = await capability.search("login");

    expect(seen).toEqual(['project = CALC AND summary ~ "login*"']);
    expect(result.complete).toBe(true);
    expect(result.tests.map((t) => t.key)).toEqual(["CALC-9"]);
  });

  it("returns an honest empty result (no transport hit) when there is nothing searchable", async () => {
    const searchTests = vi.fn(() => Promise.resolve(outcome([])));
    const capability = makeCapability({
      config: fakeConfig(15, []),
      client: fakeClient({ searchTests }),
    });

    const result = await capability.search("login"); // free text, no configured project

    expect(searchTests).not.toHaveBeenCalled();
    expect(result).toEqual({ tests: [], complete: true });
  });

  it("reports incomplete when the fetch carried errors, so the caller words it honestly", async () => {
    const capability = makeCapability({
      config: fakeConfig(15, ["CALC"]),
      client: fakeClient({
        searchTests: () => Promise.resolve(outcome([], { complete: false, errors: ["boom"] })),
      }),
    });

    const result = await capability.search("login");
    expect(result.complete).toBe(false);
  });

  // A project that reached the sync scope through the tag ladder is only in the setting-free catalogue,
  // so scoping the search to the setting alone would make its tests unfindable.
  it("scopes the JQL to the synced catalogue as well as the setting", async () => {
    const seen: string[] = [];
    const capability = makeCapability({
      config: fakeConfig(15, ["SHOP"]),
      client: fakeClient({
        fetchProjectCatalogue: () => Promise.resolve(outcome([{ key: "CALC-1" }])),
        searchTests: (jql) => {
          seen.push(jql);
          return Promise.resolve(outcome([]));
        },
      }),
    });
    await capability.sync({ projectKeys: ["CALC"] });

    await capability.search("login");

    expect(seen).toEqual(['project in (CALC, SHOP) AND summary ~ "login*"']);
  });
});

describe("XrayMetadataCapability project directory", () => {
  const acme: JiraProjectSearchResult = { projects: [{ key: "OPS", name: "Operations" }], truncated: false };

  it("answers from the last known list and refreshes it in the background", async () => {
    const listProjects = vi.fn(() => Promise.resolve(acme));
    const capability = makeCapability({ client: fakeClient({}), listProjects });

    // Nothing fetched yet: the first read is empty and synchronous, and it kicks the refresh.
    expect(capability.cached()).toEqual({ projects: [], truncated: false });
    let fired = 0;
    capability.onDidChange(() => { fired += 1; });
    await flush();

    expect(fired).toBe(1);
    expect(capability.cached()).toEqual({ projects: [{ key: "OPS", name: "Operations" }], truncated: false });
    expect(listProjects).toHaveBeenCalledTimes(1);
  });

  it("serves the cached list without re-listing until the TTL expires", async () => {
    let clock = 10_000;
    const listProjects = vi.fn(() => Promise.resolve(acme));
    const capability = makeCapability({
      client: fakeClient({}),
      config: fakeConfig(15),
      listProjects,
      now: () => clock,
    });
    capability.cached();
    await flush();

    capability.cached();
    await flush();
    expect(listProjects).toHaveBeenCalledTimes(1);

    clock += 16 * 60_000;
    capability.cached();
    await flush();
    expect(listProjects).toHaveBeenCalledTimes(2);
  });

  it("keeps the list empty, without failing, when the connection has no Jira access", async () => {
    const capability = makeCapability({ client: fakeClient({}), listProjects: noProjects });

    capability.cached();
    await flush();

    expect(capability.cached()).toEqual({ projects: [], truncated: false });
  });

  it("holds the last list after a failed refresh, and does not retry it until the TTL is up", async () => {
    let clock = 10_000;
    let fail = false;
    const listProjects = vi.fn(() => (fail ? Promise.reject(new Error("Jira denied access")) : Promise.resolve(acme)));
    const capability = makeCapability({ client: fakeClient({}), listProjects, now: () => clock });
    capability.cached();
    await flush();

    clock += 16 * 60_000;
    fail = true;
    capability.cached();
    await flush();
    expect(listProjects).toHaveBeenCalledTimes(2);

    // The failure stamped the clock like a success, so a repaint inside the TTL reads the held list
    // rather than hammering a connection that just refused.
    capability.cached();
    await flush();

    expect(listProjects).toHaveBeenCalledTimes(2);
    expect(capability.cached().projects).toEqual([{ key: "OPS", name: "Operations" }]);
  });

  it("drops the list when the credentials change, so the next read lists the new connection", async () => {
    const creds = new vscode.EventEmitter<void>();
    const listProjects = vi.fn(() => Promise.resolve(acme));
    const capability = makeCapability({
      client: fakeClient({}),
      onCredentialsChange: creds.event,
      listProjects,
    });
    capability.cached();
    await flush();

    creds.fire();

    expect(capability.cached()).toEqual({ projects: [], truncated: false });
    await flush();
    expect(listProjects).toHaveBeenCalledTimes(2);
  });

  it("discards a list that resolves after the credentials changed, since it belongs to the old connection", async () => {
    const creds = new vscode.EventEmitter<void>();
    let resolveList!: (result: JiraProjectSearchResult) => void;
    const capability = makeCapability({
      client: fakeClient({}),
      onCredentialsChange: creds.event,
      listProjects: () => new Promise<JiraProjectSearchResult>((resolve) => { resolveList = resolve; }),
    });
    capability.cached(); // kicks the refresh, which parks on the pending list
    await flush();

    creds.fire();
    resolveList(acme);
    await flush();

    expect(capability.cached().projects).toEqual([]);
  });
});

describe("XrayMetadataCapability.mergeKeys", () => {
  it("additively folds a fetched test into the snapshot and fires onDidChange", async () => {
    const memento = fakeMemento();
    const capability = makeCapability({
      memento,
      client: fakeClient({
        fetchProjectCatalogue: () => Promise.resolve(outcome([{ key: "CALC-2", summary: "two" }])),
        fetchTestsByKeys: (keys) =>
          Promise.resolve(outcome(keys.map((key) => ({ key: key.toUpperCase(), summary: `merged ${key}` })))),
      }),
    });
    await capability.sync({ projectKeys: ["CALC"] });

    let fired = 0;
    capability.onDidChange(() => { fired += 1; });
    await capability.mergeKeys(["calc-1"]);

    const tests = capability.snapshot().tests;
    expect([...tests.keys()].sort()).toEqual(["CALC-1", "CALC-2"]);
    expect(tests.get("CALC-1")?.summary).toBe("merged CALC-1");
    expect(fired).toBe(1);
  });

  it("no-ops (no fire) when the remote returns nothing for the keys", async () => {
    const capability = makeCapability({
      client: fakeClient({ fetchTestsByKeys: () => Promise.resolve(outcome([])) }),
    });
    let fired = 0;
    capability.onDidChange(() => { fired += 1; });
    await capability.mergeKeys(["CALC-1"]);
    expect(capability.snapshot().tests.size).toBe(0);
    expect(fired).toBe(0);
  });
});
