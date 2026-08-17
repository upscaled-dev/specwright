import { describe, expect, it } from "vitest";
import { hasReindexDiagnostic, providerWarnings } from "../../traceability/provider-warnings";

describe("providerWarnings", () => {
  it("keeps ordinary warnings readable", () => {
    expect(providerWarnings(["first", "second"])).toEqual({
      count: 2,
      detail: "first; second",
      omitted: 0,
      summary: "2 provider warnings",
    });
  });

  it("bounds huge warning collections and individual messages", () => {
    const digest = providerWarnings(Array.from({ length: 100 }, (_, index) => `${index}:${"x".repeat(10_000)}`));

    expect(digest.count).toBe(100);
    expect(digest.omitted).toBeGreaterThan(0);
    expect(digest.detail.length).toBeLessThanOrEqual(2_000);
    expect(digest.detail.split("; ")).toHaveLength(9);
    expect(digest.summary).toBe("100 provider warnings");
  });

  it("classifies only bounded reindex wording", () => {
    for (const diagnostic of ["reindex", "re-index", "reindexed", "reindexing", "re index required"]) {
      expect(hasReindexDiagnostic([`Project CALC may need to be ${diagnostic}`])).toBe(true);
    }
    expect(hasReindexDiagnostic(["Project CALC returned an ordinary warning"])).toBe(false);
    expect(hasReindexDiagnostic([...Array(64).fill("ordinary"), "reindex required"])).toBe(false);
    expect(hasReindexDiagnostic([`${"x".repeat(1_000)} reindex required`])).toBe(false);
  });

  it("never requests item 65 from a lazy diagnostic source", () => {
    let reads = 0;
    function* diagnostics(): IterableIterator<string> {
      while (true) {
        reads += 1;
        yield reads === 65 ? "reindex required" : "x";
      }
    }

    expect(hasReindexDiagnostic(diagnostics())).toBe(false);
    expect(reads).toBe(64);
  });
});
