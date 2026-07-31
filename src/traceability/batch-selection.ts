import { BatchSelection } from "./contracts";
import type { TraceabilitySnapshot } from "./traceability-model";
import type { OutlineExampleRow } from "../types";
import type { ArtifactCaptureTarget } from "./run-artifact-store";
import { ScenarioRef, normalizePath, refIdentity, sameScenario } from "./scenario-ref";

// One thing to run for a resolved batch. `scenario` greps by name/outline; `grep` runs one combined
// name-regex over several scenarios in a single bddgen+playwright pass (the all-mapped collapse);
// `path-filter` carries the source feature file or folder; the executor resolves its working dir
// (the owning Playwright config, monorepo-aware) and derives a forward-slashed, regex-escaped
// positional filter relative to that dir; `tags` routes the expression through the `bddgen --tags`
// path.
export type BatchInvocation =
  | { readonly kind: "scenario"; readonly ref: ScenarioRef }
  | { readonly kind: "grep"; readonly refs: readonly ScenarioRef[] }
  | { readonly kind: "path-filter"; readonly target: string }
  | { readonly kind: "tags"; readonly expression: string };

export interface ResolvedBatch {
  readonly scenarios: ScenarioRef[];
  readonly invocations: BatchInvocation[];
}

export interface BatchResolutionOptions {
  // Canonical member test keys of the target Test Plan, when the selection is `test-plan-derived`
  // (slice 2d's remote plan lookup supplies them). Absent/empty → that scope resolves to nothing.
  readonly planTestKeys?: readonly string[] | undefined;
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
  if (!first) {return { kind: "all-mapped" };}
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
  if (scenario.kind === "examplesBlock") {
    return {
      scenario,
      resultLines: rows
        .filter((row) => row.examplesBlockLineNumber === scenario.line)
        .map((row) => row.lineNumber),
    };
  }
  const file = normalizePath(scenario.filePath);
  const splitBlocks = new Set(
    mapped
      .filter((ref) => ref.kind === "examplesBlock" && normalizePath(ref.filePath) === file)
      .map((ref) => ref.line)
  );
  return {
    scenario,
    resultLines: rows
      .filter((row) =>
        row.outlineLineNumber === scenario.line
        && !splitBlocks.has(row.examplesBlockLineNumber)
      )
      .map((row) => row.lineNumber),
  };
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

function pathFilterInvocation(target: string): BatchInvocation {
  return { kind: "path-filter", target };
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
      return { scenarios: [ref], invocations: [{ kind: "scenario", ref }] };
    }
    case "multi-select": {
      const refs = selection.scenarios.map(canonical);
      return { scenarios: refs, invocations: refs.map((ref) => ({ kind: "scenario", ref })) };
    }
    case "feature": {
      const scenarios = known.filter((ref) => normalizePath(ref.filePath) === normalizePath(selection.filePath));
      return { scenarios, invocations: [pathFilterInvocation(selection.filePath)] };
    }
    case "folder": {
      const scenarios = known.filter((ref) => underFolder(ref.filePath, selection.folderPath));
      return { scenarios, invocations: [pathFilterInvocation(selection.folderPath)] };
    }
    case "all-mapped": {
      const scenarios = mappedScenarioRefs(snapshot);
      // A combined grep is safe for plain scenarios. Outline and Examples-block mappings need their
      // own invocation so artifact capture can retain the rows each mapping owns.
      const invocations = scenarios.every((ref) => ref.kind === "scenario")
        ? scenarios.length > 0 ? [{ kind: "grep" as const, refs: scenarios }] : []
        : scenarios.map((ref) => ({ kind: "scenario" as const, ref }));
      return { scenarios, invocations };
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
  }
}
