import type { RunInitiator, RunIntent } from "../core/run-contracts";
import { outlineRef, scenarioRefFromScenario, type ScenarioRef } from "../traceability/scenario-ref";
import type { ParsedFeature } from "../types";

// A named target can still be grepped when the file no longer parses, but a nameless one would
// become `--grep "scenario"` and run everything. That widening is refused, loudly.
function commandScenario(
  parsed: ParsedFeature | undefined,
  filePath: string,
  lineNumber: number | undefined,
  scenarioName: string | undefined,
  outlineName: string | undefined
): ScenarioRef {
  // A scenario or example row owns exactly one line, so a matching line names it precisely. Anything
  // that only names the outline (its declaration line, or a title with no line) runs the whole outline.
  const onLine = lineNumber === undefined
    ? undefined
    : parsed?.scenarios.find((scenario) => scenario.lineNumber === lineNumber);
  if (onLine) {return scenarioRefFromScenario({ ...onLine, filePath });}
  const title = outlineName ?? scenarioName;
  const outline = parsed?.scenarios.find((scenario) =>
    scenario.isScenarioOutline &&
    (scenario.outlineLineNumber === lineNumber || scenario.outlineName === title)
  );
  if (outline?.isScenarioOutline) {return outlineRef(filePath, outline.outlineName);}
  if (outlineName) {return outlineRef(filePath, outlineName);}
  // The parse missed, so the caller's line is unverified: keeping it would scope artifact capture to
  // a line no result can carry and silently drop the run's evidence. The title still greps.
  if (scenarioName) {return { filePath, line: 0, name: scenarioName, kind: "scenario" };}
  throw new Error(
    `No scenario was found at ${filePath}:${lineNumber}. Save the feature file and run the scenario again.`
  );
}

export function scenarioRunIntent(
  parsed: ParsedFeature | undefined,
  filePath: string,
  lineNumber: number | undefined,
  scenarioName: string | undefined,
  outlineName: string | undefined,
  mode: RunIntent["mode"],
  initiatedBy: RunInitiator,
  tagExpression?: string
): RunIntent {
  if (lineNumber === undefined && outlineName === undefined) {
    return pathRunIntent(filePath, "feature", mode, initiatedBy, tagExpression);
  }
  const scenario = commandScenario(parsed, filePath, lineNumber, scenarioName, outlineName);
  return {
    mode,
    selection: { kind: "scenario", scenario, ...(tagExpression ? { tagExpression } : {}) },
    targets: [{ kind: "scenario", scenario, ...(tagExpression ? { tagExpression } : {}) }],
    metadata: { initiatedBy },
  };
}

export function pathRunIntent(
  target: string,
  selectionKind: "feature" | "folder",
  mode: RunIntent["mode"],
  initiatedBy: RunInitiator,
  tagExpression?: string
): RunIntent {
  return {
    mode,
    selection: selectionKind === "feature"
      ? { kind: "feature", filePath: target, ...(tagExpression ? { tagExpression } : {}) }
      : { kind: "folder", folderPath: target },
    targets: [{ kind: "path", path: target, ...(tagExpression ? { tagExpression } : {}) }],
    metadata: { initiatedBy },
  };
}

export function suiteRunIntent(
  mode: RunIntent["mode"],
  initiatedBy: RunInitiator,
  maxWorkers?: number
): RunIntent {
  return {
    mode,
    selection: { kind: "suite" },
    targets: [{ kind: "suite" }],
    ...(maxWorkers !== undefined ? { maxWorkers } : {}),
    metadata: { initiatedBy },
  };
}
