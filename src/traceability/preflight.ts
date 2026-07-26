import {
  AutomationBindingClassification,
  PreflightItem,
  PreflightState,
  TestCaseMetadata,
} from "./contracts";
import type { TraceLink, TraceabilitySnapshot } from "./traceability-model";
import { ScenarioRef, refIdentity, sameScenario } from "./scenario-ref";

export interface PreflightAdapterHooks {
  // Provider-specific compatibility check (Xray: Gherkin-only). Absent → every mapped scenario is
  // `ready` (the neutral core makes no provider claims of its own).
  classifyBinding?: ((meta: TestCaseMetadata | undefined) => AutomationBindingClassification) | undefined;
  // Canonical test keys of the target Test Plan, when the run carries one (slice 2d's plan lookup).
  // A mapped scenario whose key is absent from this set classifies `not-in-target-plan`; absent →
  // the state is never produced. The caller supplies keys canonicalized to match the model's links.
  targetPlanKeys?: ReadonlySet<string> | undefined;
}

// Precomputed duplicate sets over the WHOLE snapshot (the model does not carry them): a link is a
// duplicate when its testKey is shared by more than one scenario, or its scenario carries more than
// one testKey. Keyed by strict `refIdentity` so two same-titled scenarios at different lines are
// never conflated (the same identity the >1-links check below uses).
interface DuplicateSets {
  sharedKeys: Set<string>;
  multiKeyScenarios: Set<string>;
}

function addTo(map: Map<string, Set<string>>, key: string, value: string): void {
  const existing = map.get(key);
  if (existing) {
    existing.add(value);
  } else {
    map.set(key, new Set([value]));
  }
}

function duplicateSets(links: readonly TraceLink[]): DuplicateSets {
  const scenariosByKey = new Map<string, Set<string>>();
  const keysByScenario = new Map<string, Set<string>>();
  for (const link of links) {
    const id = refIdentity(link.scenario);
    addTo(scenariosByKey, link.testKey, id);
    addTo(keysByScenario, id, link.testKey);
  }
  const sharedKeys = new Set<string>();
  for (const [key, scenarios] of scenariosByKey) {
    if (scenarios.size > 1) {sharedKeys.add(key);}
  }
  const multiKeyScenarios = new Set<string>();
  for (const [id, keys] of keysByScenario) {
    if (keys.size > 1) {multiKeyScenarios.add(id);}
  }
  return { sharedKeys, multiKeyScenarios };
}

function bindingState(
  meta: TestCaseMetadata | undefined,
  hooks: PreflightAdapterHooks
): { state: PreflightState; detail?: string } {
  const classification = hooks.classifyBinding?.(meta) ?? "compatible";
  switch (classification) {
    case "incompatible-test-type":
      return { state: "incompatible-test-type" };
    case "binding-required":
      return { state: "automation-binding-required" };
    case "unknown":
      // Same evidentiary bar as orphans: a partial snapshot can't back a claim, so it never blocks.
      return { state: "ready", detail: "Binding not verified against a partial snapshot; treated as ready." };
    default:
      return { state: "ready" };
  }
}

// A non-blocking warning for a broken `@TEST_` tag sitting alongside a working mapping, surfaced,
// never used to override the sound state (item 7: the mapping stands, the extra tag isn't hidden).
function malformedNote(links: readonly TraceLink[]): string | undefined {
  const tags = new Set<string>();
  for (const link of links) {
    for (const tag of link.malformedTags ?? []) {tags.add(tag);}
  }
  return tags.size > 0 ? `Ignoring a broken test tag: ${[...tags].join(", ")}` : undefined;
}

function withDetail(
  state: PreflightState,
  ...notes: (string | undefined)[]
): { state: PreflightState; detail?: string } {
  const detail = notes.filter((note): note is string => note !== undefined && note !== "").join(" ");
  return detail === "" ? { state } : { state, detail };
}

/**
 * Classifies each selected scenario against the offline snapshot and the adapter's binding hook.
 * Pure and vscode-free (imports only the neutral scenario-ref helpers; the model types are erased).
 *
 * Precedence on a mapped scenario: `invalid-key` (a verified-absent remote key) outranks
 * `duplicate-mapping`, which outranks the binding-derived states; an unsound key makes the mapping
 * moot before ambiguity matters. `unknown` from the hook never blocks (maps to `ready`), and a broken
 * `@TEST_` tag sitting beside a working key is surfaced as a note without overriding the sound state.
 * `not-in-target-plan` (a mapped key absent from `targetPlanKeys` when the run carries a plan) ranks
 * below duplicate but above the binding states; it can't publish there regardless of compatibility.
 */
export function classifyPreflight(
  scenarios: readonly ScenarioRef[],
  snapshot: TraceabilitySnapshot,
  hooks: PreflightAdapterHooks = {}
): PreflightItem[] {
  const { sharedKeys, multiKeyScenarios } = duplicateSets(snapshot.links);

  return scenarios.map((scenario) => {
    const id = refIdentity(scenario);
    const matching = snapshot.links.filter((link) => refIdentity(link.scenario) === id);
    const primary = matching[0];

    if (primary) {
      const missing = matching.find((link) => link.remoteMissing === true);
      if (missing) {
        return { scenario, testKey: missing.testKey, state: "invalid-key" as const };
      }
      const warning = malformedNote(matching);
      const isDuplicate =
        matching.length > 1 || multiKeyScenarios.has(id) || matching.some((link) => sharedKeys.has(link.testKey));
      if (isDuplicate) {
        return { scenario, testKey: primary.testKey, ...withDetail("duplicate-mapping", warning) };
      }
      if (hooks.targetPlanKeys !== undefined && !hooks.targetPlanKeys.has(primary.testKey)) {
        return { scenario, testKey: primary.testKey, ...withDetail("not-in-target-plan", warning) };
      }
      const bound = bindingState(primary.meta, hooks);
      return { scenario, testKey: primary.testKey, ...withDetail(bound.state, bound.detail, warning) };
    }

    const untraced = snapshot.untraced.find(
      (u) => refIdentity(u.scenario) === id || sameScenario(u.scenario, scenario)
    );
    const malformed = untraced?.malformedTags ?? [];
    if (malformed.length > 0) {
      return { scenario, state: "invalid-key" as const, detail: `Broken tag: ${malformed.join(", ")}` };
    }
    return { scenario, state: "unmapped" as const };
  });
}
