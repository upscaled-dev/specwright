import { describe, it, expect } from "vitest";
import {
  BoardViewModel,
  buildBoardViewModel,
  filterBoardViewModel,
  resolveBoardDrop,
  scenarioDropId,
} from "../../traceability/board-data";
import type {
  OrphanTest,
  TraceabilitySnapshot,
  TraceLink,
  UntracedScenario,
} from "../../traceability/traceability-model";
import type { ScenarioRef } from "../../traceability/scenario-ref";

const ROOTS = ["/ws"];
const PREFIX = "TEST_";

function build(snapshot: TraceabilitySnapshot | undefined, roots: readonly string[] = ROOTS): BoardViewModel {
  return buildBoardViewModel(snapshot, roots, PREFIX);
}

function ref(over: Partial<ScenarioRef> = {}): ScenarioRef {
  return { filePath: "/ws/features/login.feature", line: 5, name: "Log in", kind: "scenario", ...over };
}

function snapshot(over: Partial<TraceabilitySnapshot> = {}): TraceabilitySnapshot {
  return {
    links: [],
    untraced: [],
    orphans: [],
    stale: false,
    completeness: "complete",
    errors: [],
    ...over,
  };
}

function link(over: Partial<TraceLink> = {}): TraceLink {
  return { testKey: "CALC-1", scenario: ref(), reqKeys: [], ...over };
}

function untraced(over: Partial<UntracedScenario> = {}): UntracedScenario {
  return { scenario: ref(), reqKeys: [], ...over };
}

function orphan(over: Partial<OrphanTest> = {}): OrphanTest {
  return { testKey: "CALC-9", meta: { key: "CALC-9" }, ...over };
}

describe("buildBoardViewModel — untraced scenario cards", () => {
  it("returns empty columns for an undefined snapshot", () => {
    expect(build(undefined, ROOTS)).toEqual({ scenarios: [], tests: [], matrix: [] });
  });

  it("renders a plain untraced scenario with a workspace-relative location and a 'no tag' pill", () => {
    const model = build(snapshot({ untraced: [untraced()] }), ROOTS);
    expect(model.scenarios).toEqual([
      { name: "Log in", location: "features/login.feature:5", dropId: scenarioDropId(ref()), pills: ["no tag"], reqKeys: [] },
    ]);
  });

  it("gives each card an unambiguous drop id built from its absolute path, line, and name", () => {
    const model = build(snapshot({ untraced: [untraced()] }), ROOTS);
    expect(model.scenarios[0]!.dropId).toBe(scenarioDropId(ref()));
    expect(model.scenarios[0]!.dropId).toContain("/ws/features/login.feature");
  });

  it("tags an untagged outline with an 'outline' pill and its example count", () => {
    const item = untraced({ scenario: ref({ kind: "outline", name: "Adding", outlineName: "Adding" }), examples: 3 });
    const model = build(snapshot({ untraced: [item] }), ROOTS);
    expect(model.scenarios[0]!.pills).toEqual(["outline", "3 examples"]);
  });

  it("singularizes a one-row example count", () => {
    const item = untraced({ scenario: ref({ kind: "outline", name: "Adding" }), examples: 1 });
    const model = build(snapshot({ untraced: [item] }), ROOTS);
    expect(model.scenarios[0]!.pills).toEqual(["outline", "1 example"]);
  });

  it("shows only the 'outline' pill when an outline carries no example count", () => {
    const item = untraced({ scenario: ref({ kind: "outline", name: "Adding" }) });
    const model = build(snapshot({ untraced: [item] }), ROOTS);
    expect(model.scenarios[0]!.pills).toEqual(["outline"]);
  });

  it("carries the requirement tags on the card for the filter", () => {
    const model = build(snapshot({ untraced: [untraced({ reqKeys: ["REQ-7"] })] }), ROOTS);
    expect(model.scenarios[0]!.reqKeys).toEqual(["REQ-7"]);
  });

  it("sorts scenario cards by name", () => {
    const model = build(
      snapshot({
        untraced: [
          untraced({ scenario: ref({ name: "Zebra" }) }),
          untraced({ scenario: ref({ name: "Apple" }) }),
        ],
      }),
      ROOTS
    );
    expect(model.scenarios.map((c) => c.name)).toEqual(["Apple", "Zebra"]);
  });
});

describe("buildBoardViewModel — workspace-relative paths", () => {
  it("falls back to the forward-slashed absolute path when the file sits outside every root", () => {
    const item = untraced({ scenario: ref({ filePath: "/elsewhere/x.feature", line: 2 }) });
    const model = build(snapshot({ untraced: [item] }), ROOTS);
    expect(model.scenarios[0]!.location).toBe("/elsewhere/x.feature:2");
  });

  it("prefers the most specific (shortest-relative) root in a multi-root workspace", () => {
    const item = untraced({ scenario: ref({ filePath: "/ws/features/login.feature", line: 5 }) });
    const model = build(snapshot({ untraced: [item] }), ["/ws", "/ws/features"]);
    expect(model.scenarios[0]!.location).toBe("login.feature:5");
  });

  it("normalizes backslash separators to forward slashes", () => {
    const item = untraced({ scenario: ref({ filePath: "C:\\ws\\a.feature", line: 1 }) });
    const model = build(snapshot({ untraced: [item] }), ["C:\\other"]);
    expect(model.scenarios[0]!.location).toBe("C:/ws/a.feature:1");
  });
});

describe("buildBoardViewModel — test cards", () => {
  it("groups mapped links by key into a plain card carrying the linked-scenario count", () => {
    const model = build(
      snapshot({
        links: [
          link({ testKey: "CALC-1", scenario: ref({ line: 5, name: "A" }) }),
          link({ testKey: "CALC-1", scenario: ref({ line: 9, name: "B" }) }),
        ],
      }),
      ROOTS
    );
    expect(model.tests).toEqual([{ key: "CALC-1", pills: ["2 scenarios"] }]);
  });

  it("singularizes a single mapped scenario", () => {
    const model = build(snapshot({ links: [link()] }), ROOTS);
    expect(model.tests[0]!.pills).toEqual(["1 scenario"]);
  });

  it("counts one outline's multiple Examples blocks as a single covered scenario", () => {
    const block = (line: number, name: string): ScenarioRef => ({
      filePath: "/ws/features/calc.feature",
      line,
      name,
      kind: "examplesBlock",
      outlineName: "Adding",
    });
    const model = build(
      snapshot({
        links: [
          link({ testKey: "CALC-1", scenario: block(10, "Adding — small") }),
          link({ testKey: "CALC-1", scenario: block(15, "Adding — large") }),
        ],
      }),
      ROOTS
    );
    expect(model.tests[0]!.pills).toEqual(["1 scenario"]);
  });

  it("shows the remote summary on a mapped card when the link carries metadata", () => {
    const model = build(
      snapshot({ links: [link({ meta: { key: "CALC-1", summary: "Add two numbers" } })] }),
      ROOTS
    );
    expect(model.tests[0]).toEqual({ key: "CALC-1", summary: "Add two numbers", pills: ["1 scenario"] });
  });

  it("omits the summary on a mapped card with no metadata (offline)", () => {
    const model = build(snapshot({ links: [link()] }), ROOTS);
    expect(model.tests[0]).not.toHaveProperty("summary");
  });

  it("treats an empty remote summary as absent", () => {
    const model = build(
      snapshot({ links: [link({ meta: { key: "CALC-1", summary: "" } })] }),
      ROOTS
    );
    expect(model.tests[0]).not.toHaveProperty("summary");
  });

  it("renders orphan tests with an 'orphan' pill and their summary", () => {
    const model = build(
      snapshot({ orphans: [orphan({ testKey: "CALC-9", meta: { key: "CALC-9", summary: "Stray" } })] }),
      ROOTS
    );
    expect(model.tests).toEqual([{ key: "CALC-9", summary: "Stray", pills: ["orphan"] }]);
  });

  it("omits the summary on an orphan with none", () => {
    const model = build(snapshot({ orphans: [orphan()] }), ROOTS);
    expect(model.tests[0]).toEqual({ key: "CALC-9", pills: ["orphan"] });
  });

  it("sorts mapped and orphan test cards together by key", () => {
    const model = build(
      snapshot({
        links: [link({ testKey: "CALC-2" })],
        orphans: [orphan({ testKey: "CALC-1", meta: { key: "CALC-1" } }), orphan({ testKey: "CALC-3", meta: { key: "CALC-3" } })],
      }),
      ROOTS
    );
    expect(model.tests.map((c) => c.key)).toEqual(["CALC-1", "CALC-2", "CALC-3"]);
    expect(model.tests.map((c) => c.pills[0])).toEqual(["orphan", "1 scenario", "orphan"]);
  });
});

describe("filterBoardViewModel", () => {
  const model: BoardViewModel = {
    scenarios: [
      { name: "Log in", location: "features/login.feature:5", dropId: "id-login", pills: ["no tag"], reqKeys: ["REQ-7"] },
      { name: "Checkout", location: "features/cart.feature:12", dropId: "id-checkout", pills: ["no tag"], reqKeys: [] },
    ],
    tests: [
      { key: "CALC-1", summary: "Add two numbers", pills: ["1 scenario"] },
      { key: "PAY-9", pills: ["orphan"] },
    ],
    matrix: [
      { requirement: "REQ-7", test: "CALC-1", scenario: "Log in", tag: "@TEST_CALC-1", result: "passed" },
      { requirement: "", test: "PAY-9", scenario: "", tag: "", result: "no coverage" },
    ],
  };

  it("returns the model untouched for an empty query", () => {
    expect(filterBoardViewModel(model, "   ")).toBe(model);
  });

  it("matches a test by key", () => {
    const out = filterBoardViewModel(model, "pay");
    expect(out.tests.map((t) => t.key)).toEqual(["PAY-9"]);
    expect(out.scenarios).toEqual([]);
  });

  it("matches matrix rows across all five columns", () => {
    expect(filterBoardViewModel(model, "req-7").matrix.map((r) => r.test)).toEqual(["CALC-1"]);
    expect(filterBoardViewModel(model, "no coverage").matrix.map((r) => r.test)).toEqual(["PAY-9"]);
    expect(filterBoardViewModel(model, "@test_calc").matrix.map((r) => r.test)).toEqual(["CALC-1"]);
    expect(filterBoardViewModel(model, "log in").matrix.map((r) => r.test)).toEqual(["CALC-1"]);
  });

  it("matches a test by summary", () => {
    expect(filterBoardViewModel(model, "two numbers").tests.map((t) => t.key)).toEqual(["CALC-1"]);
  });

  it("matches a scenario by name", () => {
    expect(filterBoardViewModel(model, "checkout").scenarios.map((s) => s.name)).toEqual(["Checkout"]);
  });

  it("matches a scenario by its file path", () => {
    expect(filterBoardViewModel(model, "cart.feature").scenarios.map((s) => s.name)).toEqual(["Checkout"]);
  });

  it("matches a scenario by requirement tag", () => {
    expect(filterBoardViewModel(model, "req-7").scenarios.map((s) => s.name)).toEqual(["Log in"]);
  });

  it("is case-insensitive", () => {
    expect(filterBoardViewModel(model, "CALC-1").tests.map((t) => t.key)).toEqual(["CALC-1"]);
  });
});

describe("buildBoardViewModel — matrix rows", () => {
  it("joins a mapped link into requirement, test, scenario, the in-file tag, and its result", () => {
    const model = build(snapshot({ links: [link({ testKey: "CALC-1", reqKeys: ["REQ-7"], lastResult: "passed" })] }));
    expect(model.matrix).toEqual([
      { requirement: "REQ-7", test: "CALC-1", scenario: "Log in", tag: "@TEST_CALC-1", result: "passed" },
    ]);
  });

  it("joins multiple requirement keys into one comma-separated cell", () => {
    const model = build(snapshot({ links: [link({ reqKeys: ["REQ-1", "REQ-2"] })] }));
    expect(model.matrix[0]!.requirement).toBe("REQ-1, REQ-2");
  });

  it("renders an outline link's passed/total iterations as the N/M result form", () => {
    const model = build(
      snapshot({
        links: [
          link({
            testKey: "CALC-2",
            scenario: ref({ kind: "outline", name: "Adding" }),
            lastResult: "failed",
            iterations: { passed: 2, total: 3 },
          }),
        ],
      })
    );
    expect(model.matrix[0]).toMatchObject({ test: "CALC-2", scenario: "Adding", result: "2/3" });
  });

  it("marks a mapped link with no run as 'no run'", () => {
    expect(build(snapshot({ links: [link()] })).matrix[0]!.result).toBe("no run");
  });

  it("leaves the test and tag cells empty for an untraced scenario and marks it 'no run'", () => {
    const model = build(snapshot({ untraced: [untraced({ reqKeys: ["REQ-9"] })] }));
    expect(model.matrix).toEqual([
      { requirement: "REQ-9", test: "", scenario: "Log in", tag: "", result: "no run" },
    ]);
  });

  it("represents a requirement with no test as an untraced row whose test cell is empty", () => {
    const model = build(snapshot({ untraced: [untraced({ reqKeys: ["REQ-42"] })] }));
    expect(model.matrix[0]).toMatchObject({ requirement: "REQ-42", test: "" });
  });

  it("leaves requirement, scenario, and tag empty for an orphan and marks it 'no coverage'", () => {
    const model = build(snapshot({ orphans: [orphan({ testKey: "CALC-9" })] }));
    expect(model.matrix).toEqual([
      { requirement: "", test: "CALC-9", scenario: "", tag: "", result: "no coverage" },
    ]);
  });

  it("orders filled requirements ahead of holes, then by test and scenario", () => {
    const model = build(
      snapshot({
        links: [link({ testKey: "CALC-1", reqKeys: ["REQ-1"] })],
        untraced: [untraced({ scenario: ref({ name: "Zeta" }) })],
        orphans: [orphan({ testKey: "CALC-9" })],
      })
    );
    expect(model.matrix.map((r) => [r.test, r.scenario])).toEqual([
      ["CALC-1", "Log in"],
      ["CALC-9", ""],
      ["", "Zeta"],
    ]);
  });
});

describe("resolveBoardDrop", () => {
  const snap = snapshot({
    untraced: [untraced()],
    orphans: [orphan({ testKey: "CALC-9" })],
    links: [link({ testKey: "CALC-1", scenario: ref({ line: 20, name: "Other" }) })],
  });

  it("resolves a valid drop to the untraced scenario's ref and the dropped key", () => {
    expect(resolveBoardDrop(snap, scenarioDropId(ref()), "CALC-9")).toEqual({ ref: ref(), key: "CALC-9" });
  });

  it("accepts a mapped test key as the drop target as well as an orphan", () => {
    expect(resolveBoardDrop(snap, scenarioDropId(ref()), "CALC-1")).toBeDefined();
  });

  it("rejects a stale drop whose scenario id no longer matches any untraced card", () => {
    expect(resolveBoardDrop(snap, scenarioDropId(ref({ line: 99 })), "CALC-9")).toBeUndefined();
  });

  it("rejects a drop whose key is not a known test", () => {
    expect(resolveBoardDrop(snap, scenarioDropId(ref()), "NOPE-1")).toBeUndefined();
  });

  it("rejects any drop against an undefined snapshot", () => {
    expect(resolveBoardDrop(undefined, scenarioDropId(ref()), "CALC-9")).toBeUndefined();
  });

  it("resolves to the correct file when two roots hold same-named files at the same relative path and line", () => {
    const a = ref({ filePath: "/root-a/features/login.feature", line: 5, name: "Log in" });
    const b = ref({ filePath: "/root-b/features/login.feature", line: 5, name: "Log in" });
    const twoRoot = snapshot({ untraced: [untraced({ scenario: a }), untraced({ scenario: b })], orphans: [orphan({ testKey: "CALC-9" })] });
    // Both cards render the identical display location "features/login.feature:5"; only the absolute
    // path in the drop id disambiguates them.
    expect(resolveBoardDrop(twoRoot, scenarioDropId(b), "CALC-9")).toEqual({ ref: b, key: "CALC-9" });
  });

  it("rejects a drop when a rebuild moved a different scenario onto the dragged card's line", () => {
    // The card was dragged as "Log in" at line 5; the rebuilt snapshot now has a different scenario at
    // line 5, so the id (which pins name and line) no longer matches and the drop is refused.
    const dragged = scenarioDropId(ref({ line: 5, name: "Log in" }));
    const rebuilt = snapshot({ untraced: [untraced({ scenario: ref({ line: 5, name: "Log out" }) })], orphans: [orphan({ testKey: "CALC-9" })] });
    expect(resolveBoardDrop(rebuilt, dragged, "CALC-9")).toBeUndefined();
  });
});
