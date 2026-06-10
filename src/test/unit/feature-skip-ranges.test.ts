import { describe, it, expect } from "vitest";
import { computeSkipRanges } from "../../providers/feature-skip-ranges";

describe("computeSkipRanges", () => {
  it("returns an empty-ish set for a feature with only step lines", () => {
    const text = [
      "Feature: A",
      "  Scenario: S",
      "    Given a step",
      "    When another",
      "    Then result",
    ].join("\n");
    const skip = computeSkipRanges(text);
    expect(skip.has(2)).toBe(false);
    expect(skip.has(3)).toBe(false);
    expect(skip.has(4)).toBe(false);
  });

  it("skips lines inside a triple-quoted doc string block", () => {
    const text = [
      "Feature: A",
      "  Scenario: S",
      "    Given a doc string:",
      `      """`,
      "      Given this is not a step",
      "      And neither is this",
      `      """`,
      "    When the next step runs",
    ].join("\n");
    const skip = computeSkipRanges(text);
    expect(skip.has(3)).toBe(true);
    expect(skip.has(4)).toBe(true);
    expect(skip.has(5)).toBe(true);
    expect(skip.has(6)).toBe(true);
    expect(skip.has(7)).toBe(false);
  });

  it("skips data table rows starting with |", () => {
    const text = [
      "Feature: A",
      "  Scenario: S",
      "    Given a table:",
      "      | a | b |",
      "      | 1 | 2 |",
      "    When done",
    ].join("\n");
    const skip = computeSkipRanges(text);
    expect(skip.has(3)).toBe(true);
    expect(skip.has(4)).toBe(true);
    expect(skip.has(5)).toBe(false);
  });

  it("skips comment lines starting with #", () => {
    const text = [
      "Feature: A",
      "# a top-level comment",
      "  Scenario: S",
      "    # commented step",
      "    Given a real step",
    ].join("\n");
    const skip = computeSkipRanges(text);
    expect(skip.has(1)).toBe(true);
    expect(skip.has(3)).toBe(true);
    expect(skip.has(4)).toBe(false);
  });

  it("skips Examples header and its rows", () => {
    const text = [
      "Feature: A",
      "  Scenario Outline: S",
      "    Given <input>",
      "    Examples:",
      "      | input |",
      "      | foo   |",
      "      | bar   |",
    ].join("\n");
    const skip = computeSkipRanges(text);
    expect(skip.has(3)).toBe(true);
    expect(skip.has(4)).toBe(true);
    expect(skip.has(5)).toBe(true);
    expect(skip.has(6)).toBe(true);
    expect(skip.has(2)).toBe(false);
  });

  it("treats empty lines as skippable", () => {
    const text = ["Feature: A", "", "  Scenario: S", "    Given x"].join("\n");
    const skip = computeSkipRanges(text);
    expect(skip.has(1)).toBe(true);
    expect(skip.has(3)).toBe(false);
  });

  it("handles mixed doc-string + table + comments", () => {
    const text = [
      "Feature: A",
      "  Scenario: S",
      "    # comment",
      "    Given a step",
      `      """`,
      "      body",
      `      """`,
      "    When table:",
      "      | a |",
      "      | 1 |",
      "    Then done",
    ].join("\n");
    const skip = computeSkipRanges(text);
    expect(skip.has(2)).toBe(true);
    expect(skip.has(3)).toBe(false);
    expect(skip.has(4)).toBe(true);
    expect(skip.has(5)).toBe(true);
    expect(skip.has(6)).toBe(true);
    expect(skip.has(7)).toBe(false);
    expect(skip.has(8)).toBe(true);
    expect(skip.has(9)).toBe(true);
    expect(skip.has(10)).toBe(false);
  });

  it("returns an empty set for an empty file", () => {
    const skip = computeSkipRanges("");
    expect(skip.has(0)).toBe(true);
    expect(skip.size).toBe(1);
  });
});
