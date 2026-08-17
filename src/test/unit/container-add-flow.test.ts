import { describe, expect, it } from "vitest";
import { describeContainerAdd, validateContainerTargetKey } from "../../traceability/container-add-flow";
import type { KeyGrammar } from "../../traceability/contracts";

const GRAMMAR: KeyGrammar = {
  testPrefix: "TEST_",
  reqPrefix: "REQ_",
  keyShape: /^[A-Za-z][A-Za-z0-9_-]*-\d+$/,
  canonicalizeKey: (key) => key.toUpperCase(),
  projectOf: (key) => key.replace(/-\d+$/, ""),
};

describe("validateContainerTargetKey", () => {
  it("canonicalizes an exact same-project issue key", () => {
    expect(validateContainerTargetKey(" calc-90 ", "CALC", GRAMMAR)).toEqual({
      kind: "valid",
      key: "CALC-90",
    });
  });

  it("rejects malformed and cross-project values before a read", () => {
    expect(validateContainerTargetKey("CALC", "CALC", GRAMMAR)).toMatchObject({ kind: "invalid" });
    expect(validateContainerTargetKey("PAY-9", "CALC", GRAMMAR)).toEqual({
      kind: "invalid",
      message: "The target must be in project CALC.",
    });
  });
});

describe("describeContainerAdd", () => {
  it("reports the known added count against the selected count", () => {
    expect(describeContainerAdd("Test Set", "CALC-90", 2, { addedTests: ["1", "2"] })).toEqual({
      message: "Added 2 of 2 selected tests to Test Set CALC-90.",
      inspect: false,
    });
  });

  it("does not invent zero when the response list is unreadable", () => {
    const report = describeContainerAdd("Test Plan", "CALC-91", 2, {});
    expect(report.inspect).toBe(true);
    expect(report.message).toContain("did not return a readable added count");
    expect(report.message).not.toContain("0 of 2");
  });
});
