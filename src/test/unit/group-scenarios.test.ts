import { describe, it, expect } from "vitest";
import { Range } from "vscode";
import { groupScenariosByOutline } from "../../test-providers/group-scenarios";
import { OutlineExampleRow, OutlineStub, RegularScenario } from "../../types";

function baseFields(): Omit<RegularScenario, "isScenarioOutline"> {
  return {
    name: "scenario",
    line: 1,
    range: new Range(0, 0, 0, 0),
    lineNumber: 1,
    steps: [],
    filePath: "/repo/features/x.feature",
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

describe("groupScenariosByOutline", () => {
  it("returns empty map for empty input", () => {
    const result = groupScenariosByOutline([]);
    expect(result.size).toBe(0);
  });

  it("keys plain scenarios by filePath:lineNumber and gives each its own group", () => {
    const a = makeRegularScenario({ name: "A", lineNumber: 4, filePath: "/f.feature" });
    const b = makeRegularScenario({ name: "B", lineNumber: 9, filePath: "/f.feature" });
    const result = groupScenariosByOutline([a, b]);
    expect(result.size).toBe(2);
    expect(result.get("/f.feature:4")).toEqual([a]);
    expect(result.get("/f.feature:9")).toEqual([b]);
  });

  it("groups outline rows under an outlineLine:outlineName key", () => {
    const row1 = makeOutlineRow({
      name: "1: My Outline - x: 1",
      lineNumber: 10,
      outlineName: "My Outline",
      outlineLineNumber: 5,
    });
    const row2 = makeOutlineRow({
      name: "2: My Outline - x: 2",
      lineNumber: 11,
      outlineName: "My Outline",
      outlineLineNumber: 5,
    });
    const result = groupScenariosByOutline([row1, row2]);
    expect(result.size).toBe(1);
    expect(result.get("5:My Outline")).toEqual([row1, row2]);
  });

  it("keys a zero-Examples outline stub by its own line and name", () => {
    const stub = makeOutlineStub({
      name: "Lonely Outline",
      outlineLineNumber: 7,
      outlineName: "Lonely Outline",
    });
    const result = groupScenariosByOutline([stub]);
    expect(result.size).toBe(1);
    expect(result.get("7:Lonely Outline")).toEqual([stub]);
  });

  it("handles a mix of plain, outline rows, and zero-Examples stub", () => {
    const plain = makeRegularScenario({ name: "Plain", lineNumber: 3, filePath: "/m.feature" });
    const row = makeOutlineRow({
      name: "1: Outline - v: a",
      lineNumber: 15,
      filePath: "/m.feature",
      outlineName: "Outline",
      outlineLineNumber: 10,
    });
    const stub = makeOutlineStub({
      name: "EmptyOutline",
      lineNumber: 20,
      filePath: "/m.feature",
      outlineName: "EmptyOutline",
      outlineLineNumber: 20,
    });

    const result = groupScenariosByOutline([plain, row, stub]);
    expect(result.size).toBe(3);
    expect(result.get("/m.feature:3")).toEqual([plain]);
    expect(result.get("10:Outline")).toEqual([row]);
    expect(result.get("20:EmptyOutline")).toEqual([stub]);
  });
it("keeps two same-titled outlines at different lines in separate groups", () => {
    const first = makeOutlineRow({ name: "1: Dup - x: 1", lineNumber: 7, outlineName: "Dup", outlineLineNumber: 5 });
    const second = makeOutlineRow({ name: "1: Dup - x: 1", lineNumber: 22, outlineName: "Dup", outlineLineNumber: 20 });

    const result = groupScenariosByOutline([first, second]);

    expect(result.size).toBe(2);
    expect(result.get("5:Dup")).toEqual([first]);
    expect(result.get("20:Dup")).toEqual([second]);
  });
});
