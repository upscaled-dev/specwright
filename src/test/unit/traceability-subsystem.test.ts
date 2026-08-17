import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import { TraceabilitySubsystem } from "../../traceability/traceability-subsystem";
import {
  ConnectionCapability,
  ConnectionVerifyResult,
  TraceabilityAdapter,
} from "../../traceability/contracts";
import {
  ConnectionIndicator,
  TraceabilityTreeDataProvider,
} from "../../traceability/traceability-tree-data-provider";
import { TraceabilityModel, type TraceabilitySnapshot } from "../../traceability/traceability-model";
import { TraceabilityAdapterRegistry } from "../../traceability/adapter-registry";
import {
  currentAdapterVersions,
  INTEGRATION_ADAPTER_CAPABILITIES,
} from "../../traceability/adapter-contract";
import { RunResultStore } from "../../traceability/run-result-store";
import { FeatureParser } from "../../parsers/feature-parser";
import { TestDiscoveryManager } from "../../core/test-discovery-manager";
import { PlaywrightJsonParser } from "../../utils/playwright-json-parser";
import { Logger } from "../../utils/logger";
import type { ExtensionConfig } from "../../core/extension-config";

interface TreeViewCounters {
  createCount: number;
  disposeCount: number;
}
const treeViews = (vscode.window as unknown as {
  __treeViewCounters: TreeViewCounters;
  __getLastTreeView: () => { message: string | undefined } | undefined;
  __resetTreeViewCounters: () => void;
});

const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

interface ConnectionControl {
  connection: ConnectionCapability;
  setConnected: (value: boolean) => void;
  setLabel: (label: string) => void;
  fire: () => void;
}

function makeConnection(
  initial = false,
  verify?: () => Promise<ConnectionVerifyResult>
): ConnectionControl {
  let connected = initial;
  let label = "";
  const emitter = new vscode.EventEmitter<void>();
  const connection: ConnectionCapability = {
    onDidChange: emitter.event,
    get label(): string {
      return label;
    },
    isConnected: () => Promise.resolve(connected),
    ...(verify ? { verify } : {}),
  };
  return {
    connection,
    setConnected: (value) => { connected = value; },
    setLabel: (next) => { label = next; },
    fire: () => emitter.fire(),
  };
}

interface DeferredVerify {
  connection: ConnectionCapability;
  // One resolver per outstanding verify() call, in call order.
  resolvers: Array<(result: ConnectionVerifyResult) => void>;
  fire: () => void;
}

function deferredVerifyConnection(label = "acme.atlassian.net"): DeferredVerify {
  const resolvers: Array<(result: ConnectionVerifyResult) => void> = [];
  const emitter = new vscode.EventEmitter<void>();
  const connection: ConnectionCapability = {
    onDidChange: emitter.event,
    label,
    isConnected: () => Promise.resolve(true),
    verify: () => new Promise<ConnectionVerifyResult>((resolve) => { resolvers.push(resolve); }),
  };
  return { connection, resolvers, fire: () => emitter.fire() };
}

function indicatorCalls(
  spy: { mock: { calls: unknown[][] } }
): Array<ConnectionIndicator | undefined> {
  return spy.mock.calls.map((call) => call[0] as ConnectionIndicator | undefined);
}

interface DeferredConnection extends ConnectionControl {
  // One resolver per outstanding isConnected() probe, in call order, so a test can resolve them
  // out of order to model overlapping refreshes and late resolutions.
  resolvers: Array<(value: boolean) => void>;
}

function deferredConnection(label = ""): DeferredConnection {
  const resolvers: Array<(value: boolean) => void> = [];
  const emitter = new vscode.EventEmitter<void>();
  const connection: ConnectionCapability = {
    onDidChange: emitter.event,
    get label(): string {
      return label;
    },
    isConnected: () => new Promise<boolean>((resolve) => { resolvers.push(resolve); }),
  };
  return {
    connection,
    setConnected: () => { /* probes resolve via resolvers */ },
    setLabel: () => { /* label fixed at construction */ },
    fire: () => emitter.fire(),
    resolvers,
  };
}

interface TraceabilityConfigState {
  enableTraceabilityPanel: boolean;
  traceabilityProvider: string;
  testFilePattern: string;
  traceabilityTestTagPrefix: string;
  traceabilityReqTagPrefix: string;
  xraySiteUrl: string;
  xrayApiRegion: string;
  xrayDefaultProjectKey: string;
}

function makeConfig(initial?: Partial<TraceabilityConfigState>): {
  config: ExtensionConfig;
  set: (next: Partial<TraceabilityConfigState>) => void;
  fireChange: () => void;
} {
  const state: TraceabilityConfigState = {
    enableTraceabilityPanel: true,
    traceabilityProvider: "xray",
    testFilePattern: "**/*.feature",
    traceabilityTestTagPrefix: "TEST_",
    traceabilityReqTagPrefix: "REQ_",
    xraySiteUrl: "",
    xrayApiRegion: "global",
    xrayDefaultProjectKey: "",
    ...initial,
  };
  let listener: (() => void) | undefined;
  const config = {
    get enableTraceabilityPanel(): boolean { return state.enableTraceabilityPanel; },
    get traceabilityProvider(): string { return state.traceabilityProvider; },
    get testFilePattern(): string { return state.testFilePattern; },
    get traceabilityTestTagPrefix(): string { return state.traceabilityTestTagPrefix; },
    get traceabilityReqTagPrefix(): string { return state.traceabilityReqTagPrefix; },
    get xraySiteUrl(): string { return state.xraySiteUrl; },
    get xrayApiRegion(): string { return state.xrayApiRegion; },
    get xrayDefaultProjectKey(): string { return state.xrayDefaultProjectKey; },
    addChangeListener(l: () => void): { dispose: () => void } {
      listener = l;
      return { dispose: () => { listener = undefined; } };
    },
  } as unknown as ExtensionConfig;
  return { config, set: (next) => Object.assign(state, next), fireChange: () => listener?.() };
}

interface FakeWatcher {
  onDidCreate: (listener: () => void) => { dispose: () => void };
  onDidChange: (listener: () => void) => { dispose: () => void };
  onDidDelete: (listener: () => void) => { dispose: () => void };
  dispose: ReturnType<typeof vi.fn>;
  fireCreate: () => void;
  fireChange: () => void;
  replayChange: () => void;
  fireDelete: () => void;
}

function fakeAdapter(id: string, connection?: ConnectionCapability): TraceabilityAdapter {
  return {
    id,
    label: id,
    keyGrammar: {
      testPrefix: "TEST_",
      reqPrefix: "REQ_",
      keyShape: /^[A-Z]+-\d+$/,
      canonicalizeKey: (key) => key.toUpperCase(),
    },
    browseUrl: () => undefined,
    ...(connection ? { connection } : {}),
  };
}

function registryOf(adapters: Record<string, TraceabilityAdapter>): TraceabilityAdapterRegistry {
  const registry = new TraceabilityAdapterRegistry();
  for (const [id, adapter] of Object.entries(adapters)) {
    const capabilities = INTEGRATION_ADAPTER_CAPABILITIES.filter(
      (capability) => adapter[capability] !== undefined
    );
    registry.register({ id, ...currentAdapterVersions(...capabilities), create: () => adapter });
  }
  return registry;
}

function fakeMemento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    keys: () => [...store.keys()],
    get: (key: string, dflt?: unknown) => (store.has(key) ? store.get(key) : dflt),
    update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
  } as unknown as vscode.Memento;
}

function build(
  config: ExtensionConfig,
  adapters?: Record<string, TraceabilityAdapter>,
  logger = Logger.create(),
  connection: ConnectionControl = makeConnection(),
  memento: vscode.Memento = fakeMemento(),
  hasTraceabilityTags: () => Promise<boolean> = () => Promise.resolve(false),
  closeSetupSurface: () => Promise<void> = () => Promise.resolve()
): {
  subsystem: TraceabilitySubsystem;
  created: FakeWatcher[];
  connection: ConnectionControl;
  store: RunResultStore;
  discovery: TestDiscoveryManager;
  memento: vscode.Memento;
  registry: TraceabilityAdapterRegistry;
} {
  const registry = registryOf(adapters ?? { xray: fakeAdapter("xray", connection.connection) });
  const store = new RunResultStore();
  const discovery = TestDiscoveryManager.create(logger, config);
  const subsystem = new TraceabilitySubsystem(
    config,
    registry,
    FeatureParser.create(logger),
    discovery,
    PlaywrightJsonParser.create(logger),
    store,
    logger,
    memento,
    hasTraceabilityTags,
    closeSetupSurface
  );
  subsystem.rebuildDebounceMs = 0;
  const created: FakeWatcher[] = [];
  vi.spyOn(vscode.workspace, "createFileSystemWatcher").mockImplementation(() => {
    let create: (() => void) | undefined;
    let change: (() => void) | undefined;
    let recordedChange: (() => void) | undefined;
    let deleted: (() => void) | undefined;
    const watcher: FakeWatcher = {
      onDidCreate: (listener) => {create = listener; return { dispose: () => {create = undefined;} };},
      onDidChange: (listener) => {
        change = listener;
        recordedChange = listener;
        return { dispose: () => {change = undefined;} };
      },
      onDidDelete: (listener) => {deleted = listener; return { dispose: () => {deleted = undefined;} };},
      dispose: vi.fn(),
      fireCreate: () => create?.(),
      fireChange: () => change?.(),
      replayChange: () => recordedChange?.(),
      fireDelete: () => deleted?.(),
    };
    created.push(watcher);
    return watcher as unknown as vscode.FileSystemWatcher;
  });
  return { subsystem, created, connection, store, discovery, memento, registry };
}

function evidenceConfig(
  explicit: boolean | undefined,
  configured: boolean
): ExtensionConfig {
  const { config } = makeConfig({ enableTraceabilityPanel: false });
  Object.defineProperties(config, {
    traceabilityPanelPreference: { get: () => explicit },
    hasExplicitXrayConfiguration: { get: () => configured },
  });
  return config;
}

describe("TraceabilitySubsystem evidence-based activation", () => {
  beforeEach(() => treeViews.__resetTreeViewCounters());
  afterEach(() => vi.restoreAllMocks());

  it("keeps explicit false authoritative without scanning tags", async () => {
    const tags = vi.fn().mockResolvedValue(true);
    const { subsystem, created } = build(
      evidenceConfig(false, true),
      undefined,
      Logger.create(),
      makeConnection(),
      fakeMemento(),
      tags
    );

    await subsystem.applyCurrent();

    expect(subsystem.traceabilityPanelActive).toBe(false);
    expect(tags).not.toHaveBeenCalled();
    expect(created).toHaveLength(0);
    await subsystem.shutdown();
  });

  it("activates from configuration or tags only when no preference exists", async () => {
    const configured = build(evidenceConfig(undefined, true));
    const tagged = build(
      evidenceConfig(undefined, false),
      undefined,
      Logger.create(),
      makeConnection(),
      fakeMemento(),
      () => Promise.resolve(true)
    );

    await configured.subsystem.applyCurrent();
    await tagged.subsystem.applyCurrent();

    expect(configured.subsystem.traceabilityPanelActive).toBe(true);
    expect(tagged.subsystem.traceabilityPanelActive).toBe(true);
    await configured.subsystem.shutdown();
    await tagged.subsystem.shutdown();
  });

  it("reveals the panel when the first traceability tag is added without an explicit preference", async () => {
    let tagged = false;
    const tags = vi.fn(() => Promise.resolve(tagged));
    const { subsystem, created } = build(
      evidenceConfig(undefined, false),
      undefined,
      Logger.create(),
      makeConnection(),
      fakeMemento(),
      tags
    );

    await subsystem.applyCurrent();
    expect(subsystem.traceabilityPanelActive).toBe(false);
    expect(created).toHaveLength(1);

    tagged = true;
    created[0]!.fireChange();
    await flush();
    await flush();

    expect(tags).toHaveBeenCalledTimes(2);
    expect(subsystem.traceabilityPanelActive).toBe(true);
    await subsystem.shutdown();
  });

  it("retires evidence callbacks after activation and leaves saves to the model watcher", async () => {
    let tagged = false;
    const tags = vi.fn(() => Promise.resolve(tagged));
    const connection = makeConnection();
    const isConnected = vi.spyOn(connection.connection, "isConnected");
    const { subsystem, created, discovery } = build(
      evidenceConfig(undefined, false),
      undefined,
      Logger.create(),
      connection,
      fakeMemento(),
      tags
    );
    const discover = vi.spyOn(discovery, "discoverTestFiles").mockResolvedValue([]);

    await subsystem.applyCurrent();
    const evidenceWatcher = created[0]!;
    tagged = true;
    evidenceWatcher.fireChange();
    await flush();
    await flush();

    expect(subsystem.traceabilityPanelActive).toBe(true);
    expect(evidenceWatcher.dispose).toHaveBeenCalledOnce();
    const evidenceScans = tags.mock.calls.length;
    const connectionProbes = isConnected.mock.calls.length;
    const modelRebuilds = discover.mock.calls.length;

    evidenceWatcher.replayChange();
    evidenceWatcher.replayChange();
    await flush();

    expect(tags).toHaveBeenCalledTimes(evidenceScans);
    expect(isConnected).toHaveBeenCalledTimes(connectionProbes);
    expect(discover).toHaveBeenCalledTimes(modelRebuilds);

    created[1]!.fireChange();
    await flush();
    await flush();

    expect(discover.mock.calls.length).toBeGreaterThan(modelRebuilds);
    await subsystem.shutdown();
  });

  it("replaces the evidence watcher when the feature pattern changes", async () => {
    const config = evidenceConfig(undefined, false);
    let pattern = config.testFilePattern;
    Object.defineProperty(config, "testFilePattern", { get: () => pattern });
    const { subsystem, created } = build(config);

    await subsystem.applyCurrent();
    const first = created[0]!;
    pattern = "features/**/*.feature";
    await subsystem.applyCurrent();

    expect(first.dispose).toHaveBeenCalledOnce();
    expect(created).toHaveLength(2);
    await subsystem.shutdown();
  });

  it("rejects a retired watcher callback after the same evidence signature is restored", async () => {
    const config = evidenceConfig(undefined, false);
    const originalPattern = config.testFilePattern;
    let pattern = originalPattern;
    Object.defineProperty(config, "testFilePattern", { get: () => pattern });
    const tags = vi.fn().mockResolvedValue(false);
    const connection = makeConnection();
    const probe = vi.spyOn(connection.connection, "isConnected");
    const { subsystem, created, discovery, registry } = build(
      config,
      undefined,
      Logger.create(),
      connection,
      fakeMemento(),
      tags
    );
    const rebuild = vi.spyOn(discovery, "discoverTestFiles").mockResolvedValue([]);
    const activate = vi.spyOn(registry, "activate");

    await subsystem.applyCurrent();
    const retired = created[0]!;
    pattern = "features/**/*.feature";
    await subsystem.applyCurrent();
    pattern = originalPattern;
    await subsystem.applyCurrent();
    const scans = tags.mock.calls.length;

    retired.replayChange();
    await flush();

    expect(tags).toHaveBeenCalledTimes(scans);
    expect(probe).not.toHaveBeenCalled();
    expect(rebuild).not.toHaveBeenCalled();
    expect(activate).not.toHaveBeenCalled();
    await subsystem.shutdown();
  });

  it("restores evidence monitoring when a config change disables an active implicit panel", async () => {
    const { config, set } = makeConfig({ enableTraceabilityPanel: false });
    Object.defineProperties(config, {
      traceabilityPanelPreference: { get: () => undefined },
      hasExplicitXrayConfiguration: { get: () => false },
    });
    let tagged = true;
    const { subsystem, created } = build(
      config,
      undefined,
      Logger.create(),
      makeConnection(),
      fakeMemento(),
      () => Promise.resolve(tagged)
    );

    await subsystem.applyCurrent();
    const firstEvidenceWatcher = created[0]!;
    expect(subsystem.traceabilityPanelActive).toBe(true);
    expect(firstEvidenceWatcher.dispose).toHaveBeenCalledOnce();

    tagged = false;
    set({ traceabilityTestTagPrefix: "CASE_" });
    await subsystem.applyCurrent();

    expect(subsystem.traceabilityPanelActive).toBe(false);
    expect(created.at(-1)).not.toBe(firstEvidenceWatcher);
    expect(created.at(-1)?.dispose).not.toHaveBeenCalled();
    await subsystem.shutdown();
  });

  it("restores evidence monitoring after active adapter replacement fails and can recover", async () => {
    const { config, set } = makeConfig({ enableTraceabilityPanel: false });
    Object.defineProperties(config, {
      traceabilityPanelPreference: { get: () => undefined },
      hasExplicitXrayConfiguration: { get: () => false },
    });
    const adapters = {
      xray: fakeAdapter("xray"),
      azure: fakeAdapter("azure"),
    };
    const { subsystem, created, registry } = build(
      config,
      adapters,
      Logger.create(),
      makeConnection(),
      fakeMemento(),
      () => Promise.resolve(true)
    );
    await subsystem.applyCurrent();
    expect(subsystem.traceabilityPanelActive).toBe(true);

    const activate = vi.spyOn(registry, "activate").mockRejectedValueOnce(
      new Error("replacement failed")
    );
    set({ traceabilityProvider: "azure" });
    await subsystem.applyCurrent();

    expect(activate).toHaveBeenCalledOnce();
    expect(subsystem.traceabilityPanelActive).toBe(false);
    const restoredWatcher = created.at(-1)!;
    expect(restoredWatcher.dispose).not.toHaveBeenCalled();

    restoredWatcher.fireChange();
    await flush();
    await flush();

    expect(activate).toHaveBeenCalledTimes(2);
    expect(subsystem.traceabilityPanelActive).toBe(true);
    expect(restoredWatcher.dispose).toHaveBeenCalledOnce();
    await subsystem.shutdown();
  });

  it("never commits the enabled context when provider activation fails", async () => {
    const execute = vi.spyOn(vscode.commands, "executeCommand");
    const adapter = fakeAdapter("xray");
    Object.defineProperty(adapter, "keyGrammar", {
      get: () => {throw new Error("factory failed");},
    });
    const { subsystem } = build(makeConfig().config, { xray: adapter });

    await subsystem.applyCurrent();

    const enabledStates = execute.mock.calls
      .filter((call) => call[0] === "setContext" && call[1] === "playwrightBddRunner.traceability.enabled")
      .map((call) => call[2]);
    expect(enabledStates.at(-1)).toBe(false);
    expect(enabledStates).not.toContain(true);
    await subsystem.shutdown();
  });
});

describe("TraceabilitySubsystem grouping mode", () => {
  const GROUPING_KEY = "playwrightBddRunner.traceability.groupingMode";

  beforeEach(() => {
    treeViews.__resetTreeViewCounters();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("persists a toggle to workspaceState and restores it on a rebuilt provider", async () => {
    const memento = fakeMemento();
    const { config, set, fireChange } = makeConfig();
    const { subsystem } = build(config, undefined, Logger.create(), makeConnection(), memento);

    await subsystem.applyCurrent();
    await flush();

    subsystem.toggleGrouping();
    expect(memento.get(GROUPING_KEY)).toBe("file");

    // Rebuild the panel; the fresh provider must restore "file" from the memento, so the next
    // toggle returns to "test" rather than flipping away from a defaulted "test".
    set({ enableTraceabilityPanel: false });
    fireChange();
    await subsystem.applyCurrent();
    set({ enableTraceabilityPanel: true });
    fireChange();
    await subsystem.applyCurrent();
    await flush();

    subsystem.toggleGrouping();
    expect(memento.get(GROUPING_KEY)).toBe("test");
    await subsystem.shutdown();
  });

  it("coerces an unknown stored mode to the by-test layout", async () => {
    const memento = fakeMemento();
    await memento.update(GROUPING_KEY, "bogus");
    const { config } = makeConfig();
    const { subsystem } = build(config, undefined, Logger.create(), makeConnection(), memento);

    await subsystem.applyCurrent();
    await flush();

    // A garbage value reads back as "test", so one toggle lands on "file".
    subsystem.toggleGrouping();
    expect(memento.get(GROUPING_KEY)).toBe("file");
    await subsystem.shutdown();
  });
});

describe("TraceabilitySubsystem lifecycle", () => {
  beforeEach(() => {
    treeViews.__resetTreeViewCounters();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates the tree view once and is idempotent across repeated applyCurrent", async () => {
    const { config } = makeConfig();
    const { subsystem } = build(config);

    await subsystem.applyCurrent();
    await subsystem.applyCurrent();

    expect(subsystem.traceabilityPanelActive).toBe(true);
    expect(treeViews.__treeViewCounters.createCount).toBe(1);
    await subsystem.shutdown();
  });

  it("enables native multi-selection on the traceability tree", async () => {
    const createTreeView = vi.spyOn(vscode.window, "createTreeView");
    const { config } = makeConfig();
    const { subsystem } = build(config);

    await subsystem.applyCurrent();

    expect(createTreeView).toHaveBeenCalledWith(
      "playwrightBddRunner.traceability",
      expect.objectContaining({ canSelectMany: true })
    );
    await subsystem.shutdown();
  });

  it("scopes an Examples-block result to the selected mapping", async () => {
    const { config } = makeConfig();
    const { subsystem } = build(config);
    const outline = { filePath: "/ws/a.feature", line: 3, name: "Divide", kind: "outline" as const };
    const block = {
      filePath: "/ws/a.feature",
      line: 8,
      name: "Divide · edge cases",
      kind: "examplesBlock" as const,
      outlineName: "Divide",
      examplesBlockName: "edge cases",
    };
    const snapshot: TraceabilitySnapshot = {
      links: [
        { testKey: "CALC-1", scenario: outline, reqKeys: [] },
        { testKey: "CALC-2", scenario: block, reqKeys: [] },
      ],
      untraced: [],
      orphans: [],
      stale: false,
      completeProjects: ["CALC"],
      errors: [],
    };
    (subsystem as unknown as { model: { snapshot: TraceabilitySnapshot; dispose: () => void } }).model = {
      snapshot,
      dispose: () => undefined,
    };

    const resolve = subsystem.captureKeyResolver();

    expect(resolve({ ...outline, line: 10 }, block)).toBe("CALC-2");
    await subsystem.shutdown();
  });

  it("uses each invocation when an outline and its Examples block are both selected", async () => {
    const { config } = makeConfig();
    const { subsystem } = build(config);
    const outline = { filePath: "/ws/a.feature", line: 3, name: "Divide", kind: "outline" as const };
    const block = {
      filePath: "/ws/a.feature",
      line: 8,
      name: "Divide · edge cases",
      kind: "examplesBlock" as const,
      outlineName: "Divide",
      examplesBlockName: "edge cases",
    };
    const snapshot: TraceabilitySnapshot = {
      links: [
        { testKey: "CALC-1", scenario: outline, reqKeys: [] },
        { testKey: "CALC-2", scenario: block, reqKeys: [] },
      ],
      untraced: [],
      orphans: [],
      stale: false,
      completeProjects: ["CALC"],
      errors: [],
    };
    (subsystem as unknown as { model: { snapshot: TraceabilitySnapshot; dispose: () => void } }).model = {
      snapshot,
      dispose: () => undefined,
    };
    const resolve = subsystem.captureKeyResolver();
    const result = { ...outline, line: 10 };

    expect(resolve(result, outline)).toBe("CALC-1");
    expect(resolve(result, block)).toBe("CALC-2");
    await subsystem.shutdown();
  });

  it("tears down and re-creates with zero residue across disable → re-enable", async () => {
    const { config, set, fireChange } = makeConfig();
    const { subsystem, created } = build(config);

    await subsystem.applyCurrent();
    const firstWatchers = [...created];
    expect(firstWatchers.length).toBeGreaterThan(0);

    set({ enableTraceabilityPanel: false });
    fireChange();
    await subsystem.applyCurrent();
    expect(subsystem.traceabilityPanelActive).toBe(false);
    expect(treeViews.__treeViewCounters.disposeCount).toBe(1);
    for (const w of firstWatchers) {
      expect(w.dispose).toHaveBeenCalled();
    }

    set({ enableTraceabilityPanel: true });
    fireChange();
    await subsystem.applyCurrent();
    expect(subsystem.traceabilityPanelActive).toBe(true);
    expect(treeViews.__treeViewCounters.createCount).toBe(2);
    await subsystem.shutdown();
  });

  it("waits for in-flight model work before disable completes teardown", async () => {
    const { config, set } = makeConfig();
    const { subsystem, created, store } = build(config);
    await subsystem.applyCurrent();
    await flush();
    const model = (subsystem as unknown as { model: TraceabilityModel }).model;
    let finish!: () => void;
    const rebuild = vi.spyOn(model, "rebuild").mockImplementation(
      () => new Promise<void>((resolve) => {finish = resolve;})
    );

    subsystem.scheduleRebuild();
    await flush();
    expect(rebuild).toHaveBeenCalled();
    set({ enableTraceabilityPanel: false });
    let disabled = false;
    const disabling = subsystem.applyCurrent().then(() => {disabled = true;});
    await flush();

    expect(disabled).toBe(false);
    store.ingest({ "/ws/during-disable.feature:2": "passed" });
    subsystem.scheduleRebuild();
    expect((subsystem as unknown as { rebuildTimer: unknown }).rebuildTimer).toBeUndefined();
    finish();
    await disabling;
    expect(rebuild).toHaveBeenCalledOnce();
    expect(subsystem.traceabilityPanelActive).toBe(false);
    expect(created.every(({ dispose }) => dispose.mock.calls.length > 0)).toBe(true);
    await subsystem.shutdown();
  });

  it("admits no run-result rebuild timer after the panel is disabled", async () => {
    const { config, set } = makeConfig();
    const { subsystem, store } = build(config);
    await subsystem.applyCurrent();
    await flush();
    const model = (subsystem as unknown as { model: TraceabilityModel }).model;
    const rebuild = vi.spyOn(model, "rebuild");

    set({ enableTraceabilityPanel: false });
    await subsystem.applyCurrent();
    const afterDisable = rebuild.mock.calls.length;
    store.ingest({ "/ws/disabled.feature:1": "passed" });
    subsystem.scheduleRebuild();
    await flush();

    expect(rebuild).toHaveBeenCalledTimes(afterDisable);
    expect((subsystem as unknown as { rebuildTimer: unknown }).rebuildTimer).toBeUndefined();
    await subsystem.shutdown();
  });

  it("closes and drains the setup surface before disable completes", async () => {
    const { config, set } = makeConfig();
    let finish!: () => void;
    let closed = false;
    const firstClose = new Promise<void>((resolve) => {
      finish = () => {closed = true; resolve();};
    });
    const close = vi.fn(() => closed ? Promise.resolve() : firstClose);
    const { subsystem } = build(
      config,
      undefined,
      Logger.create(),
      makeConnection(),
      fakeMemento(),
      () => Promise.resolve(false),
      close
    );
    await subsystem.applyCurrent();

    set({ enableTraceabilityPanel: false });
    let disabled = false;
    const disabling = subsystem.applyCurrent().then(() => {disabled = true;});
    await flush();

    expect(close).toHaveBeenCalledOnce();
    expect(disabled).toBe(false);
    finish();
    await disabling;
    expect(disabled).toBe(true);
    await subsystem.shutdown();
  });

  it("rebuilds watchers when the feature pattern changes", async () => {
    const { config, set, fireChange } = makeConfig();
    const { subsystem, created } = build(config);

    await subsystem.applyCurrent();
    const initial = created.length;

    set({ testFilePattern: "features/**/*.feature" });
    fireChange();
    await subsystem.applyCurrent();

    expect(created.length).toBeGreaterThan(initial);
    for (let i = 0; i < initial; i++) {
      expect(created[i]!.dispose).toHaveBeenCalled();
    }
    await subsystem.shutdown();
  });

  it("rebuilds the model when the run-result store reports fresh badges (P1 live-badge wiring)", async () => {
    const { config } = makeConfig();
    const { subsystem, store, discovery } = build(config);
    const discover = vi.spyOn(discovery, "discoverTestFiles").mockResolvedValue([]);

    await subsystem.applyCurrent();
    await flush();
    const afterInitial = discover.mock.calls.length;
    expect(afterInitial).toBeGreaterThan(0);

    // A Test Explorer run feeds the store, which must drive a rebuild with no config or watcher event.
    store.ingest({ "/ws/a.feature:4": "passed" });
    await flush();

    expect(discover.mock.calls.length).toBeGreaterThan(afterInitial);
    await subsystem.shutdown();
  });

  it("rejects an explicitly awaited rebuild failure", async () => {
    const { config } = makeConfig();
    const { subsystem } = build(config);
    await subsystem.applyCurrent();
    await flush();
    const model = (subsystem as unknown as { model: TraceabilityModel }).model;
    vi.spyOn(model, "rebuild").mockRejectedValueOnce(new Error("rebuild failed"));

    await expect(subsystem.rebuildNow()).rejects.toThrow("rebuild failed");

    await subsystem.shutdown();
  });

  it("logs and absorbs a scheduled rebuild failure", async () => {
    const logger = Logger.create();
    const warned = vi.spyOn(logger, "warn");
    const { config } = makeConfig();
    const { subsystem } = build(config, undefined, logger);
    await subsystem.applyCurrent();
    await flush();
    const model = (subsystem as unknown as { model: TraceabilityModel }).model;
    vi.spyOn(model, "rebuild").mockRejectedValueOnce(new Error("scheduled failed"));

    subsystem.scheduleRebuild();
    await flush();
    await flush();

    expect(warned).toHaveBeenCalledWith("Traceability rebuild failed", {
      error: "Error: scheduled failed",
    });
    await subsystem.shutdown();
  });

  it("does not tear down watchers when only siteUrl changes", async () => {
    const { config, set, fireChange } = makeConfig();
    const { subsystem, created } = build(config);

    await subsystem.applyCurrent();
    const initial = created.length;

    set({ xraySiteUrl: "acme.atlassian.net" });
    fireChange();
    await subsystem.applyCurrent();

    expect(created.length).toBe(initial);
    for (const w of created) {
      expect(w.dispose).not.toHaveBeenCalled();
    }
    expect(subsystem.traceabilityPanelActive).toBe(true);
    await subsystem.shutdown();
  });

  it("disposes and recreates the live adapter when the normalized API region changes", async () => {
    const { config, set, fireChange } = makeConfig({ xrayApiRegion: "global" });
    const adapter = { ...fakeAdapter("xray"), dispose: vi.fn() };
    const { subsystem } = build(config, { xray: adapter });
    await subsystem.applyCurrent();

    set({ xrayApiRegion: "au" });
    fireChange();
    await subsystem.applyCurrent();

    expect(adapter.dispose).toHaveBeenCalledOnce();
    expect(treeViews.__treeViewCounters.disposeCount).toBe(1);
    expect(treeViews.__treeViewCounters.createCount).toBe(2);
    await subsystem.shutdown();
  });
});

describe("TraceabilitySubsystem provider selection", () => {
  beforeEach(() => {
    treeViews.__resetTreeViewCounters();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to xray and warns once when the configured provider is unknown", async () => {
    const logger = Logger.create();
    const warn = vi.spyOn(logger, "warn");
    const { config, fireChange } = makeConfig({ traceabilityProvider: "bogus" });
    const { subsystem } = build(config, { xray: fakeAdapter("xray") }, logger);

    await subsystem.applyCurrent();
    fireChange();
    await subsystem.applyCurrent();

    expect(subsystem.traceabilityPanelActive).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("bogus");
    await subsystem.shutdown();
  });

  it("rebuilds the panel when the active provider id changes", async () => {
    const { config, set, fireChange } = makeConfig({ traceabilityProvider: "xray" });
    const { subsystem } = build(config, { xray: fakeAdapter("xray"), azure: fakeAdapter("azure") });

    await subsystem.applyCurrent();
    expect(treeViews.__treeViewCounters.createCount).toBe(1);

    set({ traceabilityProvider: "azure" });
    fireChange();
    await subsystem.applyCurrent();

    expect(treeViews.__treeViewCounters.disposeCount).toBe(1);
    expect(treeViews.__treeViewCounters.createCount).toBe(2);
    expect(subsystem.traceabilityPanelActive).toBe(true);
    await subsystem.shutdown();
  });
});

describe("TraceabilitySubsystem connection state", () => {
  const CONTEXT_KEY = "playwrightBddRunner.traceability.connected";

  beforeEach(() => {
    treeViews.__resetTreeViewCounters();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function connectedStates(spy: { mock: { calls: unknown[][] } }): boolean[] {
    return spy.mock.calls
      .filter((call) => call[0] === "setContext" && call[1] === CONTEXT_KEY)
      .map((call) => call[2] as boolean);
  }

  it("sets the context key true when connected", async () => {
    const exec = vi.spyOn(vscode.commands, "executeCommand");
    const { config } = makeConfig();
    const conn = makeConnection(true);
    conn.setLabel("acme.atlassian.net");
    const { subsystem } = build(config, undefined, Logger.create(), conn);

    await subsystem.applyCurrent();
    await flush();

    expect(connectedStates(exec).at(-1)).toBe(true);
    await subsystem.shutdown();
  });

  it("sets the context key false when disconnected", async () => {
    const exec = vi.spyOn(vscode.commands, "executeCommand");
    const { config } = makeConfig();
    const { subsystem } = build(config, undefined, Logger.create(), makeConnection(false));

    await subsystem.applyCurrent();
    await flush();

    expect(connectedStates(exec).at(-1)).toBe(false);
    await subsystem.shutdown();
  });

  // The board's quiet loads cannot read a context key back, so they gate on this getter instead; it must
  // track the same verdict, and start closed until a probe has actually landed.
  it("exposes the same verdict as a getter, false until the first probe lands", async () => {
    const { config } = makeConfig();
    const conn = makeConnection(false);
    const { subsystem } = build(config, undefined, Logger.create(), conn);
    expect(subsystem.connected).toBe(false);

    await subsystem.applyCurrent();
    await flush();
    expect(subsystem.connected).toBe(false);

    conn.setConnected(true);
    conn.fire();
    await flush();

    expect(subsystem.connected).toBe(true);
    await subsystem.shutdown();
    expect(subsystem.connected).toBe(false);
  });

  it("re-evaluates when the credential store fires a change", async () => {
    const exec = vi.spyOn(vscode.commands, "executeCommand");
    const { config } = makeConfig();
    const conn = makeConnection(false);
    const { subsystem } = build(config, undefined, Logger.create(), conn);

    await subsystem.applyCurrent();
    await flush();
    expect(connectedStates(exec).at(-1)).toBe(false);

    conn.setConnected(true);
    conn.setLabel("acme.atlassian.net");
    conn.fire();
    await flush();

    expect(connectedStates(exec).at(-1)).toBe(true);
    await subsystem.shutdown();
  });

  it("clears the context key to false when the panel tears down", async () => {
    const exec = vi.spyOn(vscode.commands, "executeCommand");
    const { config, set, fireChange } = makeConfig();
    const { subsystem } = build(config, undefined, Logger.create(), makeConnection(true));

    await subsystem.applyCurrent();
    await flush();

    exec.mockClear();
    set({ enableTraceabilityPanel: false });
    fireChange();
    await subsystem.applyCurrent();

    const states = connectedStates(exec);
    expect(states).toContain(false);
    expect(states.every((value) => value === false)).toBe(true);
    await subsystem.shutdown();
  });

  it("clears the context key to false on dispose", async () => {
    const exec = vi.spyOn(vscode.commands, "executeCommand");
    const { config } = makeConfig();
    const { subsystem } = build(config, undefined, Logger.create(), makeConnection(true));

    await subsystem.applyCurrent();
    await flush();

    exec.mockClear();
    await subsystem.shutdown();

    expect(connectedStates(exec).at(-1)).toBe(false);
  });

  it("drains an admitted connection-state probe and discards its teardown result", async () => {
    const exec = vi.spyOn(vscode.commands, "executeCommand");
    const { config, set } = makeConfig();
    const deferred = deferredConnection("acme.atlassian.net");
    const { subsystem } = build(config, undefined, Logger.create(), deferred);

    await subsystem.applyCurrent();
    await flush();
    expect(deferred.resolvers).toHaveLength(1);

    exec.mockClear();
    set({ enableTraceabilityPanel: false });
    let disabled = false;
    const disabling = subsystem.applyCurrent().then(() => {disabled = true;});
    await flush();
    expect(disabled).toBe(false);

    deferred.resolvers[0]!(true);
    await disabling;

    expect(connectedStates(exec)).toEqual([false]);
    await subsystem.shutdown();
  });

  it("keeps the newest result when an older overlapping probe resolves last", async () => {
    const exec = vi.spyOn(vscode.commands, "executeCommand");
    const { config } = makeConfig();
    const deferred = deferredConnection("acme.atlassian.net");
    const { subsystem } = build(config, undefined, Logger.create(), deferred);

    await subsystem.applyCurrent();
    await flush();
    deferred.fire();
    await flush();
    expect(deferred.resolvers).toHaveLength(2);

    exec.mockClear();
    // Newer probe (index 1) lands true first; the older probe (index 0) resolves false last and
    // must not overwrite it.
    deferred.resolvers[1]!(true);
    await flush();
    deferred.resolvers[0]!(false);
    await flush();

    expect(connectedStates(exec).at(-1)).toBe(true);
    await subsystem.shutdown();
  });
});

describe("TraceabilitySubsystem connection indicator", () => {
  beforeEach(() => {
    treeViews.__resetTreeViewCounters();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function spyIndicator(): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(TraceabilityTreeDataProvider.prototype, "setConnectionIndicator");
  }

  it("commits a checking row and then the ok indicator on a successful verify", async () => {
    const setIndicator = spyIndicator();
    const { config } = makeConfig();
    const conn = makeConnection(true, () =>
      Promise.resolve({ status: "ok", message: "Connected to acme; project CALC" })
    );
    conn.setLabel("acme.atlassian.net");
    const { subsystem } = build(config, undefined, Logger.create(), conn);

    await subsystem.applyCurrent();
    await flush();

    const calls = indicatorCalls(setIndicator);
    expect(calls).toContainEqual({ state: "checking", label: "acme.atlassian.net", message: "Checking connection…" });
    expect(calls.at(-1)).toEqual({ state: "ok", label: "acme.atlassian.net", message: "Connected to acme; project CALC" });
    await subsystem.shutdown();
  });

  it("appends the configured default project key to the committed indicator", async () => {
    const setIndicator = spyIndicator();
    const { config } = makeConfig({ xrayDefaultProjectKey: "CALC" });
    const conn = makeConnection(true, () => Promise.resolve({ status: "ok", message: "Connected to acme" }));
    conn.setLabel("acme.atlassian.net");
    const { subsystem } = build(config, undefined, Logger.create(), conn);

    await subsystem.applyCurrent();
    await flush();

    expect(indicatorCalls(setIndicator).at(-1)?.defaultProject).toBe("CALC");
    await subsystem.shutdown();
  });

  it("commits an auth-failed indicator when verify reports auth-failed", async () => {
    const setIndicator = spyIndicator();
    const { config } = makeConfig();
    const conn = makeConnection(true, () =>
      Promise.resolve({ status: "auth-failed", message: "Authentication failed: check your client ID and secret." })
    );
    conn.setLabel("acme.atlassian.net");
    const { subsystem } = build(config, undefined, Logger.create(), conn);

    await subsystem.applyCurrent();
    await flush();

    expect(indicatorCalls(setIndicator).at(-1)).toEqual({
      state: "auth-failed",
      label: "acme.atlassian.net",
      message: "Authentication failed: check your client ID and secret.",
    });
    await subsystem.shutdown();
  });

  it("commits an unreachable indicator when verify reports unreachable", async () => {
    const setIndicator = spyIndicator();
    const { config } = makeConfig();
    const conn = makeConnection(true, () =>
      Promise.resolve({ status: "unreachable", message: "Could not reach Xray: check your network connection." })
    );
    conn.setLabel("acme.atlassian.net");
    const { subsystem } = build(config, undefined, Logger.create(), conn);

    await subsystem.applyCurrent();
    await flush();

    expect(indicatorCalls(setIndicator).at(-1)).toEqual({
      state: "unreachable",
      label: "acme.atlassian.net",
      message: "Could not reach Xray: check your network connection.",
    });
    await subsystem.shutdown();
  });

  it("maps a thrown verify to an unreachable indicator carrying the error text and its cause", async () => {
    const setIndicator = spyIndicator();
    const { config } = makeConfig();
    const cause = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), { code: "ECONNREFUSED" });
    const conn = makeConnection(true, () => Promise.reject(new Error("boom", { cause })));
    conn.setLabel("acme.atlassian.net");
    const { subsystem } = build(config, undefined, Logger.create(), conn);

    await subsystem.applyCurrent();
    await flush();

    expect(indicatorCalls(setIndicator).at(-1)).toEqual({
      state: "unreachable",
      label: "acme.atlassian.net",
      message: "Integration adapter \"xray\" connection.verify failed. "
        + "(cause: boom (cause: ECONNREFUSED: connect ECONNREFUSED 10.0.0.1:443))",
    });
    await subsystem.shutdown();
  });

  it("discards a stale verify: an older refresh resolving last must not overwrite the newer result", async () => {
    const setIndicator = spyIndicator();
    const { config } = makeConfig();
    const deferred = deferredVerifyConnection("acme.atlassian.net");
    const conn: ConnectionControl = {
      connection: deferred.connection,
      setConnected: () => { /* fixed */ },
      setLabel: () => { /* fixed */ },
      fire: deferred.fire,
    };
    const { subsystem } = build(config, undefined, Logger.create(), conn);

    await subsystem.applyCurrent();
    await flush();
    expect(deferred.resolvers).toHaveLength(1);

    deferred.fire();
    await flush();
    expect(deferred.resolvers).toHaveLength(2);

    // Newer refresh (index 1) resolves ok first; the older refresh (index 0) resolves auth-failed
    // last and must be discarded on the epoch check.
    deferred.resolvers[1]!({ status: "ok", message: "newest" });
    await flush();
    deferred.resolvers[0]!({ status: "auth-failed", message: "stale" });
    await flush();

    expect(indicatorCalls(setIndicator).at(-1)).toEqual({
      state: "ok",
      label: "acme.atlassian.net",
      message: "newest",
    });
    await subsystem.shutdown();
  });

  it("keeps disable pending until an admitted verifier settles, then discards its result", async () => {
    const setIndicator = spyIndicator();
    const execute = vi.spyOn(vscode.commands, "executeCommand");
    const { config, set } = makeConfig();
    const deferred = deferredVerifyConnection("acme.atlassian.net");
    const conn: ConnectionControl = {
      connection: deferred.connection,
      setConnected: () => { /* fixed */ },
      setLabel: () => { /* fixed */ },
      fire: deferred.fire,
    };
    const { subsystem } = build(config, undefined, Logger.create(), conn);

    await subsystem.applyCurrent();
    await flush();
    expect(deferred.resolvers).toHaveLength(1);

    execute.mockClear();
    set({ enableTraceabilityPanel: false });
    let disabled = false;
    const disabling = subsystem.applyCurrent().then(() => {disabled = true;});
    await flush();

    expect(disabled).toBe(false);
    deferred.fire();
    await flush();
    expect(deferred.resolvers).toHaveLength(1);

    deferred.resolvers[0]!({ status: "ok", message: "too late" });
    await disabling;

    const calls = indicatorCalls(setIndicator);
    expect(calls.at(-1)).toEqual({ state: "checking", label: "acme.atlassian.net", message: "Checking connection…" });
    expect(calls).not.toContainEqual({ state: "ok", label: "acme.atlassian.net", message: "too late" });
    expect(execute.mock.calls
      .filter((call) => call[0] === "setContext" && call[1] === "playwrightBddRunner.traceability.connected")
      .map((call) => call[2])).toEqual([false]);
    await subsystem.shutdown();
  });

  it("clears the indicator when the connected adapter's connection has no verify", async () => {
    const setIndicator = spyIndicator();
    const { config } = makeConfig();
    const conn = makeConnection(true);
    conn.setLabel("acme.atlassian.net");
    const { subsystem } = build(config, undefined, Logger.create(), conn);

    await subsystem.applyCurrent();
    await flush();

    expect(setIndicator).toHaveBeenCalledWith(undefined);
    expect(indicatorCalls(setIndicator).some((c) => c?.state === "checking")).toBe(false);
    await subsystem.shutdown();
  });

  it("clears the indicator and does not crash for an adapter with no connection at all", async () => {
    const setIndicator = spyIndicator();
    const { config } = makeConfig();
    const { subsystem } = build(config, { xray: fakeAdapter("xray") });

    await subsystem.applyCurrent();
    await flush();

    expect(subsystem.traceabilityPanelActive).toBe(true);
    expect(setIndicator).toHaveBeenCalledWith(undefined);
    expect(indicatorCalls(setIndicator).some((c) => c?.state === "checking")).toBe(false);
    await subsystem.shutdown();
  });
});

describe("TraceabilitySubsystem sync staleness row", () => {
  beforeEach(() => {
    treeViews.__resetTreeViewCounters();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("carries the metadata snapshot's staleness on the connection row after verify", async () => {
    const setIndicator = vi.spyOn(TraceabilityTreeDataProvider.prototype, "setConnectionIndicator");
    const { config } = makeConfig();
    const syncedAt = Date.now() - 60_000;
    const adapter: TraceabilityAdapter = {
      id: "xray",
      label: "Xray",
      keyGrammar: { testPrefix: "TEST_", reqPrefix: "REQ_", keyShape: /^[A-Z]+-\d+$/, canonicalizeKey: (k) => k.toUpperCase() },
      browseUrl: () => undefined,
      connection: {
        onDidChange: new vscode.EventEmitter<void>().event,
        label: "acme.atlassian.net",
        isConnected: () => Promise.resolve(true),
        verify: () => Promise.resolve({ status: "ok", message: "Connected to acme" }),
      },
      metadata: {
        onDidChange: new vscode.EventEmitter<void>().event,
        snapshot: () => ({ tests: new Map(), fetchedScopes: [], catalogueProjects: [], completeProjects: [], verifiedAbsentKeys: [], syncedAt, stale: false, errors: [] }),
        sync: () => Promise.resolve(),
      },
    };
    const { subsystem } = build(config, { xray: adapter });

    await subsystem.applyCurrent();
    await flush();

    const last = indicatorCalls(setIndicator).at(-1);
    expect(last?.state).toBe("ok");
    expect(last?.sync).toEqual({ syncedAt, stale: false });
    await subsystem.shutdown();
  });
});

describe("TraceabilitySubsystem snapshot change event", () => {
  beforeEach(() => {
    treeViews.__resetTreeViewCounters();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("forwards a model rebuild to onDidChangeSnapshot (what the Coverage Board subscribes to)", async () => {
    const { config } = makeConfig();
    const { subsystem, store, discovery } = build(config);
    vi.spyOn(discovery, "discoverTestFiles").mockResolvedValue([]);

    await subsystem.applyCurrent();
    await flush();

    let fired = 0;
    subsystem.onDidChangeSnapshot(() => { fired += 1; });
    store.ingest({ "/ws/a.feature:4": "passed" });
    await flush();

    expect(fired).toBeGreaterThan(0);
    await subsystem.shutdown();
  });

  it("fires on teardown, by which point getSnapshot() already reads empty", async () => {
    const { config, set, fireChange } = makeConfig();
    const { subsystem, discovery } = build(config);
    vi.spyOn(discovery, "discoverTestFiles").mockResolvedValue([]);

    await subsystem.applyCurrent();
    await flush();

    let fired = false;
    let emptyAtFire = false;
    subsystem.onDidChangeSnapshot(() => {
      fired = true;
      emptyAtFire = subsystem.getSnapshot() === undefined;
    });

    set({ enableTraceabilityPanel: false });
    fireChange();
    await subsystem.applyCurrent();

    expect(fired).toBe(true);
    expect(emptyAtFire).toBe(true);
    await subsystem.shutdown();
  });

  it("disposes the swapped-out model on a provider change and re-points forwarding at the new one", async () => {
    const { config, set, fireChange } = makeConfig({ traceabilityProvider: "xray" });
    const { subsystem, store, discovery } = build(config, { xray: fakeAdapter("xray"), azure: fakeAdapter("azure") });
    vi.spyOn(discovery, "discoverTestFiles").mockResolvedValue([]);
    const disposeModel = vi.spyOn(TraceabilityModel.prototype, "dispose");

    await subsystem.applyCurrent();
    await flush();

    set({ traceabilityProvider: "azure" });
    fireChange();
    await subsystem.applyCurrent();
    await flush();

    // The xray model is torn down (its emitter with it), so the old forwarding subscription can never
    // fire again, no leak, no double-fire from the dead model.
    expect(disposeModel).toHaveBeenCalledTimes(1);

    // A rebuild on the new (azure) model drives the event exactly once.
    let fired = 0;
    subsystem.onDidChangeSnapshot(() => { fired += 1; });
    store.ingest({ "/ws/a.feature:4": "passed" });
    await flush();

    expect(fired).toBe(1);
    await subsystem.shutdown();
  });

  it("severs forwarding on dispose so later store activity fires nothing", async () => {
    const { config } = makeConfig();
    const { subsystem, store, discovery } = build(config);
    vi.spyOn(discovery, "discoverTestFiles").mockResolvedValue([]);

    await subsystem.applyCurrent();
    await flush();

    let fired = 0;
    subsystem.onDidChangeSnapshot(() => { fired += 1; });
    await subsystem.shutdown();
    const afterDispose = fired;

    store.ingest({ "/ws/x.feature:1": "passed" });
    await flush();

    expect(fired).toBe(afterDispose);
  });
});

describe("TraceabilitySubsystem tag-derived project keys", () => {
  const FEATURE = `Feature: Calc

@TEST_CALC-1 @REQ_MATH-9
Scenario: Divide
  Given a calculator

@REQ_OPS-4
Scenario: Untagged by test
  Given x
`;

  let dir: string;

  beforeEach(() => {
    treeViews.__resetTreeViewCounters();
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "specwright-scope-"));
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("derives projects from test AND requirement tags, so a requirements-first workspace is never empty", async () => {
    const file = path.join(dir, "calc.feature");
    fs.writeFileSync(file, FEATURE, "utf-8");
    const adapter = fakeAdapter("xray");
    adapter.keyGrammar.projectOf = (key: string) => key.split("-")[0] ?? key;
    const { config } = makeConfig();
    const { subsystem, discovery } = build(config, { xray: adapter });
    vi.spyOn(discovery, "discoverTestFiles").mockResolvedValue([file]);

    await subsystem.applyCurrent();
    await flush();

    expect(subsystem.tagDerivedProjectKeys().sort()).toEqual(["CALC", "MATH", "OPS"]);
    await subsystem.shutdown();
  });

  it("derives nothing when the panel is off, so no model exists", async () => {
    const { config } = makeConfig({ enableTraceabilityPanel: false });
    const { subsystem } = build(config);

    await subsystem.applyCurrent();

    expect(subsystem.tagDerivedProjectKeys()).toEqual([]);
    await subsystem.shutdown();
  });
});
