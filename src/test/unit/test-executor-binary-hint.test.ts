import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { ExtensionConfig } from "../../core/extension-config";
import { TestExecutor, type ShellRunner } from "../../core/test-executor";
import { CommandBuilder } from "../../core/command-builder";
import { WorkspaceTrust } from "../../core/workspace-trust";
import { parseExecutableCommand } from "../../core/bounded-command-runner";
import { PlaywrightBddExtensionContext } from "../../types";
import { Logger } from "../../utils/logger";
import { PlaywrightJsonParser } from "../../utils/playwright-json-parser";

function config(values: { bddgenCommand?: string }): ExtensionConfig {
  return ExtensionConfig.create({
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      key === "bddgenCommand" ? (values.bddgenCommand ?? "") as T : defaultValue,
    update: (): Promise<void> => Promise.resolve(),
  } as unknown as vscode.WorkspaceConfiguration, false);
}

function executor(extensionConfig: ExtensionConfig, shell: ShellRunner): TestExecutor {
  const logger = Logger.create();
  const parser = PlaywrightJsonParser.create(logger);
  const value = TestExecutor.create(
    vscode.workspace,
    vscode.window,
    vscode.debug,
    extensionConfig,
    logger,
    parser,
    shell,
    undefined,
    parseExecutableCommand
  );
  value.setContext({
    logger,
    config: extensionConfig,
    testExecutor: value,
    executionGateway: { execute: vi.fn() },
    discoveryManager: {},
    organizationManager: {},
    featureParser: {},
    playwrightJsonParser: parser,
    commandBuilder: CommandBuilder.create(extensionConfig, logger),
    workspaceTrust: new WorkspaceTrust(() => true),
    traceabilityAdapter: {},
  } as unknown as PlaywrightBddExtensionContext);
  return value;
}

describe("TestExecutor missing-binary hint", () => {
  it("appends an actionable hint when the playwright run fails with exit 127 / command not found", async () => {
    const shell: ShellRunner = async () => ({ success: false, output: "", error: "sh: npx: command not found", returnCode: 127 });
    const result = await executor(config({ bddgenCommand: "" }), shell).runScenarioWithOutput({ filePath: "/abs/x.feature" });
    expect(result.error).toContain('The command "npx" was not found');
    expect(result.error).toContain("playwrightBddRunner.playwrightCommand");
    expect(result.error).toContain("command not found");
  });

  it("names the attempted binary from the bddgen step and surfaces it through the bddgen failure", async () => {
    const shell: ShellRunner = async (command) => command.includes("bddgen")
      ? { success: false, output: "", error: "'npx' is not recognized as an internal or external command", returnCode: 1 }
      : { success: true, output: "{}", error: "", returnCode: 0 };
    const result = await executor(config({ bddgenCommand: "npx bddgen" }), shell).runScenarioWithOutput({ filePath: "/abs/x.feature" });
    expect(result.error).toContain("bddgen failed");
    expect(result.error).toContain('The command "npx" was not found');
  });

  it("does not append the hint to an ordinary test failure", async () => {
    const shell: ShellRunner = async () => ({
      success: false,
      output: JSON.stringify({ suites: [{ specs: [{ title: "s", file: "/abs/x.feature", tests: [{ results: [{ status: "failed" }] }] }] }] }),
      error: "1 failed",
      returnCode: 1,
    });
    const result = await executor(config({ bddgenCommand: "" }), shell).runScenarioWithOutput({ filePath: "/abs/x.feature" });
    expect(result.error).not.toContain("was not found");
  });
});
