import { describe, it, expect } from "vitest";
import {
  BoardViewModel,
  buildBoardViewModel,
  buildExecutionRows,
  filterBoardViewModel,
  filterExecutionRows,
  resolveBoardDrop,
  resolveBoardUnlink,
  scenarioDropId,
} from "../../traceability/board-data";
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

function build(snapshot: TraceabilitySnapshot | undefined, roots: readonly string[] = ROOTS): BoardViewModel {
  return buildBoardViewModel(snapshot, roots, PREFIX);
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
  const loginRow = { name: "Log in", location: "features/login.feature:5", unlinkId: scenarioDropId(ref()) };

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
    expect(model.tests).toEqual([
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
    expect(model.tests[0]!.pills).toEqual(["1 scenario"]);
  });

  it("gives a scenario linked to two tests its own row on each card", () => {
    const model = build(
      snapshot({ links: [link({ testKey: "CALC-1" }), link({ testKey: "CALC-2" })] }),
      ROOTS
    );
    expect(model.tests.map((card) => card.links)).toEqual([[loginRow], [loginRow]]);
  });

  it("keeps one row per Examples block, counts them all in the pill, and unlinks each back to its block", () => {
    const small = examplesBlock(10, "Adding — small");
    const snap = snapshot({
      links: [link({ testKey: "CALC-1", scenario: small }), link({ testKey: "CALC-1", scenario: examplesBlock(15, "Adding — large") })],
    });
    const card = build(snap, ROOTS).tests[0]!;
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
    const card = build(snap, ROOTS).tests[0]!;
    expect(card.links.map((row) => row.location)).toEqual(["features/calc.feature:10", "features/calc.feature:15"]);
    expect(resolveBoardUnlink(snap, card.links[0]!.unlinkId, "CALC-1")).toEqual({ ref: first, key: "CALC-1" });
    expect(resolveBoardUnlink(snap, card.links[1]!.unlinkId, "CALC-1")).toEqual({ ref: second, key: "CALC-1" });
  });

  it("shows the remote summary on a mapped card when the link carries metadata", () => {
    const model = build(
      snapshot({ links: [link({ meta: { key: "CALC-1", summary: "Add two numbers" } })] }),
      ROOTS
    );
    expect(model.tests[0]).toEqual({ key: "CALC-1", summary: "Add two numbers", pills: ["1 scenario"], links: [loginRow] });
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
    expect(model.tests).toEqual([{ key: "CALC-9", summary: "Stray", pills: ["orphan"], links: [] }]);
  });

  it("omits the summary on an orphan with none and gives it no rows", () => {
    const model = build(snapshot({ orphans: [orphan()] }), ROOTS);
    expect(model.tests[0]).toEqual({ key: "CALC-9", pills: ["orphan"], links: [] });
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
      {
        key: "CALC-1",
        summary: "Add two numbers",
        pills: ["2 scenarios"],
        links: [
          { name: "Add large numbers", location: "features/calc.feature:9", unlinkId: "id-add-large" },
          { name: "Add small numbers", location: "features/calc.feature:3", unlinkId: "id-add-small" },
        ],
      },
      { key: "PAY-9", pills: ["orphan"], links: [] },
    ],
    matrix: [
      { requirement: "REQ-7", test: "CALC-1", scenario: "Log in", tag: "@TEST_CALC-1", result: "passed" },
      { requirement: "", test: "PAY-9", scenario: "", tag: "", result: "no coverage" },
    ],
  };

  it("returns the model untouched for an empty query", () => {
    expect(filterBoardViewModel(model, "   ")).toBe(model);
  });

  it("matches a test through a linked scenario's name and keeps all of that card's rows", () => {
    const out = filterBoardViewModel(model, "add small");
    expect(out.tests.map((t) => t.key)).toEqual(["CALC-1"]);
    expect(out.tests[0]!.links.map((row) => row.name)).toEqual(["Add large numbers", "Add small numbers"]);
  });

  it("matches a test through a linked scenario's location", () => {
    expect(filterBoardViewModel(model, "calc.feature").tests.map((t) => t.key)).toEqual(["CALC-1"]);
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
