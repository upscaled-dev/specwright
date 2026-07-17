import { describe, it, expect } from "vitest";
import { humanizeRegexSource, patternToSnippet } from "../../providers/pattern-humanizer";

// Pins the humanize -> snippet mapping the insert-step command depends on. If these change,
// the tab-stops users get when inserting a known step change with them.
describe("insert-step snippet mapping", () => {
  it("maps a cucumber expression to a snippet with a tab-stop per parameter", () => {
    const { label, humanized } = humanizeRegexSource("I have {int} cukes", false);
    expect(humanized).toBe(true);
    expect(label).toBe("I have {int} cukes");
    expect(patternToSnippet(label)).toBe("I have ${1:int} cukes$0");
  });

  it("maps a regex-literal integer capture to {int} then a tab-stop snippet", () => {
    const { label, humanized } = humanizeRegexSource("^the count is (\\d+)$", true);
    expect(humanized).toBe(true);
    expect(label).toBe("the count is {int}");
    expect(patternToSnippet(label)).toBe("the count is ${1:int}$0");
  });

  it("maps a named capture group to a {name} tab-stop", () => {
    const { label, humanized } = humanizeRegexSource("^I have (?<count>\\d+) items$", true);
    expect(humanized).toBe(true);
    expect(label).toBe("I have {count} items");
    expect(patternToSnippet(label)).toBe("I have ${1:count} items$0");
  });

  it("passes an unconvertible regex through unchanged with humanized:false", () => {
    const result = humanizeRegexSource("^foo|bar$", true);
    expect(result.humanized).toBe(false);
    expect(result.label).toBe("^foo|bar$");
    expect(patternToSnippet(result.label)).toBe("^foo|bar$");
  });
});
