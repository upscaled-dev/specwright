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
import { TraceabilitySubsystem } from "../../traceability/traceability-subsystem";
import { RunResultStore } from "../../traceability/run-result-store";
import { ConnectionCapability, RunArtifact, TraceabilityAdapter } from "../../traceability/contracts";
import { buildTraceabilitySnapshot } from "../../traceability/traceability-model";
import { FeatureParser } from "../../parsers/feature-parser";
import { TestDiscoveryManager } from "../../core/test-discovery-manager";
import { PlaywrightJsonParser } from "../../utils/playwright-json-parser";
import { Logger } from "../../utils/logger";
import { extractKeys } from "../../traceability/tag-extraction";
import type { ExtensionConfig } from "../../core/extension-config";

function inMemoryHarness(): AdapterContractHarness {
  const adapter = new InMemoryTraceabilityAdapter({ label: "in-memory-fixture" });
  return {
    adapter,
    connect: () => { adapter.setConnected(true); return Promise.resolve(); },
    disconnect: () => { adapter.setConnected(false); return Promise.resolve(); },
    seedCatalogue: (tests, completeness) => adapter.seedCatalogue(tests, completeness),
    seedSyncError: (message) => adapter.seedSyncError(message),
    syncScope: { projectKeys: ["fixture"] },
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
    publishTarget: { id: "EXEC-1", label: "Execution 1" },
  };
}

runAdapterContractTests(inMemoryHarness);

describe("InMemoryTraceabilityAdapter specifics", () => {
  it("uses a non-Jira grammar: numeric keys, no project derivation, leading-zero canonicalization", () => {
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
    await adapter.resultPublishing.publish(artifact, { id: "EXEC-9", label: "Nine" });

    expect(adapter.publications).toEqual([{ artifact, targetId: "EXEC-9" }]);
    const targets = await adapter.resultPublishing.listTargets();
    expect(targets.map((t) => t.id)).toContain("EXEC-9");
  });

  it("keeps last-known metadata but demotes completeness to unknown on a sync error", async () => {
    const adapter = new InMemoryTraceabilityAdapter();
    adapter.seedCatalogue([{ key: "42", summary: "kept" }], "complete");
    await adapter.metadata.sync({ testKeys: ["42"] });
    expect(adapter.metadata.snapshot().completeness).toBe("complete");

    adapter.seedSyncError("boom");
    await adapter.metadata.sync({ testKeys: ["42"] });
    const snap = adapter.metadata.snapshot();
    expect(snap.completeness).toBe("unknown");
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
    adapter.seedCatalogue([{ key: "42", summary: "kept" }], "complete");
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
    adapter.seedCatalogue([{ key: "007", summary: "kept" }], "complete");
    await adapter.metadata.sync({ testKeys: ["7", "008"] });
    expect(adapter.metadata.snapshot().verifiedAbsentKeys).toEqual(["8"]);
  });

  it("keeps model absence verdicts correct under a non-uppercasing grammar", async () => {
    const adapter = new InMemoryTraceabilityAdapter();
    adapter.seedCatalogue([{ key: "7", summary: "present" }], "complete");
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

describe("TraceabilityAdapterRegistry", () => {
  it("registers a factory and creates its adapter by id", () => {
    const registry = new TraceabilityAdapterRegistry();
    registry.register(createInMemoryAdapterFactory());
    expect(registry.has("in-memory")).toBe(true);
    expect(registry.create("in-memory", ctx)?.id).toBe("in-memory");
  });

  it("returns undefined for an unregistered id", () => {
    const registry = new TraceabilityAdapterRegistry();
    expect(registry.has("nope")).toBe(false);
    expect(registry.create("nope", ctx)).toBeUndefined();
  });

  it("lists registered ids and lets the last registration win for a duplicate id", () => {
    const registry = new TraceabilityAdapterRegistry();
    const first: TraceabilityAdapterFactory = { id: "dup", create: () => new InMemoryTraceabilityAdapter({ label: "first" }) };
    const second: TraceabilityAdapterFactory = { id: "dup", create: () => new InMemoryTraceabilityAdapter({ label: "second" }) };
    registry.register(first);
    registry.register(second);
    registry.register(createInMemoryAdapterFactory());

    expect(registry.ids().sort()).toEqual(["dup", "in-memory"]);
    expect(registry.create("dup", ctx)?.connection?.label).toBe("second");
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
// proves the *subsystem* dropped the subscription — not that the emitter merely died.
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
      snapshot: () => ({ tests: new Map(), fetchedScopes: [], catalogueProjects: [], verifiedAbsentKeys: [], stale: false, completeness: "unknown", errors: [] }),
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
      create: () => {
        const adapter = new InMemoryTraceabilityAdapter({ connected: true, label: "mem" });
        vi.spyOn(adapter, "dispose");
        created.push(adapter);
        return adapter;
      },
    };
    const registry = new TraceabilityAdapterRegistry();
    registry.register(memFactory);
    registry.register({ id: "xray", create: () => xrayFake(fixedConnection("xray-site")) });
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
      logger
    );
    subsystem.rebuildDebounceMs = 0;

    subsystem.applyCurrent();
    await settle();
    expect(created).toHaveLength(1);
    // Seed catalogue state on the first adapter so a bleed would be observable after swap-back.
    created[0]!.seedCatalogue([{ key: "42", summary: "mem-only" }], "complete");
    await created[0]!.metadata.sync({ projectKeys: ["fixture"] });

    setProvider("xray");
    fireChange();
    await settle();
    expect(created[0]!.dispose).toHaveBeenCalledTimes(1);
    expect(treeViews.__treeViewCounters.disposeCount).toBe(1);
    expect(treeViews.__treeViewCounters.createCount).toBe(2);

    // Swap back: a fresh in-memory adapter with no state bleed from the disposed one.
    setProvider("in-memory");
    fireChange();
    await settle();
    expect(created).toHaveLength(2);
    expect(created[1]).not.toBe(created[0]);
    const snap = created[1]!.metadata.snapshot();
    expect(snap.tests.size).toBe(0);
    expect(snap.completeness).toBe("unknown");

    subsystem.dispose();
    expect(created[1]!.dispose).toHaveBeenCalledTimes(1);
  });

  it("drops its connection and metadata subscriptions to the outgoing adapter on swap", async () => {
    const outgoing = controllableAdapter("in-memory");
    const registry = new TraceabilityAdapterRegistry();
    registry.register({ id: "in-memory", create: () => outgoing.adapter });
    registry.register({ id: "xray", create: () => xrayFake(fixedConnection("xray-site")) });
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
      logger
    );
    subsystem.rebuildDebounceMs = 0;

    subsystem.applyCurrent();
    await settle();

    setProvider("xray");
    fireChange();
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

    subsystem.dispose();
  });
});
