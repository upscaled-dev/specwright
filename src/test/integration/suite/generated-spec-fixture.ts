import * as fs from "node:fs";
import * as path from "node:path";

export const SAMPLE_EXACT_TARGET = ".features-gen/features/sample.feature.spec.js:6";

function specPath(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".features-gen", "features", "sample.feature.spec.js");
}

export function removeGeneratedSpecs(workspaceRoot: string): void {
  fs.rmSync(path.join(workspaceRoot, ".features-gen"), { recursive: true, force: true });
}

/** Simulate the configured bddgen command writing a current generated spec. */
export function materializeGeneratedSpecForBddgen(
  command: string,
  workspaceRoot: string
): boolean {
  if (command.trim() !== "npx bddgen") {return false;}
  const output = specPath(workspaceRoot);
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, [
    "// Generated from: features/sample.feature",
    "const bddFileData = [ // bdd-data-start",
    '  {"pwTestLine":6,"pickleLine":6,"tags":[],"steps":[]},',
    "]; // bdd-data-end",
  ].join("\n"));
  return true;
}
