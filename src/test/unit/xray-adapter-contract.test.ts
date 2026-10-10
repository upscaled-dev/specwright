import * as vscode from "vscode";
import { describe, expect, it } from "vitest";
import { AdapterContractHarness, runAdapterContractTests } from "./helpers/adapter-contract-suite";
import { FeatureParser } from "../../parsers/feature-parser";
import { ExtensionConfig } from "../../core/extension-config";
import { Logger, LogLevel } from "../../utils/logger";
import { XrayAdapter } from "../../xray/xray-adapter";
import { XrayClient, XrayFetchOutcome, XrayTestRecord } from "../../xray/xray-client";
import { XrayMetadataCapability } from "../../xray/xray-metadata";
import { XrayMetadataCache } from "../../xray/xray-metadata-cache";
import { XrayCredentialStore } from "../../xray/xray-credential-store";
import { TestCaseMetadata, type TraceabilityAdapter } from "../../traceability/contracts";
import { buildTraceabilitySnapshot } from "../../traceability/traceability-model";
import { projectTraceabilityOrganization } from "../../traceability/traceability-organization-projection";
import { validatedAdapter } from "../../traceability/validated-adapter";
import { XrayOrganizationCache, XrayOrganizationCapability, XrayOrganizationReader } from "../../xray/xray-organization";
import { trustedWorkspace } from "./helpers/test-workspace-trust";
import { currentAdapterVersions } from "../../traceability/adapter-contract";

const SITE = "acme.atlassian.net";

// A mocked transport standing in for XrayClient: `seed`/`seedError` decide what the next sync's
// fetch returns, so the contract suite drives whole/short/error catalogues without a network. A
// project outside `landed` pages short, which is how a per-project partial reaches the capability.
class ControllableClient {
  private tests: XrayTestRecord[] = [];
  private landed: string[] = [];
  private errors: string[] = [];

  public seed(tests: readonly TestCaseMetadata[], landedProjects: readonly string[]): void {
    this.tests = tests.map((test) => ({ ...test }));
    this.landed = [...landedProjects];
    this.errors = [];
  }

  public seedError(message: string): void {
    this.tests = [];
    this.landed = [];
    this.errors = [message];
  }

  private outcome(complete: boolean, tests = this.tests): XrayFetchOutcome {
    return { tests: [...tests], pages: [], complete, truncated: false, errors: [...this.errors] };
  }

  public fetchProjectCatalogue(projectKey: string): Promise<XrayFetchOutcome> {
    return Promise.resolve(this.outcome(
      this.landed.includes(projectKey),
      this.tests.filter((test) => test.key.startsWith(`${projectKey}-`))
    ));
  }

  public fetchTestsByKeys(): Promise<XrayFetchOutcome> {
    return Promise.resolve(this.outcome(this.errors.length === 0));
  }

  public invalidateAuth(): void {
    /* no-op: this fake never holds a JWT */
  }
}

function mapSecretStorage(): vscode.SecretStorage {
  const map = new Map<string, string>();
  return {
    get: (key: string): Promise<string | undefined> => Promise.resolve(map.get(key)),
    store: (key: string, value: string): Promise<void> => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string): Promise<void> => {
      map.delete(key);
      return Promise.resolve();
    },
  } as unknown as vscode.SecretStorage;
}

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

function harnessConfig(): ExtensionConfig {
  return {
    get xraySiteUrl(): string { return SITE; },
    get xrayCacheTtlMinutes(): number { return 15; },
    get traceabilityTestTagPrefix(): string { return "TEST_"; },
    get traceabilityReqTagPrefix(): string { return "REQ_"; },
  } as unknown as ExtensionConfig;
}

function xrayHarness(): AdapterContractHarness {
  const client = new ControllableClient();
  const credentialStore = new XrayCredentialStore(mapSecretStorage(), trustedWorkspace());
  const config = harnessConfig();
  const cache = new XrayMetadataCache(fakeMemento(), {
    endpoint: "xray.cloud.getxray.app",
    account: () => Promise.resolve("account"),
    workspaceId: "ws",
  });
  const metadata = new XrayMetadataCapability({
    client: client as unknown as XrayClient,
    cache,
    config,
    logger: Logger.create(undefined, LogLevel.ERROR),
    account: () => Promise.resolve("account"),
    onCredentialsChange: credentialStore.onDidChange,
    listProjects: () => Promise.resolve(undefined),
  });
  const targets: Array<{ id: string; label: string; ref: { key: string } }> = [];
  const adapter = new XrayAdapter(config, {
    credentialStore,
    verify: () => Promise.resolve({ status: "ok", message: "ok" }),
    metadata,
    resultPublishing: {
      searchTargets: (kind) => Promise.resolve(kind === "project" ? [] : [...targets]),
      publish: (artifact, request) => {
        const key = request.mode === "append" ? request.executionKey : `${request.project}-1`;
        if (!targets.some((target) => target.ref.key === key)) {
          targets.push({ id: key, label: key, ref: { key } });
        }
        return Promise.resolve({
          ref: { kind: "execution" as const, key },
          imported: artifact.results.length,
          warnings: [],
        });
      },
    },
  });

  return {
    adapter,
    factory: {
      id: "xray",
      ...currentAdapterVersions("connection", "metadata", "automationBinding", "resultPublishing"),
      create: () => adapter,
    },
    services: { config, logger: Logger.create(undefined, LogLevel.ERROR) },
    connect: () => credentialStore.setCredentials(SITE, "id", "secret"),
    disconnect: () => credentialStore.clearCredentials(SITE),
    seedCatalogue: (tests, landedProjects) => client.seed(tests, landedProjects),
    seedSyncError: (message) => client.seedError(message),
    // A project scope makes a full-catalogue fetch authoritative enough to derive orphans; the second
    // project is the sibling the suite lets fall short. The seeded keys belong to CALC.
    syncScope: { projectKeys: ["CALC", "MATH"] },
    grammarSample: { tags: ["@TEST_calc-1", "@TEST_CALC-2", "@REQ_calc-9"], testKeys: ["CALC-1", "CALC-2"], reqKeys: ["CALC-9"] },
    mappedKey: "CALC-1",
    orphanKey: "CALC-9",
    makeArtifact: () => ({
      id: "run",
      createdAt: 1,
      results: [{
        testKey: "CALC-1",
        outcome: "passed",
        scenario: { filePath: "/ws/a.feature", line: 3, name: "S", kind: "scenario" },
        durationMs: 5,
        attempts: 1,
        flaky: false,
        evidenceRefs: [],
      }],
      shards: [],
      selection: { kind: "all-mapped" },
      preflight: [],
      state: "complete",
    }),
    publishRequest: { mode: "append", executionKey: "EXEC-1" },
  };
}

runAdapterContractTests(xrayHarness);

function richTest(project: string, index: number, coverageCount = 1): TestCaseMetadata {
  return {
    key: `${project}-${index}`,
    issueId: String(index),
    summary: `Calculation ${index}`,
    status: { category: "passed", providerValue: "PASS", color: "#0f0" },
    gherkin: "Scenario: Calculate\n  Given two numbers",
    coverageKeys: Array.from({ length: coverageCount }, (_, key) => `REQ-${index}-${key}`),
    repositoryFolder: { name: "Smoke", path: "/Smoke" },
    testType: { name: "Cucumber", kind: "Gherkin" },
  };
}

describe("populated Xray snapshot boundary", () => {
  it("carries a mapped test from a rich synced catalogue into metadata and repository consumers", async () => {
    const harness = xrayHarness();
    const tests = Array.from({ length: 3_000 }, (_, index) => richTest("CALC", index + 1));
    harness.seedCatalogue(tests, ["CALC"]);
    const sourceMetadata = harness.adapter.metadata!;
    const organization = new XrayOrganizationCapability({
      reader: new XrayOrganizationReader({ readGraphql: () => Promise.resolve({ data: { getTestSets: { total: 0, results: [] } } }) }),
      metadata: sourceMetadata,
      cache: new XrayOrganizationCache(fakeMemento(), { endpoint: "xray.cloud.getxray.app", account: () => Promise.resolve("account"), workspaceId: "ws" }),
      config: harness.services.config,
      logger: harness.services.logger,
      account: () => Promise.resolve("account"),
      onCredentialsChange: new vscode.EventEmitter<void>().event,
      projectOf: (key) => key.split("-")[0]!,
    });
    const source: TraceabilityAdapter = {
      id: "xray", label: "Xray", keyGrammar: harness.adapter.keyGrammar,
      browseUrl: harness.adapter.browseUrl, metadata: sourceMetadata, organization,
    };
    const adapter = validatedAdapter(source, () => Promise.resolve(), () => undefined);
    try {
      await adapter.metadata!.sync({ projectKeys: ["CALC"] });
      const remote = adapter.metadata!.snapshot();
      const parsed = FeatureParser.create().parseFeatureContent("Feature: Calculations\n\n@TEST_CALC-3000\nScenario: Calculate\n  Given two numbers\n");
      const model = buildTraceabilitySnapshot([{ filePath: "/ws/calculations.feature", scenarios: parsed?.scenarios ?? [] }], {}, adapter.keyGrammar, remote);
      expect(model.links.find((link) => link.testKey === "CALC-3000")?.meta?.summary).toBe("Calculation 3000");

      const repository = adapter.organization!.snapshot();
      const projection = projectTraceabilityOrganization(repository, model);
      expect(projection.rows.find((row) => row.label === "CALC-3000")?.description).toContain("Calculation 3000");
    } finally {
      organization.dispose();
      await harness.adapter.dispose?.();
    }
  });

  it("carries a fully populated test from the third complete project beyond 20,000 tests", async () => {
    const harness = xrayHarness();
    const tests = ["CALC", "MATH", "SHOP"].flatMap((project) =>
      Array.from({ length: 10_000 }, (_, index) => richTest(project, index + 1, 20))
    );
    harness.seedCatalogue(tests, ["CALC", "MATH", "SHOP"]);
    const source: TraceabilityAdapter = {
      id: "xray", label: "Xray", keyGrammar: harness.adapter.keyGrammar,
      browseUrl: harness.adapter.browseUrl, metadata: harness.adapter.metadata,
    };
    const adapter = validatedAdapter(source, () => Promise.resolve(), () => undefined);
    try {
      await adapter.metadata!.sync({ projectKeys: ["CALC", "MATH", "SHOP"] });
      const snapshot = adapter.metadata!.snapshot();
      expect(snapshot.tests.size).toBe(30_000);
      expect(snapshot.tests.get("SHOP-10000")?.coverageKeys).toHaveLength(20);
      expect(snapshot.completeProjects).toEqual(["CALC", "MATH", "SHOP"]);
      expect(snapshot.truncated).toBe(false);
      const parsed = FeatureParser.create().parseFeatureContent("Feature: Shop\n\n@TEST_SHOP-10000\nScenario: Checkout\n  Given a cart\n");
      const model = buildTraceabilitySnapshot([{ filePath: "/ws/shop.feature", scenarios: parsed?.scenarios ?? [] }], {}, adapter.keyGrammar, snapshot);
      expect(model.links.find((link) => link.testKey === "SHOP-10000")?.meta?.summary).toBe("Calculation 10000");
    } finally {
      await harness.adapter.dispose?.();
    }
  });

  it("keeps every explicit key scope beyond 20,000 in a validated Xray snapshot", async () => {
    const harness = xrayHarness();
    const tests = Array.from({ length: 20_001 }, (_, index) => richTest("CALC", index + 1));
    const keys = tests.map((test) => test.key);
    harness.seedCatalogue(tests, []);
    const adapter = validatedAdapter(harness.adapter, () => Promise.resolve(), () => undefined);
    try {
      await adapter.metadata!.sync({ testKeys: keys });
      const remote = adapter.metadata!.snapshot();
      expect(remote.tests.size).toBe(20_001);
      expect(remote.fetchedScopes).toEqual(keys);
      expect(remote.verifiedAbsentKeys).toEqual([]);
      const parsed = FeatureParser.create().parseFeatureContent("Feature: Calculations\n\n@TEST_CALC-20001\nScenario: Last calculation\n  Given two numbers\n");
      const model = buildTraceabilitySnapshot([{ filePath: "/ws/last.feature", scenarios: parsed?.scenarios ?? [] }], {}, adapter.keyGrammar, remote);
      expect(model.links.find((link) => link.testKey === "CALC-20001")?.meta?.summary).toBe("Calculation 20001");
    } finally {
      await harness.adapter.dispose?.();
    }
  });

  it("keeps more than 20,000 verified absent keys even when no test was returned", async () => {
    const harness = xrayHarness();
    const keys = Array.from({ length: 20_001 }, (_, index) => `CALC-${index + 1}`);
    harness.seedCatalogue([], []);
    const adapter = validatedAdapter(harness.adapter, () => Promise.resolve(), () => undefined);
    try {
      await adapter.metadata!.sync({ testKeys: keys });
      const remote = adapter.metadata!.snapshot();
      expect(remote.tests.size).toBe(0);
      expect(remote.fetchedScopes).toEqual(keys);
      expect(remote.verifiedAbsentKeys).toEqual(keys);
      const parsed = FeatureParser.create().parseFeatureContent("Feature: Calculations\n\n@TEST_CALC-20001\nScenario: Missing calculation\n  Given two numbers\n");
      const model = buildTraceabilitySnapshot([{ filePath: "/ws/missing.feature", scenarios: parsed?.scenarios ?? [] }], {}, adapter.keyGrammar, remote);
      expect(model.links.find((link) => link.testKey === "CALC-20001")?.remoteMissing).toBe(true);
    } finally {
      await harness.adapter.dispose?.();
    }
  });

  it("uses native Map traversal and rejects entries added during validation", () => {
    const harness = xrayHarness();
    const guarded = new Map([["CALC-1", { key: "CALC-1" }]]);
    Object.defineProperty(guarded, "size", { get: () => {throw new Error("size override used");} });
    Object.defineProperty(guarded, "entries", { value: () => {throw new Error("iterator override used");} });
    const mutating = new Map<string, { key: string }>();
    mutating.set("CALC-1", {
      get key(): string {
        mutating.set("CALC-2", { key: "CALC-2" });
        return "CALC-1";
      },
    });
    const adapterFor = (tests: Map<string, { key: string }>): TraceabilityAdapter => validatedAdapter({
      id: "xray", label: "Xray", keyGrammar: harness.adapter.keyGrammar,
      browseUrl: harness.adapter.browseUrl,
      metadata: {
        onDidChange: new vscode.EventEmitter<void>().event,
        snapshot: () => ({ tests, fetchedScopes: [], catalogueProjects: [], completeProjects: [], verifiedAbsentKeys: [], stale: false, errors: [] }),
        sync: () => Promise.resolve(),
      },
    }, () => Promise.resolve(), () => undefined);

    expect(adapterFor(guarded).metadata!.snapshot().tests.get("CALC-1")?.key).toBe("CALC-1");
    expect(() => adapterFor(mutating).metadata!.snapshot()).toThrowError(
      'Integration adapter "xray" returned malformed metadata.snapshot response.'
    );
  });

  it("rejects malformed and growing metadata key lists", () => {
    const harness = xrayHarness();
    const scopes = ["CALC-1"];
    Object.defineProperty(scopes, 0, {
      get: () => {scopes.push("CALC-2"); return "CALC-1";},
    });
    const adapterFor = (fetchedScopes: unknown): TraceabilityAdapter => validatedAdapter({
      id: "xray", label: "Xray", keyGrammar: harness.adapter.keyGrammar,
      browseUrl: harness.adapter.browseUrl,
      metadata: {
        onDidChange: new vscode.EventEmitter<void>().event,
        snapshot: () => ({ tests: new Map(), fetchedScopes, catalogueProjects: [], completeProjects: [], verifiedAbsentKeys: [], stale: false, errors: [] }),
        sync: () => Promise.resolve(),
      },
    } as TraceabilityAdapter, () => Promise.resolve(), () => undefined);

    expect(() => adapterFor(["CALC-1", 2]).metadata!.snapshot()).toThrowError(
      'Integration adapter "xray" returned malformed metadata.snapshot response.'
    );
    expect(() => adapterFor(scopes).metadata!.snapshot()).toThrowError(
      'Integration adapter "xray" returned malformed metadata.snapshot response.'
    );
  });
});
