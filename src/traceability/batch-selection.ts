import { BatchSelection } from "./contracts";
import type { TraceabilitySnapshot } from "./traceability-model";
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
  const canonical = (ref: ScenarioRef): ScenarioRef => known.find((k) => sameScenario(k, ref)) ?? ref;

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
      // Collapse to one combined-grep invocation (one bddgen regeneration for the whole set) instead
      // of one full bddgen+playwright pass per scenario. Exclusion stays surgical; the grep is
      // rebuilt from the remaining refs (see `invocationsAfterExclusions`).
      const invocations = scenarios.length > 0 ? [{ kind: "grep" as const, refs: scenarios }] : [];
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
