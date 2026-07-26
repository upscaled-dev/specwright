import { describe, it, expect } from "vitest";
import { extractKeys, KeyExtractionGrammar, malformedTestTags } from "../../traceability/tag-extraction";
import { JIRA_KEY_SHAPE, projectFromKey } from "../../xray/xray-adapter";

const upper = (key: string): string => key.toUpperCase();
const DEFAULTS: KeyExtractionGrammar = {
  testPrefix: "TEST_",
  reqPrefix: "REQ_",
  keyShape: JIRA_KEY_SHAPE,
  canonicalizeKey: upper,
};

describe("extractKeys", () => {
  it("extracts test and requirement keys from a scenario's tags", () => {
    const keys = extractKeys(["@TEST_CALC-1043", "@REQ_CALC-900", "@smoke"], DEFAULTS);
    expect(keys.testKeys).toEqual(["CALC-1043"]);
    expect(keys.reqKeys).toEqual(["CALC-900"]);
  });

  it("matches prefixes case-insensitively and canonicalizes keys via the grammar", () => {
    const keys = extractKeys(["@test_calc-1", "@Req_calc-2"], DEFAULTS);
    expect(keys.testKeys).toEqual(["CALC-1"]);
    expect(keys.reqKeys).toEqual(["CALC-2"]);
  });

  it("collapses differently-cased spellings of the same key into one canonical key", () => {
    const keys = extractKeys(["@TEST_CALC-1", "@test_calc-1"], DEFAULTS);
    expect(keys.testKeys).toEqual(["CALC-1"]);
  });

  it("accepts multi-segment project keys and agrees with projectFromKey", () => {
    const keys = extractKeys(["@TEST_AB-CD-123"], DEFAULTS);
    expect(keys.testKeys).toEqual(["AB-CD-123"]);
    expect(projectFromKey("AB-CD-123")).toBe("AB-CD");
  });

  it("honours configurable prefixes", () => {
    const keys = extractKeys(["@xt-CALC-5", "@cov-CALC-6"], { testPrefix: "xt-", reqPrefix: "cov-", keyShape: JIRA_KEY_SHAPE, canonicalizeKey: upper });
    expect(keys.testKeys).toEqual(["CALC-5"]);
    expect(keys.reqKeys).toEqual(["CALC-6"]);
  });

  it("ignores tags that don't match the key shape", () => {
    const keys = extractKeys(["@TEST_", "@TEST_nodigits", "@TESTX-1", "@wip"], DEFAULTS);
    expect(keys.testKeys).toEqual([]);
    expect(keys.reqKeys).toEqual([]);
  });

  it("does not confuse a longer prefix token with the configured one", () => {
    // "@TESTING_CALC-1" must not match prefix "TEST_"; the underscore boundary matters.
    const keys = extractKeys(["@TESTING_CALC-1"], DEFAULTS);
    expect(keys.testKeys).toEqual([]);
  });

  it("dedupes repeated keys", () => {
    const keys = extractKeys(["@TEST_CALC-1", "@TEST_CALC-1"], DEFAULTS);
    expect(keys.testKeys).toEqual(["CALC-1"]);
  });

  it("prefers the test prefix when a tag could match both", () => {
    const keys = extractKeys(["@TEST_CALC-1"], { testPrefix: "TEST_", reqPrefix: "TEST_", keyShape: JIRA_KEY_SHAPE, canonicalizeKey: upper });
    expect(keys.testKeys).toEqual(["CALC-1"]);
    expect(keys.reqKeys).toEqual([]);
  });

  it("neutralizes a supplied keyShape carrying stateful g/y flags", () => {
    // A `g`/`y` flag makes RegExp.test stateful via lastIndex; without neutralizing it, matching the
    // same shape across successive tags would flip between hit and miss.
    const stateful: KeyExtractionGrammar = { ...DEFAULTS, keyShape: /^[A-Z]+-\d+$/gy };
    const first = extractKeys(["@TEST_AB-1"], stateful);
    const second = extractKeys(["@TEST_AB-2"], stateful);
    expect(first.testKeys).toEqual(["AB-1"]);
    expect(second.testKeys).toEqual(["AB-2"]);
  });
});

describe("malformedTestTags", () => {
  it("flags test-prefixed tags whose key body fails the shape", () => {
    expect(malformedTestTags(["@TEST_", "@TEST_nodigits", "@TEST_CALC-1", "@wip"], DEFAULTS)).toEqual([
      "@TEST_",
      "@TEST_nodigits",
    ]);
  });

  it("ignores a bare key-shaped tag with no test prefix (a valid convention, not a broken tag)", () => {
    expect(malformedTestTags(["@APEX-5", "@REQ_CALC-9"], DEFAULTS)).toEqual([]);
  });

  it("does not treat a longer prefix token as the configured prefix", () => {
    expect(malformedTestTags(["@TESTING_oops"], DEFAULTS)).toEqual([]);
  });
});
