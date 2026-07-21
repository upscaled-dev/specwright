import * as path from "node:path";
import { BatchSelection } from "./contracts";
import type { TraceabilitySnapshot } from "./traceability-model";
import { ScenarioRef, normalizePath, refIdentity, sameScenario } from "./scenario-ref";

// One thing to run for a resolved batch. `scenario` greps by name/outline; `path-filter` is a
// Playwright positional regex over the (forward-slashed, escaped) source path; `tags` routes the
// expression through the existing `bddgen --tags` path.
export type BatchInvocation =
  | { readonly kind: "scenario"; readonly ref: ScenarioRef }
  | { readonly kind: "path-filter"; readonly pathFilter: string; readonly workingDir?: string | undefined }
  | { readonly kind: "tags"; readonly expression: string };

export interface ResolvedBatch {
  readonly scenarios: ScenarioRef[];
  readonly invocations: BatchInvocation[];
}

export interface BatchResolutionOptions {
  // Workspace roots used to relativize a feature/folder path filter so it matches the generated spec
  // path (mirrored under the features-gen dir). No matching root → the forward-slashed path is used.
  readonly roots?: readonly string[] | undefined;
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

// Regex-escape after forward-slashing so a Windows-separator path never reads as regex poison (the
// v0.3.9 path gotcha) — Playwright treats CLI filters as regular expressions.
function toEscapedPathFilter(target: string, roots: readonly string[]): string {
  const owning = roots.find((root) => isUnder(target, root));
  const relative = owning ? path.relative(owning, target) : target;
  const slashed = relative.replaceAll("\\", "/");
  return slashed.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isUnder(target: string, dir: string): boolean {
  const rel = path.relative(dir, target);
  return rel !== "" && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function pathFilterInvocation(target: string, roots: readonly string[]): BatchInvocation {
  const workingDir = roots.find((root) => isUnder(target, root));
  return {
    kind: "path-filter",
    pathFilter: toEscapedPathFilter(target, roots),
    ...(workingDir ? { workingDir } : {}),
  };
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
 * `test-plan-derived` awaits slice 2d's plan lookup and resolves to nothing.
 */
export function resolveBatchSelection(
  selection: BatchSelection,
  snapshot: TraceabilitySnapshot,
  options: BatchResolutionOptions = {}
): ResolvedBatch {
  const roots = options.roots ?? [];
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
      return { scenarios, invocations: [pathFilterInvocation(selection.filePath, roots)] };
    }
    case "folder": {
      const scenarios = known.filter((ref) => underFolder(ref.filePath, selection.folderPath));
      return { scenarios, invocations: [pathFilterInvocation(selection.folderPath, roots)] };
    }
    case "all-mapped": {
      const scenarios = mappedScenarioRefs(snapshot);
      return { scenarios, invocations: scenarios.map((ref) => ({ kind: "scenario", ref })) };
    }
    case "tag-expression":
      return { scenarios: [], invocations: [{ kind: "tags", expression: selection.expression }] };
    case "test-plan-derived":
      return { scenarios: [], invocations: [] };
  }
}
