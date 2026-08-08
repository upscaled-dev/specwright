import { BatchSelection } from "./contracts";
import type { TraceabilitySnapshot } from "./traceability-model";
import type { OutlineExampleRow } from "../types";
import type { ArtifactCaptureTarget } from "./run-artifact-store";
import { ScenarioRef, normalizePath, refIdentity, sameScenario } from "./scenario-ref";

// One thing to run for a resolved batch. `scenario` targets one exact scenario; `path-filter`
// carries the source feature file or folder; the executor resolves its working dir (the owning
// Playwright config, monorepo-aware) and derives a forward-slashed, regex-escaped positional filter
// relative to that dir; `tags` routes the expression through the `bddgen --tags` path. There is
// deliberately no combined-title invocation: a title grep spanning files can execute a same-titled
// or chain-matched scenario the batch does not own.
export type BatchInvocation =
  | { readonly kind: "scenario"; readonly ref: ScenarioRef; readonly tagExpression?: string | undefined }
  | { readonly kind: "path-filter"; readonly target: string; readonly tagExpression?: string | undefined }
  | { readonly kind: "tags"; readonly expression: string };

export interface ResolvedBatch {
  readonly scenarios: ScenarioRef[];
  readonly invocations: BatchInvocation[];
}

export interface BatchResolutionOptions {
  // Canonical member test keys of the target Test Plan, when the selection is `test-plan-derived`
  // (slice 2d's remote plan lookup supplies them). Absent/empty → that scope resolves to nothing.
  readonly planTestKeys?: readonly string[] | undefined;
  readonly projectOf?: ((testKey: string) => string) | undefined;
}

export function batchSelectionFromScenarios(
  refs: readonly ScenarioRef[]
): BatchSelection {
  const seen = new Set<string>();
  const scenarios = refs.filter((ref) => {
    const id = refIdentity(ref);
    if (seen.has(id)) {return false;}
    seen.add(id);
    return true;
  });
  const first = scenarios[0];
  // Nothing selected means nothing to run. Widening it to every mapped scenario here would let any
  // caller that forgot a guard run the whole suite on an empty selection.
  if (!first) {return { kind: "multi-select", scenarios: [] };}
  return scenarios.length === 1
    ? { kind: "scenario", scenario: first }
    : { kind: "multi-select", scenarios };
}

// Resolve the exact report rows owned by one mapped invocation. Split Examples blocks override the
// enclosing outline, matching the ownership rule used to build the traceability snapshot.
export function artifactCaptureTarget(
  scenario: ScenarioRef,
  rows: readonly OutlineExampleRow[],
  mapped: readonly ScenarioRef[]
): ArtifactCaptureTarget {
  if (scenario.kind === "scenario") {
    return { scenario, ...(scenario.line > 0 ? { resultLines: [scenario.line] } : {}) };
  }
  // An outline-shaped scope is safe only when parsing proves at least one exact owned row. Leaving
  // it open would let a title grep capture rows the scope does not own.
  if (rows.length === 0) {
    throw new Error(
      `Could not resolve exact example rows for ${scenario.filePath}:${scenario.line}. ` +
        "No broader outline target was executed."
    );
  }
  if (scenario.kind === "examplesBlock") {
    const resultLines = rows
      .filter((row) => row.examplesBlockLineNumber === scenario.line)
      .map((row) => row.lineNumber);
    if (resultLines.length === 0) {
      throw new Error(
        `Examples block ${scenario.filePath}:${scenario.line} owns no parsed rows. ` +
          "No broader outline target was executed."
      );
    }
    return { scenario, resultLines };
  }
  // An outline ref names one row when it carries that row's own line; otherwise it names the whole
  // outline, by declaration line (the traceability mapping) or by title alone (a run target).
  if (rows.some((row) => row.lineNumber === scenario.line)) {
    return { scenario, resultLines: [scenario.line] };
  }
  const file = normalizePath(scenario.filePath);
  const splitBlocks = new Set(
    mapped
      .filter((ref) => ref.kind === "examplesBlock" && normalizePath(ref.filePath) === file)
      .map((ref) => ref.line)
  );
  const ownedByOutline = (row: OutlineExampleRow): boolean => (
    scenario.line > 0 ? row.outlineLineNumber === scenario.line : row.outlineName === scenario.name
  );
  const resultLines = rows
    .filter((row) => ownedByOutline(row) && !splitBlocks.has(row.examplesBlockLineNumber))
    .map((row) => row.lineNumber);
  if (resultLines.length === 0) {
    throw new Error(
      `Outline ${scenario.filePath}:${scenario.line} owns no parsed rows. ` +
        "No broader outline target was executed."
    );
  }
  return { scenario, resultLines };
}

function allScenarioRefs(snapshot: TraceabilitySnapshot): ScenarioRef[] {
  const seen = new Set<string>();
  const refs: ScenarioRef[] = [];
  for (const ref of [...snapshot.links.map((l) => l.scenario), ...snapshot.untraced.map((u) => u.scenario)]) {
    const id = refIdentity(ref);
    if (!seen.has(id)) {
      seen.add(id);
      refs.push(ref);
    }
  }
  return refs;
}

function mappedScenarioRefs(snapshot: TraceabilitySnapshot): ScenarioRef[] {
  const seen = new Set<string>();
  const refs: ScenarioRef[] = [];
  for (const link of snapshot.links) {
    const id = refIdentity(link.scenario);
    if (!seen.has(id)) {
      seen.add(id);
      refs.push(link.scenario);
    }
  }
  return refs;
}

function pathFilterInvocation(target: string, tagExpression?: string): BatchInvocation {
  return { kind: "path-filter", target, ...(tagExpression ? { tagExpression } : {}) };
}

function underFolder(filePath: string, folderPath: string): boolean {
  const file = normalizePath(filePath);
  const folder = normalizePath(folderPath).replace(/\/$/, "");
  return file.startsWith(`${folder}/`);
}

/**
 * Expands a batch selection into the scenario set to preflight and the executor invocations to run,
 * reusing the existing command-builder routes. Pure: derives its scenario set from the snapshot so a
 * scope's refs always agree with the ones preflight classifies. `tag-expression`'s membership is
 * bddgen's to decide, so its scenario set is left empty (nothing to preflight offline);
 * `test-plan-derived` needs `options.planTestKeys` from the remote plan lookup; without them it
 * resolves to nothing (the lookup hasn't run).
 */
export function resolveBatchSelection(
  selection: BatchSelection,
  snapshot: TraceabilitySnapshot,
  options: BatchResolutionOptions = {}
): ResolvedBatch {
  const known = allScenarioRefs(snapshot);
  const canonical = (ref: ScenarioRef): ScenarioRef => {
    const exact = known.find((candidate) => refIdentity(candidate) === refIdentity(ref));
    if (exact) {return exact;}
    const fuzzy = known.filter((candidate) => candidate.kind === ref.kind && sameScenario(candidate, ref));
    return fuzzy.length === 1 ? fuzzy[0] ?? ref : ref;
  };

  switch (selection.kind) {
    case "scenario": {
      const ref = canonical(selection.scenario);
      return {
        scenarios: [ref],
        invocations: [{
          kind: "scenario",
          ref,
          ...(selection.tagExpression ? { tagExpression: selection.tagExpression } : {}),
        }],
      };
    }
    case "multi-select": {
      const refs = selection.scenarios.map(canonical);
      return { scenarios: refs, invocations: refs.map((ref) => ({ kind: "scenario", ref })) };
    }
    case "feature": {
      const scenarios = known.filter((ref) => normalizePath(ref.filePath) === normalizePath(selection.filePath));
      return {
        scenarios,
        invocations: [pathFilterInvocation(selection.filePath, selection.tagExpression)],
      };
    }
    case "folder": {
      const scenarios = known.filter((ref) => underFolder(ref.filePath, selection.folderPath));
      return { scenarios, invocations: [pathFilterInvocation(selection.folderPath)] };
    }
    case "all-mapped": {
      const project = selection.project;
      const scenarios = project === undefined
        ? mappedScenarioRefs(snapshot)
        : mappedScenarioRefs({
            ...snapshot,
            links: snapshot.links.filter((link) => options.projectOf?.(link.testKey) === project),
          });
      return {
        scenarios,
        invocations: scenarios.map((ref) => ({ kind: "scenario", ref })),
      };
    }
    case "test-plan-derived": {
      const planKeys = new Set(options.planTestKeys ?? []);
      const scenarios = mappedScenarioRefs(snapshot).filter((ref) =>
        snapshot.links.some((link) => refIdentity(link.scenario) === refIdentity(ref) && planKeys.has(link.testKey))
      );
      return { scenarios, invocations: scenarios.map((ref) => ({ kind: "scenario", ref })) };
    }
    case "tag-expression":
      return { scenarios: [], invocations: [{ kind: "tags", expression: selection.expression }] };
    case "suite":
      // No batch entry point produces this scope. Returning every known scenario with nothing to run
      // would promise a full run and execute none of it.
      throw new Error("A suite selection cannot be resolved into a publishable batch.");
  }
}
