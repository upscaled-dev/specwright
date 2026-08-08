import * as vscode from "vscode";
import type { RunIntent, RunTarget } from "../core/run-contracts";
import { batchSelectionFromScenarios } from "../traceability/batch-selection";
import {
  normalizePath,
  outlineRef,
  refIdentity,
  scenarioRefFromScenario,
  type ScenarioRef,
} from "../traceability/scenario-ref";
import type { Scenario } from "../types";
import {
  withExecutionClientContext,
  type ClientRunIntent,
} from "../ui/execution-client-context";
import { OUTLINE_ID_SEPARATOR } from "./constants";

function hasExcludedDescendant(
  item: vscode.TestItem,
  excluded: ReadonlySet<vscode.TestItem>
): boolean {
  let found = false;
  item.children.forEach((child) => {
    if (!found && (excluded.has(child) || hasExcludedDescendant(child, excluded))) {
      found = true;
    }
  });
  return found;
}

export function requestedTestItems(
  request: vscode.TestRunRequest,
  controller: vscode.TestController
): vscode.TestItem[] {
  const roots: vscode.TestItem[] = [];
  if (request.include) {roots.push(...request.include);}
  else {controller.items.forEach((item) => roots.push(item));}
  const excluded = new Set(request.exclude ?? []);
  if (excluded.size === 0) {return roots;}

  const expanded: vscode.TestItem[] = [];
  const visit = (item: vscode.TestItem): void => {
    if (excluded.has(item)) {return;}
    if (hasExcludedDescendant(item, excluded)) {item.children.forEach(visit);}
    else {expanded.push(item);}
  };
  roots.forEach(visit);
  return expanded;
}

export function describeTestSelection(
  roots: readonly vscode.TestItem[],
  scenarioFor: (id: string) => Scenario | undefined
) {
  return batchSelectionFromScenarios(scenarioRefsUnder(roots, scenarioFor));
}

// The outline node is backed by its first example row, so only the id shape says whether the user
// picked the whole outline or one row.
function itemRunRef(item: vscode.TestItem, scenario: Scenario): ScenarioRef {
  return item.id.includes(OUTLINE_ID_SEPARATOR) && scenario.isScenarioOutline
    ? outlineRef(scenario.filePath, scenario.outlineName)
    : scenarioRefFromScenario(scenario);
}

function outlineKey(ref: ScenarioRef): string {
  return `${normalizePath(ref.filePath)}\0${ref.outlineName ?? ref.name}`;
}

function scenarioRefsUnder(
  roots: readonly vscode.TestItem[],
  scenarioFor: (id: string) => Scenario | undefined
): ScenarioRef[] {
  const seen = new Set<string>();
  const refs: ScenarioRef[] = [];
  const visit = (item: vscode.TestItem): void => {
    const scenario = scenarioFor(item.id);
    if (scenario) {
      const ref = itemRunRef(item, scenario);
      const identity = refIdentity(ref);
      if (!seen.has(identity)) {
        seen.add(identity);
        refs.push(ref);
      }
    }
    item.children.forEach(visit);
  };
  roots.forEach(visit);
  // A selected outline already runs every row, so keeping its rows as well would run them twice.
  const wholeOutlines = new Set(
    refs.filter((ref) => ref.kind === "outline" && ref.line === 0).map(outlineKey)
  );
  return refs.filter(
    (ref) => ref.kind !== "outline" || ref.line === 0 || !wholeOutlines.has(outlineKey(ref))
  );
}

function targetKey(target: RunTarget): string {
  if (target.kind === "scenario") {
    return `scenario:${refIdentity(target.scenario)}:tags:${target.tagExpression ?? ""}`;
  }
  if (target.kind === "path") {
    return [
      "path",
      normalizePath(target.path),
      `tags:${target.tagExpression ?? ""}`,
      `titles:${(target.titles ?? []).join("\0")}`,
    ].join(":");
  }
  if (target.kind === "tag-expression") {return `tags:${target.expression}`;}
  if (target.kind === "scenarios") {
    return `scenarios:${target.scenarios.map(refIdentity).join("\0")}`;
  }
  return "suite";
}

interface RunPlanOptions {
  readonly request: vscode.TestRunRequest;
  readonly roots: readonly vscode.TestItem[];
  readonly mode: RunIntent["mode"];
  readonly scenarioFor: (id: string) => Scenario | undefined;
  // Retained as part of the planner port for callers that already provide discovery's file view.
  // Exact refs no longer need a title-based batching proof.
  readonly scenariosInFile: (filePath: string) => readonly Scenario[];
  readonly isFeatureFile: (id: string) => boolean;
  readonly maxWorkers?: number | undefined;
}

function selectionFor(options: RunPlanOptions, wholeSuite: boolean, only?: vscode.TestItem) {
  if (wholeSuite) {return { kind: "suite" as const };}
  if (only?.uri && options.isFeatureFile(only.id)) {
    return { kind: "feature" as const, filePath: only.uri.fsPath };
  }
  return describeTestSelection(options.roots, options.scenarioFor);
}

// One debug session covers the whole selection, so its scenarios travel as a single target.
function debugTargets(options: RunPlanOptions, only?: vscode.TestItem): RunTarget[] {
  if (only?.uri && options.isFeatureFile(only.id)) {
    return [{ kind: "path", path: only.uri.fsPath }];
  }
  const scenarios = scenarioRefsUnder(options.roots, options.scenarioFor);
  return scenarios.length === 0 ? [] : [{ kind: "scenarios", scenarios }];
}

// A file target already runs every scenario in it and a whole-outline ref already runs every row, so
// scenario roots go through the same containment reduction the selection uses and then drop whatever
// a file target covers. Running the same test twice is never the intent, and neither is running a
// test the user did not select: a group (a tag or organization node) expands to the scenarios under
// it, never to the whole file each of those scenarios happens to live in.
function runTargets(options: RunPlanOptions): RunTarget[] {
  const files = new Set<string>();
  const scenarioRoots: vscode.TestItem[] = [];
  for (const item of options.roots) {
    if (item.uri && options.isFeatureFile(item.id)) {files.add(item.uri.fsPath);}
    else {scenarioRoots.push(item);}
  }
  const covered = new Set([...files].map(normalizePath));
  return [
    ...[...files].map((path): RunTarget => ({ kind: "path", path })),
    ...scenarioRefsUnder(scenarioRoots, options.scenarioFor)
      .filter((scenario) => !covered.has(normalizePath(scenario.filePath)))
      .map((scenario): RunTarget => ({ kind: "scenario", scenario })),
  ];
}

export function testExplorerRunIntent(options: RunPlanOptions): ClientRunIntent {
  const wholeSuite = options.mode === "run" &&
    options.request.include === undefined &&
    (options.request.exclude?.length ?? 0) === 0;
  const only = options.roots.length === 1 ? options.roots[0] : undefined;
  const targets = wholeSuite
    ? [{ kind: "suite" as const }]
    : options.mode === "debug"
      ? debugTargets(options, only)
      : runTargets(options);
  const seen = new Set<string>();
  const selection = selectionFor(options, wholeSuite, only);
  return withExecutionClientContext({
    mode: options.mode,
    targets: targets.filter((target) => {
      const key = targetKey(target);
      if (seen.has(key)) {return false;}
      seen.add(key);
      return true;
    }),
    ...(options.maxWorkers !== undefined ? { maxWorkers: options.maxWorkers } : {}),
  }, { selection, initiatedBy: "test-explorer" });
}
