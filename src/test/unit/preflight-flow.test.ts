import { describe, it, expect, vi } from "vitest";
import {
  PreflightChoice,
  invocationsAfterExclusions,
  recordDecisions,
  runPreflightFlow,
} from "../../traceability/preflight-flow";
import { BatchInvocation, ResolvedBatch } from "../../traceability/batch-selection";
import { ScenarioRef, TraceabilitySnapshot } from "../../traceability/traceability-model";
import { BatchSelection, PreflightItem } from "../../traceability/contracts";

function ref(over: Partial<ScenarioRef> = {}): ScenarioRef {
  return { filePath: "/ws/a.feature", line: 3, name: "S", kind: "scenario", ...over };
}

const UNMAPPED = ref({ name: "Untagged" });
const MAPPED = ref({ name: "Mapped", line: 8 });

const SELECTION: BatchSelection = { kind: "multi-select", scenarios: [UNMAPPED, MAPPED] };

function snapshot(over: Partial<TraceabilitySnapshot> = {}): TraceabilitySnapshot {
  return { links: [], untraced: [], orphans: [], stale: false, completeness: "complete", errors: [], ...over };
}

// One unmapped + one ready-mapped scenario; the resolved invocations mirror them.
function resolvedBatch(): ResolvedBatch {
  return {
    scenarios: [UNMAPPED, MAPPED],
    invocations: [
      { kind: "scenario", ref: UNMAPPED },
      { kind: "scenario", ref: MAPPED },
    ],
  };
}

function flowSnapshot(): TraceabilitySnapshot {
  return snapshot({
    links: [{ testKey: "CALC-1", scenario: MAPPED, reqKeys: [] }],
    untraced: [{ scenario: UNMAPPED, reqKeys: [], malformedTags: [] }],
  });
}

interface FlowHarness {
  runs: Array<{ invocations: readonly BatchInvocation[]; decisions: readonly unknown[] }>;
  repairs: ScenarioRef[];
}

function deps(choose: PreflightChoice[], harness: FlowHarness) {
  let round = 0;
  return {
    resolve: () => resolvedBatch(),
    snapshot: () => flowSnapshot(),
    ui: {
      choose: (): Promise<PreflightChoice> => Promise.resolve(choose[round++] ?? { kind: "cancel" }),
      repair: (scenario: ScenarioRef): Promise<void> => {
        harness.repairs.push(scenario);
        return Promise.resolve();
      },
    },
    runner: {
      run: (_sel: BatchSelection, invocations: readonly BatchInvocation[], decisions: readonly unknown[]): Promise<void> => {
        harness.runs.push({ invocations, decisions });
        return Promise.resolve();
      },
    },
  };
}

describe("recordDecisions", () => {
  it("records the outcome for every non-ready item and skips ready ones", () => {
    const items: PreflightItem[] = [
      { scenario: UNMAPPED, state: "unmapped" },
      { scenario: MAPPED, testKey: "CALC-1", state: "ready" },
    ];
    expect(recordDecisions(items, "exclude")).toEqual([
      { scenario: UNMAPPED, state: "unmapped", outcome: "exclude" },
    ]);
  });
});

describe("invocationsAfterExclusions", () => {
  it("drops scenario invocations for excluded scenarios and keeps coarse ones", () => {
    const invocations: BatchInvocation[] = [
      { kind: "scenario", ref: UNMAPPED },
      { kind: "scenario", ref: MAPPED },
      { kind: "tags", expression: "@smoke" },
    ];
    expect(invocationsAfterExclusions(invocations, [UNMAPPED])).toEqual([
      { kind: "scenario", ref: MAPPED },
      { kind: "tags", expression: "@smoke" },
    ]);
  });
});

describe("runPreflightFlow", () => {
  it("runs nothing when the user cancels the preflight", async () => {
    const harness: FlowHarness = { runs: [], repairs: [] };
    const ran = await runPreflightFlow(SELECTION, deps([{ kind: "cancel" }], harness));
    expect(ran).toBe(false);
    expect(harness.runs).toEqual([]);
  });

  it("excludes flagged scenarios, records their decisions, and drops their invocations", async () => {
    const harness: FlowHarness = { runs: [], repairs: [] };
    const ran = await runPreflightFlow(SELECTION, deps([{ kind: "run", outcome: "exclude" }], harness));
    expect(ran).toBe(true);
    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]?.decisions).toEqual([
      { scenario: UNMAPPED, state: "unmapped", outcome: "exclude" },
    ]);
    // The excluded scenario's grep invocation is gone; the ready one still runs.
    expect(harness.runs[0]?.invocations).toEqual([{ kind: "scenario", ref: MAPPED }]);
  });

  it("local-only runs the whole batch and records the intent without dropping anything", async () => {
    const harness: FlowHarness = { runs: [], repairs: [] };
    await runPreflightFlow(SELECTION, deps([{ kind: "run", outcome: "local-only" }], harness));
    expect(harness.runs[0]?.invocations).toHaveLength(2);
    expect(harness.runs[0]?.decisions).toEqual([
      { scenario: UNMAPPED, state: "unmapped", outcome: "local-only" },
    ]);
  });

  it("runs directly with no prompt when every scenario is ready", async () => {
    const harness: FlowHarness = { runs: [], repairs: [] };
    const choose = vi.fn();
    const d = {
      resolve: () => ({ scenarios: [MAPPED], invocations: [{ kind: "scenario" as const, ref: MAPPED }] }),
      snapshot: () => flowSnapshot(),
      ui: { choose, repair: () => Promise.resolve() },
      runner: {
        run: (_sel: BatchSelection, invocations: readonly BatchInvocation[], decisions: readonly unknown[]): Promise<void> => {
          harness.runs.push({ invocations, decisions });
          return Promise.resolve();
        },
      },
    };
    const ran = await runPreflightFlow(SELECTION, d);
    expect(ran).toBe(true);
    expect(choose).not.toHaveBeenCalled();
    expect(harness.runs[0]?.decisions).toEqual([]);
  });

  it("repair re-enters linkScenario, then re-classifies on the next round", async () => {
    const harness: FlowHarness = { runs: [], repairs: [] };
    const ran = await runPreflightFlow(
      SELECTION,
      deps([{ kind: "repair", scenario: UNMAPPED }, { kind: "cancel" }], harness)
    );
    expect(harness.repairs).toEqual([UNMAPPED]);
    expect(ran).toBe(false);
    expect(harness.runs).toEqual([]);
  });

  it("re-classifies against the REBUILT snapshot after repair and runs once all are ready", async () => {
    const harness: FlowHarness = { runs: [], repairs: [] };
    // Round 1: UNMAPPED is untraced. repair() mutates the snapshot (as rebuildNow would after the tag
    // insert), so round 2 sees it as a mapped, Gherkin-ready link and runs with no flagged items.
    let snap = snapshot({
      links: [{ testKey: "CALC-1", scenario: MAPPED, reqKeys: [] }],
      untraced: [{ scenario: UNMAPPED, reqKeys: [], malformedTags: [] }],
    });
    const d = {
      resolve: () => resolvedBatch(),
      snapshot: () => snap,
      ui: {
        choose: (): Promise<PreflightChoice> => Promise.resolve({ kind: "repair", scenario: UNMAPPED }),
        repair: (scenario: ScenarioRef): Promise<void> => {
          snap = snapshot({
            links: [
              { testKey: "CALC-1", scenario: MAPPED, reqKeys: [] },
              {
                testKey: "CALC-2",
                scenario: UNMAPPED,
                reqKeys: [],
                meta: { key: "CALC-2", testType: { name: "Cucumber", kind: "Gherkin" } },
              },
            ],
          });
          harness.repairs.push(scenario);
          return Promise.resolve();
        },
      },
      runner: {
        run: (_s: BatchSelection, invocations: readonly BatchInvocation[], decisions: readonly unknown[]): Promise<void> => {
          harness.runs.push({ invocations, decisions });
          return Promise.resolve();
        },
      },
    };
    const ran = await runPreflightFlow(SELECTION, d);
    expect(harness.repairs).toEqual([UNMAPPED]);
    expect(ran).toBe(true);
    expect(harness.runs).toHaveLength(1);
    expect(harness.runs[0]?.decisions).toEqual([]);
  });
});
