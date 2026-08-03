import {
  AutomationBindingClassification,
  BatchSelection,
  PreflightDecision,
  PreflightItem,
  TestCaseMetadata,
} from "./contracts";
import { BatchInvocation, ResolvedBatch } from "./batch-selection";
import type { TraceabilitySnapshot } from "./traceability-model";
import { ScenarioRef, refIdentity } from "./scenario-ref";
import { classifyPreflight } from "./preflight";

// A terminal outcome records this on every non-`ready` item; `repair`/`cancel` never persist.
type TerminalOutcome = "exclude" | "local-only";

// Records the chosen outcome on every non-`ready` item so nothing is ever silently dropped.
export function recordDecisions(
  items: readonly PreflightItem[],
  outcome: TerminalOutcome
): PreflightDecision[] {
  return items
    .filter((item) => item.state !== "ready")
    .map((item) => ({
      scenario: item.scenario,
      ...(item.testKey !== undefined ? { testKey: item.testKey } : {}),
      state: item.state,
      outcome,
    }));
}

function isExcluded(ref: ScenarioRef, excluded: readonly ScenarioRef[]): boolean {
  const id = refIdentity(ref);
  return excluded.some((candidate) => refIdentity(candidate) === id);
}

// Removes excluded scenarios from the invocations. A per-scenario invocation is dropped outright; a
// combined-grep invocation is rebuilt from its remaining refs (dropped if none survive), so
// exclusion stays surgical for the all-mapped scope. A coarse invocation (path-filter/tags) runs a
// whole feature/folder/tag set and can't be narrowed, so an excluded scenario that falls under one
// STILL runs and lands in `RunArtifact.results`; the exclusion is recorded as intent on
// `RunArtifact.preflight` only.
//
// CONTRACT for publish (P3): the publish path is the reconciliation seam. It MUST filter `results`
// against the `preflight` decisions (drop every result whose scenario carries an `exclude` decision)
// before building the execution payload; a result being present in the artifact is NOT consent to
// publish it. Do not treat `results` as the publishable set directly.
export function invocationsAfterExclusions(
  invocations: readonly BatchInvocation[],
  excluded: readonly ScenarioRef[]
): BatchInvocation[] {
  if (excluded.length === 0) {
    return [...invocations];
  }
  const out: BatchInvocation[] = [];
  for (const inv of invocations) {
    if (inv.kind === "scenario") {
      if (!isExcluded(inv.ref, excluded)) {
        out.push(inv);
      }
    } else {
      out.push(inv);
    }
  }
  return out;
}

// The user's resolution of a preflight round.
export type PreflightChoice =
  | { readonly kind: "cancel" }
  | { readonly kind: "run"; readonly outcome: TerminalOutcome }
  | { readonly kind: "repair"; readonly scenario: ScenarioRef };

export interface PreflightUi {
  // Present the classified items and return the chosen resolution.
  choose(items: readonly PreflightItem[]): Promise<PreflightChoice>;
  // Jump into the linkScenario flow for one item; the flow re-classifies afterwards.
  repair(scenario: ScenarioRef): Promise<void>;
}

export interface PreflightRunner {
  run(
    selection: BatchSelection,
    invocations: readonly BatchInvocation[],
    decisions: readonly PreflightDecision[]
  ): Promise<void>;
}

export interface PreflightFlowDeps {
  resolve(selection: BatchSelection): ResolvedBatch;
  snapshot(): TraceabilitySnapshot;
  classifyBinding?: ((meta: TestCaseMetadata | undefined) => AutomationBindingClassification) | undefined;
  // Canonical member keys of the run's target Test Plan (slice 2d); a mapped scenario outside it
  // classifies `not-in-target-plan`. Absent → the state is never produced.
  targetPlanKeys?: ReadonlySet<string> | undefined;
  ui: PreflightUi;
  runner: PreflightRunner;
}

// Guards the repair loop against an unrepairable item cycling forever.
const MAX_ROUNDS = 50;

/**
 * The preflight batch flow: resolve → classify → (all ready ? run : prompt). `repair` re-enters the
 * linkScenario flow and re-classifies against the freshly rebuilt snapshot; `cancel` runs nothing;
 * a terminal outcome seals the decisions onto the artifact. Returns whether a batch was run.
 */
export async function runPreflightFlow(selection: BatchSelection, deps: PreflightFlowDeps): Promise<boolean> {
  for (let round = 0; round < MAX_ROUNDS; round += 1) {
    const resolved = deps.resolve(selection);
    const items = classifyPreflight(resolved.scenarios, deps.snapshot(), {
      classifyBinding: deps.classifyBinding,
      ...(deps.targetPlanKeys !== undefined ? { targetPlanKeys: deps.targetPlanKeys } : {}),
    });
    const nonReady = items.filter((item) => item.state !== "ready");

    if (nonReady.length === 0) {
      await deps.runner.run(selection, resolved.invocations, []);
      return true;
    }

    const choice = await deps.ui.choose(items);
    if (choice.kind === "cancel") {
      return false;
    }
    if (choice.kind === "repair") {
      await deps.ui.repair(choice.scenario);
      continue;
    }

    const decisions = recordDecisions(items, choice.outcome);
    const excluded = choice.outcome === "exclude" ? nonReady.map((item) => item.scenario) : [];
    await deps.runner.run(selection, invocationsAfterExclusions(resolved.invocations, excluded), decisions);
    return true;
  }
  return false;
}
