import { describe, it, expect } from "vitest";
import { detectTagToken } from "../../providers/tag-line-detector";

describe("detectTagToken", () => {
  it("matches a bare `@` at column 0", () => {
    const ctx = detectTagToken("@");
    expect(ctx).toEqual({ partial: "", tokenStart: 0 });
  });

  it("matches a leading-indented partial tag", () => {
    const ctx = detectTagToken("  @sm");
    expect(ctx).toEqual({ partial: "sm", tokenStart: 2 });
  });

  it("matches a partial tag after a complete tag", () => {
    const ctx = detectTagToken("  @smoke @wi");
    expect(ctx).toEqual({ partial: "wi", tokenStart: 9 });
  });

  it("matches a bare `@` after a complete tag", () => {
    const ctx = detectTagToken("  @smoke @");
    expect(ctx).toEqual({ partial: "", tokenStart: 9 });
  });

  it("rejects an empty string", () => {
    expect(detectTagToken("")).toBeUndefined();
  });

  it("rejects whitespace-only", () => {
    expect(detectTagToken("  ")).toBeUndefined();
  });

  it("rejects a comment line", () => {
    expect(detectTagToken("# comment")).toBeUndefined();
  });

  it("rejects a Given step line", () => {
    expect(detectTagToken("  Given x")).toBeUndefined();
  });

  it("rejects a Scenario header", () => {
    expect(detectTagToken("Scenario: x")).toBeUndefined();
  });

  it("rejects an inline @mention inside step text", () => {
    expect(detectTagToken("Given user @mention works")).toBeUndefined();
  });

  it("rejects a Feature header", () => {
    expect(detectTagToken("Feature: x")).toBeUndefined();
  });
});
