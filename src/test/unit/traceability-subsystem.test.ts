import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import { TraceabilitySubsystem } from "../../traceability/traceability-subsystem";
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
  __resetTreeViewCounters: () => void;
});

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
  logger = Logger.create()
): { subsystem: TraceabilitySubsystem; created: FakeWatcher[] } {
  const subsystem = new TraceabilitySubsystem(
    config,
    adapters ?? { xray: new XrayAdapter(config) },
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
  return { subsystem, created };
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
