import { describe, expect, it } from "vitest";
import * as vscode from "vscode";
import { ExtensionConfig } from "../../core/extension-config";
import { TestDiscoveryManager } from "../../core/test-discovery-manager";
import { FeatureParser } from "../../parsers/feature-parser";
import { TraceabilityAdapterRegistry } from "../../traceability/adapter-registry";
import { RunResultStore } from "../../traceability/run-result-store";
import { TraceabilitySubsystem } from "../../traceability/traceability-subsystem";
import { PlaywrightJsonParser } from "../../utils/playwright-json-parser";
import { Logger, LogLevel } from "../../utils/logger";

function silentLogger(): Logger {
  const channel = {
    name: "test",
    append: () => { /* no-op */ },
    appendLine: () => { /* no-op */ },
    replace: () => { /* no-op */ },
    clear: () => { /* no-op */ },
    show: () => { /* no-op */ },
    hide: () => { /* no-op */ },
    dispose: () => { /* no-op */ },
  } as unknown as vscode.OutputChannel;
  return Logger.create(channel, LogLevel.ERROR);
}

function configWith(values: Record<string, unknown>): ExtensionConfig {
  const workspaceConfig = {
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      key in values ? (values[key] as T) : defaultValue,
    update: (): Promise<void> => Promise.resolve(),
    inspect: (key: string): { key: string } => ({ key }),
  } as unknown as vscode.WorkspaceConfiguration;
  return ExtensionConfig.create(workspaceConfig, false);
}

describe("TraceabilitySubsystem.knownTestKeys", () => {
  function makeSubsystem(): TraceabilitySubsystem {
    const logger = silentLogger();
    const config = configWith({});
    return new TraceabilitySubsystem(
      config,
      new TraceabilityAdapterRegistry(),
      FeatureParser.create(logger),
      TestDiscoveryManager.create(logger, config),
      PlaywrightJsonParser.create(logger),
      new RunResultStore(),
      logger,
      { get: () => undefined, update: () => Promise.resolve(), keys: () => [] } as unknown as vscode.Memento
    );
  }

  it("dedupes test keys across links, preserving first-seen order", () => {
    const subsystem = makeSubsystem();
    type ModelSeam = {
      model: { snapshot: { links: Array<{ testKey: string }> }; dispose: () => void } | undefined;
    };
    (subsystem as unknown as ModelSeam).model = {
      snapshot: {
        links: [
          { testKey: "CALC-1" },
          { testKey: "CALC-2" },
          { testKey: "CALC-1" },
          { testKey: "MATH-9" },
        ],
      },
      dispose: () => undefined,
    };

    expect(subsystem.knownTestKeys()).toEqual(["CALC-1", "CALC-2", "MATH-9"]);
    subsystem.dispose();
  });

  it("returns an empty array when no model exists (panel off or disposed)", () => {
    const subsystem = makeSubsystem();
    expect(subsystem.knownTestKeys()).toEqual([]);
    subsystem.dispose();
  });
});
