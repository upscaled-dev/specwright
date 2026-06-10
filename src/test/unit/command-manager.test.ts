import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CommandManager } from "../../commands/command-manager";
import { FeatureParser } from "../../parsers/feature-parser";
import { PlaywrightBddExtensionContext } from "../../types";
import { Logger } from "../../utils/logger";
import { ExtensionConfig } from "../../core/extension-config";
import { TestExecutor } from "../../core/test-executor";
import { TestDiscoveryManager } from "../../core/test-discovery-manager";
import { TestOrganizationManager } from "../../core/test-organization";
import { PlaywrightJsonParser } from "../../utils/playwright-json-parser";
import { CommandBuilder } from "../../core/command-builder";

function makeContext(overrides?: Partial<PlaywrightBddExtensionContext>): PlaywrightBddExtensionContext {
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
  };
  return { ...base, ...(overrides ?? {}) };
}

function writeTempFeature(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmdmgr-"));
  const filePath = path.join(dir, "tmp.feature");
  fs.writeFileSync(filePath, content, "utf-8");
  return filePath;
}

describe("CommandManager.resolveOutlineName — cache", () => {
  let tmpFiles: string[] = [];

  beforeEach(() => {
    tmpFiles = [];
  });

  afterEach(() => {
    for (const f of tmpFiles) {
      try { fs.rmSync(path.dirname(f), { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("parses the file only once when called twice with the same (filePath, mtime)", () => {
    const content = [
      "Feature: F",
      "",
      "  Scenario Outline: Adding",
      "    Given <x>",
      "",
      "    Examples:",
      "      | x |",
      "      | 1 |",
    ].join("\n");
    const filePath = writeTempFeature(content);
    tmpFiles.push(filePath);

    const logger = Logger.create();
    const parser = FeatureParser.create(logger);
    const parseSpy = vi.spyOn(parser, "parseFeatureContent");
    const mgr = CommandManager.create(makeContext({ featureParser: parser }));

    const callResolve = (): string | undefined =>
      (mgr as unknown as {
        resolveOutlineName: (f: string, l: number | undefined, n: string | undefined) => string | undefined;
      }).resolveOutlineName(filePath, 8, "1: Adding - x: 1");

    const first = callResolve();
    const second = callResolve();

    expect(first).toBe("Adding");
    expect(second).toBe("Adding");
    expect(parseSpy).toHaveBeenCalledTimes(1);
  });

  it("re-parses when the file's mtimeMs changes", () => {
    const initialContent = [
      "Feature: F",
      "",
      "  Scenario Outline: Adding",
      "    Given <x>",
      "",
      "    Examples:",
      "      | x |",
      "      | 1 |",
    ].join("\n");
    const filePath = writeTempFeature(initialContent);
    tmpFiles.push(filePath);

    const logger = Logger.create();
    const parser = FeatureParser.create(logger);
    const parseSpy = vi.spyOn(parser, "parseFeatureContent");
    const mgr = CommandManager.create(makeContext({ featureParser: parser }));

    const callResolve = (): string | undefined =>
      (mgr as unknown as {
        resolveOutlineName: (f: string, l: number | undefined, n: string | undefined) => string | undefined;
      }).resolveOutlineName(filePath, 8, "1: Adding - x: 1");

    callResolve();

    const futureMs = Date.now() + 5000;
    fs.utimesSync(filePath, new Date(futureMs), new Date(futureMs));

    callResolve();
    expect(parseSpy).toHaveBeenCalledTimes(2);
  });

  it("returns undefined when scenarioName is not supplied without touching the parser", () => {
    const filePath = writeTempFeature("Feature: F\n  Scenario: x\n");
    tmpFiles.push(filePath);

    const logger = Logger.create();
    const parser = FeatureParser.create(logger);
    const parseSpy = vi.spyOn(parser, "parseFeatureContent");
    const mgr = CommandManager.create(makeContext({ featureParser: parser }));

    const result = (mgr as unknown as {
      resolveOutlineName: (f: string, l: number | undefined, n: string | undefined) => string | undefined;
    }).resolveOutlineName(filePath, 2, undefined);

    expect(result).toBeUndefined();
    expect(parseSpy).not.toHaveBeenCalled();
  });
});

describe("CommandManager run commands — single execution (no double-run)", () => {
  function makeExecutorSpy() {
    return {
      runScenario: vi.fn().mockResolvedValue(undefined),
      runScenarioWithOutput: vi.fn().mockResolvedValue({ success: true, output: "ok", duration: 1 }),
      runFeatureFile: vi.fn().mockResolvedValue(undefined),
      runFeatureFileWithOutput: vi.fn().mockResolvedValue({ success: true, output: "ok", duration: 1 }),
    };
  }

  type Handlers = {
    runScenario: (...a: unknown[]) => Promise<void>;
    runFeature: (...a: unknown[]) => Promise<void>;
    runScenarioWithContext: (...a: unknown[]) => Promise<void>;
    runFeatureFileWithContext: (...a: unknown[]) => Promise<void>;
  };

  it("runScenario executes only the captured (WithOutput) path once, never the terminal path", async () => {
    const exec = makeExecutorSpy();
    const mgr = CommandManager.create(makeContext({ testExecutor: exec as unknown as TestExecutor }));
    await (mgr as unknown as Handlers).runScenario("/abs/x.feature", 3, "S");
    expect(exec.runScenarioWithOutput).toHaveBeenCalledTimes(1);
    expect(exec.runScenario).not.toHaveBeenCalled();
  });

  it("runFeature executes only the captured (WithOutput) path once, never the terminal path", async () => {
    const exec = makeExecutorSpy();
    const mgr = CommandManager.create(makeContext({ testExecutor: exec as unknown as TestExecutor }));
    await (mgr as unknown as Handlers).runFeature("/abs/x.feature");
    expect(exec.runFeatureFileWithOutput).toHaveBeenCalledTimes(1);
    expect(exec.runFeatureFile).not.toHaveBeenCalled();
  });

  it("context-menu run commands execute only once each", async () => {
    const exec = makeExecutorSpy();
    const mgr = CommandManager.create(makeContext({ testExecutor: exec as unknown as TestExecutor }));
    await (mgr as unknown as Handlers).runScenarioWithContext("/abs/x.feature", 3, "S");
    await (mgr as unknown as Handlers).runFeatureFileWithContext("/abs/x.feature");
    expect(exec.runScenarioWithOutput).toHaveBeenCalledTimes(1);
    expect(exec.runFeatureFileWithOutput).toHaveBeenCalledTimes(1);
    expect(exec.runScenario).not.toHaveBeenCalled();
    expect(exec.runFeatureFile).not.toHaveBeenCalled();
  });

  it("context-menu commands accept a vscode.Uri arg and pass its fsPath, not the Uri object", async () => {
    const exec = makeExecutorSpy();
    const mgr = CommandManager.create(makeContext({ testExecutor: exec as unknown as TestExecutor }));
    // VS Code invokes resource context-menu commands with a Uri (has .fsPath), not a string.
    const uri = { fsPath: "/abs/login.feature", scheme: "file" };
    await (mgr as unknown as Handlers).runFeatureFileWithContext(uri);
    expect(exec.runFeatureFileWithOutput).toHaveBeenCalledWith({ filePath: "/abs/login.feature" });
  });
});

describe("scenario.outlineName — Map<test.id, Scenario> lookup model", () => {
  it("returns the parser's outlineName regardless of which organization tree the test item lives in", () => {
    const parser = FeatureParser.create();
    const content = [
      "Feature: F",
      "",
      "  @smoke",
      "  Scenario Outline: Adding",
      "    Given <x>",
      "",
      "    Examples:",
      "      | x |",
      "      | 1 |",
      "      | 2 |",
    ].join("\n");
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    const scenarios = parsed!.scenarios;
    expect(scenarios).toHaveLength(2);

    const scenarioByTestId = new Map<string, typeof scenarios[number]>();
    for (const s of scenarios) {
      s.filePath = "/abs/x.feature";
      scenarioByTestId.set(`${s.filePath}:${s.lineNumber}`, s);
    }

    const lookups = [
      `/abs/x.feature:${scenarios[0]!.lineNumber}`,
      `/abs/x.feature:${scenarios[1]!.lineNumber}`,
    ];
    for (const id of lookups) {
      const s = scenarioByTestId.get(id);
      expect(s?.isScenarioOutline ? s.outlineName : undefined).toBe("Adding");
    }
  });

  it("yields undefined outlineName for a non-outline scenario (so options.outlineName is omitted)", () => {
    const parser = FeatureParser.create();
    const content = [
      "Feature: F",
      "",
      "  Scenario: Plain",
      "    Given x",
    ].join("\n");
    const parsed = parser.parseFeatureContent(content);
    expect(parsed).not.toBeNull();
    const s = parsed!.scenarios[0]!;
    expect(s.isScenarioOutline).toBe(false);
  });
});
