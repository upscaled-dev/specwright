import { describe, it, expect } from "vitest";
import { shellQuote } from "../../utils/shell";

describe("shellQuote", () => {
  it("defaults to the current platform", () => {
    // Platform-agnostic value: identical output on both branches.
    expect(shellQuote("hello")).toBe('"hello"');
  });

  describe("posix", () => {
    it("wraps a plain value in double quotes", () => {
      expect(shellQuote("hello", "linux")).toBe('"hello"');
    });

    it("escapes double quotes", () => {
      expect(shellQuote('a"b', "linux")).toBe('"a\\"b"');
    });

    it("escapes backticks, dollars, and backslashes", () => {
      expect(shellQuote("a$b`c\\d", "linux")).toBe('"a\\$b\\`c\\\\d"');
    });

    it("handles paths with spaces", () => {
      expect(shellQuote("/Users/Name With Space/repo", "linux")).toBe(
        '"/Users/Name With Space/repo"'
      );
    });
  });

  describe("win32 (cmd.exe / CommandLineToArgvW)", () => {
    it("leaves path backslashes alone — the spec-line target must survive verbatim", () => {
      // POSIX-style doubling turned this into dir\\file…:12, a Playwright filter matching
      // nothing — the silent fallback that ran a whole outline instead of one example row.
      expect(shellQuote(".features-gen\\features\\sample.feature.spec.js:12", "win32")).toBe(
        '".features-gen\\features\\sample.feature.spec.js:12"'
      );
    });

    it("leaves regex escapes in --grep patterns alone", () => {
      expect(shellQuote("Login v2\\.0 works", "win32")).toBe('"Login v2\\.0 works"');
    });

    it("does not escape dollars or backticks (literal in cmd.exe)", () => {
      expect(shellQuote("costs $5 `today`", "win32")).toBe('"costs $5 `today`"');
    });

    it("escapes embedded double quotes", () => {
      expect(shellQuote('enter "admin" role', "win32")).toBe('"enter \\"admin\\" role"');
    });

    it("doubles a backslash run directly before a double quote", () => {
      expect(shellQuote('a\\"b', "win32")).toBe('"a\\\\\\"b"');
    });

    it("doubles a trailing backslash run so the closing quote survives", () => {
      expect(shellQuote("dir\\", "win32")).toBe('"dir\\\\"');
      expect(shellQuote("dir\\\\", "win32")).toBe('"dir\\\\\\\\"');
    });

    it("passes wildcarded outline patterns through unchanged", () => {
      expect(shellQuote("Login as .* succeeds", "win32")).toBe('"Login as .* succeeds"');
    });

    it("handles paths with spaces", () => {
      expect(shellQuote("C:\\Users\\Name With Space\\repo", "win32")).toBe(
        '"C:\\Users\\Name With Space\\repo"'
      );
    });
  });
});
