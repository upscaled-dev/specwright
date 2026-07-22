import { FeatureParser } from "../parsers/feature-parser";
import { StepResolution, StepResolver } from "./execution-importers";
import type { ScenarioRef } from "../traceability/scenario-ref";
import type { ParsedFeature } from "../types";

// Find the current source for a captured scenario ref and return its feature name + step text. An
// outline ref matches by outline name (its rows share one template); a plain scenario by title. A
// ref that no longer resolves — renamed, edited, or deleted since the run — returns undefined so the
// create-mode importer drops it rather than emit a placeholder that could overwrite stored gherkin.
export function resolveScenarioSteps(parsed: ParsedFeature, ref: ScenarioRef): StepResolution | undefined {
  const targetName = ref.outlineName ?? ref.name;
  const isOutline = ref.kind === "outline" || ref.kind === "examplesBlock";
  const match = parsed.scenarios.find((scenario) => {
    if (isOutline) {
      return scenario.isScenarioOutline && scenario.outlineName === targetName;
    }
    return !scenario.isScenarioOutline && scenario.name === ref.name;
  });
  if (match === undefined) {
    return undefined;
  }
  return { featureName: parsed.feature, steps: match.steps };
}

// Resolves scenario steps against CURRENT disk state at publish time (publish already depends on live
// disk for evidence, so publish-time resolution is consistent — the artifact schema is unchanged).
export function makeFeatureStepResolver(featureParser: FeatureParser): StepResolver {
  return (ref) => {
    const parsed = featureParser.parseFeatureFile(ref.filePath);
    return parsed ? resolveScenarioSteps(parsed, ref) : undefined;
  };
}
