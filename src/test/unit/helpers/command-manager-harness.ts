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
import { FeatureParser } from "../../../parsers/feature-parser";
import type { PlaywrightBddExtensionContext } from "../../../types";
import { Logger } from "../../../utils/logger";
import { PlaywrightJsonParser } from "../../../utils/playwright-json-parser";
import { XrayAdapter } from "../../../xray/xray-adapter";

export function makeContext(
  overrides?: Partial<PlaywrightBddExtensionContext>
): PlaywrightBddExtensionContext {
  const logger = Logger.create();
  const config = ExtensionConfig.create();
  const base: PlaywrightBddExtensionContext = {
    logger,
    config,
    testExecutor: TestExecutor.create(),
    discoveryManager: TestDiscoveryManager.create(logger, config),
    organizationManager: TestOrganizationManager.create(logger),
    featureParser: FeatureParser.create(logger),
    playwrightJsonParser: PlaywrightJsonParser.create(logger),
    commandBuilder: CommandBuilder.create(config, logger),
    traceabilityAdapter: new XrayAdapter(config),
  };
  return { ...base, ...(overrides ?? {}) };
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
    manager.registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext);
  } finally {
    commandsApi.registerCommand = original;
  }
  return handlers;
}

export function fakeDoc(text: string): vscode.TextDocument {
  const separator = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(separator);
  return {
    uri: vscode.Uri.file("/ws/a.feature"),
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
