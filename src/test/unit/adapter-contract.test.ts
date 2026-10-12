import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import {
  AdapterContractHarness,
  runAdapterContractTests,
} from "./helpers/adapter-contract-suite";
import {
  createInMemoryAdapterFactory,
  InMemoryTraceabilityAdapter,
} from "../../traceability/in-memory-adapter";
import {
  AdapterContext,
  TraceabilityAdapterFactory,
  TraceabilityAdapterRegistry,
} from "../../traceability/adapter-registry";
import { currentAdapterVersions, IntegrationAdapterError } from "../../traceability/adapter-contract";
import { TraceabilitySubsystem } from "../../traceability/traceability-subsystem";
import { RunResultStore } from "../../traceability/run-result-store";
import { ConnectionCapability, RunArtifact, TraceabilityAdapter } from "../../traceability/contracts";
import { validatedAdapter } from "../../traceability/validated-adapter";
import { buildTraceabilitySnapshot } from "../../traceability/traceability-model";
import { FeatureParser } from "../../parsers/feature-parser";
import { TestDiscoveryManager } from "../../core/test-discovery-manager";
import { PlaywrightJsonParser } from "../../utils/playwright-json-parser";
import { Logger } from "../../utils/logger";
import { extractKeys } from "../../traceability/tag-extraction";
import type { ExtensionConfig } from "../../core/extension-config";

const fakeMemento = {
  get: () => undefined,
  update: () => Promise.resolve(),
  keys: () => [],
} as unknown as vscode.Memento;

function inMemoryHarness(): AdapterContractHarness {
  const adapter = new InMemoryTraceabilityAdapter({ label: "in-memory-fixture" });
  const factory: TraceabilityAdapterFactory = {
    id: "in-memory",
    ...currentAdapterVersions("connection", "metadata", "resultPublishing"),
    create: () => adapter,
  };
  return {
    adapter,
    factory,
    services: { config: {} as ExtensionConfig, logger: Logger.create() },
    connect: () => { adapter.setConnected(true); return Promise.resolve(); },
    disconnect: () => { adapter.setConnected(false); return Promise.resolve(); },
    seedCatalogue: (tests, landedProjects) => adapter.seedCatalogue(tests, landedProjects),
    seedSyncError: (message) => adapter.seedSyncError(message),
    syncScope: { projectKeys: ["FIXTURE", "OTHER"] },
    grammarSample: { tags: ["@TC-042", "@TC-7", "@RQ-3"], testKeys: ["42", "7"], reqKeys: ["3"] },
    mappedKey: "42",
    orphanKey: "77",
    makeArtifact: () => ({
      id: "run-1",
      createdAt: 1,
      results: [{
        testKey: "42",
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

runAdapterContractTests(inMemoryHarness);

describe("InMemoryTraceabilityAdapter specifics", () => {
  it("emits only actual connection changes and preserves its catalogue when sync is cancelled", async () => {
    const adapter = new InMemoryTraceabilityAdapter();
    const changed = vi.fn();
    adapter.connection.onDidChange(changed);
    adapter.setConnected(false);
    adapter.setConnected(true);
    adapter.setConnected(true);
    expect(changed).toHaveBeenCalledOnce();
    adapter.seedCatalogue([{ key: "1", summary: "Checkout" }], []);
    const controller = new AbortController();
    controller.abort();
    await adapter.metadata.sync({}, controller.signal);
    expect(adapter.metadata.snapshot().tests.size).toBe(0);
    await adapter.metadata.sync({});
    expect([...adapter.metadata.snapshot().tests.keys()]).toEqual(["1"]);
  });

  it("searches seeded executions by key or label while project search stays empty", async () => {
    const adapter = new InMemoryTraceabilityAdapter({ targets: [
      { id: "EXEC-9", label: "Nightly checkout", ref: { key: "EXEC-9" } },
    ] });
    await expect(adapter.resultPublishing.searchTargets("project", "nightly")).resolves.toEqual([]);
    await expect(adapter.resultPublishing.searchTargets("execution", "exec-9")).resolves.toMatchObject([{ id: "EXEC-9" }]);
    await expect(adapter.resultPublishing.searchTargets("execution", "checkout")).resolves.toMatchObject([{ id: "EXEC-9" }]);
    await expect(adapter.resultPublishing.searchTargets("execution", "missing")).resolves.toEqual([]);
  });
  it("uses a non-Jira grammar: numeric keys, no project derivation, leading-zero canonicalization", async () => {
    const adapter = new InMemoryTraceabilityAdapter();
    expect(adapter.keyGrammar.projectOf).toBeUndefined();
    expect(adapter.keyGrammar.canonicalizeKey("007")).toBe("7");
    expect(extractKeys(["@TC-042"], adapter.keyGrammar).testKeys).toEqual(["42"]);
    expect(extractKeys(["@CALC-1"], adapter.keyGrammar).testKeys).toEqual([]);
  });

  it("stores each published artifact against its target", async () => {
    const adapter = new InMemoryTraceabilityAdapter();
    const artifact: RunArtifact = {
      id: "run-9",
      createdAt: 5,
      results: [{
        testKey: "1",
        outcome: "failed",
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
    };
    const outcome = await adapter.resultPublishing.publish(artifact, { mode: "append", executionKey: "EXEC-9" });

    expect(outcome.ref.key).toBe("EXEC-9");
    expect(adapter.publications).toEqual([{ artifact, executionKey: "EXEC-9" }]);
    const targets = await adapter.resultPublishing.searchTargets("execution", "");
    expect(targets.map((t) => t.ref.key)).toContain("EXEC-9");
    const created = await adapter.resultPublishing.publish(artifact, { mode: "create-new", project: "CALC", summary: "Checkout" });
    expect(created.ref.key).toBe("CALC-1");
    await adapter.resultPublishing.publish(artifact, { mode: "append", executionKey: "CALC-1" });
    expect((await adapter.resultPublishing.searchTargets("execution", "")).filter((target) => target.ref.key === "CALC-1")).toHaveLength(1);
    expect(adapter.publications.slice(1)).toEqual([{ artifact, executionKey: "CALC-1" }, { artifact, executionKey: "CALC-1" }]);
  });

  it("keeps the last-known snapshot whole on a sync error, down to its catalogue scope", async () => {
    const adapter = new InMemoryTraceabilityAdapter();
    adapter.seedCatalogue([{ key: "42", summary: "kept" }], ["fixture"]);
    await adapter.metadata.sync({ projectKeys: ["fixture"], testKeys: ["42"] });
    expect(adapter.metadata.snapshot().completeProjects).toEqual(["FIXTURE"]);

    adapter.seedSyncError("boom");
    await adapter.metadata.sync({ projectKeys: ["fixture"], testKeys: ["42"] });
    const snap = adapter.metadata.snapshot();
    expect(snap.completeProjects).toEqual(["FIXTURE"]);
    expect(snap.catalogueProjects).toEqual(["FIXTURE"]);
    expect(snap.tests.get("42")?.summary).toBe("kept");
    expect(snap.errors).toEqual(["boom"]);
  });

  it("carries the uppercased catalogue project scope onto the snapshot", async () => {
    const adapter = new InMemoryTraceabilityAdapter();
    await adapter.metadata.sync({ projectKeys: ["calc", "MATH"], testKeys: ["42"] });
    expect(adapter.metadata.snapshot().catalogueProjects).toEqual(["CALC", "MATH"]);
  });

  it("leaves catalogueProjects empty when a sync carried no project scope", async () => {
    const adapter = new InMemoryTraceabilityAdapter();
    await adapter.metadata.sync({ testKeys: ["42"] });
    expect(adapter.metadata.snapshot().catalogueProjects).toEqual([]);
  });

  it("records queried keys absent from the seeded catalogue as verified-absent", async () => {
    const adapter = new InMemoryTraceabilityAdapter();
    adapter.seedCatalogue([{ key: "42", summary: "kept" }], ["fixture"]);
    await adapter.metadata.sync({ testKeys: ["42", "99"] });
    const snap = adapter.metadata.snapshot();
    expect(snap.verifiedAbsentKeys).toEqual(["99"]);
    expect(snap.tests.has("42")).toBe(true);
  });

  it("canonicalizes catalogue and scoped keys numerically when recording verified-absence", async () => {
    const adapter = new InMemoryTraceabilityAdapter();
    // The catalogue returns a leading-zero variant of key 7; the numeric grammar must treat "007" and
    // "7" as one key, so only the genuinely-absent 8 lands in the absent set. A plain uppercase
    // compare (the old behavior) would wrongly mark both queried keys absent.
    adapter.seedCatalogue([{ key: "007", summary: "kept" }], ["fixture"]);
    await adapter.metadata.sync({ testKeys: ["7", "008"] });
    expect(adapter.metadata.snapshot().verifiedAbsentKeys).toEqual(["8"]);
  });

  it("keeps model absence verdicts correct under a non-uppercasing grammar", async () => {
    const adapter = new InMemoryTraceabilityAdapter();
    adapter.seedCatalogue([{ key: "7", summary: "present" }], ["fixture"]);
    // The sync queries the non-canonical tag bodies the model later canonicalizes to 7 (present) and
    // 8 (verified absent).
    await adapter.metadata.sync({ testKeys: ["007", "008"] });

    const content = "Feature: F\n\n@TC-007\nScenario: a\n  Given x\n\n@TC-008\nScenario: b\n  Given y\n";
    const parsed = FeatureParser.create().parseFeatureContent(content);
    const feature = { filePath: "/ws/f.feature", scenarios: parsed?.scenarios ?? [] };
    const snap = buildTraceabilitySnapshot([feature], {}, adapter.keyGrammar, adapter.metadata.snapshot());

    const present = snap.links.find((l) => l.testKey === "7");
    const absent = snap.links.find((l) => l.testKey === "8");
    expect(present?.meta?.summary).toBe("present");
    expect(present?.remoteMissing).toBeUndefined();
    expect(absent?.remoteMissing).toBe(true);
  });
});

const ctx: AdapterContext = { config: {} as ExtensionConfig, logger: Logger.create() };

// `truncated` arrived after the metadata capability shipped, so an adapter written against the older
// shape omits it. The boundary must let that snapshot through rather than discard the metadata.
describe("metadata snapshot boundary", () => {
  it("accepts a snapshot with no truncation flag and reads it as not truncated", () => {
    const adapter = validatedAdapter({
      id: "legacy", label: "Legacy",
      keyGrammar: { testPrefix: "TEST_", reqPrefix: "REQ_", keyShape: /^T-\d+$/u, canonicalizeKey: (key) => key },
      browseUrl: () => undefined,
      metadata: {
        onDidChange: new vscode.EventEmitter<void>().event,
        snapshot: () => ({
          tests: new Map([["T-1", { key: "T-1" }]]),
          fetchedScopes: [], catalogueProjects: [], completeProjects: [], verifiedAbsentKeys: [],
          stale: false, errors: [],
        }),
        sync: () => Promise.resolve(),
      },
    }, () => Promise.resolve(), () => undefined);

    const snapshot = adapter.metadata!.snapshot();

    expect([...snapshot.tests.keys()]).toEqual(["T-1"]);
    expect(snapshot.truncated ?? false).toBe(false);
  });
});

function optionalCapabilities(overrides: Partial<TraceabilityAdapter> = {}): TraceabilityAdapter {
  return {
    id: "optional", label: "Optional capabilities",
    keyGrammar: { testPrefix: "TEST_", reqPrefix: "REQ_", keyShape: /^T-\d+$/u, canonicalizeKey: (key) => key },
    browseUrl: () => undefined,
    coverage: { coverageFor: () => Promise.resolve([{ kind: "requirement", key: "R-1" }]) },
    automationBinding: { classify: () => "compatible", bind: () => Promise.resolve() },
    remoteSearch: {
      search: () => Promise.resolve({ tests: [{ key: "T-1", summary: "Checkout", status: { category: "passed", providerValue: "Done" } }], complete: true }),
      mergeKeys: () => Promise.resolve(),
    },
    projectDirectory: {
      cached: () => ({ projects: [{ key: "T", name: "Tests" }], truncated: false }),
      list: () => Promise.resolve({ projects: [{ key: "T", name: "Tests" }], truncated: false }),
    },
    attachments: { attach: () => Promise.resolve() },
    ...overrides,
  };
}

describe("optional capability response boundary", () => {
  it("keeps last-known Test Set members readable after an incomplete refresh", async () => {
    const set = {
      key: "T-9", issueId: "99", members: [{ key: "T-1", summary: "Checkout" }],
      remoteMemberCount: 1, membershipComplete: false, truncated: true, membersLastKnown: true,
      errors: ["Membership refresh failed"],
    };
    const adapter = validatedAdapter(optionalCapabilities({ organization: {
      onDidChange: new vscode.EventEmitter<void>().event,
      snapshot: () => ({
        repositories: [], testSetProjects: [{ projectKey: "T", testSets: [set], complete: false, truncated: true, errors: set.errors }],
        stale: true, omittedRepositoryProjectCount: 0, omittedTestSetProjectCount: 0,
      }),
      sync: () => Promise.resolve(),
      refreshTestSet: () => Promise.resolve({ status: "incomplete", testSet: set }),
    } }), () => Promise.resolve(), () => undefined);
    expect(adapter.organization!.snapshot().testSetProjects[0]!.testSets[0]).toEqual(set);
    await expect(adapter.organization!.refreshTestSet("T-9")).resolves.toEqual({ status: "incomplete", testSet: set });
  });

  it("preserves a typed attachment denial through the write boundary", async () => {
    const denied = new IntegrationAdapterError("provider-failed", "Attachment access denied");
    const adapter = validatedAdapter(optionalCapabilities({ attachments: { attach: () => Promise.reject(denied) } }),
      () => Promise.resolve(), () => undefined);
    await expect(adapter.attachments!.attach({ kind: "execution", key: "T-9" }, ["/ws/checkout.zip"])).rejects.toBe(denied);
  });
  it.each([
    ["non-map catalogue", { tests: {} }],
    ["non-array scope list", { fetchedScopes: "CALC" }],
    ["non-text provider status", { tests: new Map([["T-1", { key: "T-1", status: { category: "passed", providerValue: 42 } }]]) }],
    ["non-object test type", { tests: new Map([["T-1", { key: "T-1", testType: "Cucumber" }]]) }],
  ])("rejects a %s metadata response before exposing a snapshot", (_case, override) => {
    const adapter = validatedAdapter(optionalCapabilities({ metadata: {
      onDidChange: new vscode.EventEmitter<void>().event,
      snapshot: () => (Object.assign({
        tests: new Map(), fetchedScopes: [], catalogueProjects: [], completeProjects: [],
        verifiedAbsentKeys: [], stale: false, errors: [],
      }, override) as never),
      sync: () => Promise.resolve(),
    } }), () => Promise.resolve(), () => undefined);
    expect(() => adapter.metadata!.snapshot()).toThrow(expect.objectContaining({ code: "malformed-response" }));
  });

  it("rejects a null metadata snapshot at the adapter boundary", () => {
    const adapter = validatedAdapter(optionalCapabilities({ metadata: {
      onDidChange: new vscode.EventEmitter<void>().event, snapshot: () => null as never, sync: async () => {},
    } }), async () => {}, () => {});
    expect(() => adapter.metadata!.snapshot()).toThrow(expect.objectContaining({ code: "malformed-response" }));
  });

  it.each(["grow", "shrink"] as const)("rejects a catalogue that can %s while its values are validated", (change) => {
    const tests = new Map<string, { key: string; readonly summary?: string }>();
    tests.set("T-1", { key: "T-1", get summary() {
      if (change === "grow") {tests.set("T-2", { key: "T-2" });}
      else {tests.delete("T-1");}
      return "Checkout";
    } });
    const adapter = validatedAdapter(optionalCapabilities({ metadata: {
      onDidChange: new vscode.EventEmitter<void>().event,
      snapshot: () => ({ tests, fetchedScopes: [], catalogueProjects: [], completeProjects: [], verifiedAbsentKeys: [], stale: false, errors: [] }),
      sync: () => Promise.resolve(),
    } }), () => Promise.resolve(), () => undefined);
    expect(() => adapter.metadata!.snapshot()).toThrow(expect.objectContaining({ code: "malformed-response" }));
  });

  it("rejects malformed publication outcomes instead of confirming a remote import", async () => {
    const artifact: RunArtifact = {
      id: "run-9", createdAt: 5, results: [], shards: [], selection: { kind: "all-mapped" }, preflight: [], state: "complete",
    };
    const adapter = validatedAdapter(optionalCapabilities({ resultPublishing: {
      searchTargets: () => Promise.resolve([]),
      publish: () => Promise.resolve({ ref: { kind: "testCase", key: "T-1" }, imported: 1, warnings: [] } as never),
    } }), () => Promise.resolve(), () => undefined);
    await expect(adapter.resultPublishing!.publish(artifact, { mode: "append", executionKey: "T-9" }))
      .rejects.toMatchObject({ code: "malformed-response" });
  });
  it("delivers populated coverage, search, and project results to consumers", async () => {
    const attach = vi.fn().mockResolvedValue(undefined);
    const adapter = validatedAdapter(optionalCapabilities({ attachments: { attach } }), () => Promise.resolve(), () => undefined);

    await expect(adapter.coverage!.coverageFor({ kind: "testCase", key: "T-1" })).resolves.toEqual([{ kind: "requirement", key: "R-1" }]);
    expect(adapter.automationBinding!.classify({ key: "T-1" })).toBe("compatible");
    await expect(adapter.automationBinding!.bind({ kind: "testCase", key: "T-1" })).resolves.toBeUndefined();
    await expect(adapter.remoteSearch!.search("checkout")).resolves.toMatchObject({ tests: [{ key: "T-1", summary: "Checkout" }], complete: true });
    await expect(adapter.remoteSearch!.mergeKeys(["T-1"])).resolves.toBeUndefined();
    expect(adapter.projectDirectory!.cached().projects).toEqual([{ key: "T", name: "Tests" }]);
    await expect(adapter.projectDirectory!.list()).resolves.toMatchObject({ truncated: false });
    await adapter.attachments!.attach({ kind: "execution", key: "T-9" }, ["/tmp/trace.zip"]);
    expect(attach).toHaveBeenCalledWith({ kind: "execution", key: "T-9" }, ["/tmp/trace.zip"], expect.any(AbortSignal));
  });

  it("rejects malformed optional results before domain state consumes them", async () => {
    const adapter = validatedAdapter(optionalCapabilities({
      coverage: { coverageFor: () => Promise.resolve([{ kind: "testCase", key: "T-1" }] as never) },
      automationBinding: { classify: () => "complete" as never, bind: () => Promise.resolve() },
      remoteSearch: { search: () => Promise.resolve({ tests: [{ summary: "Missing key" }], complete: true } as never), mergeKeys: () => Promise.resolve() },
      projectDirectory: { cached: () => ({ projects: [{ key: "T", name: 42 }], truncated: false } as never), list: () => Promise.resolve({ projects: [], truncated: "no" } as never) },
      attachments: { attach: () => Promise.reject(new Error("network unavailable")) },
    }), () => Promise.resolve(), () => undefined);

    await expect(adapter.coverage!.coverageFor({ kind: "testCase", key: "T-1" })).rejects.toMatchObject({ code: "malformed-response" });
    expect(() => adapter.automationBinding!.classify({ key: "T-1" })).toThrow(expect.objectContaining({ code: "malformed-response" }));
    await expect(adapter.remoteSearch!.search("checkout")).rejects.toMatchObject({ code: "malformed-response" });
    expect(() => adapter.projectDirectory!.cached()).toThrow(expect.objectContaining({ code: "malformed-response" }));
    await expect(adapter.projectDirectory!.list()).rejects.toMatchObject({ code: "malformed-response" });
    await expect(adapter.attachments!.attach({ kind: "execution", key: "T-9" }, ["/tmp/trace.zip"])).rejects.toMatchObject({ code: "provider-failed" });
  });

  it("preserves a typed provider error and disposes its boundary once", async () => {
    const denied = new IntegrationAdapterError("provider-failed", "Project access denied");
    const dispose = vi.fn().mockResolvedValue(undefined);
    const adapter = validatedAdapter(optionalCapabilities({
      projectDirectory: { cached: () => {throw denied;}, list: () => Promise.reject(denied) },
    }), dispose, () => undefined);

    expect(() => adapter.projectDirectory!.cached()).toThrow(denied);
    await expect(adapter.projectDirectory!.list()).rejects.toBe(denied);
    await adapter.dispose?.();
    await adapter.dispose?.();
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(() => adapter.projectDirectory!.cached()).toThrow(expect.objectContaining({ code: "adapter-disposed" }));
  });
});

describe("optional activation capability shape", () => {
  it.each([
    ["missing required method", "coverage", { coverage: {} }],
    ["non-callable optional method", "testAuthoring", { testAuthoring: { createTest: () => Promise.resolve({ warnings: [] }), createTestSet: true } }],
    ["non-text connection label", "connection", { connection: { onDidChange: new vscode.EventEmitter<void>().event, isConnected: () => Promise.resolve(true), label: 7 } }],
  ] as const)("rejects a %s", async (_case, capability, override) => {
    const registry = new TraceabilityAdapterRegistry();
    registry.register({
      id: "optional", ...currentAdapterVersions(capability),
      create: () => {
        const { id, label, keyGrammar, browseUrl } = optionalCapabilities();
        return { id, label, keyGrammar, browseUrl, ...override } as TraceabilityAdapter;
      },
    });

    await expect(registry.activate("optional", ctx)).rejects.toMatchObject({
      code: "malformed-adapter", message: expect.stringContaining(`capability "${capability}"`),
    });
  });
});

describe("TraceabilityAdapterRegistry", () => {
  it.each([
    ["blank id", { id: " " }],
    ["null versions", { capabilityVersions: null }],
    ["array versions", { capabilityVersions: [] }],
    ["excess versions", { capabilityVersions: Object.fromEntries(Array.from({ length: 11 }, (_, index) => [`unsupported-${index}`, 1])) }],
  ])("rejects a factory with %s without registering it", (_case, override) => {
    const registry = new TraceabilityAdapterRegistry();
    const factory = Object.assign(createInMemoryAdapterFactory(), override);
    expect(() => registry.register(factory as TraceabilityAdapterFactory)).toThrow(expect.objectContaining({ code: "malformed-factory" }));
    expect(registry.ids()).toEqual([]);
  });

  it("rejects an adapter factory that returns null before exposing it", async () => {
    const registry = new TraceabilityAdapterRegistry();
    registry.register({ ...createInMemoryAdapterFactory(), create: () => null as never });
    await expect(registry.activate("in-memory", ctx)).rejects.toMatchObject({ code: "malformed-adapter" });
  });

  it("contains factory property and construction faults with stable lifecycle codes", async () => {
    const registry = new TraceabilityAdapterRegistry();
    const factory = createInMemoryAdapterFactory();
    Object.defineProperty(factory, "id", { get: () => {throw new Error("factory read fault");} });
    expect(() => registry.register(factory)).toThrow(expect.objectContaining({ code: "malformed-factory" }));
    registry.register({ ...createInMemoryAdapterFactory(), create: () => {throw new Error("construction fault");} });
    await expect(registry.activate("in-memory", ctx)).rejects.toMatchObject({ code: "activation-failed", cause: expect.any(Error) });
  });

  it("preserves an adapter's typed disposal failure", async () => {
    const denied = new IntegrationAdapterError("provider-failed", "Cleanup denied");
    const registry = new TraceabilityAdapterRegistry();
    registry.register({ ...createInMemoryAdapterFactory(), create: () => Object.assign(new InMemoryTraceabilityAdapter(), {
      dispose: () => Promise.reject(denied),
    }) });
    const adapter = await registry.activate("in-memory", ctx);
    await expect(adapter!.dispose!()).rejects.toBe(denied);
  });
  it("registers a factory and activates its adapter by id", async () => {
    const registry = new TraceabilityAdapterRegistry();
    registry.register(createInMemoryAdapterFactory());
    expect(registry.has("in-memory")).toBe(true);
    expect((await registry.activate("in-memory", ctx))?.id).toBe("in-memory");
  });

  it("returns undefined for an unregistered id", async () => {
    const registry = new TraceabilityAdapterRegistry();
    expect(registry.has("nope")).toBe(false);
    expect(await registry.activate("nope", ctx)).toBeUndefined();
  });

  it("rejects a duplicate id without replacing the first registration", async () => {
    const registry = new TraceabilityAdapterRegistry();
    const first: TraceabilityAdapterFactory = {
      id: "dup",
      ...currentAdapterVersions("connection", "metadata", "resultPublishing"),
      create: () => {
        const adapter = new InMemoryTraceabilityAdapter({ label: "first" });
        Object.defineProperty(adapter, "id", { value: "dup" });
        return adapter;
      },
    };
    const second: TraceabilityAdapterFactory = {
      id: "dup",
      ...currentAdapterVersions("connection", "metadata", "resultPublishing"),
      create: () => {
        const adapter = new InMemoryTraceabilityAdapter({ label: "second" });
        Object.defineProperty(adapter, "id", { value: "dup" });
        return adapter;
      },
    };
    registry.register(first);
    expect(() => registry.register(second)).toThrowError(
      'Integration adapter "dup" registration was rejected because the ID is already registered.'
    );
    registry.register(createInMemoryAdapterFactory());

    expect(registry.ids()).toEqual(["dup", "in-memory"]);
    expect((await registry.activate("dup", ctx))?.connection?.label).toBe("first");
  });
});

// --- runtime provider replacement (leak-free) -------------------------------

const treeViews = vscode.window as unknown as {
  __treeViewCounters: { createCount: number; disposeCount: number };
  __resetTreeViewCounters: () => void;
};

const CONTEXT_KEY = "playwrightBddRunner.traceability.connected";
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

function setContextStates(spy: { mock: { calls: unknown[][] } }): boolean[] {
  return spy.mock.calls
    .filter((call) => call[0] === "setContext" && call[1] === CONTEXT_KEY)
    .map((call) => call[2] as boolean);
}

function makeConfig(): { config: ExtensionConfig; setProvider: (id: string) => void; fireChange: () => void } {
  const state = { provider: "in-memory", testFilePattern: "**/*.feature" };
  let listener: (() => void) | undefined;
  const config = {
    get enableTraceabilityPanel(): boolean { return true; },
    get traceabilityProvider(): string { return state.provider; },
    get testFilePattern(): string { return state.testFilePattern; },
    addChangeListener(l: () => void): { dispose: () => void } {
      listener = l;
      return { dispose: () => { listener = undefined; } };
    },
  } as unknown as ExtensionConfig;
  return { config, setProvider: (id) => { state.provider = id; }, fireChange: () => listener?.() };
}

function fixedConnection(label: string): ConnectionCapability {
  return {
    onDidChange: new vscode.EventEmitter<void>().event,
    label,
    isConnected: () => Promise.resolve(true),
  };
}

function xrayFake(connection: ConnectionCapability): TraceabilityAdapter {
  return {
    id: "xray",
    label: "Xray",
    keyGrammar: { testPrefix: "TEST_", reqPrefix: "REQ_", keyShape: /^[A-Z]+-\d+$/, canonicalizeKey: (k) => k.toUpperCase() },
    browseUrl: (ref) => `https://xray/${ref.key}`,
    connection,
  };
}

function mockWatchers(): void {
  vi.spyOn(vscode.workspace, "createFileSystemWatcher").mockImplementation(() => ({
    onDidCreate: () => ({ dispose: () => {} }),
    onDidChange: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  }) as unknown as vscode.FileSystemWatcher);
}

// Flush timers + microtasks enough times to drain a debounced rebuild (setTimeout → async
// discovery) so a post-swap assertion sees a settled subsystem.
const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) { await flush(); }
};

interface Controllable {
  adapter: TraceabilityAdapter;
  dispose: ReturnType<typeof vi.fn>;
  fireConnection: () => void;
  fireMetadata: () => void;
}

// An adapter whose `dispose` deliberately leaves its emitters alive, so firing them after teardown
// proves the *subsystem* dropped the subscription, not that the emitter merely died.
function controllableAdapter(id: string): Controllable {
  const connEmitter = new vscode.EventEmitter<void>();
  const metaEmitter = new vscode.EventEmitter<void>();
  const dispose = vi.fn();
  const adapter: TraceabilityAdapter = {
    id,
    label: id,
    keyGrammar: { testPrefix: "TC-", reqPrefix: "RQ-", keyShape: /^\d+$/, canonicalizeKey: (k) => String(Number(k)) },
    browseUrl: (ref) => `memory://${ref.key}`,
    connection: {
      onDidChange: connEmitter.event,
      label: `${id}-site`,
      isConnected: () => Promise.resolve(true),
    },
    metadata: {
      onDidChange: metaEmitter.event,
      snapshot: () => ({ tests: new Map(), fetchedScopes: [], catalogueProjects: [], completeProjects: [], verifiedAbsentKeys: [], stale: false, errors: [] }),
      sync: () => Promise.resolve(),
    },
    dispose,
  };
  return { adapter, dispose, fireConnection: () => connEmitter.fire(), fireMetadata: () => metaEmitter.fire() };
}

describe("TraceabilitySubsystem runtime provider replacement", () => {
  beforeEach(() => treeViews.__resetTreeViewCounters());
  afterEach(() => vi.restoreAllMocks());

  it("disposes the outgoing adapter, rebuilds the panel, and bleeds no state on swap", async () => {
    const created: InMemoryTraceabilityAdapter[] = [];
    const memFactory: TraceabilityAdapterFactory = {
      id: "in-memory",
      ...currentAdapterVersions("connection", "metadata", "resultPublishing"),
      create: () => {
        const adapter = new InMemoryTraceabilityAdapter({ connected: true, label: "mem" });
        vi.spyOn(adapter, "dispose");
        created.push(adapter);
        return adapter;
      },
    };
    const registry = new TraceabilityAdapterRegistry();
    registry.register(memFactory);
    registry.register({
      id: "xray",
      ...currentAdapterVersions("connection"),
      create: () => xrayFake(fixedConnection("xray-site")),
    });
    mockWatchers();

    const { config, setProvider, fireChange } = makeConfig();
    const logger = Logger.create();
    const subsystem = new TraceabilitySubsystem(
      config,
      registry,
      FeatureParser.create(logger),
      TestDiscoveryManager.create(logger, config),
      PlaywrightJsonParser.create(logger),
      new RunResultStore(),
      logger,
      fakeMemento
    );
    subsystem.rebuildDebounceMs = 0;

    await subsystem.applyCurrent();
    await settle();
    expect(created).toHaveLength(1);
    // Seed catalogue state on the first adapter so a bleed would be observable after swap-back.
    created[0]!.seedCatalogue([{ key: "42", summary: "mem-only" }], ["fixture"]);
    await created[0]!.metadata.sync({ projectKeys: ["fixture"] });

    setProvider("xray");
    fireChange();
    await subsystem.applyCurrent();
    await settle();
    expect(created[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(treeViews.__treeViewCounters.disposeCount).toBe(0);
    expect(treeViews.__treeViewCounters.createCount).toBe(0);

    // Swap back: a fresh in-memory adapter with no state bleed from the disposed one.
    setProvider("in-memory");
    fireChange();
    await subsystem.applyCurrent();
    await settle();
    expect(created).toHaveLength(2);
    expect(created[1]).not.toBe(created[0]);
    const snap = created[1]!.metadata.snapshot();
    expect(snap.tests.size).toBe(0);
    expect(snap.completeProjects).toEqual([]);

    await subsystem.shutdown();
    expect(created[1]!.dispose).toHaveBeenCalledTimes(1);
  });

  it("awaits outgoing disposal before constructing the replacement adapter", async () => {
    let finishDisposal: (() => void) | undefined;
    const disposal = new Promise<void>((resolve) => { finishDisposal = resolve; });
    const outgoing = controllableAdapter("in-memory");
    outgoing.adapter.dispose = vi.fn(() => disposal);
    const createIncoming = vi.fn(() => xrayFake(fixedConnection("xray-site")));
    const registry = new TraceabilityAdapterRegistry();
    registry.register({
      id: "in-memory",
      ...currentAdapterVersions("connection", "metadata"),
      create: () => outgoing.adapter,
    });
    registry.register({
      id: "xray",
      ...currentAdapterVersions("connection"),
      create: createIncoming,
    });
    mockWatchers();
    const { config, setProvider } = makeConfig();
    const logger = Logger.create();
    const subsystem = new TraceabilitySubsystem(
      config,
      registry,
      FeatureParser.create(logger),
      TestDiscoveryManager.create(logger, config),
      PlaywrightJsonParser.create(logger),
      new RunResultStore(),
      logger,
      fakeMemento
    );

    await subsystem.applyCurrent();
    setProvider("xray");
    const swap = subsystem.applyCurrent();
    await flush();

    expect(outgoing.adapter.dispose).toHaveBeenCalledOnce();
    expect(createIncoming).not.toHaveBeenCalled();

    finishDisposal?.();
    await swap;

    expect(createIncoming).toHaveBeenCalledOnce();
    await subsystem.shutdown();
  });

  it("drops its connection and metadata subscriptions to the outgoing adapter on swap", async () => {
    const outgoing = controllableAdapter("in-memory");
    const registry = new TraceabilityAdapterRegistry();
    registry.register({
      id: "in-memory",
      ...currentAdapterVersions("connection", "metadata"),
      create: () => outgoing.adapter,
    });
    registry.register({
      id: "xray",
      ...currentAdapterVersions("connection"),
      create: () => xrayFake(fixedConnection("xray-site")),
    });
    mockWatchers();
    const exec = vi.spyOn(vscode.commands, "executeCommand");

    const { config, setProvider, fireChange } = makeConfig();
    const logger = Logger.create();
    const discovery = TestDiscoveryManager.create(logger, config);
    const discoverSpy = vi.spyOn(discovery, "discoverTestFiles");
    const subsystem = new TraceabilitySubsystem(
      config,
      registry,
      FeatureParser.create(logger),
      discovery,
      PlaywrightJsonParser.create(logger),
      new RunResultStore(),
      logger,
      fakeMemento
    );
    subsystem.rebuildDebounceMs = 0;

    await subsystem.applyCurrent();
    await settle();

    setProvider("xray");
    fireChange();
    await subsystem.applyCurrent();
    await settle();
    expect(outgoing.dispose).toHaveBeenCalledTimes(1);

    // Late events on the still-live outgoing emitters must reach nobody: a leaked connection
    // subscription would re-commit the context key; a leaked metadata subscription would rebuild
    // (discovering test files). With the subscriptions dropped, the executor and discovery stay
    // untouched.
    exec.mockClear();
    discoverSpy.mockClear();
    outgoing.fireConnection();
    outgoing.fireMetadata();
    await settle();

    expect(setContextStates(exec)).toHaveLength(0);
    expect(discoverSpy).not.toHaveBeenCalled();

    await subsystem.shutdown();
  });
});
