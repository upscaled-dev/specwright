import * as vscode from "vscode";
import * as path from "node:path";
import { ExtensionConfig } from "../core/extension-config";
import { Logger } from "../utils/logger";
import { TAG_TOKEN_PATTERN } from "../parsers/tag-regex";

const DEFAULT_FEATURE_PATTERN = "**/*.feature";

export class TagIndex implements vscode.Disposable {
  private readonly logger: Logger;
  private readonly config: ExtensionConfig;
  private readonly tagsByFile = new Map<string, Set<string>>();
  private flattenedMemo: string[] | undefined;
  private scanPromise: Promise<void> | undefined;
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private disposed = false;

  constructor(logger: Logger, config: ExtensionConfig) {
    this.logger = logger;
    this.config = config;
  }

  public async getAllTags(): Promise<string[]> {
    this.scanPromise ??= this.scanWorkspace();
    await this.scanPromise;
    if (this.disposed) {return [];}
    if (this.flattenedMemo) {return this.flattenedMemo;}
    const union = new Set<string>();
    for (const set of this.tagsByFile.values()) {
      for (const tag of set) {union.add(tag);}
    }
    const sorted = Array.from(union).sort((a, b) => a.localeCompare(b));
    this.flattenedMemo = sorted;
    return sorted;
  }

  public dispose(): void {
    this.disposed = true;
    for (const w of this.watchers) {
      try { w.dispose(); } catch { /* ignore */ }
    }
    this.watchers.length = 0;
    this.tagsByFile.clear();
    this.flattenedMemo = undefined;
  }

  private async scanWorkspace(): Promise<void> {
    const pattern = this.resolveFeaturePattern();
    this.installWatcher(pattern);
    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles(pattern, "**/node_modules/**");
    } catch (error) {
      this.logger.warn("TagIndex: findFiles failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      uris = [];
    }
    if (this.disposed) {return;}
    await Promise.all(uris.map((uri) => this.indexFile(uri)));
  }

  private installWatcher(pattern: string): void {
    if (this.disposed) {return;}
    const nodeModulesFragment = `${path.sep}node_modules${path.sep}`;
    const isIgnored = (uri: vscode.Uri): boolean =>
      uri.fsPath.includes(nodeModulesFragment);
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const refresh = (uri: vscode.Uri): void => {
      if (isIgnored(uri)) {return;}
      this.indexFile(uri).catch(() => { /* logged inside */ });
    };
    watcher.onDidChange(refresh);
    watcher.onDidCreate(refresh);
    watcher.onDidDelete((uri) => {
      if (isIgnored(uri)) {return;}
      if (this.tagsByFile.delete(uri.fsPath)) {
        this.flattenedMemo = undefined;
      }
    });
    this.watchers.push(watcher);
  }

  private async indexFile(uri: vscode.Uri): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (error) {
      this.logger.warn(`TagIndex: could not read ${uri.fsPath}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (this.disposed) {return;}
    const content = Buffer.from(bytes).toString("utf-8");
    const tags = extractTagsFromContent(content);
    this.tagsByFile.set(uri.fsPath, tags);
    this.flattenedMemo = undefined;
  }

  private resolveFeaturePattern(): string {
    const raw = this.config.testFilePattern;
    return raw && raw.trim() !== "" ? raw : DEFAULT_FEATURE_PATTERN;
  }
}

function extractTagsFromContent(content: string): Set<string> {
  const tags = new Set<string>();
  const lines = content.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("@")) {continue;}
    for (const m of trimmed.matchAll(new RegExp(TAG_TOKEN_PATTERN, "g"))) {
      tags.add(m[0]);
    }
  }
  return tags;
}
