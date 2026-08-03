import { describe, it, expect } from "vitest";
import { opensScenario, scenarioGherkinSlice, scenarioScope } from "../../parsers/gherkin-slice";

describe("scenarioGherkinSlice", () => {
  const lines = (feature: string): string[] => feature.split("\n");

  it("slices a plain scenario from its keyword line through its steps, excluding the preceding tag lines", () => {
    const feature =
      "Feature: F\n\n@smoke @REQ_CALC-9\nScenario: Login\n  Given a user\n  When they log in\n  Then ok\n\nScenario: Other\n  Given x\n";
    expect(scenarioGherkinSlice(lines(feature), 4)).toBe(
      "Scenario: Login\n  Given a user\n  When they log in\n  Then ok"
    );
  });

  it("keeps a Scenario Outline's Examples tables and tagged Examples blocks, stopping at the next scenario's tags", () => {
    const feature = [
      "Feature: F",
      "",
      "Scenario Outline: Add",
      "  Given <a>",
      "  Then <b>",
      "",
      "  Examples:",
      "    | a | b |",
      "    | 1 | 2 |",
      "",
      "  @edge",
      "  Examples: edge",
      "    | a | b |",
      "    | 9 | 9 |",
      "",
      "@wip",
      "Scenario: Next",
      "  Given z",
    ].join("\n");

    const slice = scenarioGherkinSlice(lines(feature), 3);

    expect(slice).toContain("Scenario Outline: Add");
    expect(slice).toContain("@edge");
    expect(slice).toContain("Examples: edge");
    expect(slice).toContain("| 9 | 9 |");
    expect(slice).not.toContain("@wip");
    expect(slice).not.toContain("Scenario: Next");
  });

  it("includes doc-strings and data tables verbatim and stops at a following Rule", () => {
    const feature = [
      "Feature: F",
      "",
      "Scenario: Payload",
      "  Given a request:",
      '    """',
      '    { "k": 1 }',
      '    """',
      "  And rows:",
      "    | x |",
      "    | 1 |",
      "",
      "Rule: R",
      "  Scenario: Inner",
      "    Given y",
    ].join("\n");

    const slice = scenarioGherkinSlice(lines(feature), 3);

    expect(slice).toContain('"""');
    expect(slice).toContain('{ "k": 1 }');
    expect(slice).toContain("| 1 |");
    expect(slice).not.toContain("Rule: R");
    expect(slice).not.toContain("Scenario: Inner");
  });

  it("strips carriage returns so a CRLF document yields clean \\n-joined text", () => {
    const feature = "Feature: F\r\n\r\nScenario: A\r\n  Given x\r\n";
    expect(scenarioGherkinSlice(feature.split("\n"), 3)).toBe("Scenario: A\n  Given x");
  });

  it("slices the last scenario in a file to EOF, trimming trailing blank lines", () => {
    const feature = "Feature: F\n\nScenario: Last\n  Given x\n\n\n";
    expect(scenarioGherkinSlice(feature.split("\n"), 3)).toBe("Scenario: Last\n  Given x");
  });

  it("keeps a doc-string whose body line reads like a scenario, and still terminates at the next real scenario", () => {
    const feature = [
      "Feature: F",
      "",
      "Scenario: Has a docstring",
      "  Given a payload:",
      '    """',
      "    Scenario: not a real one",
      "    still inside the string",
      '    """',
      "  Then ok",
      "",
      "Scenario: Real next",
      "  Given z",
    ].join("\n");

    const slice = scenarioGherkinSlice(feature.split("\n"), 3);

    expect(slice).toContain("Scenario: not a real one");
    expect(slice).toContain("still inside the string");
    expect(slice.match(/"""/g)).toHaveLength(2);
    expect(slice).toContain("Then ok");
    expect(slice).not.toContain("Scenario: Real next");
  });

  it("keeps a doc-string body line that looks like a tag, and terminates at the next scenario's tags", () => {
    const feature = [
      "Feature: F",
      "",
      "Scenario: Tag-in-string",
      "  Given a note:",
      '    """',
      "    @not-a-tag lives in prose",
      '    """',
      "",
      "@wip",
      "Scenario: Next",
      "  Given z",
    ].join("\n");

    const slice = scenarioGherkinSlice(feature.split("\n"), 3);

    expect(slice).toContain("@not-a-tag lives in prose");
    expect(slice).not.toContain("@wip");
    expect(slice).not.toContain("Scenario: Next");
  });

  it("keeps doc-string prose beginning with Feature/Rule-style words", () => {
    const feature = [
      "Feature: F",
      "",
      "Scenario: Prose",
      "  Given docs:",
      '    """',
      "    Feature flags are described here",
      "    Rule of thumb: keep it short",
      '    """',
      "  Then ok",
      "",
      "Rule: R",
      "  Scenario: Inner",
      "    Given y",
    ].join("\n");

    const slice = scenarioGherkinSlice(feature.split("\n"), 3);

    expect(slice).toContain("Feature flags are described here");
    expect(slice).toContain("Rule of thumb: keep it short");
    expect(slice).toContain("Then ok");
    expect(slice).not.toContain("Rule: R");
    expect(slice).not.toContain("Scenario: Inner");
  });

  it("handles a backtick-fenced doc-string the same way as a triple-quote one", () => {
    const feature = [
      "Feature: F",
      "",
      "Scenario: Backtick docstring",
      "  Given json:",
      "    ```",
      "    Scenario: still prose",
      "    @nope",
      "    ```",
      "  Then ok",
      "",
      "Scenario: Next",
      "  Given z",
    ].join("\n");

    const slice = scenarioGherkinSlice(feature.split("\n"), 3);

    expect(slice).toContain("Scenario: still prose");
    expect(slice).toContain("@nope");
    expect(slice.match(/```/g)).toHaveLength(2);
    expect(slice).toContain("Then ok");
    expect(slice).not.toContain("Scenario: Next");
  });

  it("does not close a \"\"\"-fenced doc-string at a bare backtick line, nor a backtick fence at a bare \"\"\" line", () => {
    const tripleQuoted = [
      "Feature: F",
      "",
      "Scenario: Quote fence",
      "  Given a payload:",
      '    """',
      "    ```",
      "    still inside the quote fence",
      '    """',
      "  Then ok",
      "",
      "Scenario: Next",
      "  Given z",
    ].join("\n");

    const quoteSlice = scenarioGherkinSlice(tripleQuoted.split("\n"), 3);

    expect(quoteSlice).toContain("```");
    expect(quoteSlice).toContain("still inside the quote fence");
    expect(quoteSlice.match(/"""/g)).toHaveLength(2);
    expect(quoteSlice).toContain("Then ok");
    expect(quoteSlice).not.toContain("Scenario: Next");

    const backtickFenced = [
      "Feature: F",
      "",
      "Scenario: Backtick fence",
      "  Given a payload:",
      "    ```",
      '    """',
      "    still inside the backtick fence",
      "    ```",
      "  Then ok",
      "",
      "Scenario: Next",
      "  Given z",
    ].join("\n");

    const backtickSlice = scenarioGherkinSlice(backtickFenced.split("\n"), 3);

    expect(backtickSlice).toContain('"""');
    expect(backtickSlice).toContain("still inside the backtick fence");
    expect(backtickSlice.match(/```/g)).toHaveLength(2);
    expect(backtickSlice).toContain("Then ok");
    expect(backtickSlice).not.toContain("Scenario: Next");
  });

  it("trims trailing blank and comment-only lines so a stray comment between scenarios is left out", () => {
    const feature = [
      "Feature: F",
      "",
      "Scenario: A",
      "  Given x",
      "",
      "# a stray comment between scenarios",
      "",
      "Scenario: B",
      "  Given y",
    ].join("\n");

    expect(scenarioGherkinSlice(feature.split("\n"), 3)).toBe("Scenario: A\n  Given x");
  });
  // `Example:` is a scenario keyword to the parser, so it has to be a slice boundary too: without it an
  // untagged Example-keyword scenario swallows every scenario below it, and that string is both the
  // drift baseline and the push payload.
  it("ends an Example-keyword scenario's slice before the next untagged Example-keyword scenario", () => {
    const feature = [
      "Feature: F",
      "",
      "Example: First",
      "  Given x",
      "",
      "Example: Second",
      "  Given y",
    ].join("\n");

    expect(scenarioGherkinSlice(lines(feature), 3)).toBe("Example: First\n  Given x");
    expect(scenarioGherkinSlice(lines(feature), 6)).toBe("Example: Second\n  Given y");
  });

  it("keeps an untagged Examples table inside its outline, which the Example boundary must not steal", () => {
    const feature = [
      "Feature: F",
      "",
      "Scenario Outline: Add",
      "  Given <a>",
      "  Examples:",
      "    | a |",
      "    | 1 |",
      "",
      "Example: Next",
      "  Given z",
    ].join("\n");

    expect(scenarioGherkinSlice(lines(feature), 3)).toBe(
      "Scenario Outline: Add\n  Given <a>\n  Examples:\n    | a |\n    | 1 |"
    );
  });
});

describe("scenarioScope", () => {
  const lines = (feature: string): string[] => feature.split("\n");

  // The blank line above a tag block belongs to the scenario the tags introduce, so a cursor resting
  // in the gap resolves to the scenario below it rather than the one that just ended.
  it("starts at the leading tag lines and ends on the last line of the block", () => {
    const feature = [
      "Feature: F",   // 0
      "",             // 1
      "@smoke",       // 2
      "@REQ_CALC-9",  // 3
      "Scenario: Login", // 4
      "  Given a user",  // 5
      "",                // 6
      "Scenario: Other", // 7
    ].join("\n");

    expect(scenarioScope(lines(feature), 5)).toEqual({ start: 1, end: 5 });
  });

  it("collapses to the keyword line for a scenario with no body", () => {
    const feature = ["Feature: F", "Scenario: Empty", "Scenario: Next", "  Given z"].join("\n");

    expect(scenarioScope(lines(feature), 2)).toEqual({ start: 1, end: 1 });
  });

  it("runs the last scenario to the end of the file, trailing blank lines excluded", () => {
    const feature = ["Feature: F", "Scenario: Last", "  Given a step", "", ""].join("\n");

    expect(scenarioScope(lines(feature), 2)).toEqual({ start: 1, end: 2 });
  });

  // An unterminated doc string makes the fence-aware scan run to end of file. The scope still has to
  // stop before the next scenario, or two scopes would claim the same lines and a cursor in the second
  // would resolve to the first.
  it("clamps at the next block when a doc string never closes", () => {
    const feature = [
      "Feature: F",        // 0
      "Scenario: Broken",  // 1
      "  Then the text is:", // 2
      "    \"\"\"",        // 3
      "    unterminated",  // 4
      "",                  // 5
      "@wip",              // 6
      "Scenario: Next",    // 7
      "  Given z",         // 8
    ].join("\n");

    const broken = scenarioScope(lines(feature), 2);
    const next = scenarioScope(lines(feature), 8);

    expect(broken.end).toBeLessThan(next.start);
    expect(broken).toEqual({ start: 1, end: 4 });
    expect(next).toEqual({ start: 5, end: 8 });
  });
});

describe("opensScenario", () => {
  it("accepts every scenario keyword synonym, ignoring indentation and a CRLF terminator", () => {
    expect(opensScenario("Scenario: Log in", "Log in")).toBe(true);
    expect(opensScenario("    Scenario Outline: Add", "Add")).toBe(true);
    expect(opensScenario("Scenario Template: Add", "Add")).toBe(true);
    expect(opensScenario("Example: Add\r", "Add")).toBe(true);
  });

  it("refuses a line that merely ends with the name, which a suffix match would have taken", () => {
    expect(opensScenario("# Scenario: Log in", "Log in")).toBe(false);
    expect(opensScenario("Rule: Log in", "Log in")).toBe(false);
    expect(opensScenario("Examples: Log in", "Log in")).toBe(false);
    expect(opensScenario("Scenario: Please log in", "log in")).toBe(false);
  });

  it("refuses a different scenario, a missing line, and a blank one", () => {
    expect(opensScenario("Scenario: Checkout", "Log in")).toBe(false);
    expect(opensScenario(undefined, "Log in")).toBe(false);
    expect(opensScenario("", "Log in")).toBe(false);
  });
});
