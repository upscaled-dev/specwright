import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as vscode from "vscode";
import { TagIndex } from "../../providers/tag-index";
import type { ExtensionConfig } from "../../core/extension-config";
import type { Logger } from "../../utils/logger";

const stubLogger = {
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
  debug: (): void => {},
} as unknown as Logger;

function makeConfig(pattern: string = "**/*.feature"): ExtensionConfig {
  return { testFilePattern: pattern } as unknown as ExtensionConfig;
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
}

function makeFakeWatcher(): FakeWatcher {
  const changeHandlers: Array<(uri: vscode.Uri) => void> = [];
  const createHandlers: Array<(uri: vscode.Uri) => void> = [];
  const deleteHandlers: Array<(uri: vscode.Uri) => void> = [];
  const watcher: FakeWatcher = {
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

describe("TagIndex", () => {
  const originalFindFiles = vscode.workspace.findFiles;
  const originalCreateWatcher = vscode.workspace.createFileSystemWatcher;
  const originalReadFile = vscode.workspace.fs.readFile;
  let findFilesMock: ReturnType<typeof vi.fn>;
  let readFileMock: ReturnType<typeof vi.fn>;
  let watchers: FakeWatcher[];
  let fileContents: Map<string, string>;

  beforeEach(() => {
    fileContents = new Map();
    findFilesMock = vi.fn(async () => Array.from(fileContents.keys()).map((p) => vscode.Uri.file(p)));
    readFileMock = vi.fn(async (uri: { fsPath: string }) => {
      const content = fileContents.get(uri.fsPath);
      if (content === undefined) {throw new Error(`no content for ${uri.fsPath}`);}
      return encode(content);
    });
    watchers = [];
    (vscode.workspace as { findFiles: unknown }).findFiles = findFilesMock;
    (vscode.workspace.fs as { readFile: unknown }).readFile = readFileMock;
    (vscode.workspace as { createFileSystemWatcher: unknown }).createFileSystemWatcher = (): FakeWatcher => {
      const w = makeFakeWatcher();
      watchers.push(w);
      return w;
    };
  });

  afterEach(() => {
    (vscode.workspace as { findFiles: unknown }).findFiles = originalFindFiles;
    (vscode.workspace.fs as { readFile: unknown }).readFile = originalReadFile;
    (vscode.workspace as { createFileSystemWatcher: unknown }).createFileSystemWatcher = originalCreateWatcher;
  });

  it("is lazy: does not scan until first getAllTags()", () => {
    const idx = new TagIndex(stubLogger, makeConfig());
    expect(findFilesMock).toHaveBeenCalledTimes(0);
    idx.dispose();
  });

  it("returns the dedup'd, alphabetically sorted union of tags across files", async () => {
    fileContents.set("/ws/a.feature", "@beta @alpha\nFeature: A\n");
    fileContents.set("/ws/b.feature", "@alpha @gamma\nFeature: B\n");

    const idx = new TagIndex(stubLogger, makeConfig());
    const tags = await idx.getAllTags();
    expect(tags).toEqual(["@alpha", "@beta", "@gamma"]);
    idx.dispose();
  });

  it("memoizes the flattened list on a second call", async () => {
    fileContents.set("/ws/a.feature", "@alpha\nFeature: A\n");
    const idx = new TagIndex(stubLogger, makeConfig());

    const first = await idx.getAllTags();
    const second = await idx.getAllTags();
    expect(second).toBe(first);
    expect(findFilesMock).toHaveBeenCalledTimes(1);
    idx.dispose();
  });

  it("per-file invalidation via onDidChange updates only that file's tags", async () => {
    fileContents.set("/ws/a.feature", "@alpha\nFeature: A\n");
    fileContents.set("/ws/b.feature", "@beta\nFeature: B\n");

    const idx = new TagIndex(stubLogger, makeConfig());
    expect(await idx.getAllTags()).toEqual(["@alpha", "@beta"]);

    fileContents.set("/ws/a.feature", "@alpha @delta\nFeature: A\n");
    watchers[0]!.triggerChange(vscode.Uri.file("/ws/a.feature"));
    await new Promise((r) => setTimeout(r, 0));

    expect(await idx.getAllTags()).toEqual(["@alpha", "@beta", "@delta"]);
    idx.dispose();
  });

  it("onDidDelete removes that file's tags from the union", async () => {
    fileContents.set("/ws/a.feature", "@alpha @unique\nFeature: A\n");
    fileContents.set("/ws/b.feature", "@beta\nFeature: B\n");

    const idx = new TagIndex(stubLogger, makeConfig());
    expect(await idx.getAllTags()).toEqual(["@alpha", "@beta", "@unique"]);

    watchers[0]!.triggerDelete(vscode.Uri.file("/ws/a.feature"));
    expect(await idx.getAllTags()).toEqual(["@beta"]);
    idx.dispose();
  });

  it("dispose() disposes all watchers", async () => {
    fileContents.set("/ws/a.feature", "@alpha\nFeature: A\n");
    const idx = new TagIndex(stubLogger, makeConfig());
    await idx.getAllTags();
    expect(watchers).toHaveLength(1);

    idx.dispose();
    expect(watchers[0]!.disposed).toBe(true);
  });

  it("skips files that fail to read and continues with the rest", async () => {
    fileContents.set("/ws/good.feature", "@alpha\nFeature: A\n");
    fileContents.set("/ws/bad.feature", "ignored");
    readFileMock.mockImplementation(async (uri: { fsPath: string }) => {
      if (uri.fsPath === "/ws/bad.feature") {throw new Error("EACCES");}
      return encode(fileContents.get(uri.fsPath) ?? "");
    });

    const idx = new TagIndex(stubLogger, makeConfig());
    expect(await idx.getAllTags()).toEqual(["@alpha"]);
    idx.dispose();
  });

  it("ignores readFile resolution after dispose() is called", async () => {
    fileContents.set("/ws/a.feature", "@alpha\nFeature: A\n");
    let releaseRead: (() => void) | undefined;
    readFileMock.mockImplementation(async () => {
      await new Promise<void>((resolve) => { releaseRead = resolve; });
      return encode(fileContents.get("/ws/a.feature") ?? "");
    });

    const idx = new TagIndex(stubLogger, makeConfig());
    const pending = idx.getAllTags();
    await new Promise((r) => setTimeout(r, 0));

    idx.dispose();
    releaseRead?.();
    const tags = await pending;

    expect(tags).toEqual([]);
    const internalState = (idx as unknown as { tagsByFile: Map<string, Set<string>> }).tagsByFile;
    expect(internalState.size).toBe(0);
  });

  it("installs the watcher before completing the initial scan", async () => {
    fileContents.set("/ws/a.feature", "@alpha\nFeature: A\n");
    let releaseRead: (() => void) | undefined;
    readFileMock.mockImplementation(async () => {
      await new Promise<void>((resolve) => { releaseRead = resolve; });
      return encode(fileContents.get("/ws/a.feature") ?? "");
    });

    const idx = new TagIndex(stubLogger, makeConfig());
    const pending = idx.getAllTags();
    await new Promise((r) => setTimeout(r, 0));

    expect(watchers).toHaveLength(1);

    releaseRead?.();
    await pending;
    idx.dispose();
  });

  it("concurrent indexing of multiple files extracts tags correctly", async () => {
    fileContents.set("/ws/a.feature", "@alpha @shared\nFeature: A\n");
    fileContents.set("/ws/b.feature", "@beta @shared\nFeature: B\n");
    fileContents.set("/ws/c.feature", "@gamma\nFeature: C\n");

    const idx = new TagIndex(stubLogger, makeConfig());
    const tags = await idx.getAllTags();

    expect(tags).toEqual(["@alpha", "@beta", "@gamma", "@shared"]);
    idx.dispose();
  });
});
