import { describe, it, expect } from "vitest";
import { computeTagDiagnostics, prefixesOverlap } from "../../traceability/tag-diagnostics";
import { JIRA_KEY_SHAPE, projectFromKey } from "../../xray/xray-adapter";
import { InMemoryTraceabilityAdapter } from "../../traceability/in-memory-adapter";
import { KeyGrammar } from "../../traceability/contracts";

const GRAMMAR: KeyGrammar = {
  testPrefix: "TEST_",
  reqPrefix: "REQ_",
  keyShape: JIRA_KEY_SHAPE,
  canonicalizeKey: (key) => key.toUpperCase(),
  projectOf: projectFromKey,
};

const messages = (feature: string, grammar: KeyGrammar = GRAMMAR): string[] =>
  computeTagDiagnostics(feature, grammar).map((d) => d.message);

describe("computeTagDiagnostics — rule 1: one test tag per unit", () => {
  it("flags each test tag when a scenario carries more than one", () => {
    const feature = "Feature: F\n\n@TEST_CALC-1 @TEST_CALC-2\nScenario: A\n  Given x\n";
    const diags = computeTagDiagnostics(feature, GRAMMAR);
    expect(diags).toHaveLength(2);
    expect(diags.every((d) => d.message.includes("more than one test tag"))).toBe(true);
    expect(diags[0]).toMatchObject({ line: 2, startCol: 0, endCol: 12 });
    expect(diags[1]).toMatchObject({ line: 2, startCol: 13, endCol: 25 });
  });

  it("flags an outline carrying two test tags", () => {
    const feature =
      "Feature: F\n\n@TEST_CALC-1 @TEST_CALC-2\nScenario Outline: O\n  When step <a>\n\n  Examples:\n    | a |\n    | 1 |\n";
    const diags = computeTagDiagnostics(feature, GRAMMAR);
    expect(diags).toHaveLength(2);
    expect(diags.every((d) => d.message.includes("Scenario Outline"))).toBe(true);
  });

  it("flags a split Examples block carrying two test tags while leaving the outline tag alone", () => {
    const feature =
      "Feature: F\n\n@TEST_CALC-1\nScenario Outline: O\n  When step <a>\n\n  @TEST_CALC-2 @TEST_CALC-3\n  Examples: edge\n    | a |\n    | 1 |\n";
    const diags = computeTagDiagnostics(feature, GRAMMAR);
    expect(diags).toHaveLength(2);
    expect(diags.every((d) => d.message.includes("Examples block"))).toBe(true);
    expect(diags.every((d) => d.line === 6)).toBe(true);
  });
});

describe("computeTagDiagnostics — rule 2/5: a test key across independent units", () => {
  it("flags the same key mapped on two independent scenarios", () => {
    const feature =
      "Feature: F\n\n@TEST_CALC-1\nScenario: A\n  Given x\n\n@TEST_CALC-1\nScenario: B\n  Given y\n";
    const diags = messages(feature);
    expect(diags).toHaveLength(2);
    expect(diags.every((m) => m.includes("more than one scenario"))).toBe(true);
  });

  it("flags a feature-level test tag inherited by multiple scenarios (rule 5)", () => {
    const feature =
      "@TEST_CALC-1\nFeature: F\n\nScenario: A\n  Given x\n\nScenario: B\n  Given y\n";
    const diags = computeTagDiagnostics(feature, GRAMMAR);
    expect(diags).toHaveLength(1);
    expect(diags[0]).toMatchObject({ line: 0 });
    expect(diags[0]!.message).toContain("inherited by multiple scenarios");
  });

  it("does not flag a feature-level test tag on a single-scenario feature", () => {
    const feature = "@TEST_CALC-1\nFeature: F\n\nScenario: A\n  Given x\n";
    expect(computeTagDiagnostics(feature, GRAMMAR)).toEqual([]);
  });
});

describe("computeTagDiagnostics — Gherkin inheritance semantics", () => {
  it("does not inherit a tag placed directly above a Rule (parser drops it)", () => {
    const feature =
      "Feature: F\n\n@TEST_CALC-9\nRule: R1\n\n  Scenario: A\n    Given x\n\n  Scenario: B\n    Given y\n";
    expect(computeTagDiagnostics(feature, GRAMMAR)).toEqual([]);
  });

  it("still inherits feature-level tags into scenarios nested under a Rule", () => {
    const feature =
      "@TEST_CALC-1\nFeature: F\n\nRule: R1\n\n  Scenario: A\n    Given x\n\n  Scenario: B\n    Given y\n";
    const diags = computeTagDiagnostics(feature, GRAMMAR);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.message).toContain("inherited by multiple scenarios");
  });
});

describe("computeTagDiagnostics — permitted shapes", () => {
  it("permits multiple requirement tags with a single test tag (rule 3)", () => {
    const feature = "Feature: F\n\n@REQ_CALC-9 @REQ_CALC-8 @TEST_CALC-1\nScenario: A\n  Given x\n";
    expect(computeTagDiagnostics(feature, GRAMMAR)).toEqual([]);
  });

  it("permits a clean one-test one-scenario mapping", () => {
    const feature = "Feature: F\n\n@TEST_CALC-1 @REQ_CALC-9\nScenario: A\n  Given x\n";
    expect(computeTagDiagnostics(feature, GRAMMAR)).toEqual([]);
  });
});

describe("computeTagDiagnostics — non-Jira grammar", () => {
  it("lints through the active adapter's grammar (in-memory numeric keys)", () => {
    const grammar = new InMemoryTraceabilityAdapter().keyGrammar;
    const feature = "Feature: F\n\n@TC-1 @TC-2\nScenario: A\n  Given x\n";
    const diags = computeTagDiagnostics(feature, grammar);
    expect(diags).toHaveLength(2);
    expect(diags.every((d) => d.message.includes("more than one test tag"))).toBe(true);
  });
});

describe("computeTagDiagnostics — doc-string fences", () => {
  it("never treats tags or scenario keywords inside triple-quote or backtick fences as units", () => {
    const triple =
      'Feature: F\n\n@TEST_CALC-1\nScenario: A\n  Given a doc:\n  """\n  @TEST_CALC-1\n  Scenario: fake\n  """\n';
    expect(computeTagDiagnostics(triple, GRAMMAR)).toEqual([]);
    const backtick =
      "Feature: F\n\n@TEST_CALC-1\nScenario: A\n  Given a doc:\n  ```\n  @TEST_CALC-1\n  Scenario: fake\n  ```\n";
    expect(computeTagDiagnostics(backtick, GRAMMAR)).toEqual([]);
  });
});

describe("prefixesOverlap — rule 4 config-level guard", () => {
  it("detects equal, forward-overlapping, and reverse-overlapping prefixes; clean prefixes pass", () => {
    expect(prefixesOverlap(GRAMMAR)).toBe(false);
    expect(prefixesOverlap({ ...GRAMMAR, reqPrefix: "TEST_" })).toBe(true);
    // test prefix contains req prefix (test.startsWith(req)).
    expect(prefixesOverlap({ ...GRAMMAR, reqPrefix: "TE" })).toBe(true);
    // req prefix contains test prefix (req.startsWith(test)).
    expect(prefixesOverlap({ ...GRAMMAR, testPrefix: "TE", reqPrefix: "TEST_" })).toBe(true);
  });

  it("emits no per-file diagnostics while the prefixes overlap (surfaced once elsewhere)", () => {
    const feature = "Feature: F\n\n@TEST_CALC-1 @TEST_CALC-2\nScenario: A\n  Given x\n";
    expect(computeTagDiagnostics(feature, { ...GRAMMAR, reqPrefix: "TE" })).toEqual([]);
  });
});
