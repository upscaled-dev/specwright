import { describe, it, expect } from "vitest";
import {
  BoardViewModel,
  buildBoardViewModel,
  filterBoardViewModel,
} from "../../traceability/board-data";
import type {
  OrphanTest,
  TraceabilitySnapshot,
  TraceLink,
  UntracedScenario,
} from "../../traceability/traceability-model";
import type { ScenarioRef } from "../../traceability/scenario-ref";

const ROOTS = ["/ws"];

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
    expect(buildBoardViewModel(undefined, ROOTS)).toEqual({ scenarios: [], tests: [] });
  });

  it("renders a plain untraced scenario with a workspace-relative location and a 'no tag' pill", () => {
    const model = buildBoardViewModel(snapshot({ untraced: [untraced()] }), ROOTS);
    expect(model.scenarios).toEqual([
      { name: "Log in", location: "features/login.feature:5", pills: ["no tag"], reqKeys: [] },
    ]);
  });

  it("tags an untagged outline with an 'outline' pill and its example count", () => {
    const item = untraced({ scenario: ref({ kind: "outline", name: "Adding", outlineName: "Adding" }), examples: 3 });
    const model = buildBoardViewModel(snapshot({ untraced: [item] }), ROOTS);
    expect(model.scenarios[0]!.pills).toEqual(["outline", "3 examples"]);
  });

  it("singularizes a one-row example count", () => {
    const item = untraced({ scenario: ref({ kind: "outline", name: "Adding" }), examples: 1 });
    const model = buildBoardViewModel(snapshot({ untraced: [item] }), ROOTS);
    expect(model.scenarios[0]!.pills).toEqual(["outline", "1 example"]);
  });

  it("shows only the 'outline' pill when an outline carries no example count", () => {
    const item = untraced({ scenario: ref({ kind: "outline", name: "Adding" }) });
    const model = buildBoardViewModel(snapshot({ untraced: [item] }), ROOTS);
    expect(model.scenarios[0]!.pills).toEqual(["outline"]);
  });

  it("carries the requirement tags on the card for the filter", () => {
    const model = buildBoardViewModel(snapshot({ untraced: [untraced({ reqKeys: ["REQ-7"] })] }), ROOTS);
    expect(model.scenarios[0]!.reqKeys).toEqual(["REQ-7"]);
  });

  it("sorts scenario cards by name", () => {
    const model = buildBoardViewModel(
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
    const model = buildBoardViewModel(snapshot({ untraced: [item] }), ROOTS);
    expect(model.scenarios[0]!.location).toBe("/elsewhere/x.feature:2");
  });

  it("prefers the most specific (shortest-relative) root in a multi-root workspace", () => {
    const item = untraced({ scenario: ref({ filePath: "/ws/features/login.feature", line: 5 }) });
    const model = buildBoardViewModel(snapshot({ untraced: [item] }), ["/ws", "/ws/features"]);
    expect(model.scenarios[0]!.location).toBe("login.feature:5");
  });

  it("normalizes backslash separators to forward slashes", () => {
    const item = untraced({ scenario: ref({ filePath: "C:\\ws\\a.feature", line: 1 }) });
    const model = buildBoardViewModel(snapshot({ untraced: [item] }), ["C:\\other"]);
    expect(model.scenarios[0]!.location).toBe("C:/ws/a.feature:1");
  });
});

describe("buildBoardViewModel — test cards", () => {
  it("groups mapped links by key into a plain card carrying the linked-scenario count", () => {
    const model = buildBoardViewModel(
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
    const model = buildBoardViewModel(snapshot({ links: [link()] }), ROOTS);
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
    const model = buildBoardViewModel(
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
    const model = buildBoardViewModel(
      snapshot({ links: [link({ meta: { key: "CALC-1", summary: "Add two numbers" } })] }),
      ROOTS
    );
    expect(model.tests[0]).toEqual({ key: "CALC-1", summary: "Add two numbers", pills: ["1 scenario"] });
  });

  it("omits the summary on a mapped card with no metadata (offline)", () => {
    const model = buildBoardViewModel(snapshot({ links: [link()] }), ROOTS);
    expect(model.tests[0]).not.toHaveProperty("summary");
  });

  it("treats an empty remote summary as absent", () => {
    const model = buildBoardViewModel(
      snapshot({ links: [link({ meta: { key: "CALC-1", summary: "" } })] }),
      ROOTS
    );
    expect(model.tests[0]).not.toHaveProperty("summary");
  });

  it("renders orphan tests with an 'orphan' pill and their summary", () => {
    const model = buildBoardViewModel(
      snapshot({ orphans: [orphan({ testKey: "CALC-9", meta: { key: "CALC-9", summary: "Stray" } })] }),
      ROOTS
    );
    expect(model.tests).toEqual([{ key: "CALC-9", summary: "Stray", pills: ["orphan"] }]);
  });

  it("omits the summary on an orphan with none", () => {
    const model = buildBoardViewModel(snapshot({ orphans: [orphan()] }), ROOTS);
    expect(model.tests[0]).toEqual({ key: "CALC-9", pills: ["orphan"] });
  });

  it("sorts mapped and orphan test cards together by key", () => {
    const model = buildBoardViewModel(
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
      { name: "Log in", location: "features/login.feature:5", pills: ["no tag"], reqKeys: ["REQ-7"] },
      { name: "Checkout", location: "features/cart.feature:12", pills: ["no tag"], reqKeys: [] },
    ],
    tests: [
      { key: "CALC-1", summary: "Add two numbers", pills: ["1 scenario"] },
      { key: "PAY-9", pills: ["orphan"] },
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
