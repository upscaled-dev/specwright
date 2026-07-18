import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import { XraySubsystem } from "../../xray/xray-subsystem";
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

interface XrayConfigState {
  enableXrayPanel: boolean;
  testFilePattern: string;
  xrayTestTagPrefix: string;
  xrayReqTagPrefix: string;
  xraySiteUrl: string;
}

function makeConfig(initial?: Partial<XrayConfigState>): {
  config: ExtensionConfig;
  set: (next: Partial<XrayConfigState>) => void;
  fireChange: () => void;
} {
  const state: XrayConfigState = {
    enableXrayPanel: true,
    testFilePattern: "**/*.feature",
    xrayTestTagPrefix: "TEST_",
    xrayReqTagPrefix: "REQ_",
    xraySiteUrl: "",
    ...initial,
  };
  let listener: (() => void) | undefined;
  const config = {
    get enableXrayPanel(): boolean { return state.enableXrayPanel; },
    get testFilePattern(): string { return state.testFilePattern; },
    get xrayTestTagPrefix(): string { return state.xrayTestTagPrefix; },
    get xrayReqTagPrefix(): string { return state.xrayReqTagPrefix; },
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

function build(config: ExtensionConfig): { subsystem: XraySubsystem; created: FakeWatcher[] } {
  const logger = Logger.create();
  const subsystem = new XraySubsystem(
    config,
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

describe("XraySubsystem lifecycle", () => {
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

    expect(subsystem.xrayPanelActive).toBe(true);
    expect(treeViews.__treeViewCounters.createCount).toBe(1);
    subsystem.dispose();
  });

  it("tears down and re-creates with zero residue across disable → re-enable", () => {
    const { config, set, fireChange } = makeConfig();
    const { subsystem, created } = build(config);

    subsystem.applyCurrent();
    const firstWatchers = [...created];
    expect(firstWatchers.length).toBeGreaterThan(0);

    set({ enableXrayPanel: false });
    fireChange();
    expect(subsystem.xrayPanelActive).toBe(false);
    expect(treeViews.__treeViewCounters.disposeCount).toBe(1);
    for (const w of firstWatchers) {
      expect(w.dispose).toHaveBeenCalled();
    }

    set({ enableXrayPanel: true });
    fireChange();
    expect(subsystem.xrayPanelActive).toBe(true);
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
    expect(subsystem.xrayPanelActive).toBe(true);
    subsystem.dispose();
  });
});
