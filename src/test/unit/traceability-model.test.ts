import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import * as vscode from "vscode";
import { FeatureParser } from "../../parsers/feature-parser";
import { scenarioGherkinSlice } from "../../parsers/gherkin-slice";
import { TestDiscoveryManager } from "../../core/test-discovery-manager";
import { Logger } from "../../utils/logger";
import { normalizePathKey, PlaywrightJsonParser, ScenarioStatus } from "../../utils/playwright-json-parser";
import {
  buildTraceabilitySnapshot,
  findPlaywrightReport,
  linkedTestsForScenario,
  ParsedFeatureInput,
  ScenarioRef,
  TraceabilityModel,
  TraceLink,
} from "../../traceability/traceability-model";
import { RunResultStore } from "../../traceability/run-result-store";
import { RemoteMetadataSnapshot, TestCaseMetadata, TraceabilityAdapter } from "../../traceability/contracts";
import { JIRA_KEY_SHAPE, projectFromKey } from "../../xray/xray-adapter";

function remoteSnapshot(
  tests: readonly TestCaseMetadata[],
  overrides: Partial<RemoteMetadataSnapshot> = {}
): RemoteMetadataSnapshot {
  return {
    tests: new Map(tests.map((test) => [test.key, test])),
    fetchedScopes: ["CALC"],
    catalogueProjects: ["CALC"],
    verifiedAbsentKeys: [],
    syncedAt: 1_700_000_000_000,
    stale: false,
    completeness: "complete",
    errors: [],
    ...overrides,
  };
}

const upper = (key: string): string => key.toUpperCase();
const GRAMMAR = { testPrefix: "TEST_", reqPrefix: "REQ_", keyShape: JIRA_KEY_SHAPE, canonicalizeKey: upper, projectOf: projectFromKey };
const FILE = "/ws/calc.feature";

const FEATURE = `Feature: Calc

@TEST_CALC-1043 @REQ_CALC-900
Scenario: Divide by zero
  Given a calculator

Scenario: Untagged thing
  Given x

@TEST_CALC-1051
Scenario Outline: Multiply values
  When I multiply <a> by <b>
  Then the result is <r>
  Examples:
    | a | b | r |
    | 2 | 3 | 6 |

  @TEST_CALC-1052
  Examples: edge cases
    | a | b | r |
    | 0 | 9 | 0 |
`;

function parse(content: string, filePath = FILE): ParsedFeatureInput {
  const parsed = FeatureParser.create().parseFeatureContent(content);
  return { filePath, scenarios: parsed?.scenarios ?? [] };
}

function link(links: TraceLink[], testKey: string): TraceLink {
  const found = links.find((l) => l.testKey === testKey);
  if (!found) {throw new Error(`no link for ${testKey}`);}
  return found;
}

describe("buildTraceabilitySnapshot", () => {
  it("maps scenarios to test keys, derives projects, and carries requirement keys", () => {
    const snap = buildTraceabilitySnapshot([parse(FEATURE)], {}, GRAMMAR);

    expect(snap.links.map((l) => l.testKey).sort()).toEqual(["CALC-1043", "CALC-1051", "CALC-1052"]);
    const divide = link(snap.links, "CALC-1043");
    expect(divide.project).toBe("CALC");
    expect(divide.reqKeys).toEqual(["CALC-900"]);
    expect(divide.scenario.kind).toBe("scenario");
    expect(divide.scenario.name).toBe("Divide by zero");
    expect(divide.scenario.line).toBe(4);
  });

  it("leaves project undefined when the grammar has no projectOf", () => {
    const { projectOf: _drop, ...noProject } = GRAMMAR;
    const snap = buildTraceabilitySnapshot([parse(FEATURE)], {}, noProject);
    expect(link(snap.links, "CALC-1043").project).toBeUndefined();
  });

  it("buckets scenarios with no @TEST_ tag as untraced", () => {
    const snap = buildTraceabilitySnapshot([parse(FEATURE)], {}, GRAMMAR);
    expect(snap.untraced.map((u) => u.scenario.name)).toEqual(["Untagged thing"]);
    expect(snap.untraced[0]!.scenario.line).toBe(7);
    expect(snap.untraced[0]!.malformedTags).toEqual([]);
  });

  it("carries a broken test tag on the untraced scenario so preflight can tell it from an untagged one", () => {
    const content = `Feature: Calc

@TEST_notakey
Scenario: Broken mapping
  Given x
`;
    const snap = buildTraceabilitySnapshot([parse(content)], {}, GRAMMAR);
    expect(snap.links).toEqual([]);
    expect(snap.untraced).toHaveLength(1);
    expect(snap.untraced[0]!.malformedTags).toEqual(["@TEST_notakey"]);
  });

  it("groups an outline under one test key and splits a tagged Examples block into its own", () => {
    const snap = buildTraceabilitySnapshot([parse(FEATURE)], {}, GRAMMAR);

    const outline = link(snap.links, "CALC-1051");
    expect(outline.scenario.kind).toBe("outline");
    expect(outline.scenario.name).toBe("Multiply values");
    expect(outline.scenario.line).toBe(11);

    const block = link(snap.links, "CALC-1052");
    expect(block.scenario.kind).toBe("examplesBlock");
    expect(block.scenario.examplesBlockName).toBe("edge cases");
    expect(block.scenario.line).toBe(19);
  });

  it("orphans are always empty offline (no metadata provider)", () => {
    const snap = buildTraceabilitySnapshot([parse(FEATURE)], {}, GRAMMAR);
    expect(snap.orphans).toEqual([]);
    expect(snap.stale).toBe(false);
  });

  it("merges run-result badges from the status map (worst-wins across outline rows)", () => {
    const key = normalizePathKey(FILE);
    const statusMap: Record<string, ScenarioStatus> = {
      [`${key}:4`]: "passed", // Divide by zero
      [`${key}:16`]: "failed", // first Examples row of the outline
    };
    const snap = buildTraceabilitySnapshot([parse(FEATURE)], statusMap, GRAMMAR);

    expect(link(snap.links, "CALC-1043").lastResult).toBe("passed");
    expect(link(snap.links, "CALC-1051").lastResult).toBe("failed");
    expect(link(snap.links, "CALC-1052").lastResult).toBeUndefined();
  });

  it("keeps the mapping stable when a scenario is renamed (keys come from tags)", () => {
    const renamed = FEATURE.replace("Scenario: Divide by zero", "Scenario: Division guard");
    const snap = buildTraceabilitySnapshot([parse(renamed)], {}, GRAMMAR);
    const divide = link(snap.links, "CALC-1043");
    expect(divide.scenario.name).toBe("Division guard");
    expect(divide.testKey).toBe("CALC-1043");
  });

  it("uses configurable prefixes", () => {
    const content = `Feature: F

@xt-AB-1
Scenario: A
  Given x
`;
    const snap = buildTraceabilitySnapshot(
      [parse(content)],
      {},
      { testPrefix: "xt-", reqPrefix: "cov-", keyShape: JIRA_KEY_SHAPE, canonicalizeKey: upper, projectOf: projectFromKey }
    );
    expect(snap.links.map((l) => l.testKey)).toEqual(["AB-1"]);
  });

  it("keeps other blocks' rows covered when a @TEST_ sits on both the outline and the first block", () => {
    const content = `Feature: F

@TEST_CALC-1
Scenario Outline: O
  When step <a>

  @TEST_CALC-1
  Examples: first
    | a |
    | 1 |

  Examples: second
    | a |
    | 2 |
`;
    const snap = buildTraceabilitySnapshot([parse(content)], {}, GRAMMAR);
    // The second block's row must map to the outline-level test, not fall into the gap bucket.
    expect(snap.untraced).toEqual([]);
    const outlineLevel = snap.links.filter((l) => l.scenario.kind === "outline");
    expect(outlineLevel.map((l) => l.testKey)).toEqual(["CALC-1"]);
    expect(snap.links.some((l) => l.testKey === "CALC-1" && l.scenario.kind === "examplesBlock")).toBe(true);
  });

  it("matches outline-row badges via the substituted title when the outline title has placeholders", () => {
    const content = `Feature: F

@TEST_MUL-1
Scenario Outline: multiply <a> by <b>
  When x

  Examples:
    | a | b |
    | 2 | 3 |
`;
    const key = normalizePathKey(FILE);
    const statusMap: Record<string, ScenarioStatus> = { [`${key}::multiply 2 by 3`]: "passed" };
    const snap = buildTraceabilitySnapshot([parse(content)], statusMap, GRAMMAR);
    expect(link(snap.links, "MUL-1").lastResult).toBe("passed");
  });

  it("slots cached metadata and orphans through the remote-snapshot seam on a complete fetch", () => {
    const remote = remoteSnapshot([
      { key: "CALC-1043", summary: "Divide by zero", status: { category: "passed", providerValue: "PASS" } },
      { key: "CALC-9999", summary: "Ghost test" },
    ]);
    const snap = buildTraceabilitySnapshot([parse(FEATURE)], {}, GRAMMAR, remote);

    expect(link(snap.links, "CALC-1043").meta?.summary).toBe("Divide by zero");
    expect(link(snap.links, "CALC-1043").meta?.status?.category).toBe("passed");
    expect(link(snap.links, "CALC-1051").meta).toBeUndefined();
    expect(snap.orphans).toEqual([{ testKey: "CALC-9999", meta: { key: "CALC-9999", summary: "Ghost test" } }]);
    expect(snap.completeness).toBe("complete");
    expect(snap.syncedAt).toBe(1_700_000_000_000);
  });

  it("suppresses orphans and carries completeness when the remote fetch is partial", () => {
    const remote = remoteSnapshot(
      [
        { key: "CALC-1043", summary: "Divide by zero" },
        { key: "CALC-9999", summary: "Ghost test" },
      ],
      { completeness: "partial" }
    );
    const snap = buildTraceabilitySnapshot([parse(FEATURE)], {}, GRAMMAR, remote);

    expect(link(snap.links, "CALC-1043").meta?.summary).toBe("Divide by zero");
    expect(snap.orphans).toEqual([]);
    expect(snap.completeness).toBe("partial");
  });

  it("surfaces sync errors on the snapshot without deriving orphans", () => {
    const remote = remoteSnapshot([{ key: "CALC-9999", summary: "Ghost test" }], {
      completeness: "unknown",
      errors: ["fetch failed"],
    });
    const snap = buildTraceabilitySnapshot([parse(FEATURE)], {}, GRAMMAR, remote);

    expect(snap.orphans).toEqual([]);
    expect(snap.errors).toEqual(["fetch failed"]);
  });

  it("flags drift when the snapshot's stored gherkin differs from the local scenario", () => {
    const remote = remoteSnapshot([
      { key: "CALC-1043", gherkin: "Scenario: Divide by zero\n  Given a DIFFERENT calculator" },
    ]);
    const snap = buildTraceabilitySnapshot([parse(FEATURE)], {}, GRAMMAR, remote);
    expect(link(snap.links, "CALC-1043").drift).toBe(true);
  });

  it("does not flag drift when stored gherkin matches after normalizing whitespace/line endings", () => {
    const remote = remoteSnapshot([
      { key: "CALC-1043", gherkin: "Scenario: Divide by zero\r\n  Given a calculator   " },
    ]);
    const snap = buildTraceabilitySnapshot([parse(FEATURE)], {}, GRAMMAR, remote);
    expect(link(snap.links, "CALC-1043").drift).toBeUndefined();
  });

  it("leaves drift unset when the snapshot carries no stored gherkin", () => {
    const remote = remoteSnapshot([{ key: "CALC-1043", summary: "Divide by zero" }]);
    const snap = buildTraceabilitySnapshot([parse(FEATURE)], {}, GRAMMAR, remote);
    expect(link(snap.links, "CALC-1043").drift).toBeUndefined();
  });

  it("does not flag drift for an indentation-only difference", () => {
    const remote = remoteSnapshot([
      { key: "CALC-1043", gherkin: "    Scenario: Divide by zero\n        Given a calculator" },
    ]);
    const snap = buildTraceabilitySnapshot([parse(FEATURE)], {}, GRAMMAR, remote);
    expect(link(snap.links, "CALC-1043").drift).toBeUndefined();
  });

  // The badge and the push must compare ONE text: the scenario's verbatim slice, Examples tables and
  // all. A reconstruction from parsed steps would leave every outline permanently drifted, so a push
  // could never clear the badge no matter how many times it ran.
  it("compares an outline against its verbatim slice, tables included, so a matching remote is not drifted", () => {
    const outlineSlice = OUTLINE_SLICE;
    const matching = remoteSnapshot([{ key: "CALC-1051", gherkin: outlineSlice }]);
    const stripped = remoteSnapshot([
      { key: "CALC-1051", gherkin: "Scenario Outline: Multiply values\n  When I multiply <a> by <b>\n  Then the result is <r>" },
    ]);

    expect(link(buildTraceabilitySnapshot([parse(FEATURE)], {}, GRAMMAR, matching).links, "CALC-1051").drift).toBeUndefined();
    expect(link(buildTraceabilitySnapshot([parse(FEATURE)], {}, GRAMMAR, stripped).links, "CALC-1051").drift).toBe(true);
  });

  it("clears the outline's badge once the baseline refreshed to the text a push sent", () => {
    const drifted = remoteSnapshot([{ key: "CALC-1051", gherkin: "Scenario Outline: Multiply values\n  When I multiply <a> by <b>" }]);
    expect(link(buildTraceabilitySnapshot([parse(FEATURE)], {}, GRAMMAR, drifted).links, "CALC-1051").drift).toBe(true);

    // What `mergeKeys` brings back after the push: the remote now holds exactly what was sent.
    const refreshed = remoteSnapshot([{ key: "CALC-1051", gherkin: pushedText(FEATURE, "CALC-1051") }]);

    expect(link(buildTraceabilitySnapshot([parse(FEATURE)], {}, GRAMMAR, refreshed).links, "CALC-1051").drift).toBeUndefined();
  });
});

// The outline block of FEATURE, exactly as the push would send it (its keyword line through its last
// Examples row, tagged blocks included).
const OUTLINE_SLICE = [
  "Scenario Outline: Multiply values",
  "  When I multiply <a> by <b>",
  "  Then the result is <r>",
  "  Examples:",
  "    | a | b | r |",
  "    | 2 | 3 | 6 |",
  "",
  "  @TEST_CALC-1052",
  "  Examples: edge cases",
  "    | a | b | r |",
  "    | 0 | 9 | 0 |",
].join("\n");

// The text a push of `testKey` sends: the same slice the parser stamped on the linked scenario, read
// back through the model rather than restated, so this can never drift from the production path.
function pushedText(feature: string, testKey: string): string {
  const scenarios = parse(feature).scenarios;
  const snap = buildTraceabilitySnapshot([{ filePath: FILE, scenarios }], {}, GRAMMAR);
  const ref = link(snap.links, testKey).scenario;
  return scenarioGherkinSlice(feature.split("\n"), ref.line);
}

const DEMO_FEATURE = `Feature: Demo

@TEST_DEMO-404
Scenario: Bogus tag
  Given x
`;

describe("buildTraceabilitySnapshot — remote-absence verdict", () => {
  it("flags a key provably absent from a complete catalogue covering its project", () => {
    const remote = remoteSnapshot([], { completeness: "complete", catalogueProjects: ["CALC"] });
    const snap = buildTraceabilitySnapshot([parse(FEATURE)], {}, GRAMMAR, remote);
    expect(link(snap.links, "CALC-1043").remoteMissing).toBe(true);
  });

  it("does not flag absence on a partial snapshot", () => {
    const remote = remoteSnapshot([], { completeness: "partial", catalogueProjects: ["CALC"] });
    const snap = buildTraceabilitySnapshot([parse(FEATURE)], {}, GRAMMAR, remote);
    expect(link(snap.links, "CALC-1043").remoteMissing).toBeUndefined();
  });

  it("does not flag absence on an unknown snapshot", () => {
    const remote = remoteSnapshot([], { completeness: "unknown", catalogueProjects: ["CALC"] });
    const snap = buildTraceabilitySnapshot([parse(FEATURE)], {}, GRAMMAR, remote);
    expect(link(snap.links, "CALC-1043").remoteMissing).toBeUndefined();
  });

  it("does not flag a key whose project was outside the fetched catalogue scope", () => {
    const remote = remoteSnapshot([], { completeness: "complete", catalogueProjects: ["MATH"] });
    const snap = buildTraceabilitySnapshot([parse(FEATURE)], {}, GRAMMAR, remote);
    expect(link(snap.links, "CALC-1043").remoteMissing).toBeUndefined();
  });

  it("leaves the verdict unset when the key is present in the catalogue", () => {
    const remote = remoteSnapshot([{ key: "CALC-1043", summary: "Divide by zero" }], {
      completeness: "complete",
      catalogueProjects: ["CALC"],
    });
    const snap = buildTraceabilitySnapshot([parse(FEATURE)], {}, GRAMMAR, remote);
    expect(link(snap.links, "CALC-1043").remoteMissing).toBeUndefined();
  });

  it("matches the catalogue project case-insensitively", () => {
    const remote = remoteSnapshot([], { completeness: "complete", catalogueProjects: ["calc"] });
    const snap = buildTraceabilitySnapshot([parse(FEATURE)], {}, GRAMMAR, remote);
    expect(link(snap.links, "CALC-1043").remoteMissing).toBe(true);
  });

  it("never flags absence when the grammar cannot derive a project", () => {
    const { projectOf: _drop, ...noProject } = GRAMMAR;
    const remote = remoteSnapshot([], { completeness: "complete", catalogueProjects: ["CALC"] });
    const snap = buildTraceabilitySnapshot([parse(FEATURE)], {}, noProject, remote);
    expect(link(snap.links, "CALC-1043").remoteMissing).toBeUndefined();
  });

  it("flags a key a successful batch verified absent even outside the catalogue scope (DEMO repro)", () => {
    const remote = remoteSnapshot([], {
      completeness: "partial",
      catalogueProjects: ["CALC"],
      verifiedAbsentKeys: ["DEMO-404"],
    });
    const snap = buildTraceabilitySnapshot([parse(DEMO_FEATURE)], {}, GRAMMAR, remote);
    expect(link(snap.links, "DEMO-404").remoteMissing).toBe(true);
  });

  it("lets metadata win over a verified-absent listing", () => {
    const remote = remoteSnapshot([{ key: "DEMO-404", summary: "actually here" }], {
      completeness: "partial",
      catalogueProjects: ["CALC"],
      verifiedAbsentKeys: ["DEMO-404"],
    });
    const snap = buildTraceabilitySnapshot([parse(DEMO_FEATURE)], {}, GRAMMAR, remote);
    expect(link(snap.links, "DEMO-404").remoteMissing).toBeUndefined();
    expect(link(snap.links, "DEMO-404").meta?.summary).toBe("actually here");
  });

  it("matches a verified-absent key case-insensitively", () => {
    const remote = remoteSnapshot([], {
      completeness: "unknown",
      catalogueProjects: [],
      verifiedAbsentKeys: ["demo-404"],
    });
    const snap = buildTraceabilitySnapshot([parse(DEMO_FEATURE)], {}, GRAMMAR, remote);
    expect(link(snap.links, "DEMO-404").remoteMissing).toBe(true);
  });
});

const OUTLINE_FEATURE = `Feature: F

@TEST_MUL-1
Scenario Outline: multiply
  When I multiply <a> by <b>
  Then the result is <r>
  Examples:
    | a | b | r  |
    | 2 | 3 | 6  |
    | 4 | 5 | 20 |
    | 6 | 7 | 42 |
`;

describe("buildTraceabilitySnapshot — N/M outline iterations", () => {
  const K = normalizePathKey(FILE);

  it("counts passed-of-total across a mixed run (some passed, some failed, some skipped)", () => {
    const statusMap: Record<string, ScenarioStatus> = {
      [`${K}:9`]: "passed",
      [`${K}:10`]: "failed",
      [`${K}:11`]: "skipped",
    };
    const snap = buildTraceabilitySnapshot([parse(OUTLINE_FEATURE)], statusMap, GRAMMAR);
    const outline = link(snap.links, "MUL-1");
    expect(outline.iterations).toEqual({ passed: 1, total: 3 });
    expect(outline.lastResult).toBe("failed");
  });

  it("counts a flaky-then-passed row as passed (the parser already collapsed the retry)", () => {
    const statusMap: Record<string, ScenarioStatus> = {
      [`${K}:9`]: "passed",
      [`${K}:10`]: "passed",
      [`${K}:11`]: "passed",
    };
    const outline = link(buildTraceabilitySnapshot([parse(OUTLINE_FEATURE)], statusMap, GRAMMAR).links, "MUL-1");
    expect(outline.iterations).toEqual({ passed: 3, total: 3 });
  });

  it("only counts iterations that actually ran on a partial run", () => {
    const statusMap: Record<string, ScenarioStatus> = { [`${K}:9`]: "passed" };
    const outline = link(buildTraceabilitySnapshot([parse(OUTLINE_FEATURE)], statusMap, GRAMMAR).links, "MUL-1");
    expect(outline.iterations).toEqual({ passed: 1, total: 1 });
  });

  it("leaves iterations undefined when no row has a result", () => {
    const outline = link(buildTraceabilitySnapshot([parse(OUTLINE_FEATURE)], {}, GRAMMAR).links, "MUL-1");
    expect(outline.iterations).toBeUndefined();
  });

  it("derives iterations per split Examples block independently", () => {
    const key = normalizePathKey(FILE);
    const statusMap: Record<string, ScenarioStatus> = {
      [`${key}:16`]: "passed", // outline-level Examples row
      [`${key}:21`]: "failed", // split @TEST_CALC-1052 block row
    };
    const snap = buildTraceabilitySnapshot([parse(FEATURE)], statusMap, GRAMMAR);
    expect(link(snap.links, "CALC-1051").iterations).toEqual({ passed: 1, total: 1 });
    expect(link(snap.links, "CALC-1052").iterations).toEqual({ passed: 0, total: 1 });
  });

  it("leaves plain (non-outline) scenario links with no iterations", () => {
    const snap = buildTraceabilitySnapshot([parse(FEATURE)], { [`${K}:4`]: "passed" }, GRAMMAR);
    expect(link(snap.links, "CALC-1043").iterations).toBeUndefined();
  });
});

describe("TraceabilityModel.rebuild badge precedence (readStatusMap)", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* ignore */ }
    }
    dirs.length = 0;
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  const FEATURE_SRC = "Feature: Calc\n\n@TEST_CALC-1\nScenario: A\n  Given x\n";

  function makeWorkspace(): { root: string; featurePath: string; key: string } {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "xray-badge-"));
    dirs.push(root);
    const featurePath = path.join(root, "calc.feature");
    fs.writeFileSync(featurePath, FEATURE_SRC, "utf8");
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: vscode.Uri.file(root) }];
    return { root, featurePath, key: `${normalizePathKey(featurePath)}:4` };
  }

  function writeReport(root: string, featurePath: string, status: ScenarioStatus, mtimeMs: number): void {
    const report = {
      config: { rootDir: root },
      suites: [
        {
          specs: [
            {
              title: "A",
              file: "calc.feature",
              line: 4,
              tests: [{ annotations: [{ type: `${featurePath}:4` }], results: [{ status }] }],
            },
          ],
        },
      ],
    };
    const full = path.join(root, "results.json");
    fs.writeFileSync(full, JSON.stringify(report), "utf8");
    fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
  }

  async function rebuiltResult(featurePath: string, store: RunResultStore): Promise<RunOutcomeOf> {
    const logger = Logger.create();
    const discovery = {
      discoverTestFiles: () => Promise.resolve([featurePath]),
      dispose: () => { /* no-op */ },
    } as unknown as TestDiscoveryManager;
    const adapter = {
      id: "xray",
      label: "Xray",
      keyGrammar: GRAMMAR,
      browseUrl: () => undefined,
    } as unknown as TraceabilityAdapter;
    const model = new TraceabilityModel(
      FeatureParser.create(logger),
      discovery,
      PlaywrightJsonParser.create(logger),
      adapter,
      store,
      logger
    );
    await model.rebuild();
    const result = model.snapshot.links.find((l) => l.testKey === "CALC-1")?.lastResult;
    model.dispose();
    return result;
  }

  type RunOutcomeOf = ScenarioStatus | undefined;

  it("store outcome wins when it was ingested after the report's mtime", async () => {
    const { root, featurePath, key } = makeWorkspace();
    writeReport(root, featurePath, "failed", Date.now() - 100_000);
    const store = new RunResultStore();
    store.ingest({ [key]: "passed" });
    expect(await rebuiltResult(featurePath, store)).toBe("passed");
  });

  it("scan outcome wins when the report is newer than the last ingest", async () => {
    const { root, featurePath, key } = makeWorkspace();
    const store = new RunResultStore();
    store.ingest({ [key]: "failed" });
    writeReport(root, featurePath, "passed", Date.now() + 100_000);
    expect(await rebuiltResult(featurePath, store)).toBe("passed");
  });

  it("badges from the store with no report on disk (the P1 exit criterion)", async () => {
    const { featurePath, key } = makeWorkspace();
    const store = new RunResultStore();
    store.ingest({ [key]: "passed" });
    expect(await rebuiltResult(featurePath, store)).toBe("passed");
  });

  it("badges from the scan when the store was never fed", async () => {
    const { root, featurePath } = makeWorkspace();
    writeReport(root, featurePath, "failed", Date.now());
    expect(await rebuiltResult(featurePath, new RunResultStore())).toBe("failed");
  });
});

describe("findPlaywrightReport", () => {
  const dirs: string[] = [];

  afterEach(() => {
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        /* ignore */
      }
    }
    dirs.length = 0;
  });

  function makeRoot(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "xray-report-"));
    dirs.push(dir);
    return dir;
  }

  function writeReport(root: string, rel: string, contents: string, mtimeMs: number): void {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, contents, "utf8");
    fs.utimesSync(full, new Date(mtimeMs), new Date(mtimeMs));
  }

  it("returns the newest report across candidate locations", async () => {
    const root = makeRoot();
    writeReport(root, "results.json", "{}", Date.now() - 10_000);
    writeReport(root, "test-results/results.json", "{}", Date.now());
    const found = await findPlaywrightReport([root]);
    expect(found?.path).toBe(path.join(root, "test-results/results.json"));
    expect(found?.root).toBe(root);
  });

  it("propagates the winning root across multiple roots", async () => {
    const older = makeRoot();
    const newer = makeRoot();
    writeReport(older, "results.json", "{}", Date.now() - 10_000);
    writeReport(newer, "results.json", "{}", Date.now());
    const found = await findPlaywrightReport([older, newer]);
    expect(found?.root).toBe(newer);
  });

  it("returns undefined when no report exists", async () => {
    expect(await findPlaywrightReport([makeRoot()])).toBeUndefined();
  });

  it("yields no badges and does not throw on a malformed report", async () => {
    const root = makeRoot();
    writeReport(root, "results.json", "{ not valid json", Date.now());
    const found = await findPlaywrightReport([root]);
    const parser = PlaywrightJsonParser.create(Logger.create());
    const results = parser.parseFromFile(found!.path);
    expect(results).toEqual([]);
    expect(parser.toStatusMap(results, found!.root)).toEqual({});
  });
});

describe("linkedTestsForScenario", () => {
  const ref = (line: number, name: string): ScenarioRef => ({ filePath: "/ws/a.feature", line, name, kind: "scenario" });
  const linkAt = (testKey: string, scenario: ScenarioRef): TraceLink => ({ testKey, scenario, reqKeys: [] });

  it("returns the links whose scenario shares the ref's file and 1-based line", () => {
    const links = [linkAt("CALC-1", ref(4, "Create product")), linkAt("CALC-2", ref(20, "Delete product"))];
    expect(linkedTestsForScenario(links, ref(4, "Create product")).map((l) => l.testKey)).toEqual(["CALC-1"]);
  });

  it("does not claim an untagged twin is linked when an identically named sibling is tagged in the same file", () => {
    // The tagged sibling is at line 4; the dialog target is its untagged twin at line 15, same name.
    const links = [linkAt("CALC-1", ref(4, "Create product"))];
    expect(linkedTestsForScenario(links, ref(15, "Create product"))).toEqual([]);
  });

  it("keeps sameScenario's title fallback for a line-less ref (outline-row reunification)", () => {
    const links = [linkAt("CALC-1", ref(4, "Adding"))];
    const outlineRowRef: ScenarioRef = { filePath: "/ws/a.feature", line: 0, name: "Adding", kind: "outline" };
    expect(linkedTestsForScenario(links, outlineRowRef).map((l) => l.testKey)).toEqual(["CALC-1"]);
  });
});
