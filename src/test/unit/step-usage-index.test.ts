import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import { StepUsageIndex } from "../../providers/step-usage-index";
import { StepResolver, ParsedStepDefWithFile } from "../../providers/step-resolver";
import type { ExtensionConfig } from "../../core/extension-config";
import type { Logger } from "../../utils/logger";

const stubLogger = {
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
  debug: (): void => {},
} as unknown as Logger;

function makeConfig(opts: {
  pattern?: string;
  stepPaths?: string[];
}): ExtensionConfig {
  return {
    testFilePattern: opts.pattern ?? "**/*.feature",
    stepDefinitionPaths: opts.stepPaths ?? ["features/steps/**/*.ts"],
  } as unknown as ExtensionConfig;
}

interface FakeWatcher {
  onDidCreate: (cb: (uri: vscode.Uri) => void) => { dispose: () => void };
  onDidChange: (cb: (uri: vscode.Uri) => void) => { dispose: () => void };
  onDidDelete: (cb: (uri: vscode.Uri) => void) => { dispose: () => void };
  dispose: () => void;
  triggerChange: (uri: vscode.Uri) => void;
  triggerCreate: (uri: vscode.Uri) => void;
  triggerDelete: (uri: vscode.Uri) => void;
  disposed: boolean;
  pattern: string;
}

function makeFakeWatcher(pattern: string): FakeWatcher {
  const changeHandlers: Array<(uri: vscode.Uri) => void> = [];
  const createHandlers: Array<(uri: vscode.Uri) => void> = [];
  const deleteHandlers: Array<(uri: vscode.Uri) => void> = [];
  const watcher: FakeWatcher = {
    pattern,
    onDidChange: (cb) => {
      changeHandlers.push(cb);
      return { dispose: () => {} };
    },
    onDidCreate: (cb) => {
      createHandlers.push(cb);
      return { dispose: () => {} };
    },
    onDidDelete: (cb) => {
      deleteHandlers.push(cb);
      return { dispose: () => {} };
    },
    dispose: () => {
      watcher.disposed = true;
    },
    triggerChange: (uri) => {
      for (const h of changeHandlers) {h(uri);}
    },
    triggerCreate: (uri) => {
      for (const h of createHandlers) {h(uri);}
    },
    triggerDelete: (uri) => {
      for (const h of deleteHandlers) {h(uri);}
    },
    disposed: false,
  };
  return watcher;
}

function encode(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text, "utf-8"));
}

function defOf(
  pattern: string,
  filePath: string,
  line: number,
  isRegex = false
): ParsedStepDefWithFile {
  return {
    pattern,
    filePath,
    line,
    isRegex,
    regex: isRegex
      ? new RegExp(`^${pattern}$`)
      : new RegExp(`^${pattern.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  };
}

function makeResolverWithDefs(defs: ParsedStepDefWithFile[]): StepResolver {
  const resolver = new StepResolver();
  resolver.loadAllStepDefs = async (): Promise<ParsedStepDefWithFile[]> => defs;
  return resolver;
}

describe("StepUsageIndex", () => {
  const originalFindFiles = vscode.workspace.findFiles;
  const originalCreateWatcher = vscode.workspace.createFileSystemWatcher;
  const originalReadFile = vscode.workspace.fs.readFile;
  let findFilesMock: ReturnType<typeof vi.fn>;
  let readFileMock: ReturnType<typeof vi.fn>;
  let watchers: FakeWatcher[];
  let featureContents: Map<string, string>;

  beforeEach(() => {
    featureContents = new Map();
    findFilesMock = vi.fn(async (pattern: string) => {
      if (pattern.endsWith(".feature") || pattern.includes("feature")) {
        return Array.from(featureContents.keys()).map((p) => vscode.Uri.file(p));
      }
      return [];
    });
    readFileMock = vi.fn(async (uri: { fsPath: string }) => {
      const content = featureContents.get(uri.fsPath);
      if (content === undefined) {throw new Error(`no content for ${uri.fsPath}`);}
      return encode(content);
    });
    watchers = [];
    (vscode.workspace as { findFiles: unknown }).findFiles = findFilesMock;
    (vscode.workspace.fs as { readFile: unknown }).readFile = readFileMock;
    (vscode.workspace as { createFileSystemWatcher: unknown }).createFileSystemWatcher = (
      pattern: string
    ): FakeWatcher => {
      const w = makeFakeWatcher(pattern);
      watchers.push(w);
      return w;
    };
  });

  afterEach(() => {
    (vscode.workspace as { findFiles: unknown }).findFiles = originalFindFiles;
    (vscode.workspace.fs as { readFile: unknown }).readFile = originalReadFile;
    (vscode.workspace as { createFileSystemWatcher: unknown }).createFileSystemWatcher = originalCreateWatcher;
  });

  it("is lazy: does not scan until first getUsagesForDef()", () => {
    const def = defOf("I have a thing", "/ws/steps/a.ts", 0);
    const resolver = makeResolverWithDefs([def]);
    const idx = new StepUsageIndex(makeConfig({}), resolver, stubLogger);
    expect(findFilesMock).toHaveBeenCalledTimes(0);
    idx.dispose();
  });

  it("returns usages across multiple feature files for a def", async () => {
    const def = defOf("I have a thing", "/ws/steps/a.ts", 3);
    featureContents.set(
      "/ws/a.feature",
      [
        "Feature: A",
        "  Scenario: S",
        "    Given I have a thing",
      ].join("\n")
    );
    featureContents.set(
      "/ws/b.feature",
      [
        "Feature: B",
        "  Scenario: T",
        "    Given I have a thing",
      ].join("\n")
    );
    const resolver = makeResolverWithDefs([def]);
    const idx = new StepUsageIndex(makeConfig({}), resolver, stubLogger);

    const usages = await idx.getUsagesForDef(def);
    expect(usages).toHaveLength(2);
    expect(usages.map((u) => u.featurePath).sort()).toEqual(["/ws/a.feature", "/ws/b.feature"]);
    for (const u of usages) {
      expect(u.line).toBe(2);
      expect(u.stepText).toBe("I have a thing");
      expect(u.keyword).toBe("Given");
    }
    idx.dispose();
  });

  it("countUsagesForDef returns the total across feature files", async () => {
    const def = defOf("I have a thing", "/ws/steps/a.ts", 0);
    featureContents.set(
      "/ws/a.feature",
      [
        "Feature: A",
        "  Scenario: S",
        "    Given I have a thing",
        "    And I have a thing",
      ].join("\n")
    );
    const resolver = makeResolverWithDefs([def]);
    const idx = new StepUsageIndex(makeConfig({}), resolver, stubLogger);

    const count = await idx.countUsagesForDef(def);
    expect(count).toBe(2);
    idx.dispose();
  });

  it("getAllUsages includes defs with zero usages", async () => {
    const usedDef = defOf("I have a thing", "/ws/steps/a.ts", 0);
    const unusedDef = defOf("I am never called", "/ws/steps/a.ts", 5);
    featureContents.set(
      "/ws/a.feature",
      [
        "Feature: A",
        "  Scenario: S",
        "    Given I have a thing",
      ].join("\n")
    );
    const resolver = makeResolverWithDefs([usedDef, unusedDef]);
    const idx = new StepUsageIndex(makeConfig({}), resolver, stubLogger);

    const all = await idx.getAllUsages();
    expect(all.get(usedDef)).toHaveLength(1);
    expect(all.get(unusedDef)).toEqual([]);
    idx.dispose();
  });

  it("memoizes the scan: a second call does not re-read", async () => {
    const def = defOf("I have a thing", "/ws/steps/a.ts", 0);
    featureContents.set(
      "/ws/a.feature",
      [
        "Feature: A",
        "  Scenario: S",
        "    Given I have a thing",
      ].join("\n")
    );
    const resolver = makeResolverWithDefs([def]);
    const idx = new StepUsageIndex(makeConfig({}), resolver, stubLogger);

    await idx.getUsagesForDef(def);
    const firstReadCount = readFileMock.mock.calls.length;
    await idx.getUsagesForDef(def);
    expect(readFileMock.mock.calls.length).toBe(firstReadCount);
    idx.dispose();
  });

  it("per-feature invalidation: onDidChange re-indexes only that file", async () => {
    const def = defOf("I have a thing", "/ws/steps/a.ts", 0);
    featureContents.set(
      "/ws/a.feature",
      ["Feature: A", "  Scenario: S", "    Given I have a thing"].join("\n")
    );
    featureContents.set(
      "/ws/b.feature",
      ["Feature: B", "  Scenario: T", "    Given I have a thing"].join("\n")
    );
    const resolver = makeResolverWithDefs([def]);
    const idx = new StepUsageIndex(makeConfig({}), resolver, stubLogger);

    expect(await idx.countUsagesForDef(def)).toBe(2);

    featureContents.set(
      "/ws/a.feature",
      [
        "Feature: A",
        "  Scenario: S",
        "    Given I have a thing",
        "    And I have a thing",
      ].join("\n")
    );
    const featureWatcher = watchers.find((w) => w.pattern.endsWith(".feature"));
    expect(featureWatcher).toBeDefined();
    featureWatcher!.triggerChange(vscode.Uri.file("/ws/a.feature"));
    await new Promise((r) => setTimeout(r, 0));

    expect(await idx.countUsagesForDef(def)).toBe(3);
    idx.dispose();
  });

  it("onDidDelete removes that feature file's usages", async () => {
    const def = defOf("I have a thing", "/ws/steps/a.ts", 0);
    featureContents.set(
      "/ws/a.feature",
      ["Feature: A", "  Scenario: S", "    Given I have a thing"].join("\n")
    );
    featureContents.set(
      "/ws/b.feature",
      ["Feature: B", "  Scenario: T", "    Given I have a thing"].join("\n")
    );
    const resolver = makeResolverWithDefs([def]);
    const idx = new StepUsageIndex(makeConfig({}), resolver, stubLogger);

    expect(await idx.countUsagesForDef(def)).toBe(2);

    const featureWatcher = watchers.find((w) => w.pattern.endsWith(".feature"));
    featureWatcher!.triggerDelete(vscode.Uri.file("/ws/a.feature"));

    expect(await idx.countUsagesForDef(def)).toBe(1);
    idx.dispose();
  });

  it("step-def watcher invalidates the whole index on change", async () => {
    let defs = [defOf("I have a thing", "/ws/steps/a.ts", 0)];
    featureContents.set(
      "/ws/a.feature",
      ["Feature: A", "  Scenario: S", "    Given I have a thing"].join("\n")
    );
    const resolver = new StepResolver();
    resolver.loadAllStepDefs = async (): Promise<ParsedStepDefWithFile[]> => defs;

    const idx = new StepUsageIndex(
      makeConfig({ stepPaths: ["features/steps/**/*.ts"] }),
      resolver,
      stubLogger
    );

    expect(await idx.countUsagesForDef(defs[0]!)).toBe(1);
    const readsBefore = readFileMock.mock.calls.length;

    const newDef = defOf("I have a thing", "/ws/steps/b.ts", 0);
    defs = [newDef];
    const stepDefWatcher = watchers.find((w) => !w.pattern.endsWith(".feature"));
    expect(stepDefWatcher).toBeDefined();
    stepDefWatcher!.triggerChange(vscode.Uri.file("/ws/steps/b.ts"));

    expect(await idx.countUsagesForDef(newDef)).toBe(1);
    expect(readFileMock.mock.calls.length).toBeGreaterThan(readsBefore);
    idx.dispose();
  });

  it("invalidation disposes old watchers and the rescan does not stack a second set", async () => {
    const def = defOf("I have a thing", "/ws/steps/a.ts", 0);
    featureContents.set(
      "/ws/a.feature",
      ["Feature: A", "  Scenario: S", "    Given I have a thing"].join("\n")
    );
    const resolver = makeResolverWithDefs([def]);
    const idx = new StepUsageIndex(
      makeConfig({ stepPaths: ["features/steps/**/*.ts"] }),
      resolver,
      stubLogger
    );

    await idx.countUsagesForDef(def);
    const firstBatch = [...watchers];
    expect(firstBatch.length).toBeGreaterThanOrEqual(2);

    const stepDefWatcher = watchers.find((w) => !w.pattern.endsWith(".feature"));
    stepDefWatcher!.triggerChange(vscode.Uri.file("/ws/steps/a.ts"));
    for (const w of firstBatch) {
      expect(w.disposed).toBe(true);
    }

    await idx.countUsagesForDef(def);
    const live = watchers.filter((w) => !w.disposed);
    expect(live.length).toBe(firstBatch.length);
    idx.dispose();
  });

  it("rescan() drops cached defs so the next query reflects new globs", async () => {
    let defs = [defOf("I have a thing", "/ws/steps/a.ts", 0)];
    featureContents.set(
      "/ws/a.feature",
      ["Feature: A", "  Scenario: S", "    Given I have a thing"].join("\n")
    );
    const resolver = new StepResolver();
    resolver.loadAllStepDefs = async (): Promise<ParsedStepDefWithFile[]> => defs;
    const idx = new StepUsageIndex(makeConfig({}), resolver, stubLogger);

    expect(await idx.countUsagesForDef(defs[0]!)).toBe(1);

    const newDef = defOf("I have a thing", "/ws/steps/b.ts", 0);
    defs = [newDef];
    idx.rescan();

    expect(await idx.countUsagesForDef(newDef)).toBe(1);
    idx.dispose();
  });

  it("dispose() disposes all watchers and clears state", async () => {
    const def = defOf("I have a thing", "/ws/steps/a.ts", 0);
    featureContents.set(
      "/ws/a.feature",
      ["Feature: A", "  Scenario: S", "    Given I have a thing"].join("\n")
    );
    const resolver = makeResolverWithDefs([def]);
    const idx = new StepUsageIndex(
      makeConfig({ stepPaths: ["features/steps/**/*.ts"] }),
      resolver,
      stubLogger
    );

    await idx.getUsagesForDef(def);
    expect(watchers.length).toBeGreaterThanOrEqual(2);

    idx.dispose();
    for (const w of watchers) {
      expect(w.disposed).toBe(true);
    }
    const internal = idx as unknown as {
      usagesByFeature: Map<string, unknown[]>;
    };
    expect(internal.usagesByFeature.size).toBe(0);
  });

  it("ignores readFile resolution after dispose()", async () => {
    const def = defOf("I have a thing", "/ws/steps/a.ts", 0);
    featureContents.set(
      "/ws/a.feature",
      ["Feature: A", "  Scenario: S", "    Given I have a thing"].join("\n")
    );
    let releaseRead: (() => void) | undefined;
    readFileMock.mockImplementation(async () => {
      await new Promise<void>((resolve) => { releaseRead = resolve; });
      return encode(featureContents.get("/ws/a.feature") ?? "");
    });

    const resolver = makeResolverWithDefs([def]);
    const idx = new StepUsageIndex(makeConfig({}), resolver, stubLogger);
    const pending = idx.getUsagesForDef(def);
    await new Promise((r) => setTimeout(r, 0));

    idx.dispose();
    releaseRead?.();
    const usages = await pending;

    expect(usages).toEqual([]);
    const internal = idx as unknown as {
      usagesByFeature: Map<string, unknown[]>;
    };
    expect(internal.usagesByFeature.size).toBe(0);
  });

  it("fires onDidChangeUsages on step-def watcher invalidations", async () => {
    const def = defOf("I have a thing", "/ws/steps/a.ts", 0);
    featureContents.set(
      "/ws/a.feature",
      ["Feature: A", "  Scenario: S", "    Given I have a thing"].join("\n")
    );
    const resolver = makeResolverWithDefs([def]);
    const idx = new StepUsageIndex(
      makeConfig({ stepPaths: ["features/steps/**/*.ts"] }),
      resolver,
      stubLogger
    );

    await idx.getUsagesForDef(def);

    let fireCount = 0;
    idx.onDidChangeUsages(() => { fireCount += 1; });

    const stepDefWatcher = watchers.find((w) => !w.pattern.endsWith(".feature"));
    expect(stepDefWatcher).toBeDefined();
    stepDefWatcher!.triggerChange(vscode.Uri.file("/ws/steps/a.ts"));

    expect(fireCount).toBe(1);
    idx.dispose();
  });

  it("fires onDidChangeUsages on per-feature watcher invalidations", async () => {
    const def = defOf("I have a thing", "/ws/steps/a.ts", 0);
    featureContents.set(
      "/ws/a.feature",
      ["Feature: A", "  Scenario: S", "    Given I have a thing"].join("\n")
    );
    const resolver = makeResolverWithDefs([def]);
    const idx = new StepUsageIndex(makeConfig({}), resolver, stubLogger);

    await idx.getUsagesForDef(def);

    let fireCount = 0;
    idx.onDidChangeUsages(() => { fireCount += 1; });

    const featureWatcher = watchers.find((w) => w.pattern.endsWith(".feature"));
    expect(featureWatcher).toBeDefined();
    featureWatcher!.triggerChange(vscode.Uri.file("/ws/a.feature"));
    await new Promise((r) => setTimeout(r, 0));

    expect(fireCount).toBeGreaterThanOrEqual(1);

    featureWatcher!.triggerDelete(vscode.Uri.file("/ws/a.feature"));
    expect(fireCount).toBeGreaterThanOrEqual(2);
    idx.dispose();
  });

  it("skips doc-string lines so steps inside them are not counted as usages", async () => {
    const def = defOf("I have a thing", "/ws/steps/a.ts", 0);
    featureContents.set(
      "/ws/a.feature",
      [
        "Feature: A",
        "  Scenario: S",
        "    Given some setup",
        `    """`,
        "    Given I have a thing",
        `    """`,
        "    Given I have a thing",
      ].join("\n")
    );
    const resolver = makeResolverWithDefs([def]);
    const idx = new StepUsageIndex(makeConfig({}), resolver, stubLogger);

    expect(await idx.countUsagesForDef(def)).toBe(1);
    idx.dispose();
  });
});
