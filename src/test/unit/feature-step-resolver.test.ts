import { describe, it, expect } from "vitest";
import { FeatureParser } from "../../parsers/feature-parser";
import { resolveScenarioSteps } from "../../xray/feature-step-resolver";
import type { ParsedFeature } from "../../types";
import type { ScenarioRef } from "../../traceability/scenario-ref";

function parse(content: string): ParsedFeature {
  const parsed = FeatureParser.create().parseFeatureContent(content);
  if (parsed === null) {
    throw new Error("fixture failed to parse");
  }
  return parsed;
}

const SCENARIO = parse(
  "Feature: Calculator\n\n@TEST_CALC-1\nScenario: Add two numbers\n  Given a calculator\n  When I add 2 and 3\n  Then I see 5\n"
);

const OUTLINE = parse(
  "Feature: Calculator\n\n@TEST_CALC-2\nScenario Outline: Multiply\n  When I multiply <a> by <b>\n  Then the result is <r>\n  Examples:\n    | a | b | r |\n    | 2 | 3 | 6 |\n    | 4 | 5 | 20 |\n"
);

function ref(name: string, kind: ScenarioRef["kind"], outlineName?: string): ScenarioRef {
  return { filePath: "/ws/calc.feature", line: 4, name, kind, ...(outlineName !== undefined ? { outlineName } : {}) };
}

describe("resolveScenarioSteps", () => {
  it("resolves a plain scenario by title, returning the feature name and current step text", () => {
    expect(resolveScenarioSteps(SCENARIO, ref("Add two numbers", "scenario"))).toEqual({
      featureName: "Calculator",
      steps: ["Given a calculator", "When I add 2 and 3", "Then I see 5"],
    });
  });

  it("returns undefined when the scenario no longer exists (renamed/deleted since the run)", () => {
    expect(resolveScenarioSteps(SCENARIO, ref("Subtract two numbers", "scenario"))).toBeUndefined();
  });

  it("resolves an outline by its outline name (rows share one template)", () => {
    const resolution = resolveScenarioSteps(OUTLINE, ref("Multiply", "outline", "Multiply"));
    expect(resolution?.featureName).toBe("Calculator");
    expect(resolution?.steps).toEqual(["When I multiply <a> by <b>", "Then the result is <r>"]);
  });

  it("returns undefined for an outline whose name changed", () => {
    expect(resolveScenarioSteps(OUTLINE, ref("Divide", "outline", "Divide"))).toBeUndefined();
  });
});
