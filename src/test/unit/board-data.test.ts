import { describe, it, expect } from "vitest";
import {
  BoardViewModel,
  buildBoardViewModel,
  buildExecutionRows,
  filterBoardViewModel,
  filterExecutionRows,
  MatrixRow,
  resolveBoardDrop,
  resolveBoardUnlink,
  scenarioDropId,
  scopeBoardViewModel,
} from "../../traceability/board-data";
import { projectFromKey } from "../../xray/xray-adapter";
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
  syncScopeConfigured = true
): BoardViewModel {
  return buildBoardViewModel(snapshot, roots, PREFIX, syncScopeConfigured);
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
    expect(build(undefined, ROOTS)).toMatchObject({ scenarios: [], available: [], mapped: [], matrix: [] });
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
  const loginRow = { name: "Log in", location: "features/login.feature:5", unlinkId: scenarioDropId(ref()) };
  const SCOPE_HINT = "Add project keys to playwrightBddRunner.xray.syncProjectKeys to list available tests.";

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
    const small = examplesBlock(10, "Adding — small");
    const snap = snapshot({
      links: [link({ testKey: "CALC-1", scenario: small }), link({ testKey: "CALC-1", scenario: examplesBlock(15, "Adding — large") })],
    });
    const card = build(snap, ROOTS).mapped[0]!;
    // Each block owns its own tag, so each is its own row and the pill counts what the card lists.
    expect(card.pills).toEqual(["2 scenarios"]);
    expect(card.links.map((row) => row.name)).toEqual(["Adding — large", "Adding — small"]);
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

  it("points the empty available group at the sync scope setting when no project keys are configured, snapshot or not", () => {
    // No sync can help here: completeness never reaches "complete" without a project scope.
    expect(build(undefined, ROOTS, false)).toMatchObject({ availableEmptyText: SCOPE_HINT, offerSync: false });
    expect(build(snapshot({ completeness: "complete" }), ROOTS, false)).toMatchObject({
      availableEmptyText: SCOPE_HINT,
      offerSync: false,
    });
  });

  it("offers a sync when the scope is configured but no complete catalogue has landed", () => {
    const expected = { availableEmptyText: "No synced tests yet.", offerSync: true };
    expect(build(undefined, ROOTS, true)).toMatchObject(expected);
    expect(build(snapshot({ completeness: "partial" }), ROOTS, true)).toMatchObject(expected);
    expect(build(snapshot({ completeness: "unknown" }), ROOTS, true)).toMatchObject(expected);
  });

  it("offers nothing once a complete sync simply turned up no unmapped tests", () => {
    expect(build(snapshot({ completeness: "complete" }), ROOTS, true)).toMatchObject({
      availableEmptyText: "No unmapped tests in the last sync.",
      offerSync: false,
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

  it("passes the available group's empty state through untouched", () => {
    const model = scopedModel();
    const out = scopeBoardViewModel({ ...model, offerSync: true }, "CALC");
    expect(out.available).toEqual([]);
    expect(out.availableEmptyText).toBe(model.availableEmptyText);
    expect(out.offerSync).toBe(true);
  });
});

describe("filterBoardViewModel", () => {
  const model: BoardViewModel = {
    scenarios: [
      { name: "Log in", location: "features/login.feature:5", dropId: "id-login", pills: ["no tag"], reqKeys: ["REQ-7"] },
      { name: "Checkout", location: "features/cart.feature:12", dropId: "id-checkout", pills: ["no tag"], reqKeys: [] },
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
      { requirement: "REQ-7", test: "CALC-1", scenario: "Log in", tag: "@TEST_CALC-1", result: "passed", projects: ["CALC"] },
      { requirement: "", test: "PAY-9", scenario: "", tag: "", result: "no coverage", projects: ["PAY"] },
    ],
    availableEmptyText: "No unmapped tests in the last sync.",
    offerSync: false,
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
    expect(out.offerSync).toBe(false);
    expect(filterBoardViewModel({ ...model, offerSync: true }, "calc-1").offerSync).toBe(true);
  });
});

describe("buildBoardViewModel — matrix rows", () => {
  it("joins a mapped link into requirement, test, scenario, the in-file tag, and its result", () => {
    const model = build(snapshot({ links: [link({ testKey: "CALC-1", reqKeys: ["REQ-7"], lastResult: "passed" })] }));
    expect(model.matrix).toEqual([
      { requirement: "REQ-7", test: "CALC-1", scenario: "Log in", tag: "@TEST_CALC-1", result: "passed", projects: [] },
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
      { requirement: "REQ-9", test: "", scenario: "Log in", tag: "", result: "no run", projects: [] },
    ]);
  });

  it("represents a requirement with no test as an untraced row whose test cell is empty", () => {
    const model = build(snapshot({ untraced: [untraced({ reqKeys: ["REQ-42"] })] }));
    expect(model.matrix[0]).toMatchObject({ requirement: "REQ-42", test: "" });
  });

  it("leaves requirement, scenario, and tag empty for an orphan and marks it 'no coverage'", () => {
    const model = build(snapshot({ orphans: [orphan({ testKey: "CALC-9" })] }));
    expect(model.matrix).toEqual([
      { requirement: "", test: "CALC-9", scenario: "", tag: "", result: "no coverage", projects: [] },
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

  it("orders rows newest first by published time", () => {
    const rows = buildExecutionRows([
      ledgerEntry({ executionRef: "OLD-1", publishedAt: 1000 }),
      ledgerEntry({ executionRef: "NEW-1", publishedAt: 3000 }),
      ledgerEntry({ executionRef: "MID-1", publishedAt: 2000 }),
    ]);
    expect(rows.map((r) => r.key)).toEqual(["NEW-1", "MID-1", "OLD-1"]);
  });

  it("renders the pass rate and results imported from the recorded counts and total", () => {
    const [row] = buildExecutionRows([ledgerEntry({ passed: 3, failed: 1, skipped: 2, total: 6 })]);
    expect(row).toMatchObject({ passRate: "3/6 passed", resultsImported: "6" });
  });

  it("renders a plain dash for the rate and imported count when an entry recorded no counts", () => {
    const [row] = buildExecutionRows([ledgerEntry()]);
    expect(row).toMatchObject({ passRate: "-", resultsImported: "-" });
  });

  it("shows the imported total but dashes the pass rate when pass/fail/skip fall short of it (timed out or interrupted)", () => {
    // 3 passed + 1 timed-out: passed+failed+skipped is 3, but 4 results were imported — the pass rate
    // cannot be honestly stated, so it dashes while Imported still reports the whole total.
    const [row] = buildExecutionRows([ledgerEntry({ passed: 3, failed: 0, skipped: 0, total: 4 })]);
    expect(row).toMatchObject({ resultsImported: "4", passRate: "-" });
  });

  it("maps the publish mode to a Created or Appended action, dashing an entry with none", () => {
    const rows = buildExecutionRows([
      ledgerEntry({ executionRef: "A-1", publishedAt: 3000, mode: "create-new" }),
      ledgerEntry({ executionRef: "B-1", publishedAt: 2000, mode: "append" }),
      ledgerEntry({ executionRef: "C-1", publishedAt: 1000 }),
    ]);
    expect(rows.map((r) => r.action)).toEqual(["Created", "Appended", "-"]);
  });

  it("carries the summary and renders the published date as an ISO day", () => {
    const [row] = buildExecutionRows([ledgerEntry({ summary: "Nightly", publishedAt: Date.UTC(2026, 6, 22) })]);
    expect(row).toMatchObject({ summary: "Nightly", publishedAt: "2026-07-22" });
  });

  it("defaults an absent summary to an empty string", () => {
    expect(buildExecutionRows([ledgerEntry()])[0]!.summary).toBe("");
  });

  it("counts how many entries published to the same execution key", () => {
    const rows = buildExecutionRows([
      ledgerEntry({ executionRef: "XNP-1", publishedAt: 3000 }),
      ledgerEntry({ executionRef: "XNP-1", publishedAt: 2000 }),
      ledgerEntry({ executionRef: "XNP-9", publishedAt: 1000 }),
    ]);
    expect(rows.map((r) => [r.key, r.timesFromHere])).toEqual([
      ["XNP-1", 2],
      ["XNP-1", 2],
      ["XNP-9", 1],
    ]);
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
});
