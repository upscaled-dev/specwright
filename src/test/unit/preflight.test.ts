import { describe, it, expect } from "vitest";
import { classifyPreflight } from "../../traceability/preflight";
import { ScenarioRef, TraceLink, TraceabilitySnapshot } from "../../traceability/traceability-model";
import { AutomationBindingClassification, TestCaseMetadata } from "../../traceability/contracts";
import { classifyXrayBinding } from "../../xray/xray-adapter";

function ref(over: Partial<ScenarioRef> = {}): ScenarioRef {
  return { filePath: "/ws/a.feature", line: 3, name: "S", kind: "scenario", ...over };
}

function link(over: Partial<TraceLink> = {}): TraceLink {
  return { testKey: "CALC-1", scenario: ref(), reqKeys: [], ...over };
}

function snapshot(over: Partial<TraceabilitySnapshot> = {}): TraceabilitySnapshot {
  return { links: [], untraced: [], orphans: [], stale: false, completeness: "complete", errors: [], ...over };
}

const gherkin: TestCaseMetadata = { key: "CALC-1", testType: { name: "Cucumber", kind: "Gherkin" } };

describe("classifyPreflight", () => {
  it("is `ready` for a mapped scenario whose target is Gherkin-compatible", () => {
    const scenario = ref();
    const snap = snapshot({ links: [link({ meta: gherkin })] });
    const items = classifyPreflight([scenario], snap, { classifyBinding: classifyXrayBinding });
    expect(items).toEqual([{ scenario, testKey: "CALC-1", state: "ready" }]);
  });

  it("is `unmapped` for an untraced scenario with no tag", () => {
    const scenario = ref({ name: "Untagged" });
    const snap = snapshot({ untraced: [{ scenario, reqKeys: [], malformedTags: [] }] });
    expect(classifyPreflight([scenario], snap)[0]?.state).toBe("unmapped");
  });

  it("is `invalid-key` for an untraced scenario carrying a broken test tag", () => {
    const scenario = ref({ name: "Broken" });
    const snap = snapshot({ untraced: [{ scenario, reqKeys: [], malformedTags: ["@TEST_nope"] }] });
    const item = classifyPreflight([scenario], snap)[0];
    expect(item?.state).toBe("invalid-key");
    expect(item?.detail).toContain("@TEST_nope");
  });

  it("is `invalid-key` for a mapped scenario whose key is verified absent on the remote", () => {
    const scenario = ref();
    const snap = snapshot({ links: [link({ remoteMissing: true })] });
    const item = classifyPreflight([scenario], snap)[0];
    expect(item).toMatchObject({ testKey: "CALC-1", state: "invalid-key" });
  });

  it("is `duplicate-mapping` when one test key covers more than one scenario", () => {
    const a = ref({ name: "A", line: 3 });
    const b = ref({ name: "B", line: 8 });
    const snap = snapshot({
      links: [link({ scenario: a, testKey: "CALC-1" }), link({ scenario: b, testKey: "CALC-1" })],
    });
    const items = classifyPreflight([a, b], snap);
    expect(items.map((i) => i.state)).toEqual(["duplicate-mapping", "duplicate-mapping"]);
  });

  it("is `duplicate-mapping` when one scenario carries more than one test key", () => {
    const scenario = ref();
    const snap = snapshot({
      links: [link({ scenario, testKey: "CALC-1" }), link({ scenario, testKey: "CALC-2" })],
    });
    expect(classifyPreflight([scenario], snap)[0]?.state).toBe("duplicate-mapping");
  });

  it("is `incompatible-test-type` for a non-Gherkin target (Xray hook)", () => {
    const scenario = ref();
    const meta: TestCaseMetadata = { key: "CALC-1", testType: { name: "Manual", kind: "Manual" } };
    const snap = snapshot({ links: [link({ meta })] });
    expect(classifyPreflight([scenario], snap, { classifyBinding: classifyXrayBinding })[0]?.state).toBe(
      "incompatible-test-type"
    );
  });

  it("is `automation-binding-required` when the hook demands a binding", () => {
    const scenario = ref();
    const hook = (): AutomationBindingClassification => "binding-required";
    const snap = snapshot({ links: [link({ meta: gherkin })] });
    expect(classifyPreflight([scenario], snap, { classifyBinding: hook })[0]?.state).toBe(
      "automation-binding-required"
    );
  });

  it("never blocks on `unknown`: a metadata-less target maps to `ready` with an honest note", () => {
    const scenario = ref();
    // Partial snapshot: the link exists but no metadata was fetched, so the Xray hook returns unknown.
    const snap = snapshot({ completeness: "partial", links: [link({ meta: undefined })] });
    const item = classifyPreflight([scenario], snap, { classifyBinding: classifyXrayBinding })[0];
    expect(item?.state).toBe("ready");
    expect(item?.detail).toMatch(/not verified/i);
  });

  it("is `ready` with no hook supplied (the neutral core makes no provider claims)", () => {
    const scenario = ref();
    const snap = snapshot({ links: [link({ meta: undefined })] });
    expect(classifyPreflight([scenario], snap)[0]?.state).toBe("ready");
  });

  it("never emits `not-in-target-plan` when no target plan is supplied", () => {
    const scenario = ref({ name: "Untagged" });
    const snap = snapshot({ untraced: [{ scenario, reqKeys: [], malformedTags: [] }] });
    expect(classifyPreflight([scenario], snap).some((i) => i.state === "not-in-target-plan")).toBe(false);
  });

  it("is `not-in-target-plan` for a mapped scenario whose key is absent from the target plan", () => {
    const inPlan = ref({ name: "InPlan", line: 3 });
    const outOfPlan = ref({ name: "OutOfPlan", line: 8 });
    const snap = snapshot({
      links: [
        link({ scenario: inPlan, testKey: "CALC-1", meta: gherkin }),
        link({ scenario: outOfPlan, testKey: "CALC-2", meta: gherkin }),
      ],
    });
    const items = classifyPreflight([inPlan, outOfPlan], snap, {
      classifyBinding: classifyXrayBinding,
      targetPlanKeys: new Set(["CALC-1"]),
    });
    expect(items.map((i) => i.state)).toEqual(["ready", "not-in-target-plan"]);
    expect(items[1]?.testKey).toBe("CALC-2");
  });

  it("ranks `invalid-key` and `duplicate-mapping` above `not-in-target-plan`", () => {
    const absent = ref({ name: "Absent" });
    const dup = ref({ name: "Dup" });
    const snap = snapshot({
      links: [
        link({ scenario: absent, testKey: "CALC-9", remoteMissing: true }),
        link({ scenario: dup, testKey: "CALC-8" }),
        link({ scenario: dup, testKey: "CALC-7" }),
      ],
    });
    // Neither key is in the plan, but the soundness/ambiguity states take precedence.
    const items = classifyPreflight([absent, dup], snap, { targetPlanKeys: new Set(["CALC-1"]) });
    expect(items.map((i) => i.state)).toEqual(["invalid-key", "duplicate-mapping"]);
  });

  it("does not false-flag two same-titled scenarios at different lines as duplicates (strict identity)", () => {
    // Both named "S" but on different lines, mapped to DIFFERENT keys, not a duplicate mapping.
    const a = ref({ name: "S", line: 3 });
    const b = ref({ name: "S", line: 8 });
    const snap = snapshot({
      links: [link({ scenario: a, testKey: "CALC-1", meta: gherkin }), link({ scenario: b, testKey: "CALC-2", meta: gherkin })],
    });
    expect(classifyPreflight([a, b], snap, { classifyBinding: classifyXrayBinding }).map((i) => i.state)).toEqual([
      "ready",
      "ready",
    ]);
  });

  it("ranks `invalid-key` above `duplicate-mapping` when a duplicate scenario also has a verified-absent key", () => {
    const scenario = ref();
    const snap = snapshot({
      links: [link({ scenario, testKey: "CALC-1" }), link({ scenario, testKey: "CALC-2", remoteMissing: true })],
    });
    const item = classifyPreflight([scenario], snap)[0];
    expect(item?.state).toBe("invalid-key");
    expect(item?.testKey).toBe("CALC-2");
  });

  it("keeps a duplicate-mapped scenario `duplicate-mapping` but surfaces an extra broken tag as a note", () => {
    const scenario = ref();
    const snap = snapshot({
      links: [
        link({ scenario, testKey: "CALC-1", malformedTags: ["@TEST_broken"] }),
        link({ scenario, testKey: "CALC-2" }),
      ],
    });
    const item = classifyPreflight([scenario], snap)[0];
    expect(item?.state).toBe("duplicate-mapping");
    expect(item?.detail).toContain("@TEST_broken");
  });

  it("keeps a linked scenario `ready` while surfacing a broken extra tag (no silent hiding)", () => {
    const scenario = ref();
    const snap = snapshot({ links: [link({ meta: gherkin, malformedTags: ["@TEST_oops"] })] });
    const item = classifyPreflight([scenario], snap, { classifyBinding: classifyXrayBinding })[0];
    expect(item?.state).toBe("ready");
    expect(item?.detail).toContain("@TEST_oops");
  });
});
