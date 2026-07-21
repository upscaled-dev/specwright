import type { Scenario } from "../types";

// A location-and-identity handle for a scenario/outline, independent of any remote metadata. Kept in
// its own vscode-free module so the preflight classifier and scope resolution stay pure — importing
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
// must be grouped/compared by exact identity — duplicate-mapping detection and scope enumeration —
// as opposed to the fuzzy `sameScenario` used to reconcile an input ref against the snapshot.
export function refIdentity(ref: ScenarioRef): string {
  return `${normalizePath(ref.filePath)}|${ref.line}|${ref.name}|${ref.kind}`;
}

// Two refs name the same scenario when they share a file and either the same 1-based line or the
// same title. The line is authoritative for plain scenarios; outline rows reported by Playwright
// carry an example-row line (not the `Scenario Outline:` line), so the title fallback reunites them.
export function sameScenario(a: ScenarioRef, b: ScenarioRef): boolean {
  if (normalizePath(a.filePath) !== normalizePath(b.filePath)) {return false;}
  if (a.line > 0 && a.line === b.line) {return true;}
  return a.name === b.name;
}

// The ScenarioRef the model would derive for a parsed scenario — outlines collapse to one ref keyed
// on the outline declaration line/title, matching `buildTraceabilitySnapshot`.
export function scenarioRefFromScenario(scenario: Scenario): ScenarioRef {
  if (scenario.isScenarioOutline) {
    return {
      filePath: scenario.filePath,
      line: scenario.outlineLineNumber,
      name: scenario.outlineName,
      kind: "outline",
      outlineName: scenario.outlineName,
    };
  }
  return { filePath: scenario.filePath, line: scenario.lineNumber, name: scenario.name, kind: "scenario" };
}
