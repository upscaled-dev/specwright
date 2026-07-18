import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
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
import { TraceabilityAdapter } from "../../traceability/traceability-adapter";
import { XrayAdapter } from "../../xray/xray-adapter";

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
    traceabilityAdapter: new XrayAdapter(config),
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

describe("CommandManager — StepDefinitionProvider caching", () => {
  type StepDefProviderAccess = { getStepDefinitionProvider: () => unknown };

  it("reuses a single provider across invocations (no per-call re-scan)", () => {
    const mgr = CommandManager.create(makeContext());
    const get = (): unknown => (mgr as unknown as StepDefProviderAccess).getStepDefinitionProvider();
    expect(get()).toBe(get());
  });

  it("rebuilds the provider after a configuration change", () => {
    const config = ExtensionConfig.create();
    const mgr = CommandManager.create(makeContext({ config }));
    const get = (): unknown => (mgr as unknown as StepDefProviderAccess).getStepDefinitionProvider();
    const first = get();
    config.reload();
    expect(get()).not.toBe(first);
  });
});

describe("command contributions ↔ handler registrations parity", () => {
  interface PackageJson {
    contributes: {
      commands: Array<{ command: string }>;
      menus: Record<string, Array<{ command?: string; when?: string; submenu?: string; group?: string }>>;
    };
  }
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf-8")
  ) as PackageJson;

  function registeredCommandIds(): string[] {
    const registered: string[] = [];
    const commandsApi = vscode.commands as unknown as { registerCommand: unknown };
    const original = commandsApi.registerCommand;
    commandsApi.registerCommand = (cmd: string): { dispose: () => void } => {
      registered.push(cmd);
      return { dispose: () => {} };
    };
    try {
      const mgr = CommandManager.create(makeContext());
      mgr.registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext);
      mgr.dispose();
    } finally {
      commandsApi.registerCommand = original;
    }
    return registered;
  }

  it("every contributed playwrightBddRunner command has a handler and vice versa", () => {
    const contributed = pkg.contributes.commands.map((c) => c.command).sort();
    const registered = registeredCommandIds().sort();
    expect(registered).toEqual(contributed);
  });

  it("places the Steps panel commands in the view menus, gated on the stepsExplorer view", () => {
    const viewTitle = pkg.contributes.menus["view/title"]!;
    const stepsTitle = viewTitle.filter((e) => e.when?.includes("stepsExplorer"));
    expect(stepsTitle.map((e) => e.command)).toEqual([
      "playwrightBddRunner.refreshStepsPanel",
      "playwrightBddRunner.exportSteps",
      "playwrightBddRunner.exportScenarios",
    ]);
    for (const entry of stepsTitle) {
      expect(entry.when).toBe("view == playwrightBddRunner.stepsExplorer");
    }

    const itemContext = pkg.contributes.menus["view/item/context"]!;
    const stepsItems = itemContext.filter((e) => e.when?.includes("stepsExplorer"));
    expect(stepsItems.map((e) => [e.command, e.when])).toEqual([
      ["playwrightBddRunner.insertStep", "view == playwrightBddRunner.stepsExplorer && viewItem == stepDefinition"],
      ["playwrightBddRunner.scaffoldStepFromPanel", "view == playwrightBddRunner.stepsExplorer && viewItem == unmatchedStep"],
      ["playwrightBddRunner.scaffoldFeatureFromPanel", "view == playwrightBddRunner.stepsExplorer && viewItem == unmatchedFile"],
    ]);
  });

  it("hides the tree-node scaffold wrappers from the command palette", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    for (const command of [
      "playwrightBddRunner.scaffoldStepFromPanel",
      "playwrightBddRunner.scaffoldFeatureFromPanel",
    ]) {
      expect(palette.find((e) => e.command === command)?.when).toBe("false");
    }
    for (const command of [
      "playwrightBddRunner.refreshStepsPanel",
      "playwrightBddRunner.exportSteps",
      "playwrightBddRunner.exportScenarios",
      "playwrightBddRunner.insertStep",
    ]) {
      expect(palette.find((e) => e.command === command)).toBeUndefined();
    }
  });

  it("places the traceability node commands inline on the test-key item and hides them from the palette", () => {
    const itemContext = pkg.contributes.menus["view/item/context"]!;
    const traceabilityItems = itemContext.filter((e) => e.when?.includes("playwrightBddRunner.traceability"));
    expect(traceabilityItems.map((e) => [e.command, e.when])).toEqual([
      ["playwrightBddRunner.traceability.openIssue", "view == playwrightBddRunner.traceability && viewItem == traceabilityTestKey"],
      ["playwrightBddRunner.traceability.copyKey", "view == playwrightBddRunner.traceability && viewItem == traceabilityTestKey"],
    ]);

    const palette = pkg.contributes.menus["commandPalette"]!;
    for (const command of ["playwrightBddRunner.traceability.openIssue", "playwrightBddRunner.traceability.copyKey"]) {
      expect(palette.find((e) => e.command === command)?.when).toBe("false");
    }
  });

  it("puts the manage-connection gear in the traceability view title bar", () => {
    const viewTitle = pkg.contributes.menus["view/title"]!;
    const gear = viewTitle.find((e) => e.command === "playwrightBddRunner.traceability.manageConnection");
    expect(gear?.when).toBe("view == playwrightBddRunner.traceability");
    expect(gear?.group).toBe("navigation@1");
  });
});

interface EnvHooks {
  __openExternalCalls: string[];
  __clipboardText: string;
  __resetEnv: () => void;
}

const envHooks = (vscode as unknown as { env: EnvHooks }).env;

function stubAdapter(browseUrl: (key: string) => string | undefined): TraceabilityAdapter {
  return {
    id: "xray",
    label: "Xray",
    keyGrammar: {
      testPrefix: "TEST_",
      reqPrefix: "REQ_",
      keyShape: /^[A-Z]+-\d+$/,
      canonicalizeKey: (key) => key.toUpperCase(),
    },
    browseUrl,
  };
}

function captureHandlers(context: PlaywrightBddExtensionContext): Map<string, (...a: unknown[]) => Promise<void>> {
  const handlers = new Map<string, (...a: unknown[]) => Promise<void>>();
  const commandsApi = vscode.commands as unknown as { registerCommand: unknown };
  const original = commandsApi.registerCommand;
  commandsApi.registerCommand = (cmd: string, cb: (...a: unknown[]) => Promise<void>): { dispose: () => void } => {
    handlers.set(cmd, cb);
    return { dispose: () => {} };
  };
  try {
    const mgr = CommandManager.create(context);
    mgr.registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext);
  } finally {
    commandsApi.registerCommand = original;
  }
  return handlers;
}

describe("traceability browse/copy command handlers", () => {
  beforeEach(() => envHooks.__resetEnv());

  async function openIssue(adapter: TraceabilityAdapter, arg: unknown): Promise<void> {
    const handlers = captureHandlers(makeContext({ traceabilityAdapter: adapter }));
    await handlers.get("playwrightBddRunner.traceability.openIssue")!(arg);
  }

  it("opens the browse URL the adapter resolves for the key", async () => {
    await openIssue(stubAdapter((key) => `https://acme.atlassian.net/browse/${key}`), { testKey: "CALC-1" });
    expect(envHooks.__openExternalCalls).toEqual(["https://acme.atlassian.net/browse/CALC-1"]);
  });

  it("warns and opens nothing when the adapter yields no browse URL", async () => {
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    await openIssue(stubAdapter(() => undefined), { testKey: "CALC-1" });
    expect(envHooks.__openExternalCalls).toEqual([]);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("no-ops when the item carries no issue key", async () => {
    await openIssue(stubAdapter((key) => `https://acme.atlassian.net/browse/${key}`), { notAKey: true });
    expect(envHooks.__openExternalCalls).toEqual([]);
  });

  it("copies the issue key to the clipboard", async () => {
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.copyKey")!({ testKey: "CALC-1" });
    expect(envHooks.__clipboardText).toBe("CALC-1");
  });
});

describe("traceability hidePanel command handler", () => {
  interface Update {
    key: string;
    value: unknown;
    target: vscode.ConfigurationTarget;
  }

  function stubWorkspaceConfig(inspected: Record<string, unknown>): Update[] {
    const updates: Update[] = [];
    const wsConfig = {
      get: (): unknown => undefined,
      inspect: (): Record<string, unknown> => inspected,
      update: (key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void> => {
        updates.push({ key, value, target });
        return Promise.resolve();
      },
    } as unknown as vscode.WorkspaceConfiguration;
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(wsConfig);
    return updates;
  }

  afterEach(() => vi.restoreAllMocks());

  it("writes traceability.enablePanel=false to Global when it is not workspace-pinned", async () => {
    const updates = stubWorkspaceConfig({});
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.hidePanel")!();
    expect(updates).toEqual([
      { key: "traceability.enablePanel", value: false, target: vscode.ConfigurationTarget.Global },
    ]);
  });

  it("writes it back to the Workspace when the setting is pinned there", async () => {
    const updates = stubWorkspaceConfig({ workspaceValue: true });
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.hidePanel")!();
    expect(updates[0]?.target).toBe(vscode.ConfigurationTarget.Workspace);
  });
});

describe("traceability panel connection UX contributions", () => {
  interface PackageJson {
    contributes: {
      viewsWelcome: Array<{ view: string; when?: string; contents: string }>;
      menus: Record<string, Array<{ command?: string; when?: string }>>;
    };
  }
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf-8")
  ) as PackageJson;

  it("splits the traceability welcome into connected and not-connected states", () => {
    const welcomes = pkg.contributes.viewsWelcome.filter(
      (w) => w.view === "playwrightBddRunner.traceability"
    );
    const setup = welcomes.find((w) => w.when === "!playwrightBddRunner.traceability.connected");
    const connected = welcomes.find((w) => w.when === "playwrightBddRunner.traceability.connected");
    expect(setup).toBeDefined();
    expect(connected).toBeDefined();
    expect(setup!.contents).toContain("command:playwrightBddRunner.traceability.connect");
    expect(setup!.contents).toContain("command:playwrightBddRunner.traceability.hidePanel");
  });

  it("keeps the welcome-only hidePanel command out of the palette", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    expect(
      palette.find((e) => e.command === "playwrightBddRunner.traceability.hidePanel")?.when
    ).toBe("false");
  });
});
