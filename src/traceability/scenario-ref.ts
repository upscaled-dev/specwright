import type { Scenario } from "../types";
import type { ScenarioResult } from "../utils/playwright-json-parser";

// A location-and-identity handle for a scenario/outline, independent of any remote metadata. Kept in
// its own vscode-free module so the preflight classifier and scope resolution stay pure; importing
// them must never transitively load the `vscode` runtime (the model does, for its tree/event plumbing).
export interface ScenarioRef {
  filePath: string;
  line: number;
  name: string;
  kind: "scenario" | "outline" | "examplesBlock";
  outlineName?: string | undefined;
  examplesBlockName?: string | undefined;
}

// Local copy of the path canonicalization (forward slashes; Windows drive-letter cased up) so this
// module pulls nothing from `playwright-json-parser`, which chains to `vscode` via the logger. Must
// stay behaviourally identical to `normalizePathKey`.
export function normalizePath(p: string): string {
  const slashed = p.replaceAll("\\", "/");
  return /^[a-z]:\//.test(slashed) ? slashed.charAt(0).toUpperCase() + slashed.slice(1) : slashed;
}

// A strict, order-stable identity string for a ref (path + line + title + kind). Used wherever refs
// must be grouped/compared by exact identity (duplicate-mapping detection and scope enumeration),
// as opposed to the fuzzy `sameScenario` used to reconcile an input ref against the snapshot.
export function refIdentity(ref: ScenarioRef): string {
  return `${normalizePath(ref.filePath)}|${ref.line}|${ref.name}|${ref.kind}`;
}

// Two refs name the same executable unit when they share a file and either the same 1-based line or
// the same title. A plain scenario never matches an outline-shaped unit. Outline rows reported by
// Playwright carry an example-row line, so the title fallback reunites outlines and Examples blocks.
export function sameScenario(a: ScenarioRef, b: ScenarioRef): boolean {
  if (normalizePath(a.filePath) !== normalizePath(b.filePath)) {return false;}
  if ((a.kind === "scenario") !== (b.kind === "scenario")) {return false;}
  if (a.line > 0 && a.line === b.line) {return true;}
  return a.name === b.name;
}

// The ScenarioRef for the executable unit a parsed scenario is. An example row keeps its own line:
// that is the only line resolving to a generated test, and it stays stable across retries and
// projects. An outline that is not a row names the whole outline, so it gets `outlineRef`.
export function scenarioRefFromScenario(scenario: Scenario): ScenarioRef {
  if (scenario.isScenarioOutline) {
    return "examplesBlockLineNumber" in scenario
      ? {
          filePath: scenario.filePath,
          line: scenario.lineNumber,
          name: scenario.outlineName,
          kind: "outline",
          outlineName: scenario.outlineName,
        }
      : outlineRef(scenario.filePath, scenario.outlineName);
  }
  return { filePath: scenario.filePath, line: scenario.lineNumber, name: scenario.name, kind: "scenario" };
}

// "Run this whole outline": no line, because an outline declaration line has no generated test behind
// it. The runner greps the outline title instead, which runs every example row.
export function outlineRef(filePath: string, outlineName: string): ScenarioRef {
  return { filePath, line: 0, name: outlineName, kind: "outline", outlineName };
}

// The ScenarioRef one reported row denotes. The live reporter and the JSON report both produce
// ScenarioResults, so keying both on this ref gives every layer one scenario identity.
export function scenarioRefFromResult(result: ScenarioResult): ScenarioRef {
  const line = result.lineNumber ?? 0;
  return result.outlineName === undefined
    ? { filePath: result.featurePath, line, name: result.scenarioName, kind: "scenario" }
    : {
        filePath: result.featurePath,
        line,
        name: result.scenarioName,
        kind: "outline",
        outlineName: result.outlineName,
      };
}
