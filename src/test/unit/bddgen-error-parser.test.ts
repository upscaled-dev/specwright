import { describe, it, expect } from "vitest";
import { parseBddgenErrors } from "../../providers/bddgen-error-parser";

describe("parseBddgenErrors", () => {
  it("returns an empty array for empty input", () => {
    expect(parseBddgenErrors("")).toEqual([]);
  });

  it("returns an empty array when no parseable patterns are present", () => {
    const output = "Something went wrong\nNo files found\nTry again\n";
    expect(parseBddgenErrors(output)).toEqual([]);
  });

  it("parses the gherkin block format and converts 1-based lines to 0-based", () => {
    const output = [
      "Error parsing feature file: /repo/features/foo.feature",
      "Parser errors:",
      "(12:4): expected: #EOF, #Language, #TagLine, ... got 'invalid line'",
    ].join("\n");
    const errors = parseBddgenErrors(output);
    expect(errors).toEqual([
      {
        filePath: "/repo/features/foo.feature",
        line: 11,
        column: 3,
        message: "expected: #EOF, #Language, #TagLine, ... got 'invalid line'",
      },
    ]);
  });

  it("parses the single-line `path:line:col - message` format", () => {
    const output = "/repo/features/bar.feature:5:3 - unexpected token 'Scenarioo'";
    const errors = parseBddgenErrors(output);
    expect(errors).toEqual([
      {
        filePath: "/repo/features/bar.feature",
        line: 4,
        column: 2,
        message: "unexpected token 'Scenarioo'",
      },
    ]);
  });

  it("parses the MSBuild-style `path(line,col): error message` format", () => {
    const output = "/repo/features/baz.feature(7,1): error missing scenario header";
    const errors = parseBddgenErrors(output);
    expect(errors).toEqual([
      {
        filePath: "/repo/features/baz.feature",
        line: 6,
        column: 0,
        message: "missing scenario header",
      },
    ]);
  });

  it("strips ANSI color codes before parsing", () => {
    const output =
      "[31mError parsing feature file: /repo/features/x.feature[0m\n" +
      "Parser errors:\n" +
      "[33m(3:1): expected something[0m\n";
    const errors = parseBddgenErrors(output);
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatchObject({
      filePath: "/repo/features/x.feature",
      line: 2,
      column: 0,
      message: "expected something",
    });
  });

  it("dedupes identical (filePath, line, message) tuples across formats", () => {
    const output = [
      "Error parsing feature file: /repo/features/dup.feature",
      "Parser errors:",
      "(2:1): something broke",
      "/repo/features/dup.feature:2:1 - something broke",
    ].join("\n");
    const errors = parseBddgenErrors(output);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.filePath).toBe("/repo/features/dup.feature");
  });

  it("extracts multiple tuples from a single gherkin block", () => {
    const output = [
      "Error parsing feature file: /repo/features/multi.feature",
      "Parser errors:",
      "(2:1): first error",
      "(10:5): second error",
    ].join("\n");
    const errors = parseBddgenErrors(output);
    expect(errors).toHaveLength(2);
    expect(errors[0]?.line).toBe(1);
    expect(errors[1]?.line).toBe(9);
    expect(errors[1]?.column).toBe(4);
  });

  it("handles multiple gherkin blocks for different files", () => {
    const output = [
      "Error parsing feature file: /repo/features/a.feature",
      "Parser errors:",
      "(2:1): bad",
      "Error parsing feature file: /repo/features/b.feature",
      "Parser errors:",
      "(4:1): worse",
    ].join("\n");
    const errors = parseBddgenErrors(output);
    expect(errors).toHaveLength(2);
    expect(errors[0]?.filePath).toBe("/repo/features/a.feature");
    expect(errors[1]?.filePath).toBe("/repo/features/b.feature");
  });
});
