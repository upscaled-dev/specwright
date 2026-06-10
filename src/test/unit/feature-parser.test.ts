import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { describe, it, expect, vi } from "vitest";
import { FeatureParser, isOutlineExampleRow } from "../../parsers/feature-parser";
import { Logger } from "../../utils/logger";
import { OutlineExampleRow, OutlineStub, RegularScenario, Scenario } from "../../types";

function makeLoggerMock(): Logger {
  const logger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
  return logger;
}

/**
 * Unit tests for the Gherkin parser at src/parsers/feature-parser.ts.
 *
 * Most tests use inline Gherkin strings via `parseFeatureContent` so they are pure.
 * One test (`parseFeatureFile sanity`) loads a fixture from disk to prove the fs path works.
 */

const FIXTURES_DIR = path.resolve(__dirname, "../../../features");

const NL = "\n";
const lines = (...rows: string[]): string => rows.join(NL);

describe("FeatureParser.parseFeatureContent — invalid input", () => {
  it("returns null for an empty string", () => {
    const parser = FeatureParser.create();
    expect(parser.parseFeatureContent("")).toBeNull();
  });

  it("returns null for content that has no Feature: line", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Scenario: orphan scenario without a feature",
      "  Given I have 0 widgets"
    );
    expect(parser.parseFeatureContent(content)).toBeNull();
  });
});

describe("FeatureParser.parseFeatureContent — plain feature", () => {
  it("parses two scenarios with names and tags", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Feature: Plain",
      "",
      "  @smoke",
      "  Scenario: First",
      "    Given I have 0 widgets",
      "",
      "  @smoke @critical",
      "  Scenario: Second",
      "    Given I have 1 widgets"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.feature).toBe("Plain");
    expect(parsed!.scenarios).toHaveLength(2);
    expect(parsed!.scenarios[0]!.name).toBe("First");
    expect(parsed!.scenarios[0]!.tags).toEqual(["@smoke"]);
    expect(parsed!.scenarios[1]!.name).toBe("Second");
    expect(parsed!.scenarios[1]!.tags).toEqual(["@smoke", "@critical"]);
  });
});

describe("FeatureParser.parseFeatureContent — Gherkin * step keyword", () => {
  it("parses mixed Given/*/* steps as scenario steps in order", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Feature: Asterisk",
      "",
      "  Scenario: Login",
      "    Given I am on the login page",
      "    * I have valid credentials",
      "    * I click the login button",
      "    Then I see the dashboard"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.scenarios).toHaveLength(1);
    expect(parsed!.scenarios[0]!.steps).toEqual([
      "Given I am on the login page",
      "* I have valid credentials",
      "* I click the login button",
      "Then I see the dashboard",
    ]);
  });

  it("parses a scenario whose steps are all * keywords", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Feature: All Asterisks",
      "",
      "  Scenario: Dangling",
      "    * step one",
      "    * step two",
      "    * step three"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.scenarios).toHaveLength(1);
    expect(parsed!.scenarios[0]!.steps).toEqual([
      "* step one",
      "* step two",
      "* step three",
    ]);
  });
});

describe("FeatureParser.parseFeatureContent — Background propagation", () => {
  it("prepends feature-level Background as backgroundSteps on each scenario", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Feature: With Background",
      "",
      "  Background:",
      "    Given I have 0 widgets",
      "    And I add 1 widget",
      "",
      "  Scenario: A",
      "    When I add 1 widget",
      "    Then I have 2 widgets total",
      "",
      "  Scenario: B",
      "    When I add 2 widgets",
      "    Then I have 3 widgets total"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.scenarios).toHaveLength(2);
    for (const s of parsed!.scenarios) {
      expect(s.backgroundSteps).toEqual([
        "Given I have 0 widgets",
        "And I add 1 widget",
      ]);
      // Background steps are stored separately, not folded into `steps`
      expect(s.steps).not.toContain("Given I have 0 widgets");
    }
  });
});

describe("FeatureParser.parseFeatureContent — Rule scoping", () => {
  it("associates scenarios under a Rule: with the rule name via ruleName", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Feature: Rules",
      "",
      "  Rule: Adding",
      "    Scenario: Add one",
      "      Given I add 1 widget",
      "",
      "  Rule: Removing",
      "    Scenario: Remove one",
      "      When I remove 1 widgets"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.scenarios).toHaveLength(2);
    expect(parsed!.scenarios[0]!.ruleName).toBe("Adding");
    expect(parsed!.scenarios[1]!.ruleName).toBe("Removing");
  });
});

describe("FeatureParser.parseFeatureContent — Background stacking", () => {
  it("stacks feature- and rule-level Backgrounds in [feature, rule] order on scenarios inside the rule", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Feature: Stacked",
      "",
      "  Background:",
      "    Given I have 0 widgets",
      "",
      "  Rule: Adding",
      "",
      "    Background:",
      "      Given I add 1 widget",
      "",
      "    Scenario: Inner",
      "      When I add 1 widget",
      "      Then I have 2 widgets total"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.scenarios).toHaveLength(1);
    const s = parsed!.scenarios[0]!;
    expect(s.ruleName).toBe("Adding");
    expect(s.backgroundSteps).toEqual([
      "Given I have 0 widgets", // feature-level first
      "Given I add 1 widget",   // then rule-level
    ]);
  });
});

describe("FeatureParser.parseFeatureContent — Scenario Outline (single Examples)", () => {
  it("expands one scenario per example row, naming them '<idx>: <outline> - <header>: <value>, ...'", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Feature: Outline",
      "",
      "  Scenario Outline: Adding",
      "    Given I have <start> widgets",
      "    When I add <added> widgets",
      "    Then I have <total> widgets total",
      "",
      "    Examples:",
      "      | start | added | total |",
      "      | 0     | 1     | 1     |",
      "      | 2     | 2     | 4     |"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.scenarios).toHaveLength(2);
    expect(parsed!.scenarios[0]!.name).toBe(
      "1: Adding - start: 0, added: 1, total: 1"
    );
    expect(parsed!.scenarios[1]!.name).toBe(
      "2: Adding - start: 2, added: 2, total: 4"
    );
    expect(parsed!.scenarios[0]!.isScenarioOutline).toBe(true);
  });
});

describe("FeatureParser.parseFeatureContent — Scenario Outline (multiple Examples)", () => {
  it("sums rows across every Examples block", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Feature: Multi-examples",
      "",
      "  Scenario Outline: Adding",
      "    Given I have <start> widgets",
      "",
      "    Examples: happy",
      "      | start |",
      "      | 0     |",
      "      | 1     |",
      "",
      "    Examples: edge",
      "      | start |",
      "      | 10    |",
      "      | 99    |",
      "      | 100   |"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.scenarios).toHaveLength(5); // 2 + 3
    // Example index restarts at 1 and increments across all blocks
    expect(parsed!.scenarios[0]!.name).toMatch(/^1: Adding - start: 0/);
    expect(parsed!.scenarios[1]!.name).toMatch(/^2: Adding - start: 1/);
    expect(parsed!.scenarios[2]!.name).toMatch(/^3: Adding - start: 10/);
    expect(parsed!.scenarios[4]!.name).toMatch(/^5: Adding - start: 100/);
  });
});

describe("FeatureParser.parseFeatureContent — Named Examples blocks", () => {
  it("surfaces the Examples block name on each expanded scenario via examplesBlockName", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Feature: Named",
      "",
      "  Scenario Outline: Adding",
      "    Given I have <start> widgets",
      "",
      "    Examples: happy path",
      "      | start |",
      "      | 0     |",
      "",
      "    Examples: edge cases",
      "      | start |",
      "      | 99    |"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.scenarios).toHaveLength(2);
    const s0 = parsed!.scenarios[0]!;
    const s1 = parsed!.scenarios[1]!;
    expect(isOutlineExampleRow(s0) ? s0.examplesBlockName : undefined).toBe("happy path");
    expect(isOutlineExampleRow(s1) ? s1.examplesBlockName : undefined).toBe("edge cases");
  });
});

describe("FeatureParser.parseFeatureContent — Tag inheritance (positive)", () => {
  it("merges outline-level and Examples-block tags onto each expanded scenario", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Feature: Tagged",
      "",
      "  @outlineTag",
      "  Scenario Outline: Adding",
      "    Given I have <start> widgets",
      "",
      "    @critical",
      "    Examples: edge",
      "      | start |",
      "      | 0     |",
      "      | 1     |"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.scenarios).toHaveLength(2);
    for (const s of parsed!.scenarios) {
      expect(s.tags).toEqual(["@outlineTag", "@critical"]);
      expect(isOutlineExampleRow(s) ? s.examplesBlockTags : undefined).toEqual(["@critical"]);
    }
  });
});

describe("FeatureParser.parseFeatureContent — Tag inheritance", () => {
  it("propagates feature-level tags but NOT rule-level tags onto scenario.tags", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "@featureLevel",
      "Feature: Bleed",
      "",
      "  @ruleLevel",
      "  Rule: Adding",
      "",
      "    Scenario: Plain",
      "      Given I add 1 widget"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.scenarios).toHaveLength(1);
    const s = parsed!.scenarios[0]!;
    expect(s.tags).toEqual(["@featureLevel"]);
    expect(s.tags).not.toContain("@ruleLevel");
  });

  it("applies feature-level tags to every scenario, before the scenario's own tags", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "@featureLevel",
      "Feature: AllScenarios",
      "",
      "  Scenario: First",
      "    Given I have 0 widgets",
      "",
      "  @own",
      "  Scenario: Second",
      "    Given I have 1 widgets"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.scenarios).toHaveLength(2);
    expect(parsed!.scenarios[0]!.tags).toEqual(["@featureLevel"]);
    expect(parsed!.scenarios[1]!.tags).toEqual(["@featureLevel", "@own"]);
  });
});

describe("FeatureParser.provideScenarioCodeLenses — counts per fixture", () => {
  function readFixture(name: string): string {
    return fs.readFileSync(path.join(FIXTURES_DIR, name), "utf-8");
  }

  it("background.feature: 1 Run Feature + 3 tag lenses + 2 scenarios * 2 = 8", () => {
    const parser = FeatureParser.create();
    const content = readFixture("background.feature");
    const lenses = parser.provideScenarioCodeLenses(content, "background.feature");
    expect(lenses).toHaveLength(8);
  });

  it("rules.feature: 1 Run Feature + 1 tag (@rules) + 3 scenarios * 2 = 8", () => {
    const parser = FeatureParser.create();
    const content = readFixture("rules.feature");
    const lenses = parser.provideScenarioCodeLenses(content, "rules.feature");
    expect(lenses).toHaveLength(8);
  });

  it("outline-multi-examples.feature: 1 Run Feature + 3 tags + 1 outline*2 + 5 example rows*2 = 16", () => {
    const parser = FeatureParser.create();
    const content = readFixture("outline-multi-examples.feature");
    const lenses = parser.provideScenarioCodeLenses(content, "outline-multi-examples.feature");
    expect(lenses).toHaveLength(16);
  });

  it("complex.feature: 1 Run Feature + 5 tags + 2 scenarios*2 + 1 outline*2 + 2 rows*2 = 16", () => {
    const parser = FeatureParser.create();
    const content = readFixture("complex.feature");
    const lenses = parser.provideScenarioCodeLenses(content, "complex.feature");
    expect(lenses).toHaveLength(16);
  });
});

describe("FeatureParser.parseFeatureContent — hyphenated tag extraction", () => {
  it("preserves hyphenated tags like @rule-scoped in both scenario tags and CodeLens tag list", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Feature: Hyphenated",
      "",
      "  @rule-scoped @smoke",
      "  Scenario: One",
      "    Given I have 0 widgets"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.scenarios[0]!.tags).toEqual(["@rule-scoped", "@smoke"]);

    const lenses = parser.provideScenarioCodeLenses(content, "hyphenated.feature");
    const tagTitles = lenses.map((l) => l.command?.title ?? "").filter((t) => t.startsWith("🏷️"));
    expect(tagTitles).toContain("🏷️ Run with @rule-scoped");
    expect(tagTitles).not.toContain("🏷️ Run with @rule");
  });
});

describe("FeatureParser tag regex — rejects punctuation", () => {
  it("parses '@smoke,@critical' (no space) as two separate tags in scenario.tags", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Feature: NoSpaceTags",
      "",
      "  @smoke,@critical",
      "  Scenario: One",
      "    Given I have 0 widgets"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.scenarios[0]!.tags).toEqual(["@smoke", "@critical"]);
    expect(parsed!.scenarios[0]!.tags).not.toContain("@smoke,@critical");
  });

  it("parses '@smoke,@critical' (no space) as two separate tags in CodeLens tag list", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Feature: NoSpaceTags",
      "",
      "  @smoke,@critical",
      "  Scenario: One",
      "    Given I have 0 widgets"
    );
    const lenses = parser.provideScenarioCodeLenses(content, "nospace.feature");
    const tagTitles = lenses.map((l) => l.command?.title ?? "").filter((t) => t.startsWith("🏷️"));
    expect(tagTitles).toContain("🏷️ Run with @smoke");
    expect(tagTitles).toContain("🏷️ Run with @critical");
    expect(tagTitles).not.toContain("🏷️ Run with @smoke,@critical");
  });

  it("strips trailing ')' from '@foo)' in scenario.tags", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Feature: ParenTag",
      "",
      "  @foo)",
      "  Scenario: One",
      "    Given I have 0 widgets"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.scenarios[0]!.tags).toEqual(["@foo"]);
    expect(parsed!.scenarios[0]!.tags).not.toContain("@foo)");
  });

  it("strips trailing ')' from '@foo)' in CodeLens tag list", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Feature: ParenTag",
      "",
      "  @foo)",
      "  Scenario: One",
      "    Given I have 0 widgets"
    );
    const lenses = parser.provideScenarioCodeLenses(content, "paren.feature");
    const tagTitles = lenses.map((l) => l.command?.title ?? "").filter((t) => t.startsWith("🏷️"));
    expect(tagTitles).toContain("🏷️ Run with @foo");
    expect(tagTitles).not.toContain("🏷️ Run with @foo)");
  });
});

describe("FeatureParser.parseFeatureContent — tags above Rule: are dropped with a warning", () => {
  it("does not propagate dropped tags to child scenarios and logs a warning", () => {
    const logger = makeLoggerMock();
    const parser = FeatureParser.create(logger);
    const content = lines(
      "Feature: RuleTags",
      "",
      "  @ruleLevelA @ruleLevelB",
      "  Rule: Adding",
      "",
      "    Scenario: Inner",
      "      Given I add 1 widget"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.scenarios).toHaveLength(1);
    expect(parsed!.scenarios[0]!.tags).toEqual([]);

    expect(logger.warn).toHaveBeenCalled();
    const warnMessages = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warnMessages.some((m) => m.includes("@ruleLevelA") && m.includes("@ruleLevelB"))).toBe(true);
  });
});

describe("FeatureParser.parseFeatureContent — zero-Examples Scenario Outline", () => {
  it("emits a single scenario with outlineLineNumber set and warns the user", () => {
    const logger = makeLoggerMock();
    const parser = FeatureParser.create(logger);
    const content = lines(
      "Feature: EmptyOutline",
      "",
      "  Scenario Outline: Adding",
      "    Given I have <start> widgets",
      "",
      "    Examples:",
      "      | start |"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.scenarios).toHaveLength(1);
    const s = parsed!.scenarios[0]!;
    expect(s.isScenarioOutline).toBe(true);
    if (!s.isScenarioOutline) {throw new Error("expected outline");}
    expect(s.outlineLineNumber).toBeDefined();
    expect(s.outlineLineNumber).toBe(s.line);

    expect(logger.warn).toHaveBeenCalled();
    const warnMessages = (logger.warn as ReturnType<typeof vi.fn>).mock.calls.map((c) => String(c[0]));
    expect(warnMessages.some((m) => m.includes("Adding") && m.includes("no Examples rows"))).toBe(true);
  });
});

describe("FeatureParser.parseFeatureContent — zero-Examples Scenario Outline is idempotent across calls", () => {
  it("produces identical output when the same parser parses the same content twice (no internal mutation)", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Feature: EmptyOutline",
      "",
      "  Scenario Outline: Adding",
      "    Given I have <start> widgets",
      "",
      "    Examples:",
      "      | start |"
    );
    const first = parser.parseFeatureContent(content);
    const second = parser.parseFeatureContent(content);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    expect(first!.scenarios).toHaveLength(1);
    expect(second!.scenarios).toHaveLength(1);
    const s1 = first!.scenarios[0]!;
    const s2 = second!.scenarios[0]!;
    if (!s1.isScenarioOutline || !s2.isScenarioOutline) {throw new Error("expected outline");}
    expect(s1.outlineLineNumber).toBeDefined();
    expect(s2.outlineLineNumber).toBeDefined();
    expect(s1.outlineLineNumber).toBe(s2.outlineLineNumber);
    expect(s1.line).toBe(s2.line);
    expect(s1.name).toBe(s2.name);
    expect(s1.isScenarioOutline).toBe(s2.isScenarioOutline);
  });
});

describe("FeatureParser.parseFeatureContent — long Example headers are not truncated", () => {
  it("includes the full header name in the expanded scenario name", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Feature: LongHeaders",
      "",
      "  Scenario Outline: Customer",
      "    Given I have <customer_full_name_first> as a name",
      "",
      "    Examples:",
      "      | customer_full_name_first |",
      "      | Alice                    |"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.scenarios).toHaveLength(1);
    expect(parsed!.scenarios[0]!.name).toBe(
      "1: Customer - customer_full_name_first: Alice"
    );
    expect(parsed!.scenarios[0]!.name).not.toContain("...");
  });
});

describe("FeatureParser.parseFeatureContent — outlineName field on expanded rows", () => {
  it("sets outlineName on every expanded row to the literal outline name", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Feature: Outline",
      "",
      "  Scenario Outline: Adding",
      "    Given I have <start> widgets",
      "",
      "    Examples:",
      "      | start |",
      "      | 0     |",
      "      | 1     |"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.scenarios).toHaveLength(2);
    for (const s of parsed!.scenarios) {
      if (!s.isScenarioOutline) {throw new Error("expected outline");}
      expect(s.outlineName).toBe("Adding");
    }
  });

  it("sets outlineName on the zero-Examples stub scenario", () => {
    const logger = makeLoggerMock();
    const parser = FeatureParser.create(logger);
    const content = lines(
      "Feature: EmptyOutline",
      "",
      "  Scenario Outline: Adding",
      "    Given I have <start> widgets",
      "",
      "    Examples:",
      "      | start |"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.scenarios).toHaveLength(1);
    const s = parsed!.scenarios[0]!;
    if (!s.isScenarioOutline) {throw new Error("expected outline");}
    expect(s.outlineName).toBe("Adding");
  });

  it("preserves an outline name that contains ' - ' verbatim on every expanded row", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Feature: HyphenName",
      "",
      "  Scenario Outline: Login - Happy Path",
      "    Given I log in as <user>",
      "",
      "    Examples:",
      "      | user  |",
      "      | Alice |",
      "      | Bob   |"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.scenarios).toHaveLength(2);
    for (const s of parsed!.scenarios) {
      if (!s.isScenarioOutline) {throw new Error("expected outline");}
      expect(s.outlineName).toBe("Login - Happy Path");
      expect(s.outlineName).not.toBe("Login");
    }
  });

  it("preserves outlineName when a header value itself contains ' - '", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Feature: DashValue",
      "",
      "  Scenario Outline: Greeter",
      "    Given my name is <name>",
      "",
      "    Examples:",
      "      | name          |",
      "      | Alice - Smith |"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.scenarios).toHaveLength(1);
    const s = parsed!.scenarios[0]!;
    if (!s.isScenarioOutline) {throw new Error("expected outline");}
    expect(s.outlineName).toBe("Greeter");
    expect(s.name).toContain("Alice - Smith");
  });
});

describe("isOutlineExampleRow — gating helper", () => {
  function baseFields(): Omit<RegularScenario, "isScenarioOutline"> {
    return {
      name: "x",
      line: 1,
      range: new vscode.Range(0, 0, 0, 0),
      lineNumber: 1,
      steps: [],
      filePath: "",
    };
  }
  function makeRegularScenario(overrides: Partial<RegularScenario> = {}): RegularScenario {
    return { ...baseFields(), isScenarioOutline: false, ...overrides };
  }
  function makeOutlineRow(overrides: Partial<OutlineExampleRow> = {}): OutlineExampleRow {
    return {
      ...baseFields(),
      isScenarioOutline: true,
      outlineLineNumber: 5,
      outlineName: "Outline",
      examplesBlockLineNumber: 10,
      ...overrides,
    };
  }
  function makeOutlineStub(overrides: Partial<OutlineStub> = {}): OutlineStub {
    return {
      ...baseFields(),
      isScenarioOutline: true,
      outlineLineNumber: 5,
      outlineName: "Outline",
      ...overrides,
    };
  }

  it("returns true for expanded outline rows (examplesBlockLineNumber set)", () => {
    const s: Scenario = makeOutlineRow({ examplesBlockLineNumber: 10 });
    expect(isOutlineExampleRow(s)).toBe(true);
  });

  it("returns false for the zero-Examples stub (no examplesBlockLineNumber)", () => {
    const s: Scenario = makeOutlineStub({ outlineLineNumber: 5 });
    expect(isOutlineExampleRow(s)).toBe(false);
  });

  it("returns false for plain non-outline scenarios", () => {
    const s: Scenario = makeRegularScenario();
    expect(isOutlineExampleRow(s)).toBe(false);
  });

  it("returns false for a Scenario Outline declaration that is not an expanded row", () => {
    const s: Scenario = makeOutlineStub();
    expect(isOutlineExampleRow(s)).toBe(false);
  });
});

describe("FeatureParser.parseFeatureFile — fs path sanity", () => {
  it("loads complex.feature from disk and produces the same shape as parseFeatureContent", () => {
    const parser = FeatureParser.create();
    const fixturePath = path.join(FIXTURES_DIR, "complex.feature");
    const fromFs = parser.parseFeatureFile(fixturePath);
    const fromString = parser.parseFeatureContent(fs.readFileSync(fixturePath, "utf-8"));
    expect(fromFs).not.toBeNull();
    expect(fromString).not.toBeNull();
    expect(fromFs!.feature).toBe(fromString!.feature);
    expect(fromFs!.scenarios.map((s) => s.name)).toEqual(
      fromString!.scenarios.map((s) => s.name)
    );
    // Sanity: 2 regular scenarios under the Rule + 2 expanded outline rows = 4
    expect(fromFs!.scenarios).toHaveLength(4);
  });
});

describe("FeatureParser.parseFeatureContent — filePath contract", () => {
  // The parser intentionally returns scenarios with an empty filePath. Callers (the
  // test provider) are responsible for stamping the absolute path on every scenario
  // before deriving test IDs. Regressions of this contract silently corrupt test IDs
  // in the hierarchical strategy — see addFeatureFileToTestController.
  it("leaves scenario.filePath as the empty string for the caller to populate", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Feature: Caller-populated path",
      "",
      "  Scenario: One",
      "    Given I have 0 widgets",
      "  Scenario: Two",
      "    Given I have 1 widgets"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    expect(parsed!.filePath).toBe("");
    for (const scenario of parsed!.scenarios) {
      expect(scenario.filePath).toBe("");
    }
  });

  it("yields the expected ':<line>' ID when filePath is empty, and a full ID once the caller stamps it", () => {
    const parser = FeatureParser.create();
    const content = lines(
      "Feature: ID shape",
      "",
      "  Scenario: One",
      "    Given I have 0 widgets"
    );
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    const scenario = parsed!.scenarios[0]!;

    const idBefore = `${scenario.filePath}:${scenario.lineNumber}`;
    expect(idBefore).toMatch(/^:\d+$/);

    scenario.filePath = "/abs/path/to/sample.feature";
    const idAfter = `${scenario.filePath}:${scenario.lineNumber}`;
    expect(idAfter).toMatch(/\.feature:\d+$/);
  });
});
