import * as vscode from "vscode";

const CONFIG_NAMESPACE = "playwrightBddRunner";
const FEATURES_GEN_KEY = "featuresGenDir";
const DEFAULT_FEATURES_GEN_DIR = ".features-gen";

/**
 * Output directories whose files must never be scanned — for step definitions,
 * feature files, usages, or tags. bddgen's generated specs and the Playwright
 * report/results contain step invocations and copies of executed feature content
 * that mirror the real sources, so scanning them produces phantom step
 * definitions, inflated usage counts, duplicate tests, and stray tags.
 */
export const ALWAYS_EXCLUDED_DIRS = ["node_modules", "playwright-report", "test-results"];

export function normalizeDirFragment(dir: string): string {
  return dir.replaceAll("\\", "/").replace(/^\.?\//, "").replace(/\/+$/, "");
}

export function readFeaturesGenDir(resource: vscode.Uri | undefined): string {
  const value = vscode.workspace
    .getConfiguration(CONFIG_NAMESPACE, resource)
    .get<string>(FEATURES_GEN_KEY, DEFAULT_FEATURES_GEN_DIR);
  return value.trim() === "" ? DEFAULT_FEATURES_GEN_DIR : value;
}

/** Built-in excluded directory names for one config scope (folder or global). */
export function excludedDirFragments(resource: vscode.Uri | undefined): string[] {
  const gen = normalizeDirFragment(readFeaturesGenDir(resource));
  const dirs = [...ALWAYS_EXCLUDED_DIRS];
  if (gen && !dirs.includes(gen)) {dirs.push(gen);}
  return dirs;
}

/**
 * Built-in excluded directory names across every workspace folder — for
 * workspace-wide findFiles calls and watcher event filters, where per-folder
 * resolution isn't possible. Folder-scoped `featuresGenDir` overrides are unioned.
 */
export function workspaceExcludeFragments(): string[] {
  const set = new Set<string>(excludedDirFragments(undefined));
  for (const folder of vscode.workspace.workspaceFolders ?? []) {
    for (const dir of excludedDirFragments(folder.uri)) {set.add(dir);}
  }
  return Array.from(set);
}

// Brace-glob for findFiles' exclude parameter (one "**/<dir>/**" entry per fragment).
export function buildExcludeGlob(fragments: string[], extraGlobs: string[] = []): string {
  const patterns = [...fragments.map((d) => `**/${d}/**`), ...extraGlobs];
  return `{${patterns.join(",")}}`;
}

/** Workspace-wide built-in exclude glob for findFiles. */
export function workspaceExcludeGlob(): string {
  return buildExcludeGlob(workspaceExcludeFragments());
}

/** True when a path sits under one of the excluded directories (slash-agnostic). */
export function isUnderExcludedDir(fsPath: string, fragments: string[]): boolean {
  const normalized = fsPath.replaceAll("\\", "/");
  return fragments.some((frag) => normalized.includes(`/${frag}/`));
}
