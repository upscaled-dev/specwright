import * as vscode from "vscode";
import { ExtensionConfig } from "../core/extension-config";
import { Logger } from "../utils/logger";
import { ParsedStepDefWithFile, StepResolver } from "./step-resolver";
import { computeSkipRanges } from "./feature-skip-ranges";
import {
  isUnderExcludedDir,
  workspaceExcludeFragments,
  workspaceExcludeGlob,
} from "../utils/discovery-excludes";

const DEFAULT_FEATURE_PATTERN = "**/*.feature";

export interface StepUsage {
  featurePath: string;
  line: number;
  stepText: string;
  keyword: "Given" | "When" | "Then";
}

interface FeatureUsageEntry extends StepUsage {
  defKey: string;
}

function defKeyOf(def: ParsedStepDefWithFile): string {
  return `${def.filePath}:${def.line}`;
}

export class StepUsageIndex implements vscode.Disposable {
  private readonly usagesByFeature = new Map<string, FeatureUsageEntry[]>();
  private defsByKey = new Map<string, ParsedStepDefWithFile>();
  private scanPromise: Promise<void> | undefined;
  private readonly watchers: vscode.FileSystemWatcher[] = [];
  private disposed = false;
  private readonly _onDidChangeUsages = new vscode.EventEmitter<void>();
  public readonly onDidChangeUsages = this._onDidChangeUsages.event;

  constructor(
    private readonly config: ExtensionConfig,
    private readonly stepResolver: StepResolver,
    private readonly logger: Logger,
  ) {}

  public async getUsagesForDef(def: ParsedStepDefWithFile): Promise<StepUsage[]> {
    await this.ensureScanned();
    if (this.disposed) {return [];}
    const key = defKeyOf(def);
    const out: StepUsage[] = [];
    for (const entries of this.usagesByFeature.values()) {
      for (const entry of entries) {
        if (entry.defKey === key) {
          out.push({
            featurePath: entry.featurePath,
            line: entry.line,
            stepText: entry.stepText,
            keyword: entry.keyword,
          });
        }
      }
    }
    return out;
  }

  public async getAllUsages(): Promise<Map<ParsedStepDefWithFile, StepUsage[]>> {
    await this.ensureScanned();
    const result = new Map<ParsedStepDefWithFile, StepUsage[]>();
    if (this.disposed) {return result;}
    for (const def of this.defsByKey.values()) {
      result.set(def, []);
    }
    for (const entries of this.usagesByFeature.values()) {
      for (const entry of entries) {
        const def = this.defsByKey.get(entry.defKey);
        if (!def) {continue;}
        const arr = result.get(def);
        if (arr) {
          arr.push({
            featurePath: entry.featurePath,
            line: entry.line,
            stepText: entry.stepText,
            keyword: entry.keyword,
          });
        }
      }
    }
    return result;
  }

  public async countUsagesForDef(def: ParsedStepDefWithFile): Promise<number> {
    await this.ensureScanned();
    if (this.disposed) {return 0;}
    const key = defKeyOf(def);
    let count = 0;
    for (const entries of this.usagesByFeature.values()) {
      for (const entry of entries) {
        if (entry.defKey === key) {count += 1;}
      }
    }
    return count;
  }

  public dispose(): void {
    this.disposed = true;
    this.disposeWatchers();
    this.usagesByFeature.clear();
    this.defsByKey.clear();
    this._onDidChangeUsages.dispose();
  }

  /** Drop all cached state and watchers; the next query re-scans with current config. */
  public rescan(): void {
    this.invalidateAll();
  }

  private disposeWatchers(): void {
    for (const w of this.watchers) {
      try { w.dispose(); } catch { /* ignore */ }
    }
    this.watchers.length = 0;
  }

  private async ensureScanned(): Promise<void> {
    this.scanPromise ??= this.scanWorkspace();
    await this.scanPromise;
  }

  private async scanWorkspace(): Promise<void> {
    const featurePattern = this.resolveFeaturePattern();
    this.installFeatureWatcher(featurePattern);
    this.installStepDefWatchers(this.config.stepDefinitionPaths);

    await this.loadDefs();
    if (this.disposed) {return;}

    let uris: vscode.Uri[];
    try {
      uris = await vscode.workspace.findFiles(featurePattern, workspaceExcludeGlob());
    } catch (error) {
      this.logger.warn("StepUsageIndex: findFiles failed", {
        error: error instanceof Error ? error.message : String(error),
      });
      uris = [];
    }
    if (this.disposed) {return;}
    await Promise.all(uris.map((uri) => this.indexFeatureFile(uri)));
  }

  private async loadDefs(): Promise<void> {
    let defs: ParsedStepDefWithFile[];
    try {
      defs = await this.stepResolver.loadAllStepDefs(this.config.stepDefinitionPaths);
    } catch (error) {
      this.logger.warn("StepUsageIndex: failed to load step defs", {
        error: error instanceof Error ? error.message : String(error),
      });
      defs = [];
    }
    if (this.disposed) {return;}
    const next = new Map<string, ParsedStepDefWithFile>();
    for (const def of defs) {
      next.set(defKeyOf(def), def);
    }
    this.defsByKey = next;
  }

  private async indexFeatureFile(uri: vscode.Uri): Promise<void> {
    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (error) {
      this.logger.warn(`StepUsageIndex: could not read ${uri.fsPath}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return;
    }
    if (this.disposed) {return;}
    const content = Buffer.from(bytes).toString("utf-8");
    const entries = this.computeUsagesForFeature(uri.fsPath, content);
    this.usagesByFeature.set(uri.fsPath, entries);
    this._onDidChangeUsages.fire();
  }

  private computeUsagesForFeature(featurePath: string, content: string): FeatureUsageEntry[] {
    const skipRanges = computeSkipRanges(content);
    const steps = this.stepResolver.parseFeatureSteps(content);
    const defs = Array.from(this.defsByKey.values());
    const entries: FeatureUsageEntry[] = [];
    for (const step of steps) {
      if (skipRanges.has(step.line)) {continue;}
      const matches = this.stepResolver.findStepMatches(step.text, defs);
      for (const match of matches) {
        entries.push({
          defKey: defKeyOf(match),
          featurePath,
          line: step.line,
          stepText: step.text,
          keyword: step.effectiveKeyword,
        });
      }
    }
    return entries;
  }

  private installFeatureWatcher(pattern: string): void {
    if (this.disposed) {return;}
    const excluded = workspaceExcludeFragments();
    const isIgnored = (uri: vscode.Uri): boolean =>
      isUnderExcludedDir(uri.fsPath, excluded);
    const watcher = vscode.workspace.createFileSystemWatcher(pattern);
    const refresh = (uri: vscode.Uri): void => {
      if (isIgnored(uri)) {return;}
      this.indexFeatureFile(uri).catch(() => { /* logged inside */ });
    };
    watcher.onDidChange(refresh);
    watcher.onDidCreate(refresh);
    watcher.onDidDelete((uri) => {
      if (isIgnored(uri)) {return;}
      this.usagesByFeature.delete(uri.fsPath);
      this._onDidChangeUsages.fire();
    });
    this.watchers.push(watcher);
  }

  private installStepDefWatchers(globs: readonly string[]): void {
    if (this.disposed) {return;}
    if (globs.length === 0) {return;}
    const excluded = workspaceExcludeFragments();
    const onAny = (uri: vscode.Uri): void => {
      if (isUnderExcludedDir(uri.fsPath, excluded)) {return;}
      this.invalidateAll();
    };
    for (const glob of globs) {
      const watcher = vscode.workspace.createFileSystemWatcher(glob);
      watcher.onDidChange(onAny);
      watcher.onDidCreate(onAny);
      watcher.onDidDelete(onAny);
      this.watchers.push(watcher);
    }
  }

  private invalidateAll(): void {
    if (this.disposed) {return;}
    // The next scan reinstalls watchers; without disposing first every
    // invalidation would stack another set and multiply refresh events.
    this.disposeWatchers();
    this.usagesByFeature.clear();
    this.defsByKey.clear();
    this.scanPromise = undefined;
    this._onDidChangeUsages.fire();
  }

  private resolveFeaturePattern(): string {
    const raw = this.config.testFilePattern;
    return raw && raw.trim() !== "" ? raw : DEFAULT_FEATURE_PATTERN;
  }
}
