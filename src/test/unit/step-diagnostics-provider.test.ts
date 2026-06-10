import { describe, it, expect } from "vitest";
import {
  computeDiagnosticsWithInfo,
  StepDiagnosticsProvider,
} from "../../providers/step-diagnostics-provider";
import { extractStepDefsFromSource } from "../../providers/step-definition-provider";
import { ParsedStepDefWithFile } from "../../providers/step-resolver";

function defsFromSource(source: string, filePath = "/ws/steps/a.ts"): ParsedStepDefWithFile[] {
  return extractStepDefsFromSource(source).map((d) => ({ ...d, filePath }));
}

describe("computeDiagnostics (pure helper)", () => {
  it("returns zero diagnostics when every step matches a definition", () => {
    const feature = [
      "Feature: A",
      "  Scenario: S",
      "    Given I am on the page",
      "    When I click the button",
      "    Then I see the result",
    ].join("\n");
    const defs = defsFromSource(
      [
        "Given('I am on the page', async () => {});",
        "When('I click the button', async () => {});",
        "Then('I see the result', async () => {});",
      ].join("\n")
    );
    const { diagnostics } = computeDiagnosticsWithInfo(feature, defs);
    expect(diagnostics).toHaveLength(0);
  });

  it("emits one diagnostic per unmatched step", () => {
    const feature = [
      "Feature: A",
      "  Scenario: S",
      "    Given I have a thing",
      "    When I press the gizmo",
      "    Then it works",
    ].join("\n");
    const defs = defsFromSource("Given('I have a thing', async () => {});\n");
    const { diagnostics, infos } = computeDiagnosticsWithInfo(feature, defs);
    expect(diagnostics).toHaveLength(2);
    const definedInfos = infos.filter((i) => i !== undefined) as Array<{ text: string }>;
    expect(definedInfos.map((i) => i.text)).toEqual(["I press the gizmo", "it works"]);
    expect(diagnostics[0]!.severity).toBe(0);
    expect(diagnostics[0]!.source).toBe(StepDiagnosticsProvider.DIAGNOSTIC_SOURCE);
    expect(diagnostics[0]!.code).toBe(StepDiagnosticsProvider.DIAGNOSTIC_CODE);
  });

  it("does NOT flag step-looking lines inside a doc string block", () => {
    const feature = [
      "Feature: A",
      "  Scenario: S",
      "    Given a doc:",
      `      """`,
      "      Given this is not a step",
      `      """`,
    ].join("\n");
    const { diagnostics, infos } = computeDiagnosticsWithInfo(feature, []);
    const definedInfos = infos.filter((i) => i !== undefined) as Array<{ text: string }>;
    expect(definedInfos.map((i) => i.text)).toEqual(["a doc:"]);
    expect(diagnostics).toHaveLength(1);
  });

  it("does NOT flag step-looking lines that begin with #", () => {
    const feature = [
      "Feature: A",
      "  Scenario: S",
      "    # Given commented out",
      "    Given a real step",
    ].join("\n");
    const { diagnostics, infos } = computeDiagnosticsWithInfo(feature, []);
    expect(diagnostics).toHaveLength(1);
    const definedInfos = infos.filter((i) => i !== undefined) as Array<{ text: string }>;
    expect(definedInfos[0]!.text).toBe("a real step");
  });

  it("does NOT flag rows in a data table", () => {
    const feature = [
      "Feature: A",
      "  Scenario: S",
      "    Given a table:",
      "      | a | b |",
      "      | 1 | 2 |",
    ].join("\n");
    const defs = defsFromSource("Given('a table:', async () => {});\n");
    const { diagnostics } = computeDiagnosticsWithInfo(feature, defs);
    expect(diagnostics).toHaveLength(0);
  });

  it("flags multiple unmatched steps in the same file", () => {
    const feature = [
      "Feature: A",
      "  Scenario: S",
      "    Given one",
      "    When two",
      "    Then three",
      "    And four",
    ].join("\n");
    const { diagnostics } = computeDiagnosticsWithInfo(feature, []);
    expect(diagnostics).toHaveLength(4);
  });

  it("range starts at the leading-whitespace column of the step line", () => {
    const feature = [
      "Feature: A",
      "  Scenario: S",
      "        Given indented step",
    ].join("\n");
    const { diagnostics } = computeDiagnosticsWithInfo(feature, []);
    expect(diagnostics).toHaveLength(1);
    const range = diagnostics[0]!.range;
    expect(range.start.line).toBe(2);
    expect(range.start.character).toBe(8);
    expect(range.end.line).toBe(2);
    expect(range.end.character).toBe("        Given indented step".length);
  });
});

describe("computeDiagnostics ambiguous-step detection", () => {
  it("emits a warning when a step matches multiple definitions", () => {
    const feature = [
      "Feature: A",
      "  Scenario: S",
      "    Given I have a thing",
    ].join("\n");
    const defs: ParsedStepDefWithFile[] = [
      ...defsFromSource("Given('I have a thing', async () => {});\n", "/ws/steps/a.ts"),
      ...defsFromSource("Given(/^I have a thing$/, async () => {});\n", "/ws/steps/b.ts"),
    ];
    const { diagnostics, ambiguousInfos } = computeDiagnosticsWithInfo(feature, defs);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.severity).toBe(1);
    expect(diagnostics[0]!.code).toBe(StepDiagnosticsProvider.AMBIGUOUS_DIAGNOSTIC_CODE);
    expect(diagnostics[0]!.source).toBe(StepDiagnosticsProvider.DIAGNOSTIC_SOURCE);
    const definedAmbig = ambiguousInfos.filter((i) => i !== undefined) as Array<{
      text: string;
      matches: Array<{ filePath: string; line: number }>;
    }>;
    expect(definedAmbig).toHaveLength(1);
    expect(definedAmbig[0]!.text).toBe("I have a thing");
    expect(definedAmbig[0]!.matches).toHaveLength(2);
  });

  it("classifies one unmatched, one ambiguous, and one OK as exactly two diagnostics", () => {
    const feature = [
      "Feature: A",
      "  Scenario: S",
      "    Given I have a thing",
      "    When I click",
      "    Then it works",
    ].join("\n");
    const defs: ParsedStepDefWithFile[] = [
      ...defsFromSource("Given('I have a thing', async () => {});\n", "/ws/steps/a.ts"),
      ...defsFromSource("Given(/^I have a thing$/, async () => {});\n", "/ws/steps/b.ts"),
      ...defsFromSource("When('I click', async () => {});\n", "/ws/steps/a.ts"),
    ];
    const { diagnostics } = computeDiagnosticsWithInfo(feature, defs);
    expect(diagnostics).toHaveLength(2);
    const codes = diagnostics.map((d) => d.code);
    expect(codes).toContain(StepDiagnosticsProvider.AMBIGUOUS_DIAGNOSTIC_CODE);
    expect(codes).toContain(StepDiagnosticsProvider.DIAGNOSTIC_CODE);
    const severities = diagnostics.map((d) => d.severity).sort((a, b) => a - b);
    expect(severities).toEqual([0, 1]);
  });

  it("ambiguous message contains step text and every path:line", () => {
    const feature = [
      "Feature: A",
      "  Scenario: S",
      "    Given I have a thing",
    ].join("\n");
    const defs: ParsedStepDefWithFile[] = [
      ...defsFromSource("Given('I have a thing', async () => {});\n", "/ws/steps/a.ts"),
      ...defsFromSource("Given(/^I have a thing$/, async () => {});\n", "/ws/steps/b.ts"),
    ];
    const { diagnostics } = computeDiagnosticsWithInfo(feature, defs);
    expect(diagnostics).toHaveLength(1);
    const msg = diagnostics[0]!.message;
    expect(msg).toContain("Step matches multiple definitions: I have a thing");
    expect(msg).toContain("/ws/steps/a.ts:1");
    expect(msg).toContain("/ws/steps/b.ts:1");
  });

  it("does NOT flag an ambiguous-looking step inside a doc string", () => {
    const feature = [
      "Feature: A",
      "  Scenario: S",
      "    Given a doc:",
      `      """`,
      "      Given I have a thing",
      `      """`,
    ].join("\n");
    const defs: ParsedStepDefWithFile[] = [
      ...defsFromSource("Given('a doc:', async () => {});\n", "/ws/steps/a.ts"),
      ...defsFromSource("Given('I have a thing', async () => {});\n", "/ws/steps/a.ts"),
      ...defsFromSource("Given(/^I have a thing$/, async () => {});\n", "/ws/steps/b.ts"),
    ];
    const { diagnostics } = computeDiagnosticsWithInfo(feature, defs);
    expect(diagnostics).toHaveLength(0);
  });

  it("orders matches by filePath then line for stable output", () => {
    const feature = [
      "Feature: A",
      "  Scenario: S",
      "    Given I have a thing",
    ].join("\n");
    const defs: ParsedStepDefWithFile[] = [
      ...defsFromSource(
        ["", "", "Given('I have a thing', async () => {});"].join("\n"),
        "/ws/steps/z.ts"
      ),
      ...defsFromSource("Given(/^I have a thing$/, async () => {});\n", "/ws/steps/a.ts"),
      ...defsFromSource(
        ["", "Given('I have a thing', async () => {});"].join("\n"),
        "/ws/steps/a.ts"
      ),
    ];
    const { ambiguousInfos } = computeDiagnosticsWithInfo(feature, defs);
    const ambig = ambiguousInfos.find((i) => i !== undefined);
    expect(ambig).toBeDefined();
    expect(ambig!.matches.map((m) => `${m.filePath}:${m.line}`)).toEqual([
      "/ws/steps/a.ts:0",
      "/ws/steps/a.ts:1",
      "/ws/steps/z.ts:2",
    ]);
  });

  it("dedups identical (filePath, line) pairs in matches", () => {
    const feature = [
      "Feature: A",
      "  Scenario: S",
      "    Given I have a thing",
    ].join("\n");
    const single = defsFromSource(
      "Given('I have a thing', async () => {});\n",
      "/ws/steps/a.ts"
    );
    const defs: ParsedStepDefWithFile[] = [
      ...single,
      ...single,
      ...defsFromSource("Given(/^I have a thing$/, async () => {});\n", "/ws/steps/b.ts"),
    ];
    const { ambiguousInfos } = computeDiagnosticsWithInfo(feature, defs);
    const ambig = ambiguousInfos.find((i) => i !== undefined);
    expect(ambig).toBeDefined();
    expect(ambig!.matches).toHaveLength(2);
  });
});

describe("computeDiagnostics scenario outline placeholder validation", () => {
  const outlineDefs = (): ParsedStepDefWithFile[] =>
    defsFromSource(
      [
        "Given('user {string} has age {int}', async () => {});",
        "When('I greet {string}', async () => {});",
        "Then('I see {string}', async () => {});",
      ].join("\n")
    );

  const matchAllDefs = (): ParsedStepDefWithFile[] =>
    defsFromSource("Given(/.*/, async () => {});\nWhen(/.*/, async () => {});\nThen(/.*/, async () => {});\n");

  it("emits no outline diagnostics when every placeholder maps to a column and every column is used", () => {
    const feature = [
      "Feature: A",
      "  Scenario Outline: greet",
      "    Given user \"<name>\" has age <age>",
      "    When I greet \"<name>\"",
      "    Then I see \"<name>\"",
      "    Examples:",
      "      | name  | age |",
      "      | Alice | 30  |",
    ].join("\n");
    const { diagnostics } = computeDiagnosticsWithInfo(feature, outlineDefs());
    const outlineDiags = diagnostics.filter(
      (d) =>
        d.code === StepDiagnosticsProvider.UNDECLARED_PLACEHOLDER_CODE ||
        d.code === StepDiagnosticsProvider.UNUSED_COLUMN_CODE
    );
    expect(outlineDiags).toHaveLength(0);
  });

  it("flags a placeholder not present in any Examples column", () => {
    const feature = [
      "Feature: A",
      "  Scenario Outline: greet",
      "    Given user \"<name>\" has age <unknown>",
      "    Examples:",
      "      | name |",
      "      | Bob  |",
    ].join("\n");
    const { diagnostics } = computeDiagnosticsWithInfo(feature, matchAllDefs());
    const undeclared = diagnostics.filter(
      (d) => d.code === StepDiagnosticsProvider.UNDECLARED_PLACEHOLDER_CODE
    );
    expect(undeclared).toHaveLength(1);
    expect(undeclared[0]!.severity).toBe(1);
    expect(undeclared[0]!.source).toBe(StepDiagnosticsProvider.DIAGNOSTIC_SOURCE);
    expect(undeclared[0]!.message).toBe(
      "Scenario Outline placeholder `<unknown>` is not declared in Examples table"
    );
    expect(undeclared[0]!.range.start.line).toBe(2);
  });

  it("flags a column that is never referenced in any outline step", () => {
    const feature = [
      "Feature: A",
      "  Scenario Outline: greet",
      "    Given user \"<name>\" exists",
      "    Examples:",
      "      | name | extra |",
      "      | Eve  | foo   |",
    ].join("\n");
    const { diagnostics } = computeDiagnosticsWithInfo(feature, matchAllDefs());
    const unused = diagnostics.filter(
      (d) => d.code === StepDiagnosticsProvider.UNUSED_COLUMN_CODE
    );
    expect(unused).toHaveLength(1);
    expect(unused[0]!.severity).toBe(2);
    expect(unused[0]!.message).toBe(
      "Examples column `extra` is not used in any Scenario Outline step"
    );
    expect(unused[0]!.range.start.line).toBe(4);
    const headerLine = "      | name | extra |";
    expect(unused[0]!.range.start.character).toBe(headerLine.indexOf("extra"));
    expect(unused[0]!.range.end.character).toBe(headerLine.indexOf("extra") + "extra".length);
  });

  it("treats a placeholder as declared if ANY of multiple Examples blocks declare it", () => {
    const feature = [
      "Feature: A",
      "  Scenario Outline: greet",
      "    Given user \"<name>\" has \"<role>\"",
      "    Examples: admins",
      "      | name |",
      "      | Ada  |",
      "    Examples: roles",
      "      | role  |",
      "      | admin |",
    ].join("\n");
    const { diagnostics } = computeDiagnosticsWithInfo(feature, matchAllDefs());
    const undeclared = diagnostics.filter(
      (d) => d.code === StepDiagnosticsProvider.UNDECLARED_PLACEHOLDER_CODE
    );
    const unused = diagnostics.filter(
      (d) => d.code === StepDiagnosticsProvider.UNUSED_COLUMN_CODE
    );
    expect(undeclared).toHaveLength(0);
    expect(unused).toHaveLength(0);
  });

  it("does NOT validate placeholders inside a plain Scenario (not an outline)", () => {
    const feature = [
      "Feature: A",
      "  Scenario: not an outline",
      "    Given user \"<name>\" exists",
    ].join("\n");
    const { diagnostics } = computeDiagnosticsWithInfo(feature, matchAllDefs());
    const outlineDiags = diagnostics.filter(
      (d) =>
        d.code === StepDiagnosticsProvider.UNDECLARED_PLACEHOLDER_CODE ||
        d.code === StepDiagnosticsProvider.UNUSED_COLUMN_CODE
    );
    expect(outlineDiags).toHaveLength(0);
  });

  it("treats a column referenced only in a step data table as used", () => {
    const feature = [
      "Feature: A",
      "  Scenario Outline: rows",
      "    Given a table:",
      "      | value    |",
      "      | <amount> |",
      "    Examples:",
      "      | amount |",
      "      | 3      |",
    ].join("\n");
    const { diagnostics } = computeDiagnosticsWithInfo(feature, matchAllDefs());
    const unused = diagnostics.filter(
      (d) => d.code === StepDiagnosticsProvider.UNUSED_COLUMN_CODE
    );
    expect(unused).toHaveLength(0);
  });

  it("treats a column referenced only in a step docstring as used", () => {
    const feature = [
      "Feature: A",
      "  Scenario Outline: docs",
      "    Given a doc:",
      `      """`,
      "      payload includes <amount>",
      `      """`,
      "    Examples:",
      "      | amount |",
      "      | 3      |",
    ].join("\n");
    const { diagnostics } = computeDiagnosticsWithInfo(feature, matchAllDefs());
    const unused = diagnostics.filter(
      (d) => d.code === StepDiagnosticsProvider.UNUSED_COLUMN_CODE
    );
    expect(unused).toHaveLength(0);
  });

  it("still flags a column referenced only in a comment", () => {
    const feature = [
      "Feature: A",
      "  Scenario Outline: comments",
      "    Given a step",
      "    # mentions <amount> but only in prose",
      "    Examples:",
      "      | amount |",
      "      | 3      |",
    ].join("\n");
    const { diagnostics } = computeDiagnosticsWithInfo(feature, matchAllDefs());
    const unused = diagnostics.filter(
      (d) => d.code === StepDiagnosticsProvider.UNUSED_COLUMN_CODE
    );
    expect(unused).toHaveLength(1);
  });

  it("does NOT flag placeholders that appear only inside a doc string", () => {
    const feature = [
      "Feature: A",
      "  Scenario Outline: docs",
      "    Given a doc:",
      `      """`,
      "      The token <unknown> is just prose here.",
      `      """`,
      "    Examples:",
      "      | name |",
      "      | Sam  |",
    ].join("\n");
    const { diagnostics } = computeDiagnosticsWithInfo(feature, matchAllDefs());
    const undeclared = diagnostics.filter(
      (d) => d.code === StepDiagnosticsProvider.UNDECLARED_PLACEHOLDER_CODE
    );
    expect(undeclared).toHaveLength(0);
  });
});
