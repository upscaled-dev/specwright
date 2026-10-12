import { describe, expect, it } from "vitest";
import { parseAddTestsToContainer, parseTestContainerTarget } from "../../xray/xray-test-containers";

describe("container response boundaries", () => {
  it.each([
    null,
    { data: null },
    { data: { getTestSets: { results: ["damaged"] } } },
    { data: { getTestSets: { results: [{ issueId: "12", jira: null }] } } },
    { data: { getTestSets: { results: [{ issueId: "12", jira: { key: "" } }] } } },
  ])("keeps protocol damage distinct from an absent test set: %j", (body) => {
    expect(parseTestContainerTarget(body, "test-set", "SHOP-1")).toEqual({ kind: "malformed" });
  });

  it("ignores null result slots while retaining a matching populated target", () => {
    const body = { data: { getTestPlans: { results: [null, { issueId: "12", jira: { key: "shop-1" } }, null] } } };
    expect(parseTestContainerTarget(body, "test-plan", "SHOP-1")).toEqual({
      kind: "found", target: { kind: "test-plan", key: "SHOP-1", issueId: "12" },
    });
  });

  it.each([null, "unavailable"])("does not invent successful additions from an invalid response: %j", (body) => {
    expect(parseAddTestsToContainer(body, "test-set")).toEqual({});
  });
});
