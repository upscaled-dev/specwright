import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, afterEach } from "vitest";
import { FeatureParser } from "../../parsers/feature-parser";
import { Logger } from "../../utils/logger";
import { normalizePathKey, PlaywrightJsonParser, ScenarioStatus } from "../../utils/playwright-json-parser";
import {
  buildTraceabilitySnapshot,
  findPlaywrightReport,
  ParsedFeatureInput,
  TraceLink,
} from "../../traceability/traceability-model";
import { RemoteMetadataSnapshot, TestCaseMetadata } from "../../traceability/contracts";
import { JIRA_KEY_SHAPE, projectFromKey } from "../../xray/xray-adapter";

function remoteSnapshot(
  tests: readonly TestCaseMetadata[],
  overrides: Partial<RemoteMetadataSnapshot> = {}
): RemoteMetadataSnapshot {
  return {
    tests: new Map(tests.map((test) => [test.key, test])),
    fetchedScopes: ["CALC"],
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
