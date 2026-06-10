import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
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
    const globsKey = [...globs].sort().join("\0");
    if (this.fileListCache?.globsKey === globsKey) {
      return this.fileListCache.files;
    }

    let uriArrays: vscode.Uri[][];
    try {
      uriArrays = await Promise.all(
        globs.map((glob) => vscode.workspace.findFiles(glob, "**/node_modules/**"))
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
    this.installFileListWatchers(globs);
    return files;
  }

  private installFileListWatchers(globs: string[]): void {
    this.disposeWatchers();
    const nodeModulesFragment = `${path.sep}node_modules${path.sep}`;
    const onAny = (uri: vscode.Uri): void => {
      if (uri.fsPath.includes(nodeModulesFragment)) {return;}
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
