import { describe, it, expect } from "vitest";
import {
  BoardSectionMeta,
  BoardViewModel,
  buildBoardViewModel,
  buildExecutionRows,
  filterBoardViewModel,
  filterExecutionRows,
  filterScenarioColumn,
  filterTestColumn,
  groupMatrixRows,
  MatrixRow,
  paginate,
  resolveBoardDrop,
  resolveBoardUnlink,
  scenarioDropId,
  scopeBoardViewModel,
  sectionFiltering,
  syncProgressText,
} from "../../traceability/board-data";
import { projectFromKey } from "../../xray/xray-adapter";
import { UNKNOWN_EXECUTION } from "../../traceability/publish-core";
import type { LedgerEntry } from "../../traceability/publish-ledger";
import type {
  OrphanTest,
  TraceabilitySnapshot,
  TraceLink,
  UntracedScenario,
} from "../../traceability/traceability-model";
import type { ScenarioRef } from "../../traceability/scenario-ref";

const ROOTS = ["/ws"];
const PREFIX = "TEST_";

function build(
  snapshot: TraceabilitySnapshot | undefined,
  roots: readonly string[] = ROOTS,
  syncScopeResolved = true
): BoardViewModel {
  return buildBoardViewModel(snapshot, roots, PREFIX, syncScopeResolved);
}

function ref(over: Partial<ScenarioRef> = {}): ScenarioRef {
  return { filePath: "/ws/features/login.feature", line: 5, name: "Log in", kind: "scenario", ...over };
}

function examplesBlock(line: number, name: string): ScenarioRef {
  return { filePath: "/ws/features/calc.feature", line, name, kind: "examplesBlock", outlineName: "Adding" };
}

function snapshot(over: Partial<TraceabilitySnapshot> = {}): TraceabilitySnapshot {
  return {
    links: [],
    untraced: [],
    orphans: [],
    stale: false,
    completeProjects: ["CALC"],
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

describe("buildBoardViewModel: untraced scenario cards", () => {
  it("returns empty columns for an undefined snapshot", () => {
    expect(build(undefined, ROOTS)).toMatchObject({ scenarios: [], available: [], mapped: [], matrix: [] });
  });

  // Every card in this column is untraced by definition, so a "no tag" pill on all of them marked
  // nothing and cost each card a row of height. Only an outline still says something.
  it("renders a plain untraced scenario with a workspace-relative location and no pills", () => {
    const model = build(snapshot({ untraced: [untraced()] }), ROOTS);
    expect(model.scenarios).toEqual([
      { name: "Log in", location: "features/login.feature:5", dropId: scenarioDropId(ref()), pills: [], reqKeys: [] },
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

describe("buildBoardViewModel: workspace-relative paths", () => {
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

describe("buildBoardViewModel: test cards", () => {
  const loginRow = { name: "Log in", location: "features/login.feature:5", unlinkId: scenarioDropId(ref()) };
  const SCOPE_HINT = "Pick a project in the header to load its tests.";

  it("groups mapped links by key into one card carrying the linked-scenario count and a row per link", () => {
    const model = build(
      snapshot({
        links: [
          link({ testKey: "CALC-1", scenario: ref({ line: 9, name: "B" }) }),
          link({ testKey: "CALC-1", scenario: ref({ line: 5, name: "A" }) }),
        ],
      }),
      ROOTS
    );
    expect(model.mapped).toEqual([
      {
        key: "CALC-1",
        pills: ["2 scenarios"],
        links: [
          { name: "A", location: "features/login.feature:5", unlinkId: scenarioDropId(ref({ line: 5, name: "A" })) },
          { name: "B", location: "features/login.feature:9", unlinkId: scenarioDropId(ref({ line: 9, name: "B" })) },
        ],
      },
    ]);
  });

  it("singularizes a single mapped scenario", () => {
    const model = build(snapshot({ links: [link()] }), ROOTS);
    expect(model.mapped[0]!.pills).toEqual(["1 scenario"]);
  });

  it("gives a scenario linked to two tests its own row on each card", () => {
    const model = build(
      snapshot({ links: [link({ testKey: "CALC-1" }), link({ testKey: "CALC-2" })] }),
      ROOTS
    );
    expect(model.mapped.map((card) => card.links)).toEqual([[loginRow], [loginRow]]);
  });

  it("keeps one row per Examples block, counts them all in the pill, and unlinks each back to its block", () => {
    const small = examplesBlock(10, "Adding · small");
    const snap = snapshot({
      links: [link({ testKey: "CALC-1", scenario: small }), link({ testKey: "CALC-1", scenario: examplesBlock(15, "Adding · large") })],
    });
    const card = build(snap, ROOTS).mapped[0]!;
    // Each block owns its own tag, so each is its own row and the pill counts what the card lists.
    expect(card.pills).toEqual(["2 scenarios"]);
    expect(card.links.map((row) => row.name)).toEqual(["Adding · large", "Adding · small"]);
    expect(resolveBoardUnlink(snap, card.links[1]!.unlinkId, "CALC-1")).toEqual({ ref: small, key: "CALC-1" });
  });

  it("keeps same-named Examples blocks apart, ordered by location, each unlinking to its own block", () => {
    // An unnamed Examples block falls back to the outline's name, so both rows read the same and only
    // the location tie-break holds their order.
    const first = examplesBlock(10, "Adding");
    const second = examplesBlock(15, "Adding");
    const snap = snapshot({
      links: [link({ testKey: "CALC-1", scenario: second }), link({ testKey: "CALC-1", scenario: first })],
    });
    const card = build(snap, ROOTS).mapped[0]!;
    expect(card.links.map((row) => row.location)).toEqual(["features/calc.feature:10", "features/calc.feature:15"]);
    expect(resolveBoardUnlink(snap, card.links[0]!.unlinkId, "CALC-1")).toEqual({ ref: first, key: "CALC-1" });
    expect(resolveBoardUnlink(snap, card.links[1]!.unlinkId, "CALC-1")).toEqual({ ref: second, key: "CALC-1" });
  });

  it("shows the remote summary on a mapped card when the link carries metadata", () => {
    const model = build(
      snapshot({ links: [link({ meta: { key: "CALC-1", summary: "Add two numbers" } })] }),
      ROOTS
    );
    expect(model.mapped[0]).toEqual({ key: "CALC-1", summary: "Add two numbers", pills: ["1 scenario"], links: [loginRow] });
  });

  it("omits the summary on a mapped card with no metadata (offline)", () => {
    const model = build(snapshot({ links: [link()] }), ROOTS);
    expect(model.mapped[0]).not.toHaveProperty("summary");
  });

  it("treats an empty remote summary as absent", () => {
    const model = build(
      snapshot({ links: [link({ meta: { key: "CALC-1", summary: "" } })] }),
      ROOTS
    );
    expect(model.mapped[0]).not.toHaveProperty("summary");
  });

  it("renders an available test with its summary and no pills", () => {
    const model = build(
      snapshot({ orphans: [orphan({ testKey: "CALC-9", meta: { key: "CALC-9", summary: "Stray" } })] }),
      ROOTS
    );
    expect(model.available).toEqual([{ key: "CALC-9", summary: "Stray", pills: [], links: [] }]);
  });

  it("omits the summary on an available test with none and gives it no rows", () => {
    const model = build(snapshot({ orphans: [orphan()] }), ROOTS);
    expect(model.available[0]).toEqual({ key: "CALC-9", pills: [], links: [] });
  });

  it("sorts each group by key on its own, keeping mapped tests out of the available one", () => {
    const model = build(
      snapshot({
        links: [
          link({ testKey: "CALC-2" }),
          link({ testKey: "CALC-1", scenario: ref({ line: 9, name: "Other" }) }),
        ],
        orphans: [orphan({ testKey: "PAY-9", meta: { key: "PAY-9" } }), orphan({ testKey: "PAY-1", meta: { key: "PAY-1" } })],
      }),
      ROOTS
    );
    expect(model.mapped.map((c) => c.key)).toEqual(["CALC-1", "CALC-2"]);
    expect(model.available.map((c) => c.key)).toEqual(["PAY-1", "PAY-9"]);
  });

  it("points the empty available group at the project selector when the resolved sync scope is empty, snapshot or not", () => {
    // No sync can help here: no project's catalogue can land without a project scope, so the selector,
    // not the available-list copy, is the affordance.
    expect(build(undefined, ROOTS, false)).toMatchObject({ availableEmptyText: SCOPE_HINT });
    expect(build(snapshot({ completeProjects: ["CALC"] }), ROOTS, false)).toMatchObject({
      availableEmptyText: SCOPE_HINT,
    });
  });

  it("describes the unsynced state when the scope is configured but no complete catalogue has landed", () => {
    const expected = { availableEmptyText: "No synced tests yet." };
    expect(build(undefined, ROOTS, true)).toMatchObject(expected);
    expect(build(snapshot({ completeProjects: [] }), ROOTS, true)).toMatchObject(expected);
  });

  it("describes a complete sync that turned up no unmapped tests", () => {
    expect(build(snapshot({ completeProjects: ["CALC"] }), ROOTS, true)).toMatchObject({
      availableEmptyText: "No unmapped tests in the last sync.",
    });
  });
});

// One snapshot spanning every scoping case: a CALC link, a PAY orphan, an untraced scenario carrying a
// PAY requirement, and an untraced scenario carrying no key at all.
function scopedSnapshot(): TraceabilitySnapshot {
  return snapshot({
    links: [link({ testKey: "CALC-1", reqKeys: ["REQ-7"] })],
    orphans: [orphan({ testKey: "PAY-9", meta: { key: "PAY-9" } })],
    untraced: [
      untraced({ scenario: ref({ line: 20, name: "Pay by card" }), reqKeys: ["PAY-3"] }),
      untraced({ scenario: ref({ line: 30, name: "Browse" }) }),
    ],
  });
}

function scopedModel(): BoardViewModel {
  return buildBoardViewModel(scopedSnapshot(), ROOTS, PREFIX, true, projectFromKey);
}

const rowFor = (model: BoardViewModel, scenario: string): MatrixRow | undefined =>
  model.matrix.find((row) => row.scenario === scenario);

describe("buildBoardViewModel project stamping", () => {
  it("stamps every test card with its key's project", () => {
    const model = scopedModel();
    expect(model.mapped[0]).toMatchObject({ key: "CALC-1", project: "CALC" });
    expect(model.available[0]).toMatchObject({ key: "PAY-9", project: "PAY" });
  });

  it("stamps a matrix row from its test key, or from its requirements when it has no test key", () => {
    const model = scopedModel();
    expect(rowFor(model, "Log in")).toMatchObject({ test: "CALC-1", projects: ["CALC"] });
    expect(rowFor(model, "")).toMatchObject({ test: "PAY-9", projects: ["PAY"] });
    expect(rowFor(model, "Pay by card")).toMatchObject({ test: "", projects: ["PAY"] });
  });

  it("stamps every requirement's project on a test-less row, deduped, since it evidences all of them", () => {
    const model = buildBoardViewModel(
      snapshot({ untraced: [untraced({ reqKeys: ["PAY-3", "SHOP-1", "PAY-8"] })] }),
      ROOTS,
      PREFIX,
      true,
      projectFromKey
    );
    expect(rowFor(model, "Log in")?.projects).toEqual(["PAY", "SHOP"]);
  });

  it("uppercases what the grammar yields, so a stamp still matches the selector's canonical option", () => {
    const lowercased = (key: string): string => projectFromKey(key).toLowerCase();
    const model = buildBoardViewModel(
      snapshot({ orphans: [orphan({ testKey: "pay-9", meta: { key: "pay-9" } })] }),
      ROOTS,
      PREFIX,
      true,
      lowercased
    );

    expect(model.available[0]!.project).toBe("PAY");
    expect(model.matrix[0]!.projects).toEqual(["PAY"]);
    expect(scopeBoardViewModel(model, "PAY").available.map((card) => card.key)).toEqual(["pay-9"]);
  });

  it("leaves a row carrying neither key with no projects", () => {
    expect(rowFor(scopedModel(), "Browse")?.projects).toEqual([]);
  });

  it("stamps nothing when the grammar derives no project", () => {
    const model = build(scopedSnapshot());
    expect(model.mapped[0]!.project).toBeUndefined();
    expect(model.available[0]!.project).toBeUndefined();
    expect(model.matrix.every((row) => row.projects.length === 0)).toBe(true);
  });
});

describe("scopeBoardViewModel", () => {
  it("hands the model back untouched for All Projects", () => {
    const model = scopedModel();
    expect(scopeBoardViewModel(model, undefined)).toBe(model);
  });

  it("keeps only the picked project's test cards", () => {
    const pay = scopeBoardViewModel(scopedModel(), "PAY");
    expect(pay.available.map((card) => card.key)).toEqual(["PAY-9"]);
    expect(pay.mapped).toEqual([]);

    const calc = scopeBoardViewModel(scopedModel(), "CALC");
    expect(calc.available).toEqual([]);
    expect(calc.mapped.map((card) => card.key)).toEqual(["CALC-1"]);
  });

  it("keeps a matrix row whose test key is in the project and drops the other project's rows", () => {
    const rows = scopeBoardViewModel(scopedModel(), "CALC").matrix;
    expect(rows.map((row) => row.test)).toEqual(["CALC-1", ""]);
    expect(rows.map((row) => row.scenario)).toEqual(["Log in", "Browse"]);
  });

  it("keeps a row with no test key when its requirement is in the project", () => {
    const rows = scopeBoardViewModel(scopedModel(), "PAY").matrix;
    expect(rows.map((row) => row.scenario)).toContain("Pay by card");
    expect(rows.map((row) => row.test)).toContain("PAY-9");
  });

  it("shows a two-project requirement row under both of its projects and under neither third one", () => {
    const model = buildBoardViewModel(
      snapshot({ untraced: [untraced({ reqKeys: ["PAY-3", "SHOP-1"] })] }),
      ROOTS,
      PREFIX,
      true,
      projectFromKey
    );
    const scenarios = (project: string): string[] =>
      scopeBoardViewModel(model, project).matrix.map((row) => row.scenario);

    expect(scenarios("PAY")).toEqual(["Log in"]);
    expect(scenarios("SHOP")).toEqual(["Log in"]);
    expect(scenarios("CALC")).toEqual([]);
  });

  it("keeps a row carrying neither key visible under every scope, so its coverage hole never hides", () => {
    expect(scopeBoardViewModel(scopedModel(), "CALC").matrix.map((row) => row.scenario)).toContain("Browse");
    expect(scopeBoardViewModel(scopedModel(), "PAY").matrix.map((row) => row.scenario)).toContain("Browse");
  });

  it("never scopes the local scenario cards away", () => {
    const names = scopedModel().scenarios.map((card) => card.name);
    expect(scopeBoardViewModel(scopedModel(), "CALC").scenarios.map((card) => card.name)).toEqual(names);
  });

  // The empty state is re-decided for the scoped project alone. PAY's catalogue never landed, so it has
  // no orphans to show and must retain its own honest empty copy.
  it("re-decides the available group's empty state for the scoped project", () => {
    const model = buildBoardViewModel(
      snapshot({
        links: [link({ testKey: "CALC-1" })],
        completeProjects: ["CALC"],
      }),
      ROOTS,
      PREFIX,
      true,
      projectFromKey
    );

    const calc = scopeBoardViewModel(model, "CALC");
    expect(calc.available).toEqual([]);
    expect(calc.availableEmptyText).toBe("No unmapped tests in the last sync.");

    const pay = scopeBoardViewModel(model, "PAY");
    expect(pay.available).toEqual([]);
    expect(pay.availableEmptyText).toBe("No synced tests yet.");
  });

  // The scope selector's keys are uppercased; `completeProjects` is whatever the adapter reported. The
  // model already compares these case-insensitively, so the board must too or a landed lowercase project
  // reads as never synced.
  it("matches the landed projects case-insensitively, like the model does", () => {
    const model = buildBoardViewModel(
      snapshot({ links: [link({ testKey: "CALC-1" })], completeProjects: ["calc"] }),
      ROOTS,
      PREFIX,
      true,
      projectFromKey
    );

    expect(scopeBoardViewModel(model, "CALC")).toMatchObject({
      availableEmptyText: "No unmapped tests in the last sync.",
    });
  });
});

describe("filterBoardViewModel", () => {
  const model: BoardViewModel = {
    scenarios: [
      { name: "Log in", location: "features/login.feature:5", dropId: "id-login", pills: [], reqKeys: ["REQ-7"] },
      { name: "Checkout", location: "features/cart.feature:12", dropId: "id-checkout", pills: [], reqKeys: [] },
    ],
    available: [{ key: "PAY-9", pills: [], links: [] }],
    mapped: [
      {
        key: "CALC-1",
        summary: "Add two numbers",
        pills: ["2 scenarios"],
        links: [
          { name: "Add large numbers", location: "features/calc.feature:9", unlinkId: "id-add-large" },
          { name: "Add small numbers", location: "features/calc.feature:3", unlinkId: "id-add-small" },
        ],
      },
    ],
    matrix: [
      { requirement: "REQ-7", test: "CALC-1", scenario: "Log in", tag: "@TEST_CALC-1", result: "passed", file: "features/login.feature", projects: ["CALC"] },
      { requirement: "", test: "PAY-9", scenario: "", tag: "", result: "no coverage", file: "", projects: ["PAY"] },
    ],
    availableEmptyText: "No unmapped tests in the last sync.",
    completeProjects: ["CALC", "PAY"],
  };

  it("returns the model untouched for an empty query", () => {
    expect(filterBoardViewModel(model, "   ")).toBe(model);
  });

  it("matches a mapped test through a linked scenario's name and keeps all of that card's rows", () => {
    const out = filterBoardViewModel(model, "add small");
    expect(out.mapped.map((t) => t.key)).toEqual(["CALC-1"]);
    expect(out.mapped[0]!.links.map((row) => row.name)).toEqual(["Add large numbers", "Add small numbers"]);
  });

  it("matches a mapped test through a linked scenario's location", () => {
    expect(filterBoardViewModel(model, "calc.feature").mapped.map((t) => t.key)).toEqual(["CALC-1"]);
  });

  it("runs the same predicate over both groups, so a key match narrows one and empties the other", () => {
    const out = filterBoardViewModel(model, "pay");
    expect(out.available.map((t) => t.key)).toEqual(["PAY-9"]);
    expect(out.mapped).toEqual([]);
    expect(out.scenarios).toEqual([]);
  });

  it("matches matrix rows across all five columns", () => {
    expect(filterBoardViewModel(model, "req-7").matrix.map((r) => r.test)).toEqual(["CALC-1"]);
    expect(filterBoardViewModel(model, "no coverage").matrix.map((r) => r.test)).toEqual(["PAY-9"]);
    expect(filterBoardViewModel(model, "@test_calc").matrix.map((r) => r.test)).toEqual(["CALC-1"]);
    expect(filterBoardViewModel(model, "log in").matrix.map((r) => r.test)).toEqual(["CALC-1"]);
  });

  it("matches a test by summary", () => {
    expect(filterBoardViewModel(model, "two numbers").mapped.map((t) => t.key)).toEqual(["CALC-1"]);
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
    expect(filterBoardViewModel(model, "CALC-1").mapped.map((t) => t.key)).toEqual(["CALC-1"]);
  });

  it("passes the available group's empty state through untouched", () => {
    // A query that empties the group must not restate it as a remote that was never synced.
    const out = filterBoardViewModel(model, "calc-1");
    expect(out.available).toEqual([]);
    expect(out.availableEmptyText).toBe(model.availableEmptyText);
  });
});

// One model for the three mapping sections: two untraced scenarios in different files, two available
// tests with summaries, and a mapped test whose linked row says something its own header does not.
const columnModel = build(
  snapshot({
    untraced: [
      untraced({ scenario: ref({ name: "Log in" }), reqKeys: ["REQ-7"] }),
      untraced({ scenario: ref({ filePath: "/ws/features/cart.feature", line: 12, name: "Pay by card" }) }),
    ],
    orphans: [
      orphan({ testKey: "CALC-9", meta: { key: "CALC-9", summary: "Add two numbers" } }),
      orphan({ testKey: "PAY-9", meta: { key: "PAY-9", summary: "Pay with a card" } }),
    ],
    links: [
      link({
        testKey: "CALC-1",
        scenario: ref({ line: 30, name: "Add small numbers" }),
        meta: { key: "CALC-1", summary: "Adding" },
      }),
    ],
  })
);

describe("filterScenarioColumn", () => {
  const cards = columnModel.scenarios;

  it("returns the cards untouched for an empty query", () => {
    expect(filterScenarioColumn(cards, "   ")).toBe(cards);
  });

  it("matches a scenario by name, case-insensitively", () => {
    expect(filterScenarioColumn(cards, "PAY BY").map((card) => card.name)).toEqual(["Pay by card"]);
    expect(filterScenarioColumn(cards, "log").map((card) => card.name)).toEqual(["Log in"]);
  });

  // Narrower than the header search on purpose. This column search exists to bring one drag source into
  // view, and matching a file path would pull in every card that file holds.
  it("ignores the location and requirement tags the header search matches", () => {
    expect(filterBoardViewModel(columnModel, "req-7").scenarios.map((card) => card.name)).toEqual(["Log in"]);
    expect(filterScenarioColumn(cards, "cart.feature")).toEqual([]);
    expect(filterScenarioColumn(cards, "req-7")).toEqual([]);
  });

  it("composes AND-wise with the header search", () => {
    const header = filterBoardViewModel(columnModel, "cart.feature").scenarios;
    expect(header.map((card) => card.name)).toEqual(["Pay by card"]);
    expect(filterScenarioColumn(header, "pay").map((card) => card.name)).toEqual(["Pay by card"]);
    expect(filterScenarioColumn(header, "log in")).toEqual([]);
  });
});

describe("filterTestColumn", () => {
  const available = columnModel.available;

  it("returns the cards untouched for an empty query", () => {
    expect(filterTestColumn(available, "  ")).toBe(available);
  });

  it("matches a pasted test key, case-insensitively", () => {
    expect(filterTestColumn(available, "pay-9").map((card) => card.key)).toEqual(["PAY-9"]);
  });

  it("matches a summary, case-insensitively", () => {
    expect(filterTestColumn(available, "TWO NUMBERS").map((card) => card.key)).toEqual(["CALC-9"]);
  });

  it("keeps a card with no summary findable by key", () => {
    const noSummary = build(snapshot({ orphans: [orphan({ testKey: "PAY-1", meta: { key: "PAY-1" } })] })).available;
    expect(filterTestColumn(noSummary, "pay").map((card) => card.key)).toEqual(["PAY-1"]);
    expect(filterTestColumn(noSummary, "pay with")).toEqual([]);
  });

  // One predicate for both test groups, and narrower than the header's: a mapped card is found by what its
  // own header prints, not by the scenario rows listed under it.
  it("runs over the mapped group too, matching its key and summary but not its linked rows", () => {
    const mapped = columnModel.mapped;
    expect(filterTestColumn(mapped, "calc-1").map((card) => card.key)).toEqual(["CALC-1"]);
    expect(filterTestColumn(mapped, "adding").map((card) => card.key)).toEqual(["CALC-1"]);
    expect(filterTestColumn(mapped, "add small")).toEqual([]);
  });

  it("composes AND-wise with the header search", () => {
    const header = filterBoardViewModel(columnModel, "calc").available;
    expect(header.map((card) => card.key)).toEqual(["CALC-9"]);
    expect(filterTestColumn(header, "pay-9")).toEqual([]);
    expect(filterTestColumn(available, "pay-9").map((card) => card.key)).toEqual(["PAY-9"]);
  });
});

describe("paginate", () => {
  // The fold is generic in its element, so a numbered list is the honest fixture: the arithmetic and the
  // slice boundaries are what is under test.
  const numbers = (count: number): number[] => Array.from({ length: count }, (_, index) => index + 1);

  it("slices the first page and counts what the search left", () => {
    expect(paginate(numbers(5), 0, 2)).toEqual({
      items: [1, 2],
      meta: { filtered: 5, page: 0, pageCount: 3, pageSize: 2 },
    });
  });

  it("gives the last page its remainder only", () => {
    expect(paginate(numbers(5), 2, 2).items).toEqual([5]);
  });

  it("clamps a page beyond the end to the last one", () => {
    expect(paginate(numbers(5), 9, 2)).toEqual({ items: [5], meta: { filtered: 5, page: 2, pageCount: 3, pageSize: 2 } });
  });

  it("clamps to the last page when a narrowing search shrinks the set under the current page", () => {
    // Page 2 of 25 held cards a keystroke ago; a search leaving 3 must show those 3, not an empty page.
    expect(paginate(numbers(3), 1, 25)).toEqual({
      items: [1, 2, 3],
      meta: { filtered: 3, page: 0, pageCount: 1, pageSize: 25 },
    });
  });

  it("clamps a negative page to the first", () => {
    expect(paginate(numbers(3), -1, 2).meta.page).toBe(0);
  });

  it("truncates a non-integer page instead of straddling two windows", () => {
    expect(paginate(numbers(5), 1.9, 2).items).toEqual([3, 4]);
    expect(paginate(numbers(5), Number.NaN, 2).meta.page).toBe(0);
  });

  // A page size that is not a whole row is the one input that could leave cards unreachable, so it floors
  // at one and the reported size says what was actually used.
  it("floors a zero, negative, or fractional page size at one whole row", () => {
    expect(paginate(numbers(3), 0, 0)).toEqual({ items: [1], meta: { filtered: 3, page: 0, pageCount: 3, pageSize: 1 } });
    expect(paginate(numbers(3), 2, -5)).toEqual({ items: [3], meta: { filtered: 3, page: 2, pageCount: 3, pageSize: 1 } });
    expect(paginate(numbers(5), 0, 0.5).meta.pageSize).toBe(1);
    expect(paginate(numbers(5), 1, 2.7)).toEqual({ items: [3, 4], meta: { filtered: 5, page: 1, pageCount: 3, pageSize: 2 } });
  });

  it("makes an empty list one empty page, so a paginator never reads 'of 0'", () => {
    expect(paginate([], 3, 25)).toEqual({ items: [], meta: { filtered: 0, page: 0, pageCount: 1, pageSize: 25 } });
  });

  it("counts pages exactly at a multiple of the page size, and one over", () => {
    expect(paginate(numbers(100), 0, 25).meta.pageCount).toBe(4);
    expect(paginate(numbers(101), 0, 25).meta.pageCount).toBe(5);
    expect(paginate(numbers(101), 4, 25).items).toEqual([101]);
  });

  // The pipeline's "no matches for the filters" shape: nothing to paint, but the section still knows how
  // many cards it holds, which is what lets its empty state say "no matches" instead of "nothing to map".
  it("leaves a section whose search matched nothing one empty page, with the section's own count on the stamped meta", () => {
    const paged = paginate(filterTestColumn(columnModel.available, "nope"), 0, 25);
    const meta: BoardSectionMeta = {
      ...paged.meta,
      total: columnModel.available.length,
      filtering: sectionFiltering("", "nope"),
      query: "nope",
    };

    expect(paged.items).toEqual([]);
    expect(meta).toEqual({ total: 2, filtered: 0, page: 0, pageCount: 1, pageSize: 25, filtering: true, query: "nope" });
  });
});

describe("sectionFiltering", () => {
  it("is false when neither search is set", () => {
    expect(sectionFiltering("", "")).toBe(false);
    expect(sectionFiltering("  ", " ")).toBe(false);
  });

  // The header search narrows every section, so a column that filtered nothing itself still has to say
  // "no matches" rather than "nothing to map".
  it("is true when the header search alone is set", () => {
    expect(sectionFiltering("pay", "")).toBe(true);
  });

  it("is true when the column search alone is set", () => {
    expect(sectionFiltering("", "pay")).toBe(true);
  });

  it("is true when both are set", () => {
    expect(sectionFiltering("pay", "calc")).toBe(true);
  });
});

describe("buildBoardViewModel: matrix rows", () => {
  it("joins a mapped link into requirement, test, scenario, the in-file tag, and its result", () => {
    const model = build(snapshot({ links: [link({ testKey: "CALC-1", reqKeys: ["REQ-7"], lastResult: "passed" })] }));
    expect(model.matrix).toEqual([
      {
        requirement: "REQ-7",
        test: "CALC-1",
        scenario: "Log in",
        tag: "@TEST_CALC-1",
        result: "passed",
        file: "features/login.feature",
        projects: [],
      },
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
      { requirement: "REQ-9", test: "", scenario: "Log in", tag: "", result: "no run", file: "features/login.feature", projects: [] },
    ]);
  });

  it("represents a requirement with no test as an untraced row whose test cell is empty", () => {
    const model = build(snapshot({ untraced: [untraced({ reqKeys: ["REQ-42"] })] }));
    expect(model.matrix[0]).toMatchObject({ requirement: "REQ-42", test: "" });
  });

  it("leaves requirement, scenario, and tag empty for an orphan and marks it 'no coverage'", () => {
    const model = build(snapshot({ orphans: [orphan({ testKey: "CALC-9" })] }));
    expect(model.matrix).toEqual([
      { requirement: "", test: "CALC-9", scenario: "", tag: "", result: "no coverage", file: "", projects: [] },
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

  it("stamps each row with its workspace-relative feature file, leaving an orphan's empty", () => {
    const model = build(
      snapshot({
        links: [link({ scenario: ref({ filePath: "/ws/features/calc.feature" }) })],
        orphans: [orphan({ testKey: "CALC-9" })],
      })
    );
    expect(model.matrix.map((r) => r.file)).toEqual(["features/calc.feature", ""]);
  });
});

function matrixRow(over: Partial<MatrixRow> = {}): MatrixRow {
  return {
    requirement: "",
    test: "",
    scenario: "",
    tag: "",
    result: "no run",
    file: "features/login.feature",
    projects: [],
    ...over,
  };
}

describe("groupMatrixRows", () => {
  it("returns no groups for no rows", () => {
    expect(groupMatrixRows([])).toEqual([]);
  });

  it("returns one group when every row is in the same file", () => {
    const rows = [matrixRow({ test: "CALC-1" }), matrixRow({ test: "CALC-2" })];
    expect(groupMatrixRows(rows)).toEqual([{ file: "features/login.feature", count: 2, rows }]);
  });

  it("folds rows into one group per feature file, counting what each holds", () => {
    const groups = groupMatrixRows([
      matrixRow({ file: "features/calc.feature", test: "CALC-1" }),
      matrixRow({ file: "features/login.feature", test: "AUTH-1" }),
      matrixRow({ file: "features/calc.feature", test: "CALC-2" }),
    ]);
    expect(groups.map((g) => [g.file, g.count])).toEqual([
      ["features/calc.feature", 2],
      ["features/login.feature", 1],
    ]);
    expect(groups[0]!.rows.map((r) => r.test)).toEqual(["CALC-1", "CALC-2"]);
  });

  it("orders groups by file and keeps the given row order inside a group", () => {
    const groups = groupMatrixRows([
      matrixRow({ file: "features/zeta.feature", scenario: "Zed" }),
      matrixRow({ file: "features/alpha.feature", scenario: "Second" }),
      matrixRow({ file: "features/alpha.feature", scenario: "First" }),
    ]);
    expect(groups.map((g) => g.file)).toEqual(["features/alpha.feature", "features/zeta.feature"]);
    expect(groups[0]!.rows.map((r) => r.scenario)).toEqual(["Second", "First"]);
  });

  // The rows with no feature file are the orphan tests, a coverage hole like any other empty cell, so
  // they fold under one group and sort last rather than alphabetically among the files.
  it("groups the rows with no feature file under an empty file, last", () => {
    const groups = groupMatrixRows([
      matrixRow({ file: "", test: "PAY-9", result: "no coverage" }),
      matrixRow({ file: "features/login.feature" }),
      matrixRow({ file: "", test: "PAY-8", result: "no coverage" }),
    ]);
    expect(groups.map((g) => [g.file, g.count])).toEqual([
      ["features/login.feature", 1],
      ["", 2],
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

describe("resolveBoardUnlink", () => {
  const linked = ref({ line: 5, name: "Log in" });
  const snap = snapshot({
    links: [
      link({ testKey: "CALC-1", scenario: linked }),
      link({ testKey: "CALC-2", scenario: linked }),
      link({ testKey: "AUTH-9", scenario: ref({ line: 20, name: "Sign out" }) }),
    ],
  });

  it("resolves a valid pair to the linked scenario's ref and the named key", () => {
    expect(resolveBoardUnlink(snap, scenarioDropId(linked), "CALC-1")).toEqual({ ref: linked, key: "CALC-1" });
  });

  it("resolves each key of a two-link scenario independently", () => {
    expect(resolveBoardUnlink(snap, scenarioDropId(linked), "CALC-2")).toEqual({ ref: linked, key: "CALC-2" });
  });

  it("rejects a stale drop id that matches no live link", () => {
    expect(resolveBoardUnlink(snap, scenarioDropId(ref({ line: 99, name: "Log in" })), "CALC-1")).toBeUndefined();
  });

  it("rejects a key the named scenario is not linked to", () => {
    expect(resolveBoardUnlink(snap, scenarioDropId(linked), "AUTH-9")).toBeUndefined();
  });

  it("rejects any unlink against an undefined snapshot", () => {
    expect(resolveBoardUnlink(undefined, scenarioDropId(linked), "CALC-1")).toBeUndefined();
  });
});

function ledgerEntry(over: Partial<LedgerEntry> = {}): LedgerEntry {
  return {
    artifactId: "run-1",
    executionRef: "XNP-1",
    site: "acme.atlassian.net",
    account: "client-1",
    publishedAt: Date.UTC(2026, 6, 22),
    pendingAttachments: [],
    ...over,
  };
}

describe("buildExecutionRows", () => {
  it("returns no rows for an empty ledger", () => {
    expect(buildExecutionRows([])).toEqual([]);
  });

  it("renders an ambiguous publish as possibly succeeded with its correlation", () => {
    const [row] = buildExecutionRows([{
      kind: "outcome-unknown",
      artifactId: "run-unknown",
      site: "acme.atlassian.net",
      account: "client-1",
      publishedAt: Date.UTC(2026, 6, 22),
      pendingAttachments: [],
      operationId: "publish-unknown",
      mode: "create-new",
    }]);

    expect(row).toMatchObject({
      kind: "unknown",
      keyLabel: "Possibly succeeded",
      summary: "Correlation publish-unknown",
      action: "Outcome unknown",
    });
  });

  it("orders execution parents by their newest activity", () => {
    const rows = buildExecutionRows([
      ledgerEntry({ executionRef: "OLD-1", publishedAt: 1000 }),
      ledgerEntry({ executionRef: "NEW-1", publishedAt: 3000 }),
      ledgerEntry({ executionRef: "MID-1", publishedAt: 2000 }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["NEW-1", "MID-1", "OLD-1"]);
  });

  it("groups activities for the same execution, newest first", () => {
    const rows = buildExecutionRows([
      ledgerEntry({ executionRef: "XNP-1", mode: "create-new", publishedAt: 1000 }),
      ledgerEntry({ executionRef: "PAY-9", mode: "create-new", publishedAt: 2000 }),
      ledgerEntry({ executionRef: "XNP-1", mode: "append", publishedAt: 3000 }),
    ]);

    expect(rows.map((row) => row.key)).toEqual(["XNP-1", "PAY-9"]);
    const [first] = rows;
    expect(first).toMatchObject({ kind: "group", activityCount: 2 });
    expect(first?.kind === "group" ? first.activities.map((activity) => activity.action) : []).toEqual([
      "Appended",
      "Created",
    ]);
  });

  it("renders the pass rate and results imported on the recorded activity", () => {
    const [row] = buildExecutionRows([ledgerEntry({ passed: 3, failed: 1, skipped: 2, total: 6 })]);
    expect(row?.kind === "group" ? row.activities[0] : undefined).toMatchObject({
      passRate: "3/6 passed",
      resultsImported: "6",
    });
  });

  it("renders a plain dash for the rate and imported count when an entry recorded no counts", () => {
    const [row] = buildExecutionRows([ledgerEntry()]);
    expect(row?.kind === "group" ? row.activities[0] : undefined).toMatchObject({
      passRate: "-",
      resultsImported: "-",
    });
  });

  it("shows the imported total but dashes the pass rate when pass/fail/skip fall short of it (timed out or interrupted)", () => {
    // 3 passed + 1 timed-out: passed+failed+skipped is 3, but 4 results were imported; the pass rate
    // cannot be honestly stated, so it dashes while Imported still reports the whole total.
    const [row] = buildExecutionRows([ledgerEntry({ passed: 3, failed: 0, skipped: 0, total: 4 })]);
    expect(row?.kind === "group" ? row.activities[0] : undefined).toMatchObject({
      resultsImported: "4",
      passRate: "-",
    });
  });

  it("maps the activity mode to Created or Appended, dashing an entry with none", () => {
    const rows = buildExecutionRows([
      ledgerEntry({ executionRef: "A-1", publishedAt: 3000, mode: "create-new" }),
      ledgerEntry({ executionRef: "B-1", publishedAt: 2000, mode: "append" }),
      ledgerEntry({ executionRef: "C-1", publishedAt: 1000 }),
    ]);
    expect(rows.map((row) => (row.kind === "group" ? row.activities[0]!.action : row.action))).toEqual([
      "Created",
      "Appended",
      "-",
    ]);
  });

  it("renders a standalone create as Created (empty), dashing the cells it has no counts for", () => {
    const [row] = buildExecutionRows([
      ledgerEntry({ executionRef: "XNP-7", summary: "CALC Test Execution (2026-07-26)", mode: "created-empty" }),
    ]);
    expect(row).toMatchObject({
      kind: "group",
      key: "XNP-7",
      summary: "CALC Test Execution (2026-07-26)",
      activityCount: 1,
      activities: [{ action: "Created (empty)", resultsImported: "-", passRate: "-" }],
    });
  });

  it("carries the summary and latest date on the parent and the date on its child", () => {
    const [row] = buildExecutionRows([ledgerEntry({ summary: "Nightly", publishedAt: Date.UTC(2026, 6, 22) })]);
    expect(row).toMatchObject({
      summary: "Nightly",
      latestPublishedAt: "2026-07-22",
      activities: [{ publishedAt: "2026-07-22" }],
    });
  });

  it("reuses a known execution summary for a newer append parent", () => {
    const rows = buildExecutionRows([
      ledgerEntry({ executionRef: "XNP-7", mode: "append", publishedAt: 3000 }),
      ledgerEntry({ executionRef: "XNP-7", summary: "Nightly regression", mode: "create-new", publishedAt: 2000 }),
    ]);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ summary: "Nightly regression", activityCount: 2 });
  });

  it("uses the newest nonblank summary when the ledger contains more than one", () => {
    const [row] = buildExecutionRows([
      ledgerEntry({ executionRef: "XNP-7", summary: "Current", publishedAt: 3000 }),
      ledgerEntry({ executionRef: "XNP-7", summary: "Older", publishedAt: 2000 }),
    ]);

    expect(row?.summary).toBe("Current");
  });

  it("defaults an absent summary to an empty string", () => {
    expect(buildExecutionRows([ledgerEntry()])[0]!.summary).toBe("");
  });

  it("counts all activities under the execution parent", () => {
    const rows = buildExecutionRows([
      ledgerEntry({ executionRef: "XNP-1", publishedAt: 3000 }),
      ledgerEntry({ executionRef: "XNP-1", publishedAt: 2000 }),
      ledgerEntry({ executionRef: "XNP-9", publishedAt: 1000 }),
    ]);

    expect(rows.map((row) => [row.key, row.activityCount])).toEqual([
      ["XNP-1", 2],
      ["XNP-9", 1],
    ]);
  });

  // An entry whose ref is unknown names no execution, so two of them are two unrelated publishes rather
  // than one execution published to twice.
  it("keeps entries with no execution ref as independent leaves, printing the phrase for each", () => {
    const rows = buildExecutionRows([
      ledgerEntry({ executionRef: "", summary: "First unknown", publishedAt: 2000 }),
      ledgerEntry({ executionRef: "", summary: "Second unknown", publishedAt: 1000 }),
    ]);

    expect(rows.map((row) => row.kind)).toEqual(["unknown", "unknown"]);
    expect(rows.map((row) => row.activityCount)).toEqual([1, 1]);
    expect(rows.map((r) => r.keyLabel)).toEqual([UNKNOWN_EXECUTION, UNKNOWN_EXECUTION]);
    expect(rows.map((r) => r.key)).toEqual(["", ""]);
    expect(rows.map((r) => r.summary)).toEqual(["First unknown", "Second unknown"]);
  });

  it("preserves input order when activities have equal timestamps", () => {
    const [row] = buildExecutionRows([
      ledgerEntry({ executionRef: "XNP-1", mode: "create-new", publishedAt: 1000 }),
      ledgerEntry({ executionRef: "XNP-1", mode: "append", publishedAt: 1000 }),
    ]);

    expect(row?.kind === "group" ? row.activities.map((activity) => activity.action) : []).toEqual([
      "Created",
      "Appended",
    ]);
  });

  it("labels a row that has a reference with the reference itself", () => {
    expect(buildExecutionRows([ledgerEntry({ executionRef: "XNP-1" })])[0]!.keyLabel).toBe("XNP-1");
  });
});

describe("filterExecutionRows", () => {
  const rows = buildExecutionRows([
    ledgerEntry({ executionRef: "XNP-1", summary: "Checkout suite", publishedAt: 3000 }),
    ledgerEntry({ executionRef: "PAY-9", summary: "Payments", publishedAt: 2000 }),
  ]);

  it("returns the rows untouched for an empty query", () => {
    expect(filterExecutionRows(rows, "  ")).toBe(rows);
  });

  it("matches on the execution key", () => {
    expect(filterExecutionRows(rows, "pay").map((r) => r.key)).toEqual(["PAY-9"]);
  });

  it("matches on the summary, case-insensitively", () => {
    expect(filterExecutionRows(rows, "CHECKOUT").map((r) => r.key)).toEqual(["XNP-1"]);
  });

  it("matches child activity text and retains the parent's complete history", () => {
    const grouped = buildExecutionRows([
      ledgerEntry({ executionRef: "XNP-1", mode: "append", publishedAt: 3000 }),
      ledgerEntry({ executionRef: "XNP-1", mode: "create-new", publishedAt: 2000 }),
      ledgerEntry({ executionRef: "PAY-9", mode: "create-new", publishedAt: 1000 }),
    ]);
    const matches = filterExecutionRows(grouped, "appended");

    expect(matches.map((row) => row.key)).toEqual(["XNP-1"]);
    expect(matches[0]).toMatchObject({ kind: "group", activityCount: 2 });
  });

  // The reference is matched AS PRINTED, so the one row the user cannot search by key is still findable
  // by the words on it.
  it("finds a row with no reference by the phrase it displays", () => {
    const withBlank = buildExecutionRows([
      ledgerEntry({ executionRef: "XNP-1", summary: "Checkout suite", publishedAt: 3000 }),
      ledgerEntry({ executionRef: "", summary: "Payments", publishedAt: 1000 }),
    ]);

    expect(filterExecutionRows(withBlank, "no key").map((r) => r.keyLabel)).toEqual([UNKNOWN_EXECUTION]);
  });
});

describe("syncProgressText", () => {
  it("counts a page against the total the remote reported", () => {
    expect(syncProgressText({ projectKey: "APEX", fetched: 100, total: 350 })).toBe("Syncing APEX: 100 of 350 tests");
  });

  it("says only what is in hand when the remote reported no total", () => {
    expect(syncProgressText({ projectKey: "APEX", fetched: 40 })).toBe("Syncing APEX: 40 tests");
  });

  it("agrees with a single test either way", () => {
    expect(syncProgressText({ projectKey: "CALC", fetched: 1, total: 1 })).toBe("Syncing CALC: 1 of 1 test");
    expect(syncProgressText({ projectKey: "CALC", fetched: 1 })).toBe("Syncing CALC: 1 test");
  });
});
