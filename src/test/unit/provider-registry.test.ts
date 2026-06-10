import { describe, it, expect, beforeEach } from "vitest";
import * as vscode from "vscode";
import { ProviderRegistry, shouldRegisterCompletion } from "../../core/provider-registry";
import type { ExtensionConfig } from "../../core/extension-config";
import type { FeatureParser } from "../../parsers/feature-parser";
import type { Logger } from "../../utils/logger";

interface MockableLanguages {
  __counters: {
    codeLensRegisterCount: number;
    codeLensDisposeCount: number;
    definitionRegisterCount: number;
    definitionDisposeCount: number;
    codeActionRegisterCount: number;
    codeActionDisposeCount: number;
    diagnosticCollectionCreateCount: number;
    diagnosticCollectionDisposeCount: number;
    completionRegisterCount: number;
    completionDisposeCount: number;
  };
  __resetCounters: () => void;
}

const lang = vscode.languages as unknown as MockableLanguages;

interface MockableExtensions {
  getExtension: (id: string) => unknown;
  onDidChange: () => { dispose: () => void };
}

const ext = vscode.extensions as unknown as MockableExtensions;

interface FakeConfigOptions {
  enableCodeLens: boolean;
  enableStepDefinitionNavigation: boolean;
  enableStepDiagnostics: boolean;
  stepDefinitionPaths: string[];
  stepAutocompleteMode: "auto" | "on" | "off";
  tagAutocompleteMode: "auto" | "on" | "off";
  unusedStepDiagnosticsMode: "auto" | "on" | "off";
  stepLiteralPromotionMode: "auto" | "on" | "off";
  stepUsageCodeLensMode: "auto" | "on" | "off";
  testFilePattern: string;
}

function makeFakeConfig(opts: Partial<FakeConfigOptions> & Pick<FakeConfigOptions, "enableCodeLens" | "enableStepDefinitionNavigation" | "stepDefinitionPaths">): {
  config: ExtensionConfig;
  set: (next: Partial<FakeConfigOptions>) => void;
  fireChange: () => void;
} {
  const state: FakeConfigOptions = {
    enableStepDiagnostics: false,
    stepAutocompleteMode: "off",
    tagAutocompleteMode: "off",
    unusedStepDiagnosticsMode: "off",
    stepLiteralPromotionMode: "off",
    stepUsageCodeLensMode: "off",
    testFilePattern: "**/*.feature",
    ...opts,
  };
  let listener: (() => void) | undefined;
  const config = {
    get enableCodeLens(): boolean { return state.enableCodeLens; },
    get enableStepDefinitionNavigation(): boolean { return state.enableStepDefinitionNavigation; },
    get enableStepDiagnostics(): boolean { return state.enableStepDiagnostics; },
    get stepDefinitionPaths(): string[] { return state.stepDefinitionPaths; },
    get stepAutocompleteMode(): "auto" | "on" | "off" { return state.stepAutocompleteMode; },
    get tagAutocompleteMode(): "auto" | "on" | "off" { return state.tagAutocompleteMode; },
    get unusedStepDiagnosticsMode(): "auto" | "on" | "off" { return state.unusedStepDiagnosticsMode; },
    get stepLiteralPromotionMode(): "auto" | "on" | "off" { return state.stepLiteralPromotionMode; },
    get stepUsageCodeLensMode(): "auto" | "on" | "off" { return state.stepUsageCodeLensMode; },
    get testFilePattern(): string { return state.testFilePattern; },
    addChangeListener(cb: () => void): { dispose: () => void } {
      listener = cb;
      return { dispose: () => { listener = undefined; } };
    },
  } as unknown as ExtensionConfig;

  return {
    config,
    set: (next) => { Object.assign(state, next); },
    fireChange: () => { listener?.(); },
  };
}

function setCucumberAutocompletePresent(present: boolean): void {
  ext.getExtension = (id: string): unknown =>
    present && id === "alexkrechik.cucumberautocomplete" ? { id, isActive: true } : undefined;
}

const stubFeatureParser = {
  provideScenarioCodeLenses: (): unknown[] => [],
} as unknown as FeatureParser;

const stubLogger = {
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
  debug: (): void => {},
} as unknown as Logger;

describe("ProviderRegistry", () => {
  beforeEach(() => {
    lang.__resetCounters();
    setCucumberAutocompletePresent(false);
  });

  it("registers both providers when both settings are initially enabled", () => {
    const { config } = makeFakeConfig({
      enableCodeLens: true,
      enableStepDefinitionNavigation: true,
      stepDefinitionPaths: ["features/steps/**/*.ts"],
    });
    const registry = new ProviderRegistry(config, stubFeatureParser, stubLogger);
    registry.applyCurrent();

    expect(lang.__counters.codeLensRegisterCount).toBe(1);
    expect(lang.__counters.definitionRegisterCount).toBe(1);
    expect(lang.__counters.codeLensDisposeCount).toBe(0);
    expect(lang.__counters.definitionDisposeCount).toBe(0);
    expect(registry.codeLensActive).toBe(true);
    expect(registry.definitionActive).toBe(true);
    expect(registry.stepPaths).toEqual(["features/steps/**/*.ts"]);
  });

  it("registers nothing when both settings are initially disabled", () => {
    const { config } = makeFakeConfig({
      enableCodeLens: false,
      enableStepDefinitionNavigation: false,
      stepDefinitionPaths: [],
    });
    const registry = new ProviderRegistry(config, stubFeatureParser, stubLogger);
    registry.applyCurrent();

    expect(lang.__counters.codeLensRegisterCount).toBe(0);
    expect(lang.__counters.definitionRegisterCount).toBe(0);
    expect(registry.codeLensActive).toBe(false);
    expect(registry.definitionActive).toBe(false);
  });

  it("disposes the CodeLens registration when enableCodeLens flips to false", () => {
    const ctx = makeFakeConfig({
      enableCodeLens: true,
      enableStepDefinitionNavigation: false,
      stepDefinitionPaths: [],
    });
    const registry = new ProviderRegistry(ctx.config, stubFeatureParser, stubLogger);
    registry.applyCurrent();

    ctx.set({ enableCodeLens: false });
    ctx.fireChange();

    expect(lang.__counters.codeLensRegisterCount).toBe(1);
    expect(lang.__counters.codeLensDisposeCount).toBe(1);
    expect(registry.codeLensActive).toBe(false);
  });

  it("registers a new CodeLens provider when enableCodeLens flips back to true", () => {
    const ctx = makeFakeConfig({
      enableCodeLens: false,
      enableStepDefinitionNavigation: false,
      stepDefinitionPaths: [],
    });
    const registry = new ProviderRegistry(ctx.config, stubFeatureParser, stubLogger);
    registry.applyCurrent();

    ctx.set({ enableCodeLens: true });
    ctx.fireChange();

    expect(lang.__counters.codeLensRegisterCount).toBe(1);
    expect(lang.__counters.codeLensDisposeCount).toBe(0);
    expect(registry.codeLensActive).toBe(true);
  });

  it("disposes and re-registers the definition provider when navigation toggles off then on", () => {
    const ctx = makeFakeConfig({
      enableCodeLens: false,
      enableStepDefinitionNavigation: true,
      stepDefinitionPaths: ["a/**/*.ts"],
    });
    const registry = new ProviderRegistry(ctx.config, stubFeatureParser, stubLogger);
    registry.applyCurrent();
    expect(lang.__counters.definitionRegisterCount).toBe(1);

    ctx.set({ enableStepDefinitionNavigation: false });
    ctx.fireChange();
    expect(lang.__counters.definitionDisposeCount).toBe(1);
    expect(registry.definitionActive).toBe(false);

    ctx.set({ enableStepDefinitionNavigation: true });
    ctx.fireChange();
    expect(lang.__counters.definitionRegisterCount).toBe(2);
    expect(registry.definitionActive).toBe(true);
  });

  it("re-registers the definition provider when stepDefinitionPaths changes", () => {
    const ctx = makeFakeConfig({
      enableCodeLens: true,
      enableStepDefinitionNavigation: true,
      stepDefinitionPaths: ["a/**/*.ts"],
    });
    const registry = new ProviderRegistry(ctx.config, stubFeatureParser, stubLogger);
    registry.applyCurrent();

    ctx.set({ stepDefinitionPaths: ["b/**/*.ts"] });
    ctx.fireChange();

    expect(lang.__counters.definitionDisposeCount).toBe(1);
    expect(lang.__counters.definitionRegisterCount).toBe(2);
    expect(registry.stepPaths).toEqual(["b/**/*.ts"]);
    expect(lang.__counters.codeLensRegisterCount).toBe(1);
    expect(lang.__counters.codeLensDisposeCount).toBe(0);
  });

  it("does not re-register when stepDefinitionPaths is a new array with identical contents", () => {
    const ctx = makeFakeConfig({
      enableCodeLens: false,
      enableStepDefinitionNavigation: true,
      stepDefinitionPaths: ["a/**/*.ts", "b/**/*.ts"],
    });
    const registry = new ProviderRegistry(ctx.config, stubFeatureParser, stubLogger);
    registry.applyCurrent();

    ctx.set({ stepDefinitionPaths: ["a/**/*.ts", "b/**/*.ts"] });
    ctx.fireChange();

    expect(lang.__counters.definitionRegisterCount).toBe(1);
    expect(lang.__counters.definitionDisposeCount).toBe(0);
  });

  it("handles simultaneous codelens-off and paths-change in a single change event", () => {
    const ctx = makeFakeConfig({
      enableCodeLens: true,
      enableStepDefinitionNavigation: true,
      stepDefinitionPaths: ["a/**/*.ts"],
    });
    const registry = new ProviderRegistry(ctx.config, stubFeatureParser, stubLogger);
    registry.applyCurrent();

    ctx.set({ enableCodeLens: false, stepDefinitionPaths: ["b/**/*.ts"] });
    ctx.fireChange();

    expect(lang.__counters.codeLensDisposeCount).toBe(1);
    expect(lang.__counters.definitionDisposeCount).toBe(1);
    expect(lang.__counters.definitionRegisterCount).toBe(2);
    expect(registry.codeLensActive).toBe(false);
    expect(registry.definitionActive).toBe(true);
    expect(registry.stepPaths).toEqual(["b/**/*.ts"]);
  });

  it("applyCurrent() is a no-op after dispose()", () => {
    const ctx = makeFakeConfig({
      enableCodeLens: true,
      enableStepDefinitionNavigation: true,
      stepDefinitionPaths: ["a/**/*.ts"],
    });
    const registry = new ProviderRegistry(ctx.config, stubFeatureParser, stubLogger);
    registry.dispose();

    const codeLensBefore = lang.__counters.codeLensRegisterCount;
    const definitionBefore = lang.__counters.definitionRegisterCount;

    registry.applyCurrent();

    expect(lang.__counters.codeLensRegisterCount).toBe(codeLensBefore);
    expect(lang.__counters.definitionRegisterCount).toBe(definitionBefore);
    expect(registry.codeLensActive).toBe(false);
    expect(registry.definitionActive).toBe(false);
  });

  it("starts diagnostics + code action provider when enableStepDiagnostics is true", () => {
    const { config } = makeFakeConfig({
      enableCodeLens: false,
      enableStepDefinitionNavigation: false,
      enableStepDiagnostics: true,
      stepDefinitionPaths: ["features/steps/**/*.ts"],
    });
    const before = lang.__counters.diagnosticCollectionCreateCount;
    const registry = new ProviderRegistry(config, stubFeatureParser, stubLogger);
    registry.applyCurrent();

    expect(lang.__counters.diagnosticCollectionCreateCount).toBeGreaterThanOrEqual(before + 1);
    expect(lang.__counters.codeActionRegisterCount).toBe(1);
    expect(registry.diagnosticsActive).toBe(true);
  });

  it("disposes diagnostics + code action provider when enableStepDiagnostics flips to false", () => {
    const ctx = makeFakeConfig({
      enableCodeLens: false,
      enableStepDefinitionNavigation: false,
      enableStepDiagnostics: true,
      stepDefinitionPaths: ["a/**/*.ts"],
    });
    const registry = new ProviderRegistry(ctx.config, stubFeatureParser, stubLogger);
    registry.applyCurrent();

    ctx.set({ enableStepDiagnostics: false });
    ctx.fireChange();

    expect(lang.__counters.diagnosticCollectionDisposeCount).toBe(1);
    expect(lang.__counters.codeActionDisposeCount).toBe(1);
    expect(registry.diagnosticsActive).toBe(false);
  });

  it("registers the completion provider when mode=auto and cucumberautocomplete is absent", () => {
    setCucumberAutocompletePresent(false);
    const { config } = makeFakeConfig({
      enableCodeLens: false,
      enableStepDefinitionNavigation: false,
      stepDefinitionPaths: ["features/steps/**/*.ts"],
      stepAutocompleteMode: "auto",
    });
    const registry = new ProviderRegistry(config, stubFeatureParser, stubLogger);
    registry.applyCurrent();

    expect(lang.__counters.completionRegisterCount).toBe(1);
    expect(registry.completionActive).toBe(true);
  });

  it("does NOT register the completion provider when mode=auto and cucumberautocomplete is present", () => {
    setCucumberAutocompletePresent(true);
    const { config } = makeFakeConfig({
      enableCodeLens: false,
      enableStepDefinitionNavigation: false,
      stepDefinitionPaths: ["features/steps/**/*.ts"],
      stepAutocompleteMode: "auto",
    });
    const registry = new ProviderRegistry(config, stubFeatureParser, stubLogger);
    registry.applyCurrent();

    expect(lang.__counters.completionRegisterCount).toBe(0);
    expect(registry.completionActive).toBe(false);
  });

  it("does NOT register the completion provider when mode=off, even if cucumberautocomplete is absent", () => {
    setCucumberAutocompletePresent(false);
    const { config } = makeFakeConfig({
      enableCodeLens: false,
      enableStepDefinitionNavigation: false,
      stepDefinitionPaths: ["features/steps/**/*.ts"],
      stepAutocompleteMode: "off",
    });
    const registry = new ProviderRegistry(config, stubFeatureParser, stubLogger);
    registry.applyCurrent();

    expect(lang.__counters.completionRegisterCount).toBe(0);
    expect(registry.completionActive).toBe(false);
  });

  it("registers the completion provider when mode=on, even if cucumberautocomplete is present", () => {
    setCucumberAutocompletePresent(true);
    const { config } = makeFakeConfig({
      enableCodeLens: false,
      enableStepDefinitionNavigation: false,
      stepDefinitionPaths: ["features/steps/**/*.ts"],
      stepAutocompleteMode: "on",
    });
    const registry = new ProviderRegistry(config, stubFeatureParser, stubLogger);
    registry.applyCurrent();

    expect(lang.__counters.completionRegisterCount).toBe(1);
    expect(registry.completionActive).toBe(true);
  });

  it("disposes the completion provider when mode flips from on to off at runtime", () => {
    setCucumberAutocompletePresent(false);
    const ctx = makeFakeConfig({
      enableCodeLens: false,
      enableStepDefinitionNavigation: false,
      stepDefinitionPaths: ["features/steps/**/*.ts"],
      stepAutocompleteMode: "on",
    });
    const registry = new ProviderRegistry(ctx.config, stubFeatureParser, stubLogger);
    registry.applyCurrent();
    expect(lang.__counters.completionRegisterCount).toBe(1);

    ctx.set({ stepAutocompleteMode: "off" });
    ctx.fireChange();

    expect(lang.__counters.completionDisposeCount).toBe(1);
    expect(registry.completionActive).toBe(false);
  });

  it("re-registers the completion provider when mode flips from off back to on", () => {
    setCucumberAutocompletePresent(false);
    const ctx = makeFakeConfig({
      enableCodeLens: false,
      enableStepDefinitionNavigation: false,
      stepDefinitionPaths: ["features/steps/**/*.ts"],
      stepAutocompleteMode: "off",
    });
    const registry = new ProviderRegistry(ctx.config, stubFeatureParser, stubLogger);
    registry.applyCurrent();
    expect(lang.__counters.completionRegisterCount).toBe(0);

    ctx.set({ stepAutocompleteMode: "on" });
    ctx.fireChange();

    expect(lang.__counters.completionRegisterCount).toBe(1);
    expect(registry.completionActive).toBe(true);
  });

  it("re-registers the completion provider when stepDefinitionPaths changes", () => {
    setCucumberAutocompletePresent(false);
    const ctx = makeFakeConfig({
      enableCodeLens: false,
      enableStepDefinitionNavigation: false,
      stepDefinitionPaths: ["a/**/*.ts"],
      stepAutocompleteMode: "on",
    });
    const registry = new ProviderRegistry(ctx.config, stubFeatureParser, stubLogger);
    registry.applyCurrent();

    ctx.set({ stepDefinitionPaths: ["b/**/*.ts"] });
    ctx.fireChange();

    expect(lang.__counters.completionDisposeCount).toBe(1);
    expect(lang.__counters.completionRegisterCount).toBe(2);
  });

  it("disposes the completion provider on dispose()", () => {
    setCucumberAutocompletePresent(false);
    const ctx = makeFakeConfig({
      enableCodeLens: false,
      enableStepDefinitionNavigation: false,
      stepDefinitionPaths: ["a/**/*.ts"],
      stepAutocompleteMode: "on",
    });
    const registry = new ProviderRegistry(ctx.config, stubFeatureParser, stubLogger);
    registry.applyCurrent();
    expect(lang.__counters.completionRegisterCount).toBe(1);

    registry.dispose();

    expect(lang.__counters.completionDisposeCount).toBe(1);
    expect(registry.completionActive).toBe(false);
  });

  describe("step literal promotion lifecycle", () => {
    it("registers the literal-promotion code-action provider when mode=on", () => {
      setCucumberAutocompletePresent(false);
      const { config } = makeFakeConfig({
        enableCodeLens: false,
        enableStepDefinitionNavigation: false,
        stepDefinitionPaths: ["features/steps/**/*.ts"],
        stepLiteralPromotionMode: "on",
      });
      const registry = new ProviderRegistry(config, stubFeatureParser, stubLogger);
      registry.applyCurrent();
      expect(lang.__counters.codeActionRegisterCount).toBe(1);
      expect(registry.literalPromotionActive).toBe(true);
    });

    it("does NOT register when mode=off", () => {
      setCucumberAutocompletePresent(false);
      const { config } = makeFakeConfig({
        enableCodeLens: false,
        enableStepDefinitionNavigation: false,
        stepDefinitionPaths: ["features/steps/**/*.ts"],
        stepLiteralPromotionMode: "off",
      });
      const registry = new ProviderRegistry(config, stubFeatureParser, stubLogger);
      registry.applyCurrent();
      expect(registry.literalPromotionActive).toBe(false);
    });

    it("does NOT register when mode=auto and cucumberautocomplete is present", () => {
      setCucumberAutocompletePresent(true);
      const { config } = makeFakeConfig({
        enableCodeLens: false,
        enableStepDefinitionNavigation: false,
        stepDefinitionPaths: ["features/steps/**/*.ts"],
        stepLiteralPromotionMode: "auto",
      });
      const registry = new ProviderRegistry(config, stubFeatureParser, stubLogger);
      registry.applyCurrent();
      expect(registry.literalPromotionActive).toBe(false);
    });

    it("disposes on dispose()", () => {
      setCucumberAutocompletePresent(false);
      const { config } = makeFakeConfig({
        enableCodeLens: false,
        enableStepDefinitionNavigation: false,
        stepDefinitionPaths: ["features/steps/**/*.ts"],
        stepLiteralPromotionMode: "on",
      });
      const registry = new ProviderRegistry(config, stubFeatureParser, stubLogger);
      registry.applyCurrent();
      const before = lang.__counters.codeActionDisposeCount;
      registry.dispose();
      expect(lang.__counters.codeActionDisposeCount).toBe(before + 1);
      expect(registry.literalPromotionActive).toBe(false);
    });
  });

  describe("step usage index globs", () => {
    interface UsageIndexInternals {
      stepUsageIndex: { rescan: () => void } | undefined;
    }

    it("rescans the shared StepUsageIndex when stepDefinitionPaths changes", () => {
      setCucumberAutocompletePresent(false);
      const ctx = makeFakeConfig({
        enableCodeLens: false,
        enableStepDefinitionNavigation: false,
        stepDefinitionPaths: ["a/**/*.ts"],
        stepUsageCodeLensMode: "on",
      });
      const registry = new ProviderRegistry(ctx.config, stubFeatureParser, stubLogger);
      registry.applyCurrent();

      const index = (registry as unknown as UsageIndexInternals).stepUsageIndex;
      expect(index).toBeDefined();
      let rescans = 0;
      const original = index!.rescan.bind(index);
      index!.rescan = (): void => {
        rescans += 1;
        original();
      };

      ctx.fireChange();
      expect(rescans).toBe(0);

      ctx.set({ stepDefinitionPaths: ["b/**/*.ts"] });
      ctx.fireChange();
      expect(rescans).toBe(1);
      registry.dispose();
    });
  });

  describe("shouldRegisterCompletion decision matrix", () => {
    it("returns true for mode=on regardless of cucumberautocomplete", () => {
      expect(shouldRegisterCompletion("on", true)).toBe(true);
      expect(shouldRegisterCompletion("on", false)).toBe(true);
    });

    it("returns false for mode=off regardless of cucumberautocomplete", () => {
      expect(shouldRegisterCompletion("off", true)).toBe(false);
      expect(shouldRegisterCompletion("off", false)).toBe(false);
    });

    it("returns true for mode=auto only when cucumberautocomplete is absent", () => {
      expect(shouldRegisterCompletion("auto", false)).toBe(true);
      expect(shouldRegisterCompletion("auto", true)).toBe(false);
    });
  });

  it("disposes both providers and the change listener on dispose()", () => {
    const ctx = makeFakeConfig({
      enableCodeLens: true,
      enableStepDefinitionNavigation: true,
      stepDefinitionPaths: ["a/**/*.ts"],
    });
    const registry = new ProviderRegistry(ctx.config, stubFeatureParser, stubLogger);
    registry.applyCurrent();

    registry.dispose();

    expect(lang.__counters.codeLensDisposeCount).toBe(1);
    expect(lang.__counters.definitionDisposeCount).toBe(1);

    ctx.set({ enableCodeLens: false });
    ctx.fireChange();
    expect(lang.__counters.codeLensRegisterCount).toBe(1);
    expect(lang.__counters.codeLensDisposeCount).toBe(1);
  });

  describe("tag completion lifecycle", () => {
    interface RegistryInternals {
      tagIndex: { dispose: () => void; disposed?: boolean } | undefined;
    }

    function patchTagIndex(registry: ProviderRegistry): { current: () => RegistryInternals["tagIndex"]; lastDisposed: () => boolean } {
      const internals = registry as unknown as RegistryInternals;
      let lastDisposedFlag = false;
      const wrap = (): void => {
        const ti = internals.tagIndex;
        if (!ti) {return;}
        if ((ti as { __wrapped?: boolean }).__wrapped) {return;}
        const originalDispose = ti.dispose.bind(ti);
        ti.dispose = (): void => {
          lastDisposedFlag = true;
          originalDispose();
        };
        (ti as { __wrapped?: boolean }).__wrapped = true;
      };
      return {
        current: () => { wrap(); return internals.tagIndex; },
        lastDisposed: () => lastDisposedFlag,
      };
    }

    it("disposes tagIndex when mode flips to off", () => {
      setCucumberAutocompletePresent(false);
      const ctx = makeFakeConfig({
        enableCodeLens: false,
        enableStepDefinitionNavigation: false,
        stepDefinitionPaths: [],
        tagAutocompleteMode: "on",
      });
      const registry = new ProviderRegistry(ctx.config, stubFeatureParser, stubLogger);
      registry.applyCurrent();
      const probe = patchTagIndex(registry);
      expect(probe.current()).toBeDefined();

      ctx.set({ tagAutocompleteMode: "off" });
      ctx.fireChange();

      expect(probe.lastDisposed()).toBe(true);
      expect((registry as unknown as RegistryInternals).tagIndex).toBeUndefined();
      expect(registry.tagCompletionActive).toBe(false);
    });

    it("re-instantiates tagIndex when testFilePattern changes", () => {
      setCucumberAutocompletePresent(false);
      const ctx = makeFakeConfig({
        enableCodeLens: false,
        enableStepDefinitionNavigation: false,
        stepDefinitionPaths: [],
        tagAutocompleteMode: "on",
        testFilePattern: "features/**/*.feature",
      });
      const registry = new ProviderRegistry(ctx.config, stubFeatureParser, stubLogger);
      registry.applyCurrent();
      const probe = patchTagIndex(registry);
      const first = probe.current();
      expect(first).toBeDefined();

      ctx.set({ testFilePattern: "tests/**/*.feature" });
      ctx.fireChange();

      expect(probe.lastDisposed()).toBe(true);
      const second = (registry as unknown as RegistryInternals).tagIndex;
      expect(second).toBeDefined();
      expect(second).not.toBe(first);
    });

    it("creates a fresh tagIndex on off->on re-toggle (watcher-leak fix supersedes reuse)", () => {
      setCucumberAutocompletePresent(false);
      const ctx = makeFakeConfig({
        enableCodeLens: false,
        enableStepDefinitionNavigation: false,
        stepDefinitionPaths: [],
        tagAutocompleteMode: "on",
        testFilePattern: "**/*.feature",
      });
      const registry = new ProviderRegistry(ctx.config, stubFeatureParser, stubLogger);
      registry.applyCurrent();
      const firstIndex = (registry as unknown as RegistryInternals).tagIndex;
      expect(firstIndex).toBeDefined();

      ctx.set({ tagAutocompleteMode: "off" });
      ctx.fireChange();
      expect((registry as unknown as RegistryInternals).tagIndex).toBeUndefined();

      ctx.set({ tagAutocompleteMode: "on" });
      ctx.fireChange();
      const secondIndex = (registry as unknown as RegistryInternals).tagIndex;
      expect(secondIndex).toBeDefined();
      expect(secondIndex).not.toBe(firstIndex);
    });
  });
});
