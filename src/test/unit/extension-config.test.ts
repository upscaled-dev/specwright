import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";
import { ExtensionConfig } from "../../core/extension-config";

// A config stub that answers every get() with the getter's own fallback default — so each
// getter returns exactly the default hardcoded in ExtensionConfig, ready to compare against
// the default declared in package.json.
function defaultsOnlyConfig(): vscode.WorkspaceConfiguration {
  return {
    get: <T>(_key: string, defaultValue?: T): T | undefined => defaultValue,
    update: (): Promise<void> => Promise.resolve(),
    inspect: (key: string): { key: string } => ({ key }),
  } as unknown as vscode.WorkspaceConfiguration;
}

function declaredDefaults(): Record<string, unknown> {
  const packageJson = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")
  ) as {
    contributes: { configuration: { properties: Record<string, { default?: unknown }> } };
  };
  const result: Record<string, unknown> = {};
  for (const [key, schema] of Object.entries(packageJson.contributes.configuration.properties)) {
    result[key.replace("playwrightBddRunner.", "")] = schema.default;
  }
  return result;
}

// Maps each declared setting to the ExtensionConfig getter that reads it. A new setting in
// package.json without an entry here fails the completeness test below — by design.
const GETTER_FOR_SETTING: Record<string, (c: ExtensionConfig) => unknown> = {
  playwrightCommand: (c) => c.playwrightCommand,
  bddgenCommand: (c) => c.bddgenCommand,
  preRunCommand: (c) => c.preRunCommand,
  workingDirectory: (c) => c.workingDirectory,
  testFilePattern: (c) => c.testFilePattern,
  enableCodeLens: (c) => c.enableCodeLens,
  parallelExecution: (c) => c.parallelExecution,
  maxParallelProcesses: (c) => c.maxParallelProcesses,
  reporter: (c) => c.reporter,
  tags: (c) => c.tags,
  dryRun: (c) => c.dryRun,
  stepDefinitionPaths: (c) => c.stepDefinitionPaths,
  enableStepDefinitionNavigation: (c) => c.enableStepDefinitionNavigation,
  enableStepDiagnostics: (c) => c.enableStepDiagnostics,
  enableStepAutocomplete: (c) => c.stepAutocompleteMode,
  enableTagAutocomplete: (c) => c.tagAutocompleteMode,
  enableStepHover: (c) => c.stepHoverMode,
  enableStepReferences: (c) => c.stepReferencesMode,
  enableStepUsageCodeLens: (c) => c.stepUsageCodeLensMode,
  enableUnusedStepDiagnostics: (c) => c.unusedStepDiagnosticsMode,
  enableStepLiteralPromotion: (c) => c.stepLiteralPromotionMode,
  enableTableFormatting: (c) => c.tableFormattingMode,
};

describe("ExtensionConfig defaults vs package.json", () => {
  const declared = declaredDefaults();
  const config = ExtensionConfig.create(defaultsOnlyConfig(), false);

  it("covers every setting declared in package.json", () => {
    expect(Object.keys(GETTER_FOR_SETTING).sort()).toEqual(Object.keys(declared).sort());
  });

  for (const [setting, getter] of Object.entries(GETTER_FOR_SETTING)) {
    it(`getter default for "${setting}" matches the declared default`, () => {
      expect(getter(config)).toEqual(declared[setting]);
    });
  }
});

describe("ExtensionConfig.validate", () => {
  function configReturning(values: Record<string, unknown>): vscode.WorkspaceConfiguration {
    return {
      get: <T>(key: string, defaultValue?: T): T | undefined =>
        key in values ? (values[key] as T) : defaultValue,
      update: (): Promise<void> => Promise.resolve(),
      inspect: (key: string): { key: string } => ({ key }),
    } as unknown as vscode.WorkspaceConfiguration;
  }

  it("accepts the declared defaults", () => {
    expect(() => ExtensionConfig.create(defaultsOnlyConfig(), false).validate()).not.toThrow();
  });

  it("rejects maxParallelProcesses outside 1..16", () => {
    expect(() =>
      ExtensionConfig.create(configReturning({ maxParallelProcesses: 0 }), false).validate()
    ).toThrow(/maxParallelProcesses/);
    expect(() =>
      ExtensionConfig.create(configReturning({ maxParallelProcesses: 17 }), false).validate()
    ).toThrow(/maxParallelProcesses/);
  });

  it("rejects an empty testFilePattern and an unknown reporter", () => {
    expect(() =>
      ExtensionConfig.create(configReturning({ testFilePattern: " " }), false).validate()
    ).toThrow(/testFilePattern/);
    expect(() =>
      ExtensionConfig.create(configReturning({ reporter: "tap" }), false).validate()
    ).toThrow(/reporter/);
  });
});

describe("ExtensionConfig change listeners", () => {
  it("notifies on reload and stops after the listener subscription is disposed", () => {
    const config = ExtensionConfig.create(defaultsOnlyConfig(), false);
    let calls = 0;
    const subscription = config.addChangeListener(() => {
      calls += 1;
    });

    config.reload();
    expect(calls).toBe(1);

    subscription.dispose();
    config.reload();
    expect(calls).toBe(1);
  });

  it("drops all listeners on dispose()", () => {
    const config = ExtensionConfig.create(defaultsOnlyConfig(), false);
    let calls = 0;
    config.addChangeListener(() => {
      calls += 1;
    });

    config.dispose();
    config.reload();

    expect(calls).toBe(0);
  });
});
