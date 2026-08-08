import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { CommandManager } from "../../../commands/command-manager";
import { CommandBuilder } from "../../../core/command-builder";
import { ExtensionConfig } from "../../../core/extension-config";
import { TestDiscoveryManager } from "../../../core/test-discovery-manager";
import { TestExecutor } from "../../../core/test-executor";
import { TestOrganizationManager } from "../../../core/test-organization";
import { LegacyDirectExecutionGateway } from "../../../core/execution-gateway";
import { LegacyExecutionDiscovery } from "../../../core/legacy-discovery";
import { FeatureParser } from "../../../parsers/feature-parser";
import type { ScenarioRef } from "../../../traceability/scenario-ref";
import type { RunArtifactStore } from "../../../traceability/run-artifact-store";
import type { PlaywrightBddExtensionContext } from "../../../types";
import { Logger } from "../../../utils/logger";
import { PlaywrightJsonParser } from "../../../utils/playwright-json-parser";
import { XrayAdapter } from "../../../xray/xray-adapter";
import { WorkspaceTrust } from "../../../core/workspace-trust";
import { LegacyArtifactGateway } from "../../../ui/legacy-artifact-gateway";

export function makeContext(
  overrides?: Partial<PlaywrightBddExtensionContext> & {
    mappedScenarios?: readonly ScenarioRef[];
  }
): PlaywrightBddExtensionContext {
  const logger = Logger.create();
  const config = ExtensionConfig.create();
  const testExecutor = TestExecutor.create();
  const featureParser = FeatureParser.create(logger);
  const discoveryManager = TestDiscoveryManager.create(logger, config);
  const base = {
    logger,
    config,
    testExecutor,
    discoveryManager,
    organizationManager: TestOrganizationManager.create(logger),
    featureParser,
    playwrightJsonParser: PlaywrightJsonParser.create(logger),
    commandBuilder: CommandBuilder.create(config, logger),
    workspaceTrust: new WorkspaceTrust(() => true),
    attachmentSpoolRoot: path.join(os.tmpdir(), "specwright-command-tests"),
    extensionUri: vscode.Uri.file("/extension"),
    traceabilityAdapter: new XrayAdapter(config),
  };
  const merged = { ...base, ...(overrides ?? {}) };
  const legacyGateway = new LegacyDirectExecutionGateway(
    merged.testExecutor,
    merged.featureParser,
    merged.workspaceTrust,
    undefined,
    undefined,
    new LegacyExecutionDiscovery(merged.discoveryManager, merged.featureParser)
  );
  return {
    ...merged,
    executionGateway: overrides?.executionGateway ?? (overrides?.runArtifactStore
      ? new LegacyArtifactGateway(
        legacyGateway,
        overrides.runArtifactStore as RunArtifactStore,
        merged.logger,
        merged.testExecutor,
        overrides.mappedScenarios ? () => overrides.mappedScenarios ?? [] : undefined
      )
      : legacyGateway),
  };
}

export function memento(): vscode.Memento {
  const store = new Map<string, unknown>();
  return {
    keys: () => [...store.keys()],
    get: (key: string, defaultValue?: unknown) =>
      store.has(key) ? store.get(key) : defaultValue,
    update: (key: string, value: unknown) => {
      store.set(key, JSON.parse(JSON.stringify(value)));
      return Promise.resolve();
    },
  } as unknown as vscode.Memento;
}

export function captureHandlers(
  context: PlaywrightBddExtensionContext
): Map<string, (...args: unknown[]) => Promise<void>> {
  const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
  const commandsApi = vscode.commands as unknown as { registerCommand: unknown };
  const original = commandsApi.registerCommand;
  commandsApi.registerCommand = (
    command: string,
    handler: (...args: unknown[]) => Promise<void>
  ): { dispose: () => void } => {
    handlers.set(command, handler);
    return { dispose: () => {} };
  };
  try {
    const manager = CommandManager.create(context);
    manager.registerCommands({
      subscriptions: [],
      extensionUri: vscode.Uri.file("/extension"),
      globalStorageUri: vscode.Uri.file("/tmp/specwright-command-tests"),
    } as unknown as vscode.ExtensionContext);
  } finally {
    commandsApi.registerCommand = original;
  }
  return handlers;
}

export function fakeDoc(text: string, fsPath = "/ws/a.feature"): vscode.TextDocument {
  const separator = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(separator);
  return {
    uri: vscode.Uri.file(fsPath),
    eol: separator === "\r\n" ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF,
    getText: () => text,
    lineAt: (line: number) => ({
      text: lines[line] ?? "",
      rangeIncludingLineBreak: new vscode.Range(line, 0, line + 1, 0),
    }),
    save: () => Promise.resolve(true),
  } as unknown as vscode.TextDocument;
}

export function writeTempFeature(content: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cmdmgr-"));
  const filePath = path.join(directory, "tmp.feature");
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}
