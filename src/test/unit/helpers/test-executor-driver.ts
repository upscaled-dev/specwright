import * as nodePath from "node:path";
import * as vscode from "vscode";
import { vi } from "vitest";
import { BreakpointMirror } from "../../../core/breakpoint-mirror";
import { parseExecutableCommand } from "../../../core/bounded-command-runner";
import { CommandBuilder } from "../../../core/command-builder";
import { ExtensionConfig } from "../../../core/extension-config";
import { generatedSpecPaths } from "../../../core/generated-test-target";
import { TestExecutor, ShellRunner } from "../../../core/test-executor";
import { WorkspaceTrust } from "../../../core/workspace-trust";
import { BddgenDiagnosticsProvider } from "../../../providers/bddgen-diagnostics-provider";
import { PlaywrightBddExtensionContext } from "../../../types";
import { Logger } from "../../../utils/logger";
import { PlaywrightJsonParser, normalizePathKey } from "../../../utils/playwright-json-parser";

export interface ExecutorDeps {
  workspace?: typeof vscode.workspace;
  window?: typeof vscode.window;
  debug?: typeof vscode.debug;
  bddgenDiagnostics?: BddgenDiagnosticsProvider;
  mirror?: BreakpointMirror;
  playwrightJsonParser?: PlaywrightJsonParser;
}

export function makeConfig(
  values: { preRunCommand?: string; workingDirectory?: string; bddgenCommand?: string } = {}
): ExtensionConfig {
  const stub = {
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      if (key === "preRunCommand") {return (values.preRunCommand ?? "") as unknown as T;}
      if (key === "workingDirectory") {return (values.workingDirectory ?? "") as unknown as T;}
      if (key === "bddgenCommand" && values.bddgenCommand !== undefined) {
        return values.bddgenCommand as unknown as T;
      }
      return defaultValue;
    },
    update: (): Promise<void> => Promise.resolve(),
  } as unknown as vscode.WorkspaceConfiguration;
  return ExtensionConfig.create(stub, false);
}

export function makeExecutor(
  config: ExtensionConfig,
  shellRunner: ShellRunner,
  deps: ExecutorDeps = {}
): { executor: TestExecutor; commandBuilder: CommandBuilder } {
  const logger = Logger.create();
  const playwrightJsonParser = deps.playwrightJsonParser ?? PlaywrightJsonParser.create(logger);
  const executor = TestExecutor.create(
    deps.workspace ?? vscode.workspace,
    deps.window ?? vscode.window,
    deps.debug ?? vscode.debug,
    config,
    logger,
    playwrightJsonParser,
    shellRunner,
    deps.mirror,
    parseExecutableCommand
  );
  const commandBuilder = CommandBuilder.create(config, logger);
  const context: PlaywrightBddExtensionContext = {
    logger,
    config,
    testExecutor: executor,
    executionGateway: { execute: vi.fn() } as unknown as PlaywrightBddExtensionContext["executionGateway"],
    discoveryManager: {} as PlaywrightBddExtensionContext["discoveryManager"],
    organizationManager: {} as PlaywrightBddExtensionContext["organizationManager"],
    featureParser: {} as PlaywrightBddExtensionContext["featureParser"],
    playwrightJsonParser,
    commandBuilder,
    workspaceTrust: new WorkspaceTrust(() => true),
    traceabilityAdapter: {} as PlaywrightBddExtensionContext["traceabilityAdapter"],
    ...(deps.bddgenDiagnostics ? { bddgenDiagnostics: deps.bddgenDiagnostics } : {}),
  };
  executor.setContext(context);
  const debugFixture = executor as unknown as {
    resolveSpecPaths(workingDir: string, filePath: string): string[];
  };
  debugFixture.resolveSpecPaths = (workingDir, filePath) => {
    const discovered = generatedSpecPaths(workingDir, config.featuresGenDir, filePath);
    const fixtureRoot = normalizePathKey(workingDir);
    if (discovered.length > 0 || (fixtureRoot !== "/abs" && fixtureRoot !== "/work")) {return discovered;}
    return [nodePath.join(workingDir, ".features-gen", "features/a.feature.spec.js")];
  };
  return { executor, commandBuilder };
}
