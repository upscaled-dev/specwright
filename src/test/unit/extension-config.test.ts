import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import type * as vscode from "vscode";
import { ExtensionConfig } from "../../core/extension-config";

// A config stub that answers every get() with the getter's own fallback default, so each
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
    contributes: { configuration: Array<{ properties: Record<string, { default?: unknown }> }> };
  };
  const result: Record<string, unknown> = {};
  for (const group of packageJson.contributes.configuration) {
    for (const [key, schema] of Object.entries(group.properties)) {
      result[key.replace("playwrightBddRunner.", "")] = schema.default;
    }
  }
  return result;
}

// Maps each declared setting to the ExtensionConfig getter that reads it. A new setting in
// package.json without an entry here fails the completeness test below, by design.
const GETTER_FOR_SETTING: Record<string, (c: ExtensionConfig) => unknown> = {
  playwrightCommand: (c) => c.playwrightCommand,
  bddgenCommand: (c) => c.bddgenCommand,
  preRunCommand: (c) => c.preRunCommand,
  workingDirectory: (c) => c.workingDirectory,
  featuresGenDir: (c) => c.featuresGenDir,
  testFilePattern: (c) => c.testFilePattern,
  enableCodeLens: (c) => c.enableCodeLens,
  parallelExecution: (c) => c.parallelExecution,
  maxParallelProcesses: (c) => c.maxParallelProcesses,
  reporter: (c) => c.reporter,
  useConfigReporters: (c) => c.useConfigReporters,
  tags: (c) => c.tags,
  dryRun: (c) => c.dryRun,
  stepDefinitionPaths: (c) => c.stepDefinitionPaths,
  stepDefinitionExcludePaths: (c) => c.stepDefinitionExcludePaths,
  enableStepDefinitionNavigation: (c) => c.enableStepDefinitionNavigation,
  enableStepDiagnostics: (c) => c.enableStepDiagnostics,
  enableStepsPanel: (c) => c.enableStepsPanel,
  enableStepAutocomplete: (c) => c.stepAutocompleteMode,
  enableTagAutocomplete: (c) => c.tagAutocompleteMode,
  enableStepHover: (c) => c.stepHoverMode,
  enableStepReferences: (c) => c.stepReferencesMode,
  enableStepUsageCodeLens: (c) => c.stepUsageCodeLensMode,
  enableUnusedStepDiagnostics: (c) => c.unusedStepDiagnosticsMode,
  enableStepLiteralPromotion: (c) => c.stepLiteralPromotionMode,
  enableTableFormatting: (c) => c.tableFormattingMode,
  collapseMarkdownExportSections: (c) => c.collapseMarkdownExportSections,
  "traceability.enablePanel": (c) => c.enableTraceabilityPanel,
  "traceability.provider": (c) => c.traceabilityProvider,
  "traceability.testTagPrefix": (c) => c.traceabilityTestTagPrefix,
  "traceability.reqTagPrefix": (c) => c.traceabilityReqTagPrefix,
  "xray.siteUrl": (c) => c.xraySiteUrl,
  "xray.apiRegion": (c) => c.xrayApiRegion,
  "xray.syncProjectKeys": (c) => c.xraySyncProjectKeys,
  "xray.cacheTtlMinutes": (c) => c.xrayCacheTtlMinutes,
  "xray.defaultProjectKey": (c) => c.xrayDefaultProjectKey,
  "xray.executionIssueType": (c) => c.xrayExecutionIssueType,
  "xray.reportGlob": (c) => c.xrayReportGlob,
  "xray.attachTo": (c) => c.xrayAttachTo,
};

describe("ExtensionConfig defaults vs package.json", () => {
  const declared = declaredDefaults();
  const config = ExtensionConfig.create(defaultsOnlyConfig(), false);

  it("covers every setting declared in package.json", () => {
    expect(Object.keys(GETTER_FOR_SETTING).sort()).toEqual(Object.keys(declared).sort());
  });

  it("uses the same six-format glob in each default step root", () => {
    expect(declared["stepDefinitionPaths"]).toEqual([
      "features/steps/**/*.{ts,mts,cts,js,mjs,cjs}",
      "tests/steps/**/*.{ts,mts,cts,js,mjs,cjs}",
      "steps/**/*.{ts,mts,cts,js,mjs,cjs}",
    ]);
    expect(config.stepDefinitionPaths).toEqual(declared["stepDefinitionPaths"]);
  });

  for (const [setting, getter] of Object.entries(GETTER_FOR_SETTING)) {
    it(`getter default for "${setting}" matches the declared default`, () => {
      expect(getter(config)).toEqual(declared[setting]);
    });
  }
});

describe("package.json setting organization", () => {
  interface SettingSchema {
    order?: number;
    enum?: unknown[];
    enumDescriptions?: string[];
  }
  const groups = (JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")
  ) as {
    contributes: { configuration: Array<{
      title: string;
      order?: number;
      properties: Record<string, SettingSchema>;
    }> };
  }).contributes.configuration;

  it("uses the stable Execution, Authoring, Compatibility, and Xray order", () => {
    expect(groups.map(({ title, order }) => [title, order])).toEqual([
      ["Specwright: Execution", 10],
      ["Specwright: Authoring", 20],
      ["Specwright: Compatibility", 30],
      ["Specwright: Xray", 40],
    ]);
  });

  it("gives every property an explicit increasing order within its group", () => {
    for (const group of groups) {
      const orders = Object.values(group.properties).map(({ order }) => order);
      expect(orders.every((order) => typeof order === "number"), group.title).toBe(true);
      expect(orders, group.title).toEqual([...orders].sort((a, b) => a! - b!));
      expect(new Set(orders).size, group.title).toBe(orders.length);
    }
  });

  it("aligns enum descriptions with every enum value", () => {
    for (const group of groups) {
      for (const [setting, schema] of Object.entries(group.properties)) {
        if (!schema.enum) {continue;}
        expect(schema.enumDescriptions, setting).toHaveLength(schema.enum.length);
      }
    }
  });
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

  it("accepts extra built-ins, module paths, and comma-separated reporter lists", () => {
    for (const reporter of ["github", "blob", "null", "list,json", "./my-reporter.ts", "reporters/custom.js"]) {
      expect(() =>
        ExtensionConfig.create(configReturning({ reporter }), false).validate()
      ).not.toThrow();
    }
  });

  it("rejects a non-positive xray.cacheTtlMinutes", () => {
    expect(() =>
      ExtensionConfig.create(configReturning({ "xray.cacheTtlMinutes": 0 }), false).validate()
    ).toThrow(/cacheTtlMinutes/);
    expect(() =>
      ExtensionConfig.create(configReturning({ "xray.cacheTtlMinutes": -5 }), false).validate()
    ).toThrow(/cacheTtlMinutes/);
  });

  it("rejects a reporter list with an empty or unknown token", () => {
    expect(() =>
      ExtensionConfig.create(configReturning({ reporter: "list," }), false).validate()
    ).toThrow(/reporter/);
    expect(() =>
      ExtensionConfig.create(configReturning({ reporter: "list,tap" }), false).validate()
    ).toThrow(/reporter/);
  });
});

describe("ExtensionConfig xray publish settings", () => {
  function configReturning(values: Record<string, unknown>): vscode.WorkspaceConfiguration {
    return {
      get: <T>(key: string, defaultValue?: T): T | undefined => (key in values ? (values[key] as T) : defaultValue),
      update: (): Promise<void> => Promise.resolve(),
      inspect: (key: string): { key: string } => ({ key }),
    } as unknown as vscode.WorkspaceConfiguration;
  }

  it("keeps a valid reportGlob and attachTo", () => {
    const config = ExtensionConfig.create(
      configReturning({ "xray.reportGlob": ["reports/**"], "xray.attachTo": "both" }),
      false
    );
    expect(config.xrayReportGlob).toEqual(["reports/**"]);
    expect(config.xrayAttachTo).toBe("both");
  });

  it("falls back to the default reportGlob for a non-array or all-empty value", () => {
    const dflt = ["playwright-report/**", "test-results/**/*.zip"];
    expect(ExtensionConfig.create(configReturning({ "xray.reportGlob": "nope" }), false).xrayReportGlob).toEqual(dflt);
    expect(ExtensionConfig.create(configReturning({ "xray.reportGlob": ["", "  "] }), false).xrayReportGlob).toEqual(dflt);
  });

  it("drops non-string reportGlob entries", () => {
    const config = ExtensionConfig.create(configReturning({ "xray.reportGlob": ["ok/**", 42, null] }), false);
    expect(config.xrayReportGlob).toEqual(["ok/**"]);
  });

  it("falls back to 'evidence' for an unknown attachTo value", () => {
    expect(ExtensionConfig.create(configReturning({ "xray.attachTo": "elsewhere" }), false).xrayAttachTo).toBe("evidence");
  });

  it("trims the execution issue type and reads a blank one as the default", () => {
    const configured = configReturning({ "xray.executionIssueType": "  Sub-Test Execution  " });
    expect(ExtensionConfig.create(configured, false).xrayExecutionIssueType).toBe("Sub-Test Execution");
    const blank = configReturning({ "xray.executionIssueType": "   " });
    expect(ExtensionConfig.create(blank, false).xrayExecutionIssueType).toBe("Test Execution");
  });
});

describe("ExtensionConfig traceability preference", () => {
  function inspectedConfig(
    effective: boolean,
    inspection: Record<string, unknown>
  ): vscode.WorkspaceConfiguration {
    return {
      get: <T>(key: string, fallback?: T): T | undefined =>
        key === "traceability.enablePanel" ? (effective as T) : fallback,
      update: (): Promise<void> => Promise.resolve(),
      inspect: (key: string): Record<string, unknown> =>
        key === "traceability.enablePanel" ? { key, ...inspection } : { key },
    } as unknown as vscode.WorkspaceConfiguration;
  }

  it("distinguishes the clean-install default from explicit false at supported scopes", () => {
    const clean = ExtensionConfig.create(inspectedConfig(false, {}), false);
    const globalFalse = ExtensionConfig.create(
      inspectedConfig(false, { globalValue: false }),
      false
    );
    const workspaceFalse = ExtensionConfig.create(
      inspectedConfig(false, { workspaceValue: false }),
      false
    );

    expect(clean.traceabilityPanelPreference).toBeUndefined();
    expect(globalFalse.traceabilityPanelPreference).toBe(false);
    expect(workspaceFalse.traceabilityPanelPreference).toBe(false);
  });

  it("detects existing Xray configuration without treating defaults as user settings", () => {
    const configured = {
      get: <T>(_key: string, fallback?: T): T | undefined => fallback,
      update: (): Promise<void> => Promise.resolve(),
      inspect: (key: string): Record<string, unknown> =>
        key === "xray.siteUrl" ? { key, workspaceValue: "acme.atlassian.net" } : { key },
    } as unknown as vscode.WorkspaceConfiguration;

    expect(ExtensionConfig.create(defaultsOnlyConfig(), false).hasExplicitXrayConfiguration)
      .toBe(false);
    expect(ExtensionConfig.create(configured, false).hasExplicitXrayConfiguration).toBe(true);
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
