import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FeatureBasedOrganization, FileBasedOrganization, FlatOrganization,
  ScenarioTypeOrganization, TagBasedOrganization, TestOrganizationManager,
} from "../../core/test-organization";
import { FeatureParser } from "../../parsers/feature-parser";
import { Logger } from "../../utils/logger";

const source = `Feature: Checkout
  @smoke @payment
  Scenario: Pay by card
    Given a basket
  Scenario: Empty basket
    Given an empty basket
  @smoke
  Scenario Outline: Pay with <method>
    Given a <method> payment
    Examples:
      | method |
      | cash   |
      | credit |
`;

function scenarios() {
  return FeatureParser.create().parseFeatureContent(source)!.scenarios.map((scenario) => ({
    ...scenario, filePath: "/shop/checkout.feature",
  }));
}

afterEach(() => vi.restoreAllMocks());

describe("test organization", () => {
  it("groups parsed examples with regular scenarios under every matching tag", () => {
    const parsed = scenarios();
    const groups = TagBasedOrganization.create(Logger.create()).organizeTests(parsed);
    expect(groups.map(({ label, scenarios: members }) => [label, members.map((s) => s.name)]))
      .toEqual([
        ["@smoke", [parsed[0]!.name, parsed[2]!.name, parsed[3]!.name]],
        ["@payment", ["Pay by card"]],
        ["Untagged", ["Empty basket"]],
      ]);
    expect(groups[0]!.description).toBe("3 scenario(s)");
  });

  it("keeps empty discoveries and absent tags usable", () => {
    const strategy = TagBasedOrganization.create(Logger.create());
    expect(strategy.organizeTests([])).toEqual([
      { id: "group:all", label: "All Scenarios", description: "0 scenario(s)", scenarios: [] },
    ]);
    const untagged = { ...scenarios()[0]!, tags: undefined };
    expect(strategy.organizeTests([untagged])[0]).toMatchObject({ label: "Untagged", scenarios: [untagged] });
  });

  it.each([FileBasedOrganization, FeatureBasedOrganization])(
    "%s preserves distinct files with matching basenames on both path styles",
    (Strategy) => {
      const parsed = scenarios();
      const other = { ...parsed[0]!, filePath: "C:\\other\\checkout.feature" };
      const groups = Strategy.create(Logger.create()).organizeTests([...parsed, other]);
      expect(groups.map((g) => g.label)).toEqual(["checkout.feature", "checkout.feature"]);
      expect(groups[0]!.scenarios).toEqual(parsed);
      expect(groups[1]!.scenarios).toEqual([other]);
      expect(groups[0]!.id).not.toBe(groups[1]!.id);
      expect(groups[1]!.description).toBe("1 scenario(s) in C:\\other\\checkout.feature");
    },
  );

  it("separates parsed outline examples from ordinary scenarios without empty groups", () => {
    const strategy = ScenarioTypeOrganization.create(Logger.create());
    const parsed = scenarios();
    const groups = strategy.organizeTests(parsed);
    expect(groups.map((g) => [g.label, g.scenarios])).toEqual([
      ["Regular Scenarios", parsed.slice(0, 2)], ["Scenario Outlines", parsed.slice(2)],
    ]);
    expect(strategy.organizeTests(parsed.slice(0, 2))).toHaveLength(1);
    expect(strategy.organizeTests(parsed.slice(2))).toHaveLength(1);
    expect(strategy.organizeTests([])).toEqual([]);
  });

  it("switches the selected strategy while preserving scenario identities and presentation", () => {
    const manager = TestOrganizationManager.create(Logger.create());
    const parsed = scenarios();
    expect(manager.getStrategy()).toBeInstanceOf(FeatureBasedOrganization);
    for (const { strategy, description } of manager.getAvailableStrategies()) {
      manager.setStrategy(strategy);
      expect(manager.getStrategy()).toBe(strategy);
      expect(strategy.getDescription()).toBe(description);
      const groups = manager.organizeTests(parsed);
      expect(new Set(groups.flatMap((g) => g.scenarios))).toEqual(new Set(parsed));
      for (const group of groups) {
        expect(strategy.getGroupLabel(group)).toBe(group.label);
        expect(strategy.getGroupDescription(group)).toBe(group.description);
      }
    }
    expect(manager.organizeTests(parsed)[0]).toMatchObject({
      label: "All Scenarios", description: "4 scenario(s)", scenarios: parsed,
    });
  });

  it.each([new Error("strategy failed"), "strategy failed"])(
    "keeps every scenario discoverable when a custom strategy throws %s",
    (failure) => {
      const strategy = FlatOrganization.create(Logger.create());
      vi.spyOn(strategy, "organizeTests").mockImplementation(() => { throw failure; });
      const manager = TestOrganizationManager.create(Logger.create(), strategy);
      const parsed = scenarios();
      expect(manager.organizeTests(parsed)).toEqual([
        { id: "group:all", label: "All Scenarios", description: "4 scenario(s)", scenarios: parsed },
      ]);
    },
  );
});
