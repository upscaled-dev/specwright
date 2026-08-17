import type { RunTarget } from "../core/run-contracts";
import {
  type BatchInvocation,
  batchSelectionFromScenarios,
} from "../traceability/batch-selection";
import type { BatchSelection } from "../traceability/contracts";
import { normalizePath, refIdentity, type ScenarioRef } from "../traceability/scenario-ref";
import type { TraceabilitySnapshot } from "../traceability/traceability-model";
import { scenarioRefFromArg } from "./traceability-link-commands";

// The palette and the view-title button both invoke the tree command with no node at all, so an
// empty argument list names nothing to run. Widening it to every mapped scenario would run the whole
// suite without the user ever choosing it.
export function treeBatchSelection(
  args: readonly unknown[],
  snapshot: TraceabilitySnapshot
): { readonly selection: BatchSelection; readonly skipped: number } {
  const nodes = [args[0], ...(Array.isArray(args[1]) ? args[1] : [])]
    .filter((node, index, all) => node !== undefined && all.indexOf(node) === index);
  const only = nodes.length === 1 ? nodes[0] as { kind?: unknown; filePath?: unknown } : undefined;
  if (only?.kind === "file" && typeof only.filePath === "string") {
    return { selection: { kind: "feature", filePath: only.filePath }, skipped: 0 };
  }

  const refs: ScenarioRef[] = [];
  const skipped = new Set<string>();
  for (const node of nodes) {
    const shaped = node as { kind?: unknown; filePath?: unknown };
    if (shaped.kind === "link") {
      const ref = scenarioRefFromArg(node);
      if (ref) {refs.push(ref);}
    } else if (shaped.kind === "file" && typeof shaped.filePath === "string") {
      const file = normalizePath(shaped.filePath);
      refs.push(...snapshot.links
        .filter((link) => normalizePath(link.scenario.filePath) === file)
        .map((link) => link.scenario));
      for (const item of snapshot.untraced) {
        if (normalizePath(item.scenario.filePath) === file) {
          skipped.add(refIdentity(item.scenario));
        }
      }
    } else if (shaped.kind === "untraced") {
      const ref = scenarioRefFromArg(node);
      if (ref) {skipped.add(refIdentity(ref));}
    }
  }
  const seen = new Set<string>();
  const scenarios = refs.filter((ref) => {
    const identity = refIdentity(ref);
    if (seen.has(identity)) {return false;}
    seen.add(identity);
    return true;
  });
  return { selection: batchSelectionFromScenarios(scenarios), skipped: skipped.size };
}

export function executionTargets(invocations: readonly BatchInvocation[]): RunTarget[] {
  return invocations.map((invocation): RunTarget => {
    if (invocation.kind === "scenario") {
      return {
        kind: "scenario",
        scenario: invocation.ref,
        ...(invocation.tagExpression ? { tagExpression: invocation.tagExpression } : {}),
      };
    }
    if (invocation.kind === "path-filter") {
      return {
        kind: "path",
        path: invocation.target,
        ...(invocation.tagExpression ? { tagExpression: invocation.tagExpression } : {}),
      };
    }
    return { kind: "tag-expression", expression: invocation.expression };
  });
}
