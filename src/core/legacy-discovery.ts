import type { FeatureParser } from "../parsers/feature-parser";
import type { TestDiscoveryManager } from "./test-discovery-manager";
import type { ExecutionDefinition, ExecutionDiscovery } from "./run-contracts";

export interface LegacyDiscoveryPort {
  discover(options?: { readonly refresh?: boolean | undefined }): Promise<ExecutionDiscovery>;
}

export class LegacyExecutionDiscovery implements LegacyDiscoveryPort {
  constructor(
    private readonly files: TestDiscoveryManager,
    private readonly parser: FeatureParser
  ) {}

  public async discover(
    options: { readonly refresh?: boolean | undefined } = {}
  ): Promise<ExecutionDiscovery> {
    const paths = await this.files.discoverTestFiles({ forceRefresh: options.refresh ?? false });
    const cases: ExecutionDefinition[] = [];
    const diagnostics: ExecutionDiscovery["diagnostics"][number][] = [];
    for (const filePath of paths) {
      const parsed = this.parser.parseFeatureFile(filePath);
      if (!parsed) {
        diagnostics.push({
          code: "execution.discovery.unreadable-source",
          severity: "warning",
          message: `Could not parse ${filePath}.`,
          identity: { engine: "legacy-direct", schemaProfile: "legacy-v1" },
        });
        continue;
      }
      for (const scenario of parsed.scenarios) {
        const suites: ExecutionDefinition["suites"][number][] = [{
          name: parsed.feature,
          ...(parsed.featureLineNumber
            ? { source: { path: filePath, line: parsed.featureLineNumber } }
            : {}),
        }];
        if (scenario.ruleName) {suites.push({ name: scenario.ruleName });}
        cases.push(Object.freeze({
          id: `${filePath}:${scenario.lineNumber}`,
          name: scenario.name,
          source: { path: filePath, line: scenario.lineNumber },
          suites: Object.freeze(suites),
          tags: Object.freeze([...(scenario.tags ?? [])]),
          ...(scenario.isScenarioOutline ? {
            parameterized: Object.freeze({
              groupName: scenario.outlineName,
              groupLine: scenario.outlineLineNumber,
              ...("examplesBlockLineNumber" in scenario
                ? {
                    blockLine: scenario.examplesBlockLineNumber,
                    ...(scenario.examplesBlockName ? { blockName: scenario.examplesBlockName } : {}),
                    ...(scenario.substitutedName ? { substitutedName: scenario.substitutedName } : {}),
                  }
                : {}),
            }),
          } : {}),
        }));
      }
    }
    return Object.freeze({ cases: Object.freeze(cases), diagnostics: Object.freeze(diagnostics) });
  }
}
