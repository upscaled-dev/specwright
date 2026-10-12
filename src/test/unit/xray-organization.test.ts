import * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionConfig } from "../../core/extension-config";
import { ORGANIZATION_ITEM_LIMIT, type MetadataCapability, type RemoteMetadataSnapshot, type RepositoryProject, type TestSetProject } from "../../traceability/contracts";
import { Logger } from "../../utils/logger";
import {
  ORGANIZATION_SYNC_PROJECT_LIMIT,
  XrayOrganizationCache,
  XrayOrganizationCapability,
  XrayOrganizationReader,
} from "../../xray/xray-organization";

function memento(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
    update: (key: string, value: unknown): Promise<void> => {values.set(key, value); return Promise.resolve();},
    keys: (): readonly string[] => [...values.keys()],
  } as unknown as vscode.Memento;
}

const EMPTY_METADATA: RemoteMetadataSnapshot = {
  tests: new Map(), fetchedScopes: [], catalogueProjects: [], completeProjects: [], verifiedAbsentKeys: [], stale: false, errors: [],
};

function metadata(snapshot = EMPTY_METADATA): MetadataCapability {
  return {
    onDidChange: new vscode.EventEmitter<void>().event,
    snapshot: () => snapshot,
    sync: () => Promise.resolve(),
  };
}

function project(testSets: TestSetProject["testSets"]): TestSetProject {
  return { projectKey: "SHOP", testSets, complete: true, truncated: false, errors: [] };
}

const SHOP_301 = {
  key: "SHOP-301",
  issueId: "301",
  summary: "Checkout smoke",
  members: ["SHOP-101", "SHOP-117", "SHOP-124", "SHOP-130"].map((key) => ({ key, summary: `Summary ${key}` })),
  remoteMemberCount: 4,
  membershipComplete: true,
  truncated: false,
  errors: [],
} as const;

describe("XrayOrganizationReader", () => {
  const rawSet = (tests: unknown = { total: 1, results: [{ jira: { key: "SHOP-101" } }] }) => ({
    issueId: "301", jira: { key: "SHOP-301" }, tests,
  });
  const listBody = (results: unknown, total: unknown = 1) => ({ data: { getTestSets: { total, results } } });

  it.each([null, {}, listBody(null), listBody([null]), listBody([{ jira: { key: "SHOP-301" } }]),
    listBody([rawSet()], -1), listBody([rawSet()], 1.5)])(
    "does not claim a complete catalogue for malformed responses: %j", async (body) => {
      const result = await new XrayOrganizationReader({ readGraphql: vi.fn().mockResolvedValue(body) }).list("SHOP");
      expect(result.complete).toBe(false);
    },
  );

  it.each([
    { total: 2, results: null },
    { total: 2, results: [null, { jira: {} }, { jira: { key: "SHOP-101" } }] },
    { total: "2", results: [{ jira: { key: "SHOP-101" } }] },
    { total: 51, results: Array.from({ length: 51 }, (_, index) => ({ jira: { key: `SHOP-${index}` } })) },
  ])("retains usable members but marks malformed or oversized membership incomplete: %j", async (tests) => {
    const result = await new XrayOrganizationReader({ readGraphql: vi.fn().mockResolvedValue(listBody([rawSet(tests)])) }).list("SHOP");
    expect(result.testSets[0]).toMatchObject({ key: "SHOP-301", membershipComplete: false });
    expect(result.testSets[0]!.errors).toContain("Xray returned incomplete Test Set membership data.");
    expect(result.testSets[0]!.members.length).toBeLessThanOrEqual(50);
  });

  it("deduplicates case-insensitive membership without inventing extra tests", async () => {
    const body = listBody([rawSet({ total: 1, results: [{ jira: { key: "shop-101" } }, { jira: { key: "SHOP-101" } }] })]);
    const result = await new XrayOrganizationReader({ readGraphql: vi.fn().mockResolvedValue(body) }).list("SHOP");
    expect(result.testSets[0]).toMatchObject({ members: [{ key: "SHOP-101" }], membershipComplete: true });
  });

  it.each([
    { errors: [{ message: "permission denied" }] }, listBody([]), listBody(null),
    listBody([null]), listBody([rawSet(), rawSet()], 2), listBody([rawSet()], 2),
    listBody([{ ...rawSet(), jira: { key: "SHOP-999" } }]),
  ])("refuses an exact refresh with ambiguous or mismatched identity: %j", async (body) => {
    const readGraphql = vi.fn().mockResolvedValue(body);
    await expect(new XrayOrganizationReader({ readGraphql }).refresh("SHOP-301")).resolves.toBeUndefined();
    expect(readGraphql).toHaveBeenCalledOnce();
  });

  it.each([
    { errors: [{ message: "permission denied" }] },
    { data: { getTestSet: null } },
    { data: { getTestSet: { ...rawSet(), jira: { key: "SHOP-999" } } } },
    { data: { getTestSet: rawSet({ total: 3, results: [{ jira: { key: "SHOP-101" } }] }) } },
    { data: { getTestSet: rawSet({ total: 2, results: [] }) } },
    { data: { getTestSet: rawSet({ total: 2, results: [{ jira: { key: "SHOP-101" } }] }) } },
  ])("never labels a changed, failed or short membership page complete: %j", async (page) => {
    const readGraphql = vi.fn().mockResolvedValueOnce(listBody([rawSet({ total: 2, results: [] })])).mockResolvedValueOnce(page);
    await expect(new XrayOrganizationReader({ readGraphql }).refresh("SHOP-301")).resolves.toBeUndefined();
    expect(readGraphql).toHaveBeenCalledTimes(2);
  });

  it("stops at the selected-set membership limit before requesting pages", async () => {
    const readGraphql = vi.fn().mockResolvedValue(listBody([rawSet({ total: 10_001, results: [] })]));
    await expect(new XrayOrganizationReader({ readGraphql }).refresh("SHOP-301")).resolves.toMatchObject({
      membershipComplete: false, truncated: true,
      errors: ["Test Set membership exceeds the 10000-member run limit."],
    });
    expect(readGraphql).toHaveBeenCalledOnce();
  });

  it("does not request another membership page after cancellation", async () => {
    const controller = new AbortController();
    const readGraphql = vi.fn().mockImplementation(async () => {
      controller.abort();
      return listBody([rawSet({ total: 2, results: [] })]);
    });
    await expect(new XrayOrganizationReader({ readGraphql }).refresh("SHOP-301", controller.signal)).rejects.toThrow();
    expect(readGraphql).toHaveBeenCalledOnce();
  });

  it("parses a production-shaped SHOP-301 list response with exact membership", async () => {
    const readGraphql = vi.fn().mockResolvedValue({
      data: {
        getTestSets: {
          total: 1,
          results: [{
            issueId: "301",
            jira: { key: "SHOP-301", summary: "Checkout smoke", description: "Critical checkout path" },
            tests: {
              total: 4,
              results: SHOP_301.members.map((member) => ({ jira: member })),
            },
          }],
        },
      },
    });

    const result = await new XrayOrganizationReader({ readGraphql }).list("SHOP");

    expect(result).toMatchObject({ projectKey: "SHOP", complete: true, truncated: false });
    expect(result.testSets).toEqual([expect.objectContaining({
      key: "SHOP-301", remoteMemberCount: 4, membershipComplete: true,
      members: SHOP_301.members,
    })]);
    expect(readGraphql.mock.calls[0]?.[0]).toContain("limit: 50");
    expect(readGraphql.mock.calls[0]?.[0]).toContain("tests(limit: 50");
  });

  it("marks list and membership truncation honestly within the ordinary-sync item budget", async () => {
    const readGraphql = vi.fn().mockResolvedValue({
      data: {
        getTestSets: {
          total: 51,
          results: [{
            issueId: "301",
            jira: { key: "SHOP-301" },
            tests: { total: 51, results: Array.from({ length: 50 }, (_, index) => ({ jira: { key: `SHOP-${index + 1}` } })) },
          }],
        },
      },
    });
    const result = await new XrayOrganizationReader({ readGraphql }).list("SHOP");
    expect(result).toMatchObject({ complete: false, truncated: true });
    expect(result.testSets[0]).toMatchObject({ membershipComplete: false, truncated: true, remoteMemberCount: 51 });
    expect(readGraphql).toHaveBeenCalledTimes(1);
  });

  it("fully paginates only the selected set refresh and deduplicates exact members", async () => {
    const members = Array.from({ length: 120 }, (_, index) => ({ jira: { key: `SHOP-${index + 1}` } }));
    const readGraphql = vi.fn().mockImplementation((query: string) => {
      if (query.includes("getTestSets")) {
        return Promise.resolve({ data: { getTestSets: { total: 1, results: [{ issueId: "301", jira: { key: "SHOP-301" }, tests: { total: 120, results: members.slice(0, 50) } }] } } });
      }
      const start = Number(/start: (\d+)/u.exec(query)?.[1] ?? 0);
      return Promise.resolve({ data: { getTestSet: { issueId: "301", jira: { key: "SHOP-301" }, tests: { total: 120, results: members.slice(start, start + 100) } } } });
    });
    const result = await new XrayOrganizationReader({ readGraphql }).refresh("shop-301");
    expect(result).toMatchObject({ key: "SHOP-301", membershipComplete: true, remoteMemberCount: 120 });
    expect(result?.members).toHaveLength(120);
    expect(readGraphql).toHaveBeenCalledTimes(3);
  });
});

describe("XrayOrganizationCapability cache isolation", () => {
  // The slot existing installs already store under, spelled out: the organization payload keeps its
  // own schema version (1), which the shared key helper must not collapse into the metadata one.
  it("stores under the §7 organization key", async () => {
    const state = memento();
    const cache = new XrayOrganizationCache(state, {
      endpoint: "xray.example",
      account: () => Promise.resolve("account-a"),
      workspaceId: "ws",
    });

    await cache.save("account-a", { syncedAt: 1, projects: [], omittedTestSetProjectCount: 0 });

    expect(state.keys()).toEqual(["traceability:xray-organization:xray.example:account-a:ws:1"]);
  });

  it("saves only under the explicitly captured account stamp", async () => {
    const state = memento();
    const liveAccount = "account-b";
    const cache = new XrayOrganizationCache(state, {
      endpoint: "xray.example",
      account: () => Promise.resolve(liveAccount),
      workspaceId: "ws",
    });

    await cache.save("account-a", { syncedAt: 1, projects: [project([SHOP_301])], omittedTestSetProjectCount: 0 });

    expect(cache.loadForAccount("account-a")?.projects[0]?.testSets[0]?.key).toBe("SHOP-301");
    expect(cache.loadForAccount(liveAccount)).toBeUndefined();
  });

  it("loads the cache for the captured account even when the live account rotates between awaits", async () => {
    const state = memento();
    let liveAccount = "account-a";
    const identity = { endpoint: "xray.example", account: () => Promise.resolve(liveAccount), workspaceId: "ws" };
    const cache = new XrayOrganizationCache(state, identity);
    await cache.save("account-a", { syncedAt: 1, projects: [project([SHOP_301])], omittedTestSetProjectCount: 0 });
    await cache.save("account-b", { syncedAt: 2, projects: [project([{ ...SHOP_301, key: "SHOP-999" }])], omittedTestSetProjectCount: 0 });
    let resolveAccount!: (value: string) => void;
    const captured = new Promise<string>((resolve) => {resolveAccount = resolve;});
    const changed = new vscode.EventEmitter<void>();
    const capability = new XrayOrganizationCapability({
      reader: { list: vi.fn(), refresh: vi.fn() } as unknown as XrayOrganizationReader,
      metadata: metadata(), cache,
      config: { xrayCacheTtlMinutes: 15 } as ExtensionConfig,
      logger: Logger.create(),
      account: () => captured,
      onCredentialsChange: changed.event,
      projectOf: () => "SHOP",
      now: () => 3,
    });
    liveAccount = "account-b";
    resolveAccount("account-a");
    await new Promise((resolve) => setImmediate(resolve));
    expect(capability.snapshot().testSetProjects[0]?.testSets[0]?.key).toBe("SHOP-301");
    capability.dispose();
  });

  it("keeps last-known complete members when a confirmation refresh fails", async () => {
    const state = memento();
    const cache = new XrayOrganizationCache(state, { endpoint: "xray.example", account: () => Promise.resolve("account-a"), workspaceId: "ws" });
    await cache.save("account-a", { syncedAt: 1, projects: [project([SHOP_301])], omittedTestSetProjectCount: 0 });
    const capability = new XrayOrganizationCapability({
      reader: { list: vi.fn(), refresh: vi.fn().mockResolvedValue(undefined) } as unknown as XrayOrganizationReader,
      metadata: metadata(), cache,
      config: { xrayCacheTtlMinutes: 15 } as ExtensionConfig,
      logger: Logger.create(), account: () => Promise.resolve("account-a"),
      onCredentialsChange: new vscode.EventEmitter<void>().event,
      projectOf: () => "SHOP", now: () => 3,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const result = await capability.refreshTestSet("SHOP-301");
    expect(result).toMatchObject({ status: "failed", testSet: { key: "SHOP-301", membershipComplete: true, remoteMemberCount: 4 } });
    expect(capability.snapshot().testSetProjects[0]?.testSets[0]?.members).toHaveLength(4);
    capability.dispose();
  });

  it("does not replace complete cached membership with an ordinary partial hydration", async () => {
    const state = memento();
    const cache = new XrayOrganizationCache(state, { endpoint: "xray.example", account: () => Promise.resolve("account-a"), workspaceId: "ws" });
    await cache.save("account-a", { syncedAt: 1, projects: [project([SHOP_301])], omittedTestSetProjectCount: 0 });
    const partial = { ...SHOP_301, members: SHOP_301.members.slice(0, 1), remoteMemberCount: 100, membershipComplete: false, truncated: true };
    const capability = new XrayOrganizationCapability({
      reader: { list: vi.fn().mockResolvedValue({ ...project([partial]), complete: false }), refresh: vi.fn() } as unknown as XrayOrganizationReader,
      metadata: metadata(), cache,
      config: { xrayCacheTtlMinutes: 15 } as ExtensionConfig,
      logger: Logger.create(), account: () => Promise.resolve("account-a"),
      onCredentialsChange: new vscode.EventEmitter<void>().event,
      projectOf: () => "SHOP", now: () => 3,
    });
    await new Promise((resolve) => setImmediate(resolve));
    await capability.sync(["SHOP"]);
    expect(capability.snapshot().testSetProjects[0]?.testSets[0]).toMatchObject({
      key: "SHOP-301", membershipComplete: false, remoteMemberCount: 100, membersLastKnown: true,
    });
    expect(capability.snapshot().testSetProjects[0]?.testSets[0]?.members).toHaveLength(4);
    capability.dispose();
  });

  it("keeps shrunken last-known membership explicitly incomplete and boundary-valid", async () => {
    const state = memento();
    const cache = new XrayOrganizationCache(state, { endpoint: "xray.example", account: () => Promise.resolve("account-a"), workspaceId: "ws" });
    const previous = {
      ...SHOP_301,
      members: Array.from({ length: 120 }, (_, index) => ({ key: `SHOP-${index + 1}` })),
      remoteMemberCount: 120,
    };
    await cache.save("account-a", { syncedAt: 1, projects: [project([previous])], omittedTestSetProjectCount: 0 });
    const partial = { ...SHOP_301, members: SHOP_301.members.slice(0, 1), remoteMemberCount: 100, membershipComplete: false, truncated: true };
    const capability = new XrayOrganizationCapability({
      reader: { list: vi.fn().mockResolvedValue({ ...project([partial]), complete: false }), refresh: vi.fn() } as unknown as XrayOrganizationReader,
      metadata: metadata(), cache,
      config: { xrayCacheTtlMinutes: 15 } as ExtensionConfig,
      logger: Logger.create(), account: () => Promise.resolve("account-a"),
      onCredentialsChange: new vscode.EventEmitter<void>().event,
      projectOf: () => "SHOP", now: () => 3,
    });
    await new Promise((resolve) => setImmediate(resolve));

    await capability.sync(["SHOP"]);

    expect(capability.snapshot().testSetProjects[0]?.testSets[0]).toMatchObject({
      remoteMemberCount: 100, membershipComplete: false, membersLastKnown: true,
    });
    expect(capability.snapshot().testSetProjects[0]?.testSets[0]?.members).toHaveLength(120);
    capability.dispose();
  });

  it("does not expose refreshed membership when credentials rotate during cache persistence", async () => {
    const changed = new vscode.EventEmitter<void>();
    let releaseSave!: () => void;
    let saveStarted!: () => void;
    let currentAccount = "account-a";
    const started = new Promise<void>((resolve) => {saveStarted = resolve;});
    const saveGate = new Promise<void>((resolve) => {releaseSave = resolve;});
    const cache = {
      loadForAccount: (account: string | undefined) => account === "account-a"
        ? { schemaVersion: 1, syncedAt: 1, projects: [project([SHOP_301])] }
        : undefined,
      save: vi.fn(async () => {saveStarted(); await saveGate;}),
    } as unknown as XrayOrganizationCache;
    const refreshed = { ...SHOP_301, members: [...SHOP_301.members, { key: "SHOP-999" }], remoteMemberCount: 5 };
    const capability = new XrayOrganizationCapability({
      reader: { list: vi.fn(), refresh: vi.fn().mockResolvedValue(refreshed) } as unknown as XrayOrganizationReader,
      metadata: metadata(), cache,
      config: { xrayCacheTtlMinutes: 15 } as ExtensionConfig,
      logger: Logger.create(), account: () => Promise.resolve(currentAccount),
      onCredentialsChange: changed.event, projectOf: () => "SHOP", now: () => 3,
    });
    await new Promise((resolve) => setImmediate(resolve));

    const pending = capability.refreshTestSet("SHOP-301");
    await started;
    currentAccount = "account-b";
    changed.fire();
    releaseSave();

    await expect(pending).resolves.toMatchObject({ status: "failed" });
    expect(capability.snapshot().testSetProjects).toEqual([]);
    capability.dispose();
  });

  it("hard-caps a large requested project scope and persists an honest omission count", async () => {
    const changed = new vscode.EventEmitter<void>();
    const list = vi.fn((projectKey: string) => Promise.resolve({
      projectKey, testSets: [], complete: true, truncated: false, errors: [],
    }));
    const cache = new XrayOrganizationCache(memento(), {
      endpoint: "xray.example", account: () => Promise.resolve("account-a"), workspaceId: "ws",
    });
    const capability = new XrayOrganizationCapability({
      reader: { list, refresh: vi.fn() } as unknown as XrayOrganizationReader,
      metadata: metadata(),
      cache,
      config: { xrayCacheTtlMinutes: 15 } as ExtensionConfig,
      logger: Logger.create(), account: () => Promise.resolve("account-a"),
      onCredentialsChange: changed.event, projectOf: (key) => key.split("-")[0] ?? key,
    });
    await new Promise((resolve) => setImmediate(resolve));
    const requested = Array.from({ length: 10_000 }, (_, index) => `P${index}`);

    await capability.sync(requested);

    expect(list).toHaveBeenCalledTimes(ORGANIZATION_SYNC_PROJECT_LIMIT);
    expect(capability.snapshot().testSetProjects).toHaveLength(ORGANIZATION_SYNC_PROJECT_LIMIT);
    expect(capability.snapshot().omittedTestSetProjectCount).toBe(requested.length - ORGANIZATION_SYNC_PROJECT_LIMIT);
    expect(cache.loadForAccount("account-a")?.projects).toHaveLength(ORGANIZATION_SYNC_PROJECT_LIMIT);
    expect(cache.loadForAccount("account-a")?.omittedTestSetProjectCount).toBe(requested.length - ORGANIZATION_SYNC_PROJECT_LIMIT);
    capability.dispose();
  });

  it("counts requested and item-bound project omissions together after retaining complete sets", async () => {
    const cache = new XrayOrganizationCache(memento(), {
      endpoint: "xray.example", account: () => Promise.resolve("account-a"), workspaceId: "ws",
    });
    const sets = [9_999, 9_998].map((count, index) => ({
      ...SHOP_301,
      key: `SHOP-${index + 301}`,
      issueId: String(index + 301),
      members: Array.from({ length: count }, (_, member) => ({ key: `SHOP-${(index + 2) * 10_000 + member}` })),
      remoteMemberCount: count,
    }));
    await cache.save("account-a", { syncedAt: 1, projects: [project(sets)], omittedTestSetProjectCount: 0 });
    const list = vi.fn((projectKey: string) => Promise.resolve(projectKey === "SHOP"
      ? project(sets.map((set) => ({
        ...set, members: set.members.slice(0, 50), membershipComplete: false, truncated: true,
      })))
      : { projectKey, testSets: [], complete: true, truncated: false, errors: [] }));
    const capability = new XrayOrganizationCapability({
      reader: { list, refresh: vi.fn() } as unknown as XrayOrganizationReader,
      metadata: metadata(), cache,
      config: { xrayCacheTtlMinutes: 15 } as ExtensionConfig,
      logger: Logger.create(), account: () => Promise.resolve("account-a"),
      onCredentialsChange: new vscode.EventEmitter<void>().event,
      projectOf: (key) => key.split("-")[0] ?? key,
    });
    await new Promise<void>((resolve) => {
      if (capability.snapshot().testSetProjects.length) {resolve(); return;}
      const subscription = capability.onDidChange(() => {subscription.dispose(); resolve();});
    });

    await capability.sync(["SHOP", ...Array.from({ length: 9 }, (_, index) => `P${index + 1}`)]);

    const live = capability.snapshot();
    const saved = cache.loadForAccount("account-a");
    expect(list).toHaveBeenCalledTimes(ORGANIZATION_SYNC_PROJECT_LIMIT);
    expect(live.testSetProjects.map((item) => item.projectKey)).toEqual(["SHOP"]);
    expect(live.testSetProjects[0]?.testSets.map((set) => set.members.length)).toEqual([9_999, 9_998]);
    expect(live.omittedTestSetProjectCount).toBe(9);
    expect(saved?.omittedTestSetProjectCount).toBe(9);
    expect(saved?.projects).toEqual(live.testSetProjects);
    capability.dispose();
  });

  it("keeps the omitted-project count on the current bounding across repeated refreshes", async () => {
    const cache = new XrayOrganizationCache(memento(), {
      endpoint: "xray.example", account: () => Promise.resolve("account-a"), workspaceId: "ws",
    });
    const projects = ["P1", "P2", "P3", "P4"].map((projectKey) => ({
      projectKey,
      testSets: [{ ...SHOP_301, key: `${projectKey}-301`, issueId: `${projectKey}-301` }],
      complete: true, truncated: false, errors: [],
    }));
    await cache.save("account-a", { syncedAt: 1, projects, omittedTestSetProjectCount: 0 });
    const capability = new XrayOrganizationCapability({
      reader: {
        list: vi.fn(),
        refresh: vi.fn().mockResolvedValue({ ...SHOP_301, key: "P4-301", issueId: "P4-301" }),
      } as unknown as XrayOrganizationReader,
      metadata: metadata(), cache,
      config: { xrayCacheTtlMinutes: 15 } as ExtensionConfig,
      logger: Logger.create(), account: () => Promise.resolve("account-a"),
      onCredentialsChange: new vscode.EventEmitter<void>().event,
      projectOf: (key) => key.split("-")[0] ?? key, now: () => 3,
    });
    await new Promise((resolve) => setImmediate(resolve));
    expect(capability.snapshot().omittedTestSetProjectCount).toBe(1);

    await capability.refreshTestSet("P4-301");
    await capability.refreshTestSet("P4-301");

    expect(capability.snapshot().omittedTestSetProjectCount).toBe(1);
    expect(cache.loadForAccount("account-a")?.omittedTestSetProjectCount).toBe(1);
    capability.dispose();
  });

  it("hard-caps repository tests in the combined organization snapshot", async () => {
    const tests = new Map(Array.from({ length: ORGANIZATION_ITEM_LIMIT + 100 }, (_, index) => [
      `SHOP-${index}`, { key: `SHOP-${index}` },
    ]));
    const capability = new XrayOrganizationCapability({
      reader: { list: vi.fn(), refresh: vi.fn() } as unknown as XrayOrganizationReader,
      metadata: metadata({ ...EMPTY_METADATA, tests, catalogueProjects: ["SHOP"], completeProjects: ["SHOP"] }),
      cache: new XrayOrganizationCache(memento(), { endpoint: "xray.example", account: () => Promise.resolve("account-a"), workspaceId: "ws" }),
      config: { xrayCacheTtlMinutes: 15 } as ExtensionConfig,
      logger: Logger.create(), account: () => Promise.resolve("account-a"), onCredentialsChange: new vscode.EventEmitter<void>().event,
      projectOf: () => "SHOP",
    });
    await new Promise((resolve) => setImmediate(resolve));

    const repository = capability.snapshot().repositories[0];

    expect(repository?.tests).toHaveLength(ORGANIZATION_ITEM_LIMIT - 1);
    expect(repository).toMatchObject({ complete: false, truncated: true });
    capability.dispose();
  });

  it("reads repository truncation from the metadata flag, never from the error prose", async () => {
    const repositoryFor = (snapshot: RemoteMetadataSnapshot): RepositoryProject | undefined => {
      const capability = new XrayOrganizationCapability({
        reader: { list: vi.fn(), refresh: vi.fn() } as unknown as XrayOrganizationReader,
        metadata: metadata(snapshot),
        cache: new XrayOrganizationCache(memento(), { endpoint: "xray.example", account: () => Promise.resolve("account-a"), workspaceId: "ws" }),
        config: { xrayCacheTtlMinutes: 15 } as ExtensionConfig,
        logger: Logger.create(), account: () => Promise.resolve("account-a"), onCredentialsChange: new vscode.EventEmitter<void>().event,
        projectOf: () => "SHOP",
      });
      const repository = capability.snapshot().repositories[0];
      capability.dispose();
      return repository;
    };
    const partial = {
      ...EMPTY_METADATA,
      tests: new Map([["SHOP-1", { key: "SHOP-1" }]]),
      catalogueProjects: ["SHOP"],
      completeProjects: [],
    };

    expect(repositoryFor({ ...partial, truncated: true })).toMatchObject({ complete: false, truncated: true });
    expect(repositoryFor({
      ...partial,
      errors: ['project = "SHOP": reached the 10000-item pagination cap; scope truncated, marked incomplete'],
    })).toMatchObject({ complete: false, truncated: false });
  });

  it("notifies consumers only after a guarded exact refresh commit", async () => {
    const changed = new vscode.EventEmitter<void>();
    const capability = new XrayOrganizationCapability({
      reader: { list: vi.fn(), refresh: vi.fn().mockResolvedValue(SHOP_301) } as unknown as XrayOrganizationReader,
      metadata: metadata(),
      cache: new XrayOrganizationCache(memento(), { endpoint: "xray.example", account: () => Promise.resolve("account-a"), workspaceId: "ws" }),
      config: { xrayCacheTtlMinutes: 15 } as ExtensionConfig,
      logger: Logger.create(), account: () => Promise.resolve("account-a"), onCredentialsChange: changed.event,
      projectOf: () => "SHOP",
    });
    await new Promise((resolve) => setImmediate(resolve));
    const notified = vi.fn();
    capability.onDidChange(notified);

    await expect(capability.refreshTestSet("SHOP-301")).resolves.toMatchObject({ status: "complete" });

    expect(notified).toHaveBeenCalledOnce();
    capability.dispose();
  });

  it("does not notify consumers for a cancelled exact refresh", async () => {
    const controller = new AbortController();
    const capability = new XrayOrganizationCapability({
      reader: { list: vi.fn(), refresh: vi.fn((_key, signal?: AbortSignal) => new Promise((_resolve, reject) => signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true }))) } as unknown as XrayOrganizationReader,
      metadata: metadata(),
      cache: new XrayOrganizationCache(memento(), { endpoint: "xray.example", account: () => Promise.resolve("account-a"), workspaceId: "ws" }),
      config: { xrayCacheTtlMinutes: 15 } as ExtensionConfig,
      logger: Logger.create(), account: () => Promise.resolve("account-a"), onCredentialsChange: new vscode.EventEmitter<void>().event,
      projectOf: () => "SHOP",
    });
    await new Promise((resolve) => setImmediate(resolve));
    const notified = vi.fn();
    capability.onDidChange(notified);

    const pending = capability.refreshTestSet("SHOP-301", controller.signal);
    controller.abort();
    await expect(pending).resolves.toMatchObject({ status: "failed" });

    expect(notified).not.toHaveBeenCalled();
    capability.dispose();
  });

  // The refresh hangs until the test releases it, so what each caller gets is decided by the abort
  // bookkeeping and not by a race with the reader.
  function heldRefresh(): {
    capability: XrayOrganizationCapability;
    signal: () => AbortSignal | undefined;
    release: () => void;
  } {
    let taken: AbortSignal | undefined;
    let settle: (() => void) | undefined;
    const capability = new XrayOrganizationCapability({
      reader: {
        list: vi.fn(),
        refresh: vi.fn((_key: string, signal?: AbortSignal) => new Promise((resolve, reject) => {
          taken = signal;
          settle = () => resolve(SHOP_301);
          signal?.addEventListener("abort", () => reject(new Error("cancelled")), { once: true });
        })),
      } as unknown as XrayOrganizationReader,
      metadata: metadata(),
      cache: new XrayOrganizationCache(memento(), { endpoint: "xray.example", account: () => Promise.resolve("account-a"), workspaceId: "ws" }),
      config: { xrayCacheTtlMinutes: 15 } as ExtensionConfig,
      logger: Logger.create(), account: () => Promise.resolve("account-a"), onCredentialsChange: new vscode.EventEmitter<void>().event,
      projectOf: () => "SHOP",
    });
    return { capability, signal: () => taken, release: (): void => settle?.() };
  }

  it("completes a shared refresh for the callers still waiting after one abandons it", async () => {
    const abandoned = new AbortController();
    const waiting = new AbortController();
    const held = heldRefresh();
    await new Promise((resolve) => setImmediate(resolve));

    const first = held.capability.refreshTestSet("SHOP-301", abandoned.signal);
    const second = held.capability.refreshTestSet("SHOP-301", waiting.signal);
    abandoned.abort();
    await new Promise((resolve) => setImmediate(resolve));
    held.release();

    await expect(second).resolves.toMatchObject({ status: "complete" });
    await expect(first).resolves.toMatchObject({ status: "complete" });
    expect(held.signal()?.aborted).toBe(false);
    held.capability.dispose();
  });

  it("holds a shared refresh open for a caller that brought no signal to abandon it with", async () => {
    const abandoned = new AbortController();
    const held = heldRefresh();
    await new Promise((resolve) => setImmediate(resolve));

    const anonymous = held.capability.refreshTestSet("SHOP-301");
    const signalled = held.capability.refreshTestSet("SHOP-301", abandoned.signal);
    abandoned.abort();
    await new Promise((resolve) => setImmediate(resolve));
    held.release();

    await expect(anonymous).resolves.toMatchObject({ status: "complete" });
    await expect(signalled).resolves.toMatchObject({ status: "complete" });
    expect(held.signal()?.aborted).toBe(false);
    held.capability.dispose();
  });

  it("cancels a shared refresh once every caller has abandoned it", async () => {
    const first = new AbortController();
    const second = new AbortController();
    const held = heldRefresh();
    await new Promise((resolve) => setImmediate(resolve));

    const pending = [
      held.capability.refreshTestSet("SHOP-301", first.signal),
      held.capability.refreshTestSet("SHOP-301", second.signal),
    ];
    await new Promise((resolve) => setImmediate(resolve));
    first.abort();
    second.abort();

    await expect(Promise.all(pending)).resolves.toMatchObject([{ status: "failed" }, { status: "failed" }]);
    expect(held.signal()?.aborted).toBe(true);
    held.capability.dispose();
  });
});

describe("organization refresh failure boundaries", () => {
  async function fixture(cached = true, account = vi.fn().mockResolvedValue("account-a")) {
    const cache = new XrayOrganizationCache(memento(), { endpoint: "xray.example", account: () => Promise.resolve("account-a"), workspaceId: "ws" });
    if (cached) { await cache.save("account-a", { syncedAt: 1, projects: [project([SHOP_301])], omittedTestSetProjectCount: 0 }); }
    const reader = { list: vi.fn().mockResolvedValue(project([SHOP_301])), refresh: vi.fn().mockResolvedValue(SHOP_301) };
    const changed = new vscode.EventEmitter<void>();
    const capability = new XrayOrganizationCapability({ reader: reader as unknown as XrayOrganizationReader,
      metadata: metadata(), cache, config: { xrayCacheTtlMinutes: 15 } as ExtensionConfig,
      logger: Logger.create(), account, onCredentialsChange: changed.event, projectOf: () => "SHOP", now: () => 3 });
    await vi.waitFor(() => expect(account).toHaveBeenCalled());
    return { capability, reader, cache, changed, account };
  }

  it.each(["read", "save"] as const)("retains cached organization when cancellation arrives during the final %s", async (stage) => {
    const h = await fixture();
    const abort = new AbortController();
    if (stage === "read") {
      h.reader.list.mockImplementation(async () => { abort.abort(); return project([]); });
    } else {
      vi.spyOn(h.cache, "save").mockImplementation(async () => { abort.abort(); });
      h.reader.list.mockResolvedValue(project([]));
    }
    try {
      await h.capability.sync(["SHOP"], abort.signal);
      expect(h.capability.snapshot().testSetProjects[0]?.testSets).toEqual([SHOP_301]);
    } finally { await h.capability.dispose(); h.changed.dispose(); }
  });

  it.each(["startup", "rotation"])("does not warn when a pending %s account lookup fails after disposal", async (stage) => {
    let reject!: (error: Error) => void;
    const pending = new Promise<string>((_resolve, fail) => {reject = fail;});
    const account = vi.fn().mockReturnValue(pending);
    const h = stage === "startup" ? await fixture(false, account) : await fixture();
    const warn = vi.spyOn(Logger.prototype, "warn");
    try {
      if (stage === "rotation") {h.account.mockReturnValue(pending); h.changed.fire();}
      await h.capability.dispose();
      reject(new Error("credential store closed"));
      await expect(pending).rejects.toThrow("credential store closed");
      expect(warn).not.toHaveBeenCalled();
      expect(h.reader.list).not.toHaveBeenCalled();
      expect(h.reader.refresh).not.toHaveBeenCalled();
    } finally {warn.mockRestore(); h.changed.dispose();}
  });

  it("logs an account lookup failure after credential rotation without restoring old data", async () => {
    const h = await fixture();
    const logger = vi.spyOn(Logger.prototype, "warn");
    h.account.mockRejectedValue(new Error("credential store unavailable"));
    try {
      h.changed.fire();
      await vi.waitFor(() => expect(logger).toHaveBeenCalledWith(expect.stringContaining("account lookup failed")));
      expect(h.capability.snapshot().testSetProjects).toEqual([]);
    } finally { logger.mockRestore(); await h.capability.dispose(); h.changed.dispose(); }
  });

  it("does not start an exact refresh after its pending account lookup is cancelled", async () => {
    const h = await fixture();
    let resolveAccount!: (value: string) => void;
    const account = new Promise<string>((resolve) => { resolveAccount = resolve; });
    h.account.mockReturnValue(account);
    h.changed.fire();
    const abort = new AbortController();
    const pending = h.capability.refreshTestSet("SHOP-301", abort.signal);
    abort.abort();
    resolveAccount("account-b");
    try {
      await expect(pending).resolves.toMatchObject({ status: "failed" });
      expect(h.reader.refresh).not.toHaveBeenCalled();
    } finally { await h.capability.dispose(); h.changed.dispose(); }
  });

  it("caps a catalogue that fills the item budget exactly before another set", async () => {
    const h = await fixture(false);
    const full = { ...SHOP_301,
      members: Array.from({ length: ORGANIZATION_ITEM_LIMIT - 2 }, (_, index) => ({ key: `SHOP-${index + 1000}` })),
      remoteMemberCount: ORGANIZATION_ITEM_LIMIT - 2,
    };
    h.reader.list.mockResolvedValue(project([full, { ...SHOP_301, key: "SHOP-302" }]));
    try {
      await h.capability.sync(["SHOP"]);
      expect(h.capability.snapshot().testSetProjects[0]).toMatchObject({
        complete: false, truncated: true, testSets: [full],
      });
    } finally { await h.capability.dispose(); h.changed.dispose(); }
  });

  it.each([true, false])("reports sync failure with last-known data available: %s", async cached => {
    const h = await fixture(cached);
    h.reader.list.mockRejectedValue(new Error("offline"));
    try {
      await h.capability.sync(["SHOP"]);
      const value = h.capability.snapshot().testSetProjects[0]!;
      expect(value.complete).toBe(false);
      expect(value.testSets.map(set => set.key)).toEqual(cached ? ["SHOP-301"] : []);
      expect(value.errors[0]).toContain(cached ? "last-known" : "refresh failed");
    } finally { await h.capability.dispose(); h.changed.dispose(); }
  });

  it.each([true, false])("retains only known sets when a partial catalogue omits them (cached: %s)", async cached => {
    const h = await fixture(cached);
    h.reader.list.mockResolvedValue({ ...project([]), complete: false });
    try {
      await h.capability.sync(["SHOP"]);
      expect(h.capability.snapshot().testSetProjects[0]?.testSets.map(set => set.key)).toEqual(cached ? ["SHOP-301"] : []);
    } finally { await h.capability.dispose(); h.changed.dispose(); }
  });

  it("retains known member details while marking a larger partial catalogue incomplete", async () => {
    const h = await fixture();
    h.reader.list.mockResolvedValue(project([{ ...SHOP_301, members: [], remoteMemberCount: 8, membershipComplete: false, truncated: false }]));
    try {
      await h.capability.sync(["SHOP"]);
      expect(h.capability.snapshot().testSetProjects[0]?.testSets[0]).toMatchObject({
        members: SHOP_301.members, remoteMemberCount: 8, membershipComplete: false, truncated: true, membersLastKnown: true,
      });
    } finally { await h.capability.dispose(); h.changed.dispose(); }
  });

  it.each([true, false])("reports incomplete exact membership with prior data available: %s", async cached => {
    const h = await fixture(cached);
    const partial = { ...SHOP_301, members: [], membershipComplete: false };
    h.reader.refresh.mockResolvedValue(partial);
    try {
      const result = await h.capability.refreshTestSet("SHOP-301");
      expect(result.status).toBe("incomplete");
      expect(result.testSet).toEqual(cached ? SHOP_301 : partial);
      expect(h.capability.snapshot().testSetProjects.flatMap(p => p.testSets)).toEqual(cached ? [SHOP_301] : []);
    } finally { await h.capability.dispose(); h.changed.dispose(); }
  });

  it("reports a failed exact refresh and retains its cached membership", async () => {
    const h = await fixture();
    h.reader.refresh.mockRejectedValue(new Error("offline"));
    try {
      await expect(h.capability.refreshTestSet("SHOP-301")).resolves.toEqual({ status: "failed", testSet: SHOP_301 });
    } finally { await h.capability.dispose(); h.changed.dispose(); }
  });

  it("starts no read for an already cancelled sync or exact refresh", async () => {
    const h = await fixture();
    const controller = new AbortController(); controller.abort();
    try {
      await h.capability.sync(["SHOP"], controller.signal);
      await expect(h.capability.refreshTestSet("SHOP-301", controller.signal)).resolves.toEqual({ status: "failed", testSet: SHOP_301 });
      expect(h.reader.list).not.toHaveBeenCalled();
      expect(h.reader.refresh).not.toHaveBeenCalled();
    } finally { await h.capability.dispose(); h.changed.dispose(); }
  });

  it("does not replace cached data when cancellation lands during a successful remote read", async () => {
    const h = await fixture();
    const controller = new AbortController();
    h.reader.list.mockImplementation(() => { controller.abort(); return Promise.resolve(project([])); });
    try {
      await h.capability.sync(["SHOP", "NEXT"], controller.signal);
      expect(h.reader.list).toHaveBeenCalledTimes(1);
      expect(h.capability.snapshot().testSetProjects[0]?.testSets).toEqual([SHOP_301]);
    } finally { await h.capability.dispose(); h.changed.dispose(); }
  });

  it("does not replace cached data when the cancelled remote read rejects", async () => {
    const h = await fixture();
    const controller = new AbortController();
    h.reader.list.mockImplementation(() => { controller.abort(); return Promise.reject(new Error("cancelled")); });
    try {
      await h.capability.sync(["SHOP"], controller.signal);
      expect(h.capability.snapshot().testSetProjects[0]?.testSets).toEqual([SHOP_301]);
    } finally { await h.capability.dispose(); h.changed.dispose(); }
  });
});


describe("organization startup account identity", () => {
  it.each(["sync", "refresh"] as const)("does not start %s when its account lookup disagrees with the loaded cache", async (operation) => {
    const cache = new XrayOrganizationCache(memento(), { endpoint: "xray.example", account: () => Promise.resolve("account-a"), workspaceId: "ws" });
    await cache.save("account-a", { syncedAt: 1, projects: [project([SHOP_301])], omittedTestSetProjectCount: 0 });
    let loadAccount!: (value: string) => void;
    let requestAccount!: (value: string) => void;
    const account = vi.fn<() => Promise<string>>()
      .mockReturnValueOnce(new Promise((resolve) => { loadAccount = resolve; }))
      .mockReturnValueOnce(new Promise((resolve) => { requestAccount = resolve; }));
    const reader = { list: vi.fn(), refresh: vi.fn() };
    const changed = new vscode.EventEmitter<void>();
    const capability = new XrayOrganizationCapability({
      reader: reader as unknown as XrayOrganizationReader, metadata: metadata(), cache,
      config: { xrayCacheTtlMinutes: 15 } as ExtensionConfig, logger: Logger.create(), account,
      onCredentialsChange: changed.event, projectOf: () => "SHOP",
    });
    const loaded = new Promise<void>((resolve) => {
      const subscription = capability.onDidChange(() => { subscription.dispose(); resolve(); });
    });
    const pending = operation === "sync" ? capability.sync(["SHOP"]) : capability.refreshTestSet("SHOP-301");
    loadAccount("account-a");
    await loaded;
    requestAccount("account-b");
    await pending;
    expect(reader.list).not.toHaveBeenCalled();
    expect(reader.refresh).not.toHaveBeenCalled();
    expect(capability.snapshot().testSetProjects).toEqual([project([SHOP_301])]);
    expect(cache.loadForAccount("account-b")).toBeUndefined();
    await capability.dispose(); changed.dispose();
  });

  it("does not persist organization data without an account identity", async () => {
    const store = memento();
    const cache = new XrayOrganizationCache(store, { endpoint: "xray.example", account: () => Promise.resolve(undefined), workspaceId: "ws" });
    await cache.save(undefined, { syncedAt: 1, projects: [project([SHOP_301])], omittedTestSetProjectCount: 0 });
    expect(store.keys()).toEqual([]);
    expect(cache.loadForAccount(undefined)).toBeUndefined();
  });
});
