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
import { TraceabilityModel } from "../../traceability/traceability-model";
import { TraceabilityAdapterRegistry } from "../../traceability/adapter-registry";
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
    get xrayDefaultProjectKey(): string { return state.xrayDefaultProjectKey; },
    addChangeListener(l: () => void): { dispose: () => void } {
      listener = l;
      return { dispose: () => { listener = undefined; } };
    },
  } as unknown as ExtensionConfig;
  return { config, set: (next) => Object.assign(state, next), fireChange: () => listener?.() };
}

interface FakeWatcher {
  onDidCreate: () => { dispose: () => void };
  onDidChange: () => { dispose: () => void };
  onDidDelete: () => { dispose: () => void };
  dispose: ReturnType<typeof vi.fn>;
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
    registry.register({ id, create: () => adapter });
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
  memento: vscode.Memento = fakeMemento()
): {
  subsystem: TraceabilitySubsystem;
  created: FakeWatcher[];
  connection: ConnectionControl;
  store: RunResultStore;
  discovery: TestDiscoveryManager;
  memento: vscode.Memento;
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
    memento
  );
  subsystem.rebuildDebounceMs = 0;
  const created: FakeWatcher[] = [];
  vi.spyOn(vscode.workspace, "createFileSystemWatcher").mockImplementation(() => {
    const watcher: FakeWatcher = {
      onDidCreate: () => ({ dispose: () => {} }),
      onDidChange: () => ({ dispose: () => {} }),
      onDidDelete: () => ({ dispose: () => {} }),
      dispose: vi.fn(),
    };
    created.push(watcher);
    return watcher as unknown as vscode.FileSystemWatcher;
  });
  return { subsystem, created, connection, store, discovery, memento };
}

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

    subsystem.applyCurrent();
    await flush();

    subsystem.toggleGrouping();
    expect(memento.get(GROUPING_KEY)).toBe("file");

    // Rebuild the panel; the fresh provider must restore "file" from the memento, so the next
    // toggle returns to "test" rather than flipping away from a defaulted "test".
    set({ enableTraceabilityPanel: false });
    fireChange();
    set({ enableTraceabilityPanel: true });
    fireChange();
    await flush();

    subsystem.toggleGrouping();
    expect(memento.get(GROUPING_KEY)).toBe("test");
    subsystem.dispose();
  });

  it("coerces an unknown stored mode to the by-test layout", async () => {
    const memento = fakeMemento();
    await memento.update(GROUPING_KEY, "bogus");
    const { config } = makeConfig();
    const { subsystem } = build(config, undefined, Logger.create(), makeConnection(), memento);

    subsystem.applyCurrent();
    await flush();

    // A garbage value reads back as "test", so one toggle lands on "file".
    subsystem.toggleGrouping();
    expect(memento.get(GROUPING_KEY)).toBe("file");
    subsystem.dispose();
  });
});

describe("TraceabilitySubsystem lifecycle", () => {
  beforeEach(() => {
    treeViews.__resetTreeViewCounters();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("creates the tree view once and is idempotent across repeated applyCurrent", () => {
    const { config } = makeConfig();
    const { subsystem } = build(config);

    subsystem.applyCurrent();
    subsystem.applyCurrent();

    expect(subsystem.traceabilityPanelActive).toBe(true);
    expect(treeViews.__treeViewCounters.createCount).toBe(1);
    subsystem.dispose();
  });

  it("tears down and re-creates with zero residue across disable → re-enable", () => {
    const { config, set, fireChange } = makeConfig();
    const { subsystem, created } = build(config);

    subsystem.applyCurrent();
    const firstWatchers = [...created];
    expect(firstWatchers.length).toBeGreaterThan(0);

    set({ enableTraceabilityPanel: false });
    fireChange();
    expect(subsystem.traceabilityPanelActive).toBe(false);
    expect(treeViews.__treeViewCounters.disposeCount).toBe(1);
    for (const w of firstWatchers) {
      expect(w.dispose).toHaveBeenCalled();
    }

    set({ enableTraceabilityPanel: true });
    fireChange();
    expect(subsystem.traceabilityPanelActive).toBe(true);
    expect(treeViews.__treeViewCounters.createCount).toBe(2);
    subsystem.dispose();
  });

  it("rebuilds watchers when the feature pattern changes", () => {
    const { config, set, fireChange } = makeConfig();
    const { subsystem, created } = build(config);

    subsystem.applyCurrent();
    const initial = created.length;

    set({ testFilePattern: "features/**/*.feature" });
    fireChange();

    expect(created.length).toBeGreaterThan(initial);
    for (let i = 0; i < initial; i++) {
      expect(created[i]!.dispose).toHaveBeenCalled();
    }
    subsystem.dispose();
  });

  it("rebuilds the model when the run-result store reports fresh badges (P1 live-badge wiring)", async () => {
    const { config } = makeConfig();
    const { subsystem, store, discovery } = build(config);
    const discover = vi.spyOn(discovery, "discoverTestFiles").mockResolvedValue([]);

    subsystem.applyCurrent();
    await flush();
    const afterInitial = discover.mock.calls.length;
    expect(afterInitial).toBeGreaterThan(0);

    // A Test Explorer run feeds the store, which must drive a rebuild with no config or watcher event.
    store.ingest({ "/ws/a.feature:4": "passed" });
    await flush();

    expect(discover.mock.calls.length).toBeGreaterThan(afterInitial);
    subsystem.dispose();
  });

  it("does not tear down watchers when only siteUrl changes", () => {
    const { config, set, fireChange } = makeConfig();
    const { subsystem, created } = build(config);

    subsystem.applyCurrent();
    const initial = created.length;

    set({ xraySiteUrl: "acme.atlassian.net" });
    fireChange();

    expect(created.length).toBe(initial);
    for (const w of created) {
      expect(w.dispose).not.toHaveBeenCalled();
    }
    expect(subsystem.traceabilityPanelActive).toBe(true);
    subsystem.dispose();
  });
});

describe("TraceabilitySubsystem provider selection", () => {
  beforeEach(() => {
    treeViews.__resetTreeViewCounters();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("falls back to xray and warns once when the configured provider is unknown", () => {
    const logger = Logger.create();
    const warn = vi.spyOn(logger, "warn");
    const { config, fireChange } = makeConfig({ traceabilityProvider: "bogus" });
    const { subsystem } = build(config, { xray: fakeAdapter("xray") }, logger);

    subsystem.applyCurrent();
    fireChange();

    expect(subsystem.traceabilityPanelActive).toBe(true);
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]![0]).toContain("bogus");
    subsystem.dispose();
  });

  it("rebuilds the panel when the active provider id changes", () => {
    const { config, set, fireChange } = makeConfig({ traceabilityProvider: "xray" });
    const { subsystem } = build(config, { xray: fakeAdapter("xray"), azure: fakeAdapter("azure") });

    subsystem.applyCurrent();
    expect(treeViews.__treeViewCounters.createCount).toBe(1);

    set({ traceabilityProvider: "azure" });
    fireChange();

    expect(treeViews.__treeViewCounters.disposeCount).toBe(1);
    expect(treeViews.__treeViewCounters.createCount).toBe(2);
    expect(subsystem.traceabilityPanelActive).toBe(true);
    subsystem.dispose();
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

    subsystem.applyCurrent();
    await flush();

    expect(connectedStates(exec).at(-1)).toBe(true);
    subsystem.dispose();
  });

  it("sets the context key false when disconnected", async () => {
    const exec = vi.spyOn(vscode.commands, "executeCommand");
    const { config } = makeConfig();
    const { subsystem } = build(config, undefined, Logger.create(), makeConnection(false));

    subsystem.applyCurrent();
    await flush();

    expect(connectedStates(exec).at(-1)).toBe(false);
    subsystem.dispose();
  });

  // The board's quiet loads cannot read a context key back, so they gate on this getter instead; it must
  // track the same verdict, and start closed until a probe has actually landed.
  it("exposes the same verdict as a getter, false until the first probe lands", async () => {
    const { config } = makeConfig();
    const conn = makeConnection(false);
    const { subsystem } = build(config, undefined, Logger.create(), conn);
    expect(subsystem.connected).toBe(false);

    subsystem.applyCurrent();
    await flush();
    expect(subsystem.connected).toBe(false);

    conn.setConnected(true);
    conn.fire();
    await flush();

    expect(subsystem.connected).toBe(true);
    subsystem.dispose();
    expect(subsystem.connected).toBe(false);
  });

  it("re-evaluates when the credential store fires a change", async () => {
    const exec = vi.spyOn(vscode.commands, "executeCommand");
    const { config } = makeConfig();
    const conn = makeConnection(false);
    const { subsystem } = build(config, undefined, Logger.create(), conn);

    subsystem.applyCurrent();
    await flush();
    expect(connectedStates(exec).at(-1)).toBe(false);

    conn.setConnected(true);
    conn.setLabel("acme.atlassian.net");
    conn.fire();
    await flush();

    expect(connectedStates(exec).at(-1)).toBe(true);
    subsystem.dispose();
  });

  it("clears the context key to false when the panel tears down", async () => {
    const exec = vi.spyOn(vscode.commands, "executeCommand");
    const { config, set, fireChange } = makeConfig();
    const { subsystem } = build(config, undefined, Logger.create(), makeConnection(true));

    subsystem.applyCurrent();
    await flush();

    exec.mockClear();
    set({ enableTraceabilityPanel: false });
    fireChange();

    const states = connectedStates(exec);
    expect(states).toContain(false);
    expect(states.every((value) => value === false)).toBe(true);
    subsystem.dispose();
  });

  it("clears the context key to false on dispose", async () => {
    const exec = vi.spyOn(vscode.commands, "executeCommand");
    const { config } = makeConfig();
    const { subsystem } = build(config, undefined, Logger.create(), makeConnection(true));

    subsystem.applyCurrent();
    await flush();

    exec.mockClear();
    subsystem.dispose();

    expect(connectedStates(exec).at(-1)).toBe(false);
  });

  it("discards a probe that resolves true after teardown so the context key stays false", async () => {
    const exec = vi.spyOn(vscode.commands, "executeCommand");
    const { config, set, fireChange } = makeConfig();
    const deferred = deferredConnection("acme.atlassian.net");
    const { subsystem } = build(config, undefined, Logger.create(), deferred);

    subsystem.applyCurrent();
    await flush();
    expect(deferred.resolvers).toHaveLength(1);

    set({ enableTraceabilityPanel: false });
    fireChange();
    exec.mockClear();

    deferred.resolvers[0]!(true);
    await flush();

    expect(connectedStates(exec)).not.toContain(true);
    subsystem.dispose();
  });

  it("keeps the newest result when an older overlapping probe resolves last", async () => {
    const exec = vi.spyOn(vscode.commands, "executeCommand");
    const { config } = makeConfig();
    const deferred = deferredConnection("acme.atlassian.net");
    const { subsystem } = build(config, undefined, Logger.create(), deferred);

    subsystem.applyCurrent();
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
    subsystem.dispose();
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

    subsystem.applyCurrent();
    await flush();

    const calls = indicatorCalls(setIndicator);
    expect(calls).toContainEqual({ state: "checking", label: "acme.atlassian.net", message: "Checking connection…" });
    expect(calls.at(-1)).toEqual({ state: "ok", label: "acme.atlassian.net", message: "Connected to acme; project CALC" });
    subsystem.dispose();
  });

  it("appends the configured default project key to the committed indicator", async () => {
    const setIndicator = spyIndicator();
    const { config } = makeConfig({ xrayDefaultProjectKey: "CALC" });
    const conn = makeConnection(true, () => Promise.resolve({ status: "ok", message: "Connected to acme" }));
    conn.setLabel("acme.atlassian.net");
    const { subsystem } = build(config, undefined, Logger.create(), conn);

    subsystem.applyCurrent();
    await flush();

    expect(indicatorCalls(setIndicator).at(-1)?.defaultProject).toBe("CALC");
    subsystem.dispose();
  });

  it("commits an auth-failed indicator when verify reports auth-failed", async () => {
    const setIndicator = spyIndicator();
    const { config } = makeConfig();
    const conn = makeConnection(true, () =>
      Promise.resolve({ status: "auth-failed", message: "Authentication failed: check your client ID and secret." })
    );
    conn.setLabel("acme.atlassian.net");
    const { subsystem } = build(config, undefined, Logger.create(), conn);

    subsystem.applyCurrent();
    await flush();

    expect(indicatorCalls(setIndicator).at(-1)).toEqual({
      state: "auth-failed",
      label: "acme.atlassian.net",
      message: "Authentication failed: check your client ID and secret.",
    });
    subsystem.dispose();
  });

  it("commits an unreachable indicator when verify reports unreachable", async () => {
    const setIndicator = spyIndicator();
    const { config } = makeConfig();
    const conn = makeConnection(true, () =>
      Promise.resolve({ status: "unreachable", message: "Could not reach Xray: check your network connection." })
    );
    conn.setLabel("acme.atlassian.net");
    const { subsystem } = build(config, undefined, Logger.create(), conn);

    subsystem.applyCurrent();
    await flush();

    expect(indicatorCalls(setIndicator).at(-1)).toEqual({
      state: "unreachable",
      label: "acme.atlassian.net",
      message: "Could not reach Xray: check your network connection.",
    });
    subsystem.dispose();
  });

  it("maps a thrown verify to an unreachable indicator carrying the error text", async () => {
    const setIndicator = spyIndicator();
    const { config } = makeConfig();
    const conn = makeConnection(true, () => Promise.reject(new Error("boom")));
    conn.setLabel("acme.atlassian.net");
    const { subsystem } = build(config, undefined, Logger.create(), conn);

    subsystem.applyCurrent();
    await flush();

    expect(indicatorCalls(setIndicator).at(-1)).toEqual({
      state: "unreachable",
      label: "acme.atlassian.net",
      message: "Error: boom",
    });
    subsystem.dispose();
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

    subsystem.applyCurrent();
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
    subsystem.dispose();
  });

  it("discards a verify that resolves after dispose", async () => {
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

    subsystem.applyCurrent();
    await flush();
    expect(deferred.resolvers).toHaveLength(1);

    subsystem.dispose();
    deferred.resolvers[0]!({ status: "ok", message: "too late" });
    await flush();

    const calls = indicatorCalls(setIndicator);
    expect(calls.at(-1)).toEqual({ state: "checking", label: "acme.atlassian.net", message: "Checking connection…" });
    expect(calls).not.toContainEqual({ state: "ok", label: "acme.atlassian.net", message: "too late" });
  });

  it("clears the indicator when the connected adapter's connection has no verify", async () => {
    const setIndicator = spyIndicator();
    const { config } = makeConfig();
    const conn = makeConnection(true);
    conn.setLabel("acme.atlassian.net");
    const { subsystem } = build(config, undefined, Logger.create(), conn);

    subsystem.applyCurrent();
    await flush();

    expect(setIndicator).toHaveBeenCalledWith(undefined);
    expect(indicatorCalls(setIndicator).some((c) => c?.state === "checking")).toBe(false);
    subsystem.dispose();
  });

  it("clears the indicator and does not crash for an adapter with no connection at all", async () => {
    const setIndicator = spyIndicator();
    const { config } = makeConfig();
    const { subsystem } = build(config, { xray: fakeAdapter("xray") });

    subsystem.applyCurrent();
    await flush();

    expect(subsystem.traceabilityPanelActive).toBe(true);
    expect(setIndicator).toHaveBeenCalledWith(undefined);
    expect(indicatorCalls(setIndicator).some((c) => c?.state === "checking")).toBe(false);
    subsystem.dispose();
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

    subsystem.applyCurrent();
    await flush();

    const last = indicatorCalls(setIndicator).at(-1);
    expect(last?.state).toBe("ok");
    expect(last?.sync).toEqual({ syncedAt, stale: false });
    subsystem.dispose();
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

    subsystem.applyCurrent();
    await flush();

    let fired = 0;
    subsystem.onDidChangeSnapshot(() => { fired += 1; });
    store.ingest({ "/ws/a.feature:4": "passed" });
    await flush();

    expect(fired).toBeGreaterThan(0);
    subsystem.dispose();
  });

  it("fires on teardown, by which point getSnapshot() already reads empty", async () => {
    const { config, set, fireChange } = makeConfig();
    const { subsystem, discovery } = build(config);
    vi.spyOn(discovery, "discoverTestFiles").mockResolvedValue([]);

    subsystem.applyCurrent();
    await flush();

    let fired = false;
    let emptyAtFire = false;
    subsystem.onDidChangeSnapshot(() => {
      fired = true;
      emptyAtFire = subsystem.getSnapshot() === undefined;
    });

    set({ enableTraceabilityPanel: false });
    fireChange();

    expect(fired).toBe(true);
    expect(emptyAtFire).toBe(true);
    subsystem.dispose();
  });

  it("disposes the swapped-out model on a provider change and re-points forwarding at the new one", async () => {
    const { config, set, fireChange } = makeConfig({ traceabilityProvider: "xray" });
    const { subsystem, store, discovery } = build(config, { xray: fakeAdapter("xray"), azure: fakeAdapter("azure") });
    vi.spyOn(discovery, "discoverTestFiles").mockResolvedValue([]);
    const disposeModel = vi.spyOn(TraceabilityModel.prototype, "dispose");

    subsystem.applyCurrent();
    await flush();

    set({ traceabilityProvider: "azure" });
    fireChange();
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
    subsystem.dispose();
  });

  it("severs forwarding on dispose so later store activity fires nothing", async () => {
    const { config } = makeConfig();
    const { subsystem, store, discovery } = build(config);
    vi.spyOn(discovery, "discoverTestFiles").mockResolvedValue([]);

    subsystem.applyCurrent();
    await flush();

    let fired = 0;
    subsystem.onDidChangeSnapshot(() => { fired += 1; });
    subsystem.dispose();
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

    subsystem.applyCurrent();
    await flush();

    expect(subsystem.tagDerivedProjectKeys().sort()).toEqual(["CALC", "MATH", "OPS"]);
    subsystem.dispose();
  });

  it("derives nothing when the panel is off, so no model exists", () => {
    const { config } = makeConfig({ enableTraceabilityPanel: false });
    const { subsystem } = build(config);

    subsystem.applyCurrent();

    expect(subsystem.tagDerivedProjectKeys()).toEqual([]);
    subsystem.dispose();
  });
});
