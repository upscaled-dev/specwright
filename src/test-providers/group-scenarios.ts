import { Scenario } from "../types";

export function groupScenariosByOutline(scenarios: Scenario[]): Map<string, Scenario[]> {
  const groups = new Map<string, Scenario[]>();
  for (const scenario of scenarios) {
    if (scenario.isScenarioOutline) {
      // Keyed by line as well as name: two outlines with the same title in one file must not
      // merge into a single tree node (their test-item ids would collide).
      const key = `${scenario.outlineLineNumber}:${scenario.outlineName}`;
      const group = groups.get(key) ?? [];
      group.push(scenario);
      groups.set(key, group);
    } else {
      groups.set(`${scenario.filePath}:${scenario.lineNumber}`, [scenario]);
    }
  }
  return groups;
}
