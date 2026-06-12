import * as vscode from "vscode";
import * as fs from "node:fs";
import { Logger } from "../utils/logger";
import {
  extractStepDefsFromSource,
  extractStepText,
  ParsedStepDef,
} from "./step-definition-provider";
import { STEP_KEYWORDS } from "./step-keywords";
import { SCENARIO_BOUNDARY_RE } from "./scenario-boundary";
import { computeSkipRanges } from "./feature-skip-ranges";

export interface UnmatchedStep {
  line: number;
  keyword: string;
  effectiveKeyword: "Given" | "When" | "Then";
  text: string;
}

export interface ParsedFeatureStep {
  line: number;
  keyword: string;
  effectiveKeyword: "Given" | "When" | "Then";
  text: string;
}

export interface ParsedStepDefWithFile extends ParsedStepDef {
  filePath: string;
}

const STEP_LINE_WITH_KEYWORD_RE = new RegExp(`^\\s*(${STEP_KEYWORDS})\\s+(.+?)\\s*$`);

const CONFIG_NAMESPACE = "playwrightBddRunner";
const STEP_PATHS_KEY = "stepDefinitionPaths";
const STEP_EXCLUDE_PATHS_KEY = "stepDefinitionExcludePaths";
const FEATURES_GEN_KEY = "featuresGenDir";
const DEFAULT_FEATURES_GEN_DIR = ".features-gen";

// Output directories whose files must never be scanned for step definitions.
// bddgen's generated specs and the Playwright report/results contain Given/When/Then
// *invocations* that are syntactically identical to step *definitions*, so scanning
// them produces phantom duplicate defs and false "matches multiple definitions" noise.
const ALWAYS_EXCLUDED_DIRS = ["node_modules", "playwright-report", "test-results"];

interface DiscoveryTarget {
  folder: vscode.WorkspaceFolder | undefined;
  globs: string[];
  // Brace-glob of directories excluded from findFiles (node_modules, generated/output dirs).
  exclude: string;
  // Directory names (slash-normalized) used to filter watcher events.
  excludeFragments: string[];
}

function normalizeDirFragment(dir: string): string {
  return dir.replaceAll("\\", "/").replace(/^\.?\//, "").replace(/\/+$/, "");
}

function readFeaturesGenDir(resource: vscode.Uri | undefined): string {
  const value = vscode.workspace
    .getConfiguration(CONFIG_NAMESPACE, resource)
    .get<string>(FEATURES_GEN_KEY, DEFAULT_FEATURES_GEN_DIR);
  return value.trim() === "" ? DEFAULT_FEATURES_GEN_DIR : value;
}

function excludedDirFragments(featuresGenDir: string): string[] {
  const gen = normalizeDirFragment(featuresGenDir);
  const dirs = [...ALWAYS_EXCLUDED_DIRS];
  if (gen && !dirs.includes(gen)) {dirs.push(gen);}
  return dirs;
}

function readExcludePaths(resource: vscode.Uri | undefined): string[] {
  return vscode.workspace
    .getConfiguration(CONFIG_NAMESPACE, resource)
    .get<string[]>(STEP_EXCLUDE_PATHS_KEY, [])
    .map((g) => g.trim())
    .filter((g) => g.length > 0);
}

function buildExcludeGlob(fragments: string[], extraGlobs: string[]): string {
  const patterns = [...fragments.map((d) => `**/${d}/**`), ...extraGlobs];
  return `{${patterns.join(",")}}`;
}

/**
 * Resolve where to scan for step definitions, scoped per workspace folder.
 * `stepDefinitionPaths` is a `resource`-scoped setting, so in a multi-root / monorepo
 * workspace each folder can declare its own step directories. We read the folder-scoped
 * value and bind discovery to that folder via RelativePattern, so a folder's globs only
 * ever match inside that folder — discovery never reaches outside the directories a
 * folder declares. Each folder's generated `featuresGenDir` (plus the Playwright
 * report/results dirs) is excluded, so even a broad glob can't mistake generated
 * Given/When/Then invocations for definitions; users can exclude additional
 * directories via `stepDefinitionExcludePaths`. Falls back to the caller-supplied
 * globs when there are no workspace folders (unit tests, loose-file windows).
 */
function resolveDiscoveryTargets(fallbackGlobs: string[]): DiscoveryTarget[] {
  const folders = vscode.workspace.workspaceFolders;
  if (!folders || folders.length === 0) {
    const fragments = excludedDirFragments(readFeaturesGenDir(undefined));
    return [
      {
        folder: undefined,
        globs: fallbackGlobs,
        exclude: buildExcludeGlob(fragments, readExcludePaths(undefined)),
        excludeFragments: fragments,
      },
    ];
  }
  return folders.map((folder) => {
    const fragments = excludedDirFragments(readFeaturesGenDir(folder.uri));
    return {
      folder,
      globs: vscode.workspace
        .getConfiguration(CONFIG_NAMESPACE, folder.uri)
        .get<string[]>(STEP_PATHS_KEY, fallbackGlobs),
      exclude: buildExcludeGlob(fragments, readExcludePaths(folder.uri)),
      excludeFragments: fragments,
    };
  });
}

export class StepResolver implements vscode.Disposable {
  private readonly logger: Logger;
  private readonly cache = new Map<string, { mtimeMs: number; defs: ParsedStepDef[] }>();
  private fileListCache: { globsKey: string; files: string[] } | undefined;
  private fsWatchers: vscode.FileSystemWatcher[] = [];

  constructor(logger?: Logger) {
    this.logger = logger ?? Logger.create();
  }

  public async loadAllStepDefs(globs: string[]): Promise<ParsedStepDefWithFile[]> {
    const files = await this.findStepFiles(globs);
    const all: ParsedStepDefWithFile[] = [];
    for (const file of files) {
      const defs = this.parseStepFile(file);
      for (const def of defs) {
        all.push({ ...def, filePath: file });
      }
    }
    return all;
  }

  public parseStepFile(filePath: string): ParsedStepDef[] {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(filePath);
    } catch {
      return [];
    }
    const cached = this.cache.get(filePath);
    if (cached?.mtimeMs === stat.mtimeMs) {return cached.defs;}

    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (error) {
      this.logger.warn(`Could not read step file: ${filePath}`, {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }

    const defs = extractStepDefsFromSource(content);
    this.cache.set(filePath, { mtimeMs: stat.mtimeMs, defs });
    return defs;
  }

  public async findStepFiles(globs: string[]): Promise<string[]> {
    const targets = resolveDiscoveryTargets(globs);
    const globsKey = targets
      .map((t) => `${t.folder?.uri.toString() ?? ""}${[...t.globs].sort().join("\0")}|${t.exclude}`)
      .sort()
      .join("");
    if (this.fileListCache?.globsKey === globsKey) {
      return this.fileListCache.files;
    }

    let uriArrays: vscode.Uri[][];
    try {
      uriArrays = await Promise.all(
        targets.flatMap((t) =>
          t.globs.map((glob) =>
            vscode.workspace.findFiles(
              t.folder ? new vscode.RelativePattern(t.folder, glob) : glob,
              t.exclude
            )
          )
        )
      );
    } catch (error) {
      this.logger.warn("Failed to find step files", {
        error: error instanceof Error ? error.message : String(error),
      });
      return [];
    }
    const seen = new Set<string>();
    for (const uris of uriArrays) {
      for (const uri of uris) {seen.add(uri.fsPath);}
    }
    const files = Array.from(seen);
    this.fileListCache = { globsKey, files };
    const watchGlobs = Array.from(new Set(targets.flatMap((t) => t.globs)));
    const excludeFragments = Array.from(new Set(targets.flatMap((t) => t.excludeFragments)));
    this.installFileListWatchers(watchGlobs, excludeFragments);
    return files;
  }

  private installFileListWatchers(globs: string[], excludeFragments: string[]): void {
    this.disposeWatchers();
    const onAny = (uri: vscode.Uri): void => {
      const normalized = uri.fsPath.replaceAll("\\", "/");
      if (excludeFragments.some((frag) => normalized.includes(`/${frag}/`))) {return;}
      this.fileListCache = undefined;
    };
    for (const glob of globs) {
      const watcher = vscode.workspace.createFileSystemWatcher(glob);
      watcher.onDidCreate(onAny);
      watcher.onDidDelete(onAny);
      this.fsWatchers.push(watcher);
    }
  }

  public disposeWatchers(): void {
    for (const w of this.fsWatchers) {
      try { w.dispose(); } catch { /* ignore */ }
    }
    this.fsWatchers.length = 0;
  }

  public dispose(): void {
    this.disposeWatchers();
    this.fileListCache = undefined;
    this.cache.clear();
  }

  public parseFeatureSteps(text: string): ParsedFeatureStep[] {
    const lines = text.split("\n");
    const steps: ParsedFeatureStep[] = [];
    let lastConcreteKeyword: "Given" | "When" | "Then" | undefined;

    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i] ?? "";
      if (SCENARIO_BOUNDARY_RE.test(raw)) {
        lastConcreteKeyword = undefined;
        continue;
      }
      const m = STEP_LINE_WITH_KEYWORD_RE.exec(raw);
      if (!m) {continue;}
      const keyword = m[1] as "Given" | "When" | "Then" | "And" | "But" | "*";
      const text = m[2] ?? "";

      let effective: "Given" | "When" | "Then";
      if (keyword === "And" || keyword === "But" || keyword === "*") {
        if (!lastConcreteKeyword) {continue;}
        effective = lastConcreteKeyword;
      } else {
        effective = keyword;
        lastConcreteKeyword = keyword;
      }

      steps.push({ line: i, keyword, effectiveKeyword: effective, text });
    }

    return steps;
  }

  public findUnmatchedSteps(featureText: string, defs: ParsedStepDef[]): UnmatchedStep[] {
    const skipRanges = computeSkipRanges(featureText);
    const unmatched: UnmatchedStep[] = [];
    for (const step of this.parseFeatureSteps(featureText)) {
      if (skipRanges.has(step.line)) {continue;}
      if (this.isStepMatched(step.text, defs)) {continue;}
      unmatched.push({
        line: step.line,
        keyword: step.keyword,
        effectiveKeyword: step.effectiveKeyword,
        text: step.text,
      });
    }
    return unmatched;
  }

  public findStepMatches<T extends ParsedStepDef>(stepText: string, defs: T[]): T[] {
    const matches: T[] = [];
    for (const def of defs) {
      if (def.regex.test(stepText)) {matches.push(def);}
    }
    return matches;
  }

  public isStepMatched(stepText: string, defs: ParsedStepDef[]): boolean {
    for (const def of defs) {
      if (def.regex.test(stepText)) {return true;}
    }
    return false;
  }

  public invalidate(filePath: string): void {
    this.cache.delete(filePath);
  }
}

export { extractStepText };
