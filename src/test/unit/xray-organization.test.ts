import * as vscode from "vscode";
import { describe, expect, it, vi } from "vitest";
import type { ExtensionConfig } from "../../core/extension-config";
import { ORGANIZATION_ITEM_LIMIT, type MetadataCapability, type RemoteMetadataSnapshot, type TestSetProject } from "../../traceability/contracts";
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
});
