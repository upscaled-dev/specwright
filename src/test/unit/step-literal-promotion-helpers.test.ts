import { describe, it, expect } from "vitest";
import {
  findLiteralCandidates,
  findLiteralInDefPattern,
  literalOccurrenceOrdinal,
} from "../../providers/step-literal-promotion-helpers";

describe("findLiteralCandidates", () => {
  it("returns nothing for a literal-free step", () => {
    expect(findLiteralCandidates("I am on the home page")).toEqual([]);
  });

  it("detects a double-quoted string literal", () => {
    const result = findLiteralCandidates(`I press "login"`);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "string",
      text: `"login"`,
      placeholder: "{string}",
      stepStart: 8,
      stepEnd: 15,
    });
  });

  it("detects a single-quoted string literal", () => {
    const result = findLiteralCandidates(`I press 'login'`);
    expect(result).toHaveLength(1);
    expect(result[0]?.text).toBe(`'login'`);
    expect(result[0]?.placeholder).toBe("{string}");
  });

  it("detects an integer literal", () => {
    const result = findLiteralCandidates("I have 42 items");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "int",
      text: "42",
      placeholder: "{int}",
      stepStart: 7,
      stepEnd: 9,
    });
  });

  it("detects a float literal", () => {
    const result = findLiteralCandidates("the price is 3.14 dollars");
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      kind: "float",
      text: "3.14",
      placeholder: "{float}",
    });
  });

  it("surfaces multiple literals on the same line in source order", () => {
    const result = findLiteralCandidates(`I add 5 items to "cart" with weight 2.5`);
    expect(result.map((c) => c.text)).toEqual(["5", `"cart"`, "2.5"]);
    for (let i = 1; i < result.length; i++) {
      expect(result[i]!.stepStart).toBeGreaterThan(result[i - 1]!.stepStart);
    }
  });

  it("ignores digits that appear inside a string literal", () => {
    const result = findLiteralCandidates(`I see "order 42 confirmed"`);
    expect(result).toHaveLength(1);
    expect(result[0]?.kind).toBe("string");
  });

  it("ignores numbers attached to identifiers (e.g. v2, abc123)", () => {
    expect(findLiteralCandidates("I open page v2")).toEqual([]);
    expect(findLiteralCandidates("user abc123")).toEqual([]);
  });

  it("treats an integer adjacent to a float correctly", () => {
    const result = findLiteralCandidates("values 1 and 2.5");
    expect(result.map((c) => c.kind)).toEqual(["int", "float"]);
  });
});

describe("findLiteralInDefPattern", () => {
  it("finds a literal in a plain pattern", () => {
    const pos = findLiteralInDefPattern("I press login", "login", 0);
    expect(pos).toEqual({ start: 8, end: 13 });
  });

  it("finds a literal in a segment between placeholders", () => {
    const pos = findLiteralInDefPattern("I add {int} apples to {string}", "apples", 0);
    expect(pos).toBeDefined();
    expect("I add {int} apples to {string}".slice(pos!.start, pos!.end)).toBe("apples");
  });

  it("returns undefined when the literal only appears inside a placeholder name", () => {
    expect(findLiteralInDefPattern("I have {string}", "string", 0)).toBeUndefined();
  });

  it("returns undefined when the literal is absent", () => {
    expect(findLiteralInDefPattern("I have a thing", "missing", 0)).toBeUndefined();
  });

  it("treats escaped braces as literal content (not placeholders)", () => {
    const pos = findLiteralInDefPattern(String.raw`I send \{token\}`, "token", 0);
    expect(pos).toBeDefined();
  });

  it("locates a literal in the trailing segment after a placeholder", () => {
    const pos = findLiteralInDefPattern("I see {string} at home", "home", 0);
    expect(pos).toBeDefined();
    expect("I see {string} at home".slice(pos!.start, pos!.end)).toBe("home");
  });

  it("finds the Nth occurrence when the literal repeats", () => {
    expect(findLiteralInDefPattern("I move 5 by 5", "5", 0)).toEqual({ start: 7, end: 8 });
    expect(findLiteralInDefPattern("I move 5 by 5", "5", 1)).toEqual({ start: 12, end: 13 });
  });

  it("returns undefined when the requested occurrence does not exist", () => {
    expect(findLiteralInDefPattern("I move 5 by 5", "5", 2)).toBeUndefined();
  });
});

describe("literalOccurrenceOrdinal", () => {
  it("returns 0 for the first occurrence", () => {
    expect(literalOccurrenceOrdinal("I move 5 by 5", "5", 7)).toBe(0);
  });

  it("counts occurrences strictly before the literal start", () => {
    expect(literalOccurrenceOrdinal("I move 5 by 5", "5", 12)).toBe(1);
  });
});
