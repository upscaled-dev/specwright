import { describe, it, expect } from "vitest";
import { extractXrayKeys, projectFromKey } from "../../xray/tag-extraction";

const DEFAULTS = { testPrefix: "TEST_", reqPrefix: "REQ_" };

describe("extractXrayKeys", () => {
  it("extracts test and requirement keys from a scenario's tags", () => {
    const keys = extractXrayKeys(["@TEST_CALC-1043", "@REQ_CALC-900", "@smoke"], DEFAULTS);
    expect(keys.testKeys).toEqual(["CALC-1043"]);
    expect(keys.reqKeys).toEqual(["CALC-900"]);
  });

  it("matches prefixes case-insensitively and normalizes keys to uppercase", () => {
    const keys = extractXrayKeys(["@test_calc-1", "@Req_calc-2"], DEFAULTS);
    expect(keys.testKeys).toEqual(["CALC-1"]);
    expect(keys.reqKeys).toEqual(["CALC-2"]);
  });

  it("collapses differently-cased spellings of the same key into one canonical key", () => {
    const keys = extractXrayKeys(["@TEST_CALC-1", "@test_calc-1"], DEFAULTS);
    expect(keys.testKeys).toEqual(["CALC-1"]);
  });

  it("accepts multi-segment project keys and agrees with projectFromKey", () => {
    const keys = extractXrayKeys(["@TEST_AB-CD-123"], DEFAULTS);
    expect(keys.testKeys).toEqual(["AB-CD-123"]);
    expect(projectFromKey("AB-CD-123")).toBe("AB-CD");
  });

  it("falls back to the default prefix when the configured prefix is empty/whitespace", () => {
    const keys = extractXrayKeys(["@TEST_CALC-1", "@REQ_CALC-2"], { testPrefix: "  ", reqPrefix: "" });
    expect(keys.testKeys).toEqual(["CALC-1"]);
    expect(keys.reqKeys).toEqual(["CALC-2"]);
  });

  it("honours configurable prefixes", () => {
    const keys = extractXrayKeys(["@xt-CALC-5", "@cov-CALC-6"], { testPrefix: "xt-", reqPrefix: "cov-" });
    expect(keys.testKeys).toEqual(["CALC-5"]);
    expect(keys.reqKeys).toEqual(["CALC-6"]);
  });

  it("ignores tags that don't match the key shape", () => {
    const keys = extractXrayKeys(["@TEST_", "@TEST_nodigits", "@TESTX-1", "@wip"], DEFAULTS);
    expect(keys.testKeys).toEqual([]);
    expect(keys.reqKeys).toEqual([]);
  });

  it("does not confuse a longer prefix token with the configured one", () => {
    // "@TESTING_CALC-1" must not match prefix "TEST_" — the underscore boundary matters.
    const keys = extractXrayKeys(["@TESTING_CALC-1"], DEFAULTS);
    expect(keys.testKeys).toEqual([]);
  });

  it("dedupes repeated keys", () => {
    const keys = extractXrayKeys(["@TEST_CALC-1", "@TEST_CALC-1"], DEFAULTS);
    expect(keys.testKeys).toEqual(["CALC-1"]);
  });

  it("prefers the test prefix when a tag could match both", () => {
    const keys = extractXrayKeys(["@TEST_CALC-1"], { testPrefix: "TEST_", reqPrefix: "TEST_" });
    expect(keys.testKeys).toEqual(["CALC-1"]);
    expect(keys.reqKeys).toEqual([]);
  });
});

describe("projectFromKey", () => {
  it("derives the project from the key prefix", () => {
    expect(projectFromKey("CALC-1043")).toBe("CALC");
    expect(projectFromKey("AB12-7")).toBe("AB12");
  });
});
