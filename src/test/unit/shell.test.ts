import { describe, it, expect } from "vitest";
import { shellQuote } from "../../utils/shell";

describe("shellQuote", () => {
  it("wraps a plain value in double quotes", () => {
    expect(shellQuote("hello")).toBe('"hello"');
  });

  it("escapes double quotes", () => {
    expect(shellQuote('a"b')).toBe('"a\\"b"');
  });

  it("escapes backticks, dollars, and backslashes", () => {
    expect(shellQuote("a$b`c\\d")).toBe('"a\\$b\\`c\\\\d"');
  });

  it("handles paths with spaces", () => {
    expect(shellQuote("/Users/Name With Space/repo")).toBe('"/Users/Name With Space/repo"');
  });
});
