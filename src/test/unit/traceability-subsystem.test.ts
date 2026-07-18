import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import {
  TraceabilityConnectionSource,
  TraceabilitySubsystem,
} from "../../traceability/traceability-subsystem";
import { TraceabilityAdapter } from "../../traceability/traceability-adapter";
import { XrayAdapter } from "../../xray/xray-adapter";
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
  connection: TraceabilityConnectionSource;
  setConnected: (value: boolean) => void;
  setLabel: (label: string) => void;
  fire: () => void;
}

function makeConnection(initial = false): ConnectionControl {
  let connected = initial;
  let label = "";
  const emitter = new vscode.EventEmitter<void>();
  const connection: TraceabilityConnectionSource = {
    onDidChange: emitter.event,
    get label(): string {
      return label;
    },
    isConnected: () => Promise.resolve(connected),
  };
  return {
    connection,
    setConnected: (value) => { connected = value; },
    setLabel: (next) => { label = next; },
    fire: () => emitter.fire(),
  };
}

interface DeferredConnection extends ConnectionControl {
  // One resolver per outstanding isConnected() probe, in call order, so a test can resolve them
  // out of order to model overlapping refreshes and late resolutions.
  resolvers: Array<(value: boolean) => void>;
}

function deferredConnection(label = ""): DeferredConnection {
  const resolvers: Array<(value: boolean) => void> = [];
  const emitter = new vscode.EventEmitter<void>();
  const connection: TraceabilityConnectionSource = {
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

function fakeAdapter(id: string): TraceabilityAdapter {
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
  };
}

function build(
  config: ExtensionConfig,
  adapters?: Record<string, TraceabilityAdapter>,
  logger = Logger.create(),
  connection: ConnectionControl = makeConnection()
): { subsystem: TraceabilitySubsystem; created: FakeWatcher[]; connection: ConnectionControl } {
  const subsystem = new TraceabilitySubsystem(
    config,
    adapters ?? { xray: new XrayAdapter(config) },
    connection.connection,
    FeatureParser.create(logger),
    TestDiscoveryManager.create(logger, config),
    PlaywrightJsonParser.create(logger),
    logger
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
  return { subsystem, created, connection };
}

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

  it("sets the context key true and shows the connected indicator when connected", async () => {
    const exec = vi.spyOn(vscode.commands, "executeCommand");
    const { config } = makeConfig();
    const conn = makeConnection(true);
    conn.setLabel("acme.atlassian.net");
    const { subsystem } = build(config, undefined, Logger.create(), conn);

    subsystem.applyCurrent();
    await flush();

    expect(connectedStates(exec).at(-1)).toBe(true);
    expect(treeViews.__getLastTreeView()?.message).toBe("acme.atlassian.net · Connected");
    subsystem.dispose();
  });

  it("sets the context key false and clears the indicator when disconnected", async () => {
    const exec = vi.spyOn(vscode.commands, "executeCommand");
    const { config } = makeConfig();
    const { subsystem } = build(config, undefined, Logger.create(), makeConnection(false));

    subsystem.applyCurrent();
    await flush();

    expect(connectedStates(exec).at(-1)).toBe(false);
    expect(treeViews.__getLastTreeView()?.message).toBe("");
    subsystem.dispose();
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
    expect(treeViews.__getLastTreeView()?.message).toBe("acme.atlassian.net · Connected");
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
    expect(treeViews.__getLastTreeView()?.message).not.toBe("acme.atlassian.net · Connected");
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
    expect(treeViews.__getLastTreeView()?.message).toBe("acme.atlassian.net · Connected");
    subsystem.dispose();
  });
});
