import { describe, it, expect } from "vitest";
import { humanizeRegexSource, patternToSnippet } from "../../providers/pattern-humanizer";

describe("humanizeRegexSource", () => {
  it("returns Cucumber expressions unchanged when isRegex=false", () => {
    const result = humanizeRegexSource("I have {int} users", false);
    expect(result).toEqual({ label: "I have {int} users", humanized: true });
  });

  it("strips leading ^ and trailing $", () => {
    const result = humanizeRegexSource("^I am ready$", true);
    expect(result.label).toBe("I am ready");
    expect(result.humanized).toBe(true);
  });

  it("converts named groups to {name}", () => {
    const result = humanizeRegexSource("^I have (?<count>\\d+) items$", true);
    expect(result.label).toBe("I have {count} items");
    expect(result.humanized).toBe(true);
  });

  it("converts (\\d+) to {int}", () => {
    const result = humanizeRegexSource("^count is (\\d+)$", true);
    expect(result.label).toBe("count is {int}");
    expect(result.humanized).toBe(true);
  });

  it("converts (\\d+\\.\\d+) to {float}", () => {
    const result = humanizeRegexSource("^price is (\\d+\\.\\d+)$", true);
    expect(result.label).toBe("price is {float}");
    expect(result.humanized).toBe(true);
  });

  it("converts ([\\d.]+) to {float}", () => {
    const result = humanizeRegexSource("^ratio ([\\d.]+)$", true);
    expect(result.label).toBe("ratio {float}");
    expect(result.humanized).toBe(true);
  });

  it("converts \"([^\"]*)\" to \"{string}\"", () => {
    const result = humanizeRegexSource(`^I click "([^"]*)"$`, true);
    expect(result.label).toBe(`I click "{string}"`);
    expect(result.humanized).toBe(true);
  });

  it("converts '([^']*)' to '{string}'", () => {
    const result = humanizeRegexSource(`^I click '([^']*)'$`, true);
    expect(result.label).toBe(`I click '{string}'`);
    expect(result.humanized).toBe(true);
  });

  it("converts (.+?) to {}", () => {
    const result = humanizeRegexSource("^I do (.+?) thing$", true);
    expect(result.label).toBe("I do {} thing");
    expect(result.humanized).toBe(true);
  });

  it("collapses \\s+ to a single space", () => {
    const result = humanizeRegexSource("^I have\\s+items$", true);
    expect(result.label).toBe("I have items");
    expect(result.humanized).toBe(true);
  });

  it("falls back when regex still contains metachars after substitution", () => {
    const result = humanizeRegexSource("^foo|bar$", true);
    expect(result.humanized).toBe(false);
    expect(result.label).toBe("^foo|bar$");
  });

  it("falls back on complex regex with character classes", () => {
    const result = humanizeRegexSource("^[a-z]+ thing$", true);
    expect(result.humanized).toBe(false);
    expect(result.label).toBe("^[a-z]+ thing$");
  });
});

describe("patternToSnippet", () => {
  it("returns label unchanged when no placeholders", () => {
    expect(patternToSnippet("I am ready")).toBe("I am ready");
  });

  it("converts {int} to ${1:int} and appends $0", () => {
    expect(patternToSnippet("I have {int} users")).toBe("I have ${1:int} users$0");
  });

  it("converts multiple placeholders with sequential indices", () => {
    expect(patternToSnippet(`I have {int} and "{string}"`)).toBe(
      `I have \${1:int} and "\${2:string}"$0`
    );
  });

  it("converts {} to ${N:arg}", () => {
    expect(patternToSnippet("do {} thing")).toBe("do ${1:arg} thing$0");
  });

  it("converts custom named placeholders", () => {
    expect(patternToSnippet("I have {count} items")).toBe("I have ${1:count} items$0");
  });

  it("escapes $ in literal text so it is not parsed as a tabstop", () => {
    expect(patternToSnippet("I pay $5 for {int} items")).toBe(
      String.raw`I pay \$5 for ${"${1:int}"} items$0`
    );
  });

  it("escapes bare } and \\ in literal text", () => {
    expect(patternToSnippet(String.raw`press } and C:\tmp with {word}`)).toBe(
      String.raw`press \} and C:\\tmp with ${"${1:word}"}$0`
    );
  });

  it("leaves a placeholder-free label unchanged even when it contains $", () => {
    expect(patternToSnippet("I pay $5")).toBe("I pay $5");
  });
});
