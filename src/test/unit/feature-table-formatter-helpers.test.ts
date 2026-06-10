import { describe, it, expect } from "vitest";
import {
  findTableBlocks,
  formatTableBlock,
} from "../../providers/feature-table-formatter-helpers";

describe("formatTableBlock", () => {
  it("formats a single-column block", () => {
    const result = formatTableBlock(["| a |", "| bb |", "| ccc |"]);
    expect(result).toEqual([
      "| a   |",
      "| bb  |",
      "| ccc |",
    ]);
  });

  it("formats a multi-column block, left-aligning text cells", () => {
    const result = formatTableBlock([
      "| name | role |",
      "| Alice | admin |",
      "| Bo | user |",
    ]);
    expect(result).toEqual([
      "| name  | role  |",
      "| Alice | admin |",
      "| Bo    | user  |",
    ]);
  });

  it("right-aligns numeric cells", () => {
    const result = formatTableBlock([
      "| n |",
      "| 1 |",
      "| 200 |",
      "| 35 |",
    ]);
    expect(result).toEqual([
      "| n   |",
      "|   1 |",
      "| 200 |",
      "|  35 |",
    ]);
  });

  it("recognises decimals and negatives as numeric", () => {
    const result = formatTableBlock([
      "| value |",
      "| -1.5 |",
      "| 0 |",
      "| 12.34 |",
    ]);
    expect(result).toEqual([
      "| value |",
      "|  -1.5 |",
      "|     0 |",
      "| 12.34 |",
    ]);
  });

  it("aligns mixed numeric/text columns independently (per cell)", () => {
    const result = formatTableBlock([
      "| label | qty |",
      "| apple | 1 |",
      "| pear  | 200 |",
    ]);
    expect(result).toEqual([
      "| label | qty |",
      "| apple |   1 |",
      "| pear  | 200 |",
    ]);
  });

  it("preserves leading indentation of the block", () => {
    const result = formatTableBlock([
      "      | a | b |",
      "      | 1 | 22 |",
    ]);
    expect(result).toEqual([
      "      | a | b  |",
      "      | 1 | 22 |",
    ]);
  });

  it("preserves escaped pipes inside cells", () => {
    const result = formatTableBlock([
      "| label |",
      String.raw`| a\|b |`,
      "| x |",
    ]);
    expect(result).toEqual([
      "| label |",
      String.raw`| a\|b  |`,
      "| x     |",
    ]);
  });

  it("pads ragged input (rows with fewer columns) to the max column count", () => {
    const result = formatTableBlock([
      "| a | b | c |",
      "| 1 | 2 |",
      "| x |",
    ]);
    expect(result).toEqual([
      "| a | b | c |",
      "| 1 | 2 |   |",
      "| x |   |   |",
    ]);
  });

  it("returns undefined when input is already formatted", () => {
    const formatted = [
      "| label  | qty |",
      "| apple  |   1 |",
      "| cherry | 200 |",
    ];
    expect(formatTableBlock(formatted)).toBeUndefined();
  });

  it("returns undefined for empty input", () => {
    expect(formatTableBlock([])).toBeUndefined();
  });
});

describe("findTableBlocks", () => {
  it("returns one block for a contiguous run of table rows", () => {
    const lines = [
      "Feature: x",
      "  | a | b |",
      "  | 1 | 2 |",
      "  | 3 | 4 |",
      "  Scenario: s",
    ];
    expect(findTableBlocks(lines, new Set())).toEqual([
      { start: 1, end: 3 },
    ]);
  });

  it("splits two blocks when a blank line separates them", () => {
    const lines = [
      "  | a |",
      "  | 1 |",
      "",
      "  | b |",
      "  | 2 |",
    ];
    expect(findTableBlocks(lines, new Set())).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 4 },
    ]);
  });

  it("splits two blocks separated by any non-table line", () => {
    const lines = [
      "  | a |",
      "  | 1 |",
      "  Examples:",
      "  | b |",
      "  | 2 |",
    ];
    expect(findTableBlocks(lines, new Set())).toEqual([
      { start: 0, end: 1 },
      { start: 3, end: 4 },
    ]);
  });

  it("treats lines in skipLines (doc strings) as non-table", () => {
    const lines = [
      "  | a |",
      "  | 1 |",
      `  """`,
      "  | not a table |",
      `  """`,
      "  | b |",
    ];
    const skip = new Set([2, 3, 4]);
    expect(findTableBlocks(lines, skip)).toEqual([
      { start: 0, end: 1 },
      { start: 5, end: 5 },
    ]);
  });

  it("returns an empty list when no table rows are present", () => {
    const lines = ["Feature: x", "  Scenario: s", "    Given step"];
    expect(findTableBlocks(lines, new Set())).toEqual([]);
  });

  it("closes a block that runs to the last line of the file", () => {
    const lines = ["  | a |", "  | 1 |"];
    expect(findTableBlocks(lines, new Set())).toEqual([{ start: 0, end: 1 }]);
  });
});
