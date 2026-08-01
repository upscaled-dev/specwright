import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import { CommandManager } from "../../commands/command-manager";
import { TraceabilityCommands } from "../../commands/traceability-commands";
import { TraceabilityLinkCommands } from "../../commands/traceability-link-commands";
import { TraceabilityPublishCommands } from "../../commands/traceability-publish-commands";
import { FeatureParser } from "../../parsers/feature-parser";
import { Logger } from "../../utils/logger";
import { ExtensionConfig } from "../../core/extension-config";
import { TestExecutor } from "../../core/test-executor";
import { ExternalRef, RunArtifact, SyncProgress, SyncScope, TraceabilityAdapter } from "../../traceability/contracts";
import { XrayAdapter } from "../../xray/xray-adapter";
import { XrayCredentialStore } from "../../xray/xray-credential-store";
import { InMemoryTraceabilityAdapter } from "../../traceability/in-memory-adapter";
import { BoardPanel, BoardPanelDeps } from "../../traceability/board-panel";
import type { TraceabilitySubsystem } from "../../traceability/traceability-subsystem";
import { NO_MAPPING_PAGE_SIZE } from "../../traceability/mapping-page-size";
import { NO_PROJECT_SCOPE, ProjectScopeStore, projectScopeStore } from "../../traceability/project-scope";
import { ArtifactCaptureTarget, RunArtifactStore } from "../../traceability/run-artifact-store";
import { PublishLedger } from "../../traceability/publish-ledger";
import { BoardViewModel, scenarioDropId } from "../../traceability/board-data";
import type { TraceabilitySnapshot, TraceLink } from "../../traceability/traceability-model";
import type { ScenarioRef } from "../../traceability/scenario-ref";
import type { PreflightChoice } from "../../traceability/preflight-flow";
import { applyWsEdit, EditEntry } from "./helpers/workspace-edit";
import { captureHandlers, fakeDoc, makeContext, memento, writeTempFeature } from "./helpers/command-manager-harness";

// The webview-panel stub the board opens onto: `__posted` records what the host sent, `__receive`
// delivers an inbound message, and the reset disposes every panel between tests.
interface StubBoardPanel {
  title: string;
  webview: { __posted: Array<{ surface?: string; type: string; projects?: string[]; text?: string }> };
  __revealCount: number;
  dispose: () => void;
  __receive: (message: unknown) => Promise<void>;
}
const win = vscode.window as unknown as {
  __webviewPanels: StubBoardPanel[];
  __resetWebviewPanels: () => void;
};

function traceabilityCommands(manager: CommandManager): TraceabilityCommands {
  return (manager as unknown as { traceabilityCommands: TraceabilityCommands })
    .traceabilityCommands;
}

function linkCommands(manager: CommandManager): TraceabilityLinkCommands {
  return (
    traceabilityCommands(manager) as unknown as {
      getLinkCommands: () => TraceabilityLinkCommands;
    }
  ).getLinkCommands();
}

function publishCommands(manager: CommandManager): TraceabilityPublishCommands {
  return (
    traceabilityCommands(manager) as unknown as {
      getPublishCommands: () => TraceabilityPublishCommands;
    }
  ).getPublishCommands();
}

function traceabilityBoardDeps(manager: CommandManager): BoardPanelDeps {
  return (
    traceabilityCommands(manager) as unknown as {
      boardDeps: () => BoardPanelDeps;
    }
  ).boardDeps();
}

describe("CommandManager.resolveOutlineName: cache", () => {
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

describe("CommandManager run commands: single execution (no double-run)", () => {
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
    expect(exec.runFeatureFileWithOutput).toHaveBeenCalledWith(expect.objectContaining({
      filePath: "/abs/login.feature",
    }));
  });

  it("wires editor-run cancellation through the executor and its open TestRun session", async () => {
    const cancelled = { success: false, output: "", error: "Cancelled", duration: 1 };
    const runFeatureFileWithOutput = vi.fn(async (options: { signal?: AbortSignal }) => {
      await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
      return cancelled;
    });
    const exec = {
      ...makeExecutorSpy(),
      runFeatureFileWithOutput,
    };
    const complete = vi.fn();
    const end = vi.fn();
    const beginExternalRun = vi.fn(() => ({ progress: {}, complete, end }));
    const mgr = CommandManager.create(makeContext({ testExecutor: exec as unknown as TestExecutor }));
    mgr.setTestProvider({ beginExternalRun });
    const progressSpy = vi.spyOn(vscode.window, "withProgress").mockImplementation((
      _options,
      task
    ) => Promise.resolve(task(
      { report: () => undefined },
      {
        isCancellationRequested: false,
        onCancellationRequested: (listener) => {
          queueMicrotask(() => listener(undefined));
          return { dispose: () => undefined };
        },
      } as vscode.CancellationToken
    )));

    try {
      await (mgr as unknown as Handlers).runFeature("/abs/x.feature");
    } finally {
      progressSpy.mockRestore();
    }

    expect(beginExternalRun).toHaveBeenCalledWith("/abs/x.feature", undefined);
    expect(runFeatureFileWithOutput.mock.calls[0]?.[0].signal?.aborted).toBe(true);
    expect(complete).toHaveBeenCalledWith(cancelled);
    expect(end).not.toHaveBeenCalled();
  });
});

describe("scenario.outlineName: Map<test.id, Scenario> lookup model", () => {
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

describe("CommandManager palette run commands", () => {
  const window = vscode.window as unknown as { activeTextEditor: unknown };

  afterEach(() => {
    window.activeTextEditor = undefined;
    vi.restoreAllMocks();
  });

  it("resolves the active feature and cursor for zero-argument run and debug commands", async () => {
    const exec = {
      runScenarioWithOutput: vi.fn().mockResolvedValue({ success: true, output: "ok", duration: 1 }),
      runFeatureFileWithOutput: vi.fn().mockResolvedValue({ success: true, output: "ok", duration: 1 }),
      debugScenario: vi.fn().mockResolvedValue(undefined),
    };
    window.activeTextEditor = {
      document: fakeDoc("Feature: Palette\n\nScenario: chosen\n  Given a step\n"),
      selection: { active: { line: 3 } },
    };
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("@smoke");
    const handlers = captureHandlers(makeContext({ testExecutor: exec as unknown as TestExecutor }));

    await handlers.get("playwrightBddRunner.runScenario")!();
    await handlers.get("playwrightBddRunner.debugScenario")!();
    await handlers.get("playwrightBddRunner.runFeatureFile")!();
    await handlers.get("playwrightBddRunner.runScenarioWithTags")!();
    await handlers.get("playwrightBddRunner.runFeatureFileWithTags")!();

    expect(exec.runScenarioWithOutput).toHaveBeenCalledTimes(2);
    expect(exec.runScenarioWithOutput.mock.calls.map(([options]) => options)).toEqual([
      expect.objectContaining({ filePath: "/ws/a.feature", lineNumber: 3, scenarioName: "chosen" }),
      expect.objectContaining({ filePath: "/ws/a.feature", lineNumber: 3, scenarioName: "chosen", tags: "@smoke" }),
    ]);
    expect(exec.debugScenario).toHaveBeenCalledWith(expect.objectContaining({
      filePath: "/ws/a.feature", lineNumber: 3, scenarioName: "chosen",
    }));
    expect(exec.runFeatureFileWithOutput.mock.calls.map(([options]) => options)).toEqual([
      expect.objectContaining({ filePath: "/ws/a.feature" }),
      expect.objectContaining({ filePath: "/ws/a.feature", tags: "@smoke" }),
    ]);
  });

  it("picks a discovered feature and scenario when no feature editor is active", async () => {
    const filePath = writeTempFeature("Feature: Palette\n\nScenario: picked\n  Given a step\n");
    const exec = {
      runScenarioWithOutput: vi.fn().mockResolvedValue({ success: true, output: "ok", duration: 1 }),
    };
    const discoveryManager = { discoverTestFiles: vi.fn().mockResolvedValue([filePath]) };
    vi.spyOn(vscode.window, "showQuickPick").mockImplementation((items) =>
      Promise.resolve((items as Array<unknown>)[0] as never)
    );
    const handlers = captureHandlers(makeContext({
      discoveryManager: discoveryManager as never,
      testExecutor: exec as unknown as TestExecutor,
    }));

    try {
      await handlers.get("playwrightBddRunner.runScenario")!();
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }

    expect(discoveryManager.discoverTestFiles).toHaveBeenCalledOnce();
    expect(exec.runScenarioWithOutput).toHaveBeenCalledWith(expect.objectContaining({
      filePath, lineNumber: 3, scenarioName: "picked",
    }));
  });

  it("treats target and tag prompt cancellation as a quiet no-op", async () => {
    const exec = {
      runScenarioWithOutput: vi.fn(),
      runFeatureFileWithOutput: vi.fn(),
    };
    const errors = vi.spyOn(vscode.window, "showErrorMessage");
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    const handlers = captureHandlers(makeContext({
      discoveryManager: { discoverTestFiles: vi.fn().mockResolvedValue(["/ws/a.feature"]) } as never,
      testExecutor: exec as unknown as TestExecutor,
    }));

    await handlers.get("playwrightBddRunner.runScenario")!();

    window.activeTextEditor = {
      document: fakeDoc("Feature: Palette\n\nScenario: chosen\n  Given a step\n"),
      selection: { active: { line: 3 } },
    };
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue(undefined);
    await handlers.get("playwrightBddRunner.runFeatureFileWithTags")!();

    expect(exec.runScenarioWithOutput).not.toHaveBeenCalled();
    expect(exec.runFeatureFileWithOutput).not.toHaveBeenCalled();
    expect(errors).not.toHaveBeenCalled();
  });

  it("passes a palette outline target through to execution", async () => {
    const exec = {
      runScenarioWithOutput: vi.fn().mockResolvedValue({ success: true, output: "ok", duration: 1 }),
      debugScenario: vi.fn().mockResolvedValue(undefined),
    };
    window.activeTextEditor = {
      document: fakeDoc([
        "Feature: Palette",
        "Scenario Outline: Divide",
        "  Given <n>",
        "  Examples:",
        "    | n |",
        "    | 1 |",
      ].join("\n")),
      selection: { active: { line: 2 } },
    };
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("@smoke");
    const handlers = captureHandlers(makeContext({ testExecutor: exec as unknown as TestExecutor }));

    await handlers.get("playwrightBddRunner.runScenario")!();
    await handlers.get("playwrightBddRunner.debugScenario")!();
    await handlers.get("playwrightBddRunner.runScenarioWithTags")!();

    expect(exec.runScenarioWithOutput.mock.calls.map(([options]) => options)).toEqual([
      expect.objectContaining({ lineNumber: 2, scenarioName: "Divide", outlineName: "Divide" }),
      expect.objectContaining({ lineNumber: 2, scenarioName: "Divide", outlineName: "Divide", tags: "@smoke" }),
    ]);
    expect(exec.debugScenario).toHaveBeenCalledWith(expect.objectContaining({
      lineNumber: 2, scenarioName: "Divide", outlineName: "Divide",
    }));
  });

  it("surfaces selected-file and empty-tag errors through the command handler", async () => {
    const exec = { runFeatureFileWithOutput: vi.fn() };
    const errors = vi.spyOn(vscode.window, "showErrorMessage");
    vi.spyOn(vscode.window, "showQuickPick").mockImplementation((items) =>
      Promise.resolve((items as Array<unknown>)[0] as never)
    );
    const handlers = captureHandlers(makeContext({
      discoveryManager: { discoverTestFiles: vi.fn().mockResolvedValue(["/ws/missing.feature"]) } as never,
      testExecutor: exec as unknown as TestExecutor,
    }));

    await handlers.get("playwrightBddRunner.runFeatureFile")!();

    window.activeTextEditor = {
      document: fakeDoc("Feature: Palette\nScenario: chosen\n"),
      selection: { active: { line: 1 } },
    };
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("  ");
    await handlers.get("playwrightBddRunner.runFeatureFileWithTags")!();

    expect(exec.runFeatureFileWithOutput).not.toHaveBeenCalled();
    expect(errors.mock.calls.map(([message]) => String(message))).toEqual([
      expect.stringContaining("Unable to read feature file: /ws/missing.feature"),
      expect.stringContaining("Tags are required"),
    ]);
  });
});

describe("CommandManager: StepDefinitionProvider caching", () => {
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
      commands: Array<{ command: string; icon?: string }>;
      menus: Record<string, Array<{ command?: string; when?: string; submenu?: string; group?: string }>>;
    };
  }
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf-8")
  ) as PackageJson;

  const paletteCommands = {
    visible: [
      "playwrightBddRunner.discoverTests",
      "playwrightBddRunner.refreshTests",
      "playwrightBddRunner.runAllTests",
      "playwrightBddRunner.runScenario",
      "playwrightBddRunner.debugScenario",
      "playwrightBddRunner.runAllTestsParallel",
      "playwrightBddRunner.runFeatureFile",
      "playwrightBddRunner.runScenarioWithTags",
      "playwrightBddRunner.runFeatureFileWithTags",
      "playwrightBddRunner.setOrganizationStrategy",
      "playwrightBddRunner.setTagBasedOrganization",
      "playwrightBddRunner.setFileBasedOrganization",
      "playwrightBddRunner.setScenarioTypeOrganization",
      "playwrightBddRunner.setFlatOrganization",
      "playwrightBddRunner.setFeatureBasedOrganization",
      "playwrightBddRunner.debugOrganization",
      "playwrightBddRunner.showOutput",
      "playwrightBddRunner.validateConfiguration",
      "playwrightBddRunner.generateStepDefinitions",
      "playwrightBddRunner.goToStepDefinition",
      "playwrightBddRunner.refreshStepsPanel",
      "playwrightBddRunner.exportSteps",
      "playwrightBddRunner.exportScenarios",
      "playwrightBddRunner.insertStep",
      "playwrightBddRunner.traceability.runAndPublish",
      "playwrightBddRunner.traceability.publishLastRun",
      "playwrightBddRunner.traceability.sync",
      "playwrightBddRunner.traceability.openBoard",
      "playwrightBddRunner.traceability.manageConnection",
      "playwrightBddRunner.traceability.connect",
      "playwrightBddRunner.traceability.disconnect",
      "playwrightBddRunner.traceability.testConnection",
      "playwrightBddRunner.traceability.toggleGrouping",
      "playwrightBddRunner.traceability.switchDefaultProject",
      "playwrightBddRunner.traceability.clearLocalRunHistory",
      "playwrightBddRunner.traceability.bulkCreateTests",
      "playwrightBddRunner.traceability.createTestSet",
      "playwrightBddRunner.traceability.createTestPlan",
      "playwrightBddRunner.traceability.createTestExecution",
    ],
    hidden: [
      "playwrightBddRunner.runScenarioWithContext",
      "playwrightBddRunner.debugScenarioWithContext",
      "playwrightBddRunner.runFeatureFileWithContext",
      "playwrightBddRunner.generateStepDefinitionForStep",
      "playwrightBddRunner.scaffoldStepFromPanel",
      "playwrightBddRunner.scaffoldFeatureFromPanel",
      "playwrightBddRunner.traceability.openIssue",
      "playwrightBddRunner.traceability.copyKey",
      "playwrightBddRunner.traceability.linkScenario",
      "playwrightBddRunner.traceability.hidePanel",
      "playwrightBddRunner.traceability.pushScenarioText",
    ],
  };

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

  // The board's webview serializer must stay out of the re-runnable path: the host refuses a second one
  // for the same view type, and registerCommands is re-run on purpose.
  it("survives a re-run of registerCommands once the board serializer is registered", () => {
    const subscriptions: Array<{ dispose: () => void }> = [];
    const context = { subscriptions } as unknown as vscode.ExtensionContext;
    const mgr = CommandManager.create(makeContext());

    mgr.registerCommands(context);
    mgr.registerBoardSerializer(context);

    expect(() => mgr.registerCommands(context)).not.toThrow();
    mgr.dispose();
    for (const subscription of subscriptions.splice(0)) {
      subscription.dispose();
    }
  });

  it("every contributed playwrightBddRunner command has a handler and vice versa", () => {
    const contributed = pkg.contributes.commands.map((c) => c.command).sort();
    const registered = registeredCommandIds().sort();
    expect(registered).toEqual(contributed);
  });

  it("classifies every contributed command as palette-visible or explicitly hidden", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    const paletteIds = palette.flatMap((entry) => entry.command === undefined ? [] : [entry.command]);
    const contributed = pkg.contributes.commands.map((c) => c.command).sort();
    const classified = [...paletteCommands.visible, ...paletteCommands.hidden].sort();
    const effectiveVisible = contributed.filter(
      (command) => {
        const entries = palette.filter((entry) => entry.command === command);
        return entries.length === 0 || entries.some((entry) => entry.when !== "false");
      }
    ).sort();

    expect(new Set(paletteIds).size).toBe(paletteIds.length);
    expect(classified).toEqual(contributed);
    expect(effectiveVisible).toEqual([...paletteCommands.visible].sort());
    for (const command of paletteCommands.hidden) {
      const entries = palette.filter((entry) => entry.command === command);
      expect(entries).toHaveLength(1);
      expect(entries.every((entry) => entry.when === "false")).toBe(true);
    }
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
    const traceabilityItems = itemContext.filter((e) => e.when?.includes("traceabilityTestKey"));
    expect(traceabilityItems.map((e) => [e.command, e.when])).toEqual([
      ["playwrightBddRunner.traceability.openIssue", "view == playwrightBddRunner.traceability && viewItem == traceabilityTestKey"],
      ["playwrightBddRunner.traceability.copyKey", "view == playwrightBddRunner.traceability && viewItem == traceabilityTestKey"],
    ]);

    const palette = pkg.contributes.menus["commandPalette"]!;
    for (const command of ["playwrightBddRunner.traceability.openIssue", "playwrightBddRunner.traceability.copyKey"]) {
      expect(palette.find((e) => e.command === command)?.when).toBe("false");
    }
  });

  it("leaves clear-run-history in the palette unconditionally (the stores fill with the panel off)", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    expect(palette.find((e) => e.command === "playwrightBddRunner.traceability.clearLocalRunHistory")).toBeUndefined();
  });

  it("puts the manage-connection plug last in the traceability view title bar", () => {
    const viewTitle = pkg.contributes.menus["view/title"]!;
    const plug = viewTitle.find((e) => e.command === "playwrightBddRunner.traceability.manageConnection");
    expect(plug?.when).toBe("view == playwrightBddRunner.traceability");
    expect(plug?.group).toBe("navigation@4");
  });

  // One toolbar, six buttons, one slot each: two commands sharing a slot leaves their order to chance.
  it("gives every traceability title-bar button its own navigation slot, in the approved order", () => {
    const slots = pkg.contributes.menus["view/title"]!
      .filter((e) => e.command?.startsWith("playwrightBddRunner.traceability."))
      .map((e) => [e.command, e.group] as const)
      .sort((a, b) => Number(a[1]?.split("@")[1]) - Number(b[1]?.split("@")[1]));

    expect(slots).toEqual([
      ["playwrightBddRunner.traceability.toggleGrouping", "navigation@-1"],
      ["playwrightBddRunner.traceability.sync", "navigation@0"],
      ["playwrightBddRunner.traceability.openBoard", "navigation@1"],
      ["playwrightBddRunner.traceability.runAndPublish", "navigation@2"],
      ["playwrightBddRunner.traceability.publishLastRun", "navigation@3"],
      ["playwrightBddRunner.traceability.manageConnection", "navigation@4"],
    ]);
  });

  // Adjacent duplicates read as one button pressed twice, so the toolbar's glyphs must all differ.
  it("paints every title-bar button with a distinct icon", () => {
    const iconOf = (command: string): string | undefined =>
      pkg.contributes.commands.find((c) => c.command === command)?.icon;
    const icons = pkg.contributes.menus["view/title"]!
      .filter((e) => e.command?.startsWith("playwrightBddRunner.traceability."))
      .sort((a, b) => Number(a.group?.split("@")[1]) - Number(b.group?.split("@")[1]))
      .map((e) => iconOf(e.command!));

    expect(icons).toEqual(["$(list-tree)", "$(sync)", "$(project)", "$(play-circle)", "$(cloud-upload)", "$(plug)"]);
    expect(new Set(icons).size).toBe(icons.length);
  });

  // Every traceability command carries an icon now, so the ones VS Code paints (title bar, inline rows,
  // editor actions) never fall back to a blank slot.
  it("declares an icon for every traceability command", () => {
    const iconless = pkg.contributes.commands
      .filter((c) => c.command.startsWith("playwrightBddRunner.traceability.") && c.icon === undefined)
      .map((c) => c.command);

    expect(iconless).toEqual([]);
  });

  it("offers switch-default-project inline on the connection row as well as in its context menu", () => {
    const entries = pkg.contributes.menus["view/item/context"]!.filter(
      (e) =>
        e.command === "playwrightBddRunner.traceability.switchDefaultProject" &&
        e.when === "view == playwrightBddRunner.traceability && viewItem == traceabilityConnection"
    );

    expect(entries.map((e) => e.group)).toEqual([undefined, "inline@1"]);
  });
});

interface EnvHooks {
  __openExternalCalls: string[];
  __clipboardText: string;
  __resetEnv: () => void;
}

const envHooks = (vscode as unknown as { env: EnvHooks }).env;

function stubAdapter(resolve: (key: string) => string | undefined): TraceabilityAdapter {
  return {
    id: "xray",
    label: "Xray",
    keyGrammar: {
      testPrefix: "TEST_",
      reqPrefix: "REQ_",
      keyShape: /^[A-Z]+-\d+$/,
      canonicalizeKey: (key) => key.toUpperCase(),
    },
    browseUrl: (ref: ExternalRef) => resolve(ref.key),
  };
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

describe("traceability linkScenario command", () => {
  const win = vscode.window as unknown as {
    __webviewPanels: Array<{
      title: string;
      webview: { __posted: Array<{ type: string; visible?: boolean }> };
      __receive: (message: unknown) => Promise<void>;
      dispose: () => void;
    }>;
    __resetWebviewPanels: () => void;
  };

  afterEach(() => {
    win.__resetWebviewPanels();
    vi.restoreAllMocks();
  });

  const untracedNode = {
    kind: "untraced",
    item: { scenario: { filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" } },
  };

  // The command opens the board and begins a Link session on it; drive a link-tagged confirm on the
  // board panel, then await the handler so the tag-write side effect has run.
  async function confirmLink(pending: Promise<void>, id: string): Promise<void> {
    await win.__webviewPanels.at(-1)!.__receive({ surface: "link", type: "confirm", id });
    await pending;
  }

  async function syncedAdapter(): Promise<InMemoryTraceabilityAdapter> {
    const adapter = new InMemoryTraceabilityAdapter();
    adapter.seedCatalogue([{ key: "5", summary: "Five" }], []);
    await adapter.metadata.sync({ testKeys: ["5"] });
    return adapter;
  }

  it("prompts to connect/sync when the active adapter exposes no metadata capability", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.linkScenario")!(untracedNode);
    expect(String(info.mock.calls[0]?.[0])).toContain("Sync");
  });

  it("no-ops with guidance when invoked from the palette without a scenario row", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.linkScenario")!();
    expect(String(info.mock.calls[0]?.[0])).toContain("Traceability view");
  });

  it("informs the user when the snapshot has no synced tests instead of showing a blank picker", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const handlers = captureHandlers(makeContext({ traceabilityAdapter: new InMemoryTraceabilityAdapter() }));
    await handlers.get("playwrightBddRunner.traceability.linkScenario")!(untracedNode);
    expect(String(info.mock.calls[0]?.[0])).toContain("No synced tests");
  });

  it("inserts the grammar-built test tag above the untraced scenario via a WorkspaceEdit", async () => {
    const adapter = await syncedAdapter();
    const feature = "Feature: F\n\nScenario: A\n  Given x\n";
    const doc = {
      uri: vscode.Uri.file("/ws/a.feature"),
      getText: () => feature,
      save: () => Promise.resolve(true),
    };
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(doc as unknown as vscode.TextDocument);
    const applied: Array<{ __entries: Array<{ op: string; text: string }> }> = [];
    vi.spyOn(vscode.workspace, "applyEdit").mockImplementation((edit) => {
      applied.push(edit as unknown as { __entries: Array<{ op: string; text: string }> });
      return Promise.resolve(true);
    });

    const handlers = captureHandlers(makeContext({ traceabilityAdapter: adapter }));
    await confirmLink(handlers.get("playwrightBddRunner.traceability.linkScenario")!(untracedNode), "5");

    expect(applied).toHaveLength(1);
    expect(applied[0]!.__entries).toHaveLength(1);
    expect(applied[0]!.__entries[0]).toMatchObject({ op: "insert", text: "@TC-5\n" });
  });

  it("reports an error rather than a link when the workspace refuses the tag edit", async () => {
    const adapter = await syncedAdapter();
    const doc = {
      uri: vscode.Uri.file("/ws/a.feature"),
      getText: () => "Feature: F\n\nScenario: A\n  Given x\n",
      save: () => Promise.resolve(true),
    };
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(doc as unknown as vscode.TextDocument);
    vi.spyOn(vscode.workspace, "applyEdit").mockResolvedValue(false);
    const error = vi.spyOn(vscode.window, "showErrorMessage");

    const handlers = captureHandlers(makeContext({ traceabilityAdapter: adapter }));
    await confirmLink(handlers.get("playwrightBddRunner.traceability.linkScenario")!(untracedNode), "5");

    expect(error.mock.calls[0]?.[0]).toBe("Could not link 5: the feature file edit was not applied.");
  });

  it("opens the Coverage Board and reveals the contextual Link tab", async () => {
    const adapter = await syncedAdapter();
    const handlers = captureHandlers(makeContext({ traceabilityAdapter: adapter }));
    const pending = handlers.get("playwrightBddRunner.traceability.linkScenario")!(untracedNode);

    const board = win.__webviewPanels.at(-1)!;
    expect(board.title).toBe("Coverage Board");
    await board.__receive({ type: "ready" });
    expect(board.webview.__posted.find((m) => m.type === "linkTab" && m.visible === true)).toBeDefined();

    await confirmLink(pending, "5");
  });

  async function reMap(feature: string): Promise<string> {
    const adapter = new InMemoryTraceabilityAdapter();
    adapter.seedCatalogue([{ key: "9", summary: "Nine" }], []);
    await adapter.metadata.sync({ testKeys: ["9"] });
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(fakeDoc(feature));
    const applied: EditEntry[][] = [];
    vi.spyOn(vscode.workspace, "applyEdit").mockImplementation((edit) => {
      applied.push((edit as unknown as { __entries: EditEntry[] }).__entries);
      return Promise.resolve(true);
    });
    const handlers = captureHandlers(makeContext({ traceabilityAdapter: adapter }));
    await confirmLink(
      handlers.get("playwrightBddRunner.traceability.linkScenario")!({
        kind: "link",
        link: { scenario: { filePath: "/ws/a.feature", line: 4, name: "A", kind: "scenario" } },
      }),
      "9"
    );
    expect(applied).toHaveLength(1);
    return applyWsEdit(feature, applied[0]!);
  }

  it("re-maps an already-linked LF document to the picked key, byte-exact", async () => {
    expect(await reMap("Feature: F\n\n@TC-5\nScenario: A\n  Given x\n")).toBe(
      "Feature: F\n\n@TC-9\nScenario: A\n  Given x\n"
    );
  });

  it("re-maps an already-linked CRLF document without a doubled carriage return", async () => {
    const out = await reMap("Feature: F\r\n\r\n@TC-5\r\nScenario: A\r\n  Given x\r\n");
    expect(out).toBe("Feature: F\r\n\r\n@TC-9\r\nScenario: A\r\n  Given x\r\n");
    expect(out).not.toContain("\r\r");
  });
});

describe("traceability linkScenario contributions", () => {
  interface Pkg {
    contributes: {
      commands: Array<{ command: string; category?: string }>;
      menus: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
    };
  }
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf-8")
  ) as Pkg;
  const CMD = "playwrightBddRunner.traceability.linkScenario";

  it("declares the command under the Specwright category", () => {
    expect(pkg.contributes.commands.find((c) => c.command === CMD)?.category).toBe("Specwright");
  });

  it("offers the inline link action on both untraced and mapped rows", () => {
    const items = pkg.contributes.menus["view/item/context"]!.filter((e) => e.command === CMD);
    expect(items.every((e) => e.group === "inline@1")).toBe(true);
    const whens = items.map((e) => e.when);
    expect(whens).toContain("view == playwrightBddRunner.traceability && viewItem == traceabilityUntraced");
    expect(whens).toContain("view == playwrightBddRunner.traceability && viewItem == traceabilityScenario");
  });

  it("hides the node action from the palette", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    const entries = palette.filter((entry) => entry.command === CMD);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.when).toBe("false");
  });
});

describe("traceability sync command handler", () => {
  afterEach(() => {
    win.__resetWebviewPanels();
    vi.restoreAllMocks();
  });

  it("guides the user when no metadata capability is active", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.sync")!();
    expect(String(info.mock.calls[0]?.[0])).toContain("Connect");
  });

  // A subsystem whose adapter derives projects from its keys, with every seam the sync scope reads:
  // the tag-derived keys, the catalogue the last sync left, the provider directory, and the board's
  // stored project selection. Its sync commits like the real one (a fresh `syncedAt` per run) unless
  // `commits: false` reproduces a run that discarded its pages and left the snapshot untouched.
  function syncSubsystem(over: {
    sync?: (scope: SyncScope, signal?: AbortSignal, onProgress?: SyncProgress) => Promise<void>;
    snapshotErrors?: string[];
    tests?: Map<string, unknown>;
    catalogueProjects?: string[];
    tagDerived?: string[];
    testKeys?: string[];
    directory?: string[];
    scope?: ProjectScopeStore;
    completeProjects?: string[];
    commits?: boolean;
    connected?: boolean;
  } = {}): TraceabilitySubsystem {
    const run = over.sync ?? ((): Promise<void> => Promise.resolve());
    let syncedAt: number | undefined;
    const adapter = {
      keyGrammar: { testPrefix: "TEST_", projectOf: (k: string) => k.split("-")[0] },
      metadata: {
        sync: async (scope: SyncScope, signal?: AbortSignal, onProgress?: SyncProgress): Promise<void> => {
          await run(scope, signal, onProgress);
          if (over.commits !== false) {
            syncedAt = (syncedAt ?? 0) + 1;
          }
        },
        snapshot: () => ({
          tests: over.tests ?? new Map(),
          fetchedScopes: [],
          catalogueProjects: over.catalogueProjects ?? [],
          completeProjects: [],
          verifiedAbsentKeys: [],
          stale: false,
          errors: over.snapshotErrors ?? [],
          syncedAt,
        }),
      },
      ...(over.directory
        ? {
            projectDirectory: {
              cached: () => ({ projects: over.directory!.map((key) => ({ key, name: key })), truncated: false }),
              list: () => Promise.resolve({ projects: [], truncated: false }),
            },
          }
        : {}),
    };
    return {
      traceabilityPanelActive: true,
      connected: over.connected ?? true,
      getSnapshot: () => ({
        links: [],
        untraced: [],
        orphans: [],
        stale: false,
        completeProjects: over.completeProjects ?? ["CALC"],
        errors: [],
      }),
      getActiveAdapter: () => adapter,
      knownTestKeys: () => over.testKeys ?? [],
      tagDerivedProjectKeys: () => over.tagDerived ?? [],
      projectScope: () => over.scope ?? NO_PROJECT_SCOPE,
      mappingPageSize: () => NO_MAPPING_PAGE_SIZE,
      onDidChangeSnapshot: new vscode.EventEmitter<void>().event,
    } as unknown as TraceabilitySubsystem;
  }

  function managerFor(
    subsystem: TraceabilitySubsystem,
    settings: Record<string, unknown> = {},
    logger = Logger.create()
  ): CommandManager {
    const workspaceConfig = {
      get: (key: string, fallback: unknown) => (key in settings ? settings[key] : fallback),
    } as unknown as vscode.WorkspaceConfiguration;
    const mgr = CommandManager.create(
      makeContext({ config: ExtensionConfig.create(workspaceConfig, false), logger })
    );
    mgr.setTraceabilitySubsystem(subsystem);
    return mgr;
  }

  const runSyncOn = (mgr: CommandManager): Promise<void> =>
    traceabilityCommands(mgr).syncTraceability();

  // The board's two ways into the sync: the Sync now button and the quiet per-project load.
  const boardLoads = (mgr: CommandManager): { runSync: () => Promise<void>; autoSync: (key: string) => Promise<void> } =>
    traceabilityBoardDeps(mgr);

  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  it("syncs with the workspace + configured project scope and surfaces snapshot errors as a toast", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const errorToast = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);

    await runSyncOn(managerFor(syncSubsystem({ sync, snapshotErrors: ["boom"], testKeys: ["CALC-1"] })));

    expect(sync).toHaveBeenCalledWith({ testKeys: ["CALC-1"], projectKeys: [] }, expect.anything(), expect.anything());
    expect(errorToast).toHaveBeenCalled();
  });

  it("scopes the sync to the tags, the setting and the already-synced catalogue, never the provider directory", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const subsystem = syncSubsystem({
      sync,
      testKeys: ["CALC-1"],
      tagDerived: ["CALC"],
      catalogueProjects: ["MATH"],
      directory: ["OPS"],
    });

    await runSyncOn(managerFor(subsystem, { "xray.syncProjectKeys": ["shop"] }));

    expect(sync).toHaveBeenCalledWith(
      { testKeys: ["CALC-1"], projectKeys: ["CALC", "MATH", "SHOP"] },
      expect.anything(),
      expect.anything()
    );
  });

  it("carries the default project key into the sync scope, so a create target is also a sync target", async () => {
    const sync = vi.fn(() => Promise.resolve());

    await runSyncOn(managerFor(syncSubsystem({ sync }), { "xray.defaultProjectKey": " pay " }));

    expect(sync).toHaveBeenCalledWith({ testKeys: [], projectKeys: ["PAY"] }, expect.anything(), expect.anything());
  });

  // The directory rung stays out of the sync scope, so a project only the connection knows about is
  // fetched precisely because the board is scoped to it.
  it("carries the board's stored project selection into the sync scope", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const scope = projectScopeStore(memento(), () => undefined);
    scope.set("PAY");

    await runSyncOn(managerFor(syncSubsystem({ sync, directory: ["PAY", "OPS"], scope })));

    expect(sync).toHaveBeenCalledWith({ testKeys: [], projectKeys: ["PAY"] }, expect.anything(), expect.anything());
  });

  it("coalesces concurrent invocations into a single in-flight run", async () => {
    let resolveSync!: () => void;
    const sync = vi.fn(() => new Promise<void>((resolve) => { resolveSync = resolve; }));
    const mgr = managerFor(syncSubsystem({ sync }));

    const first = runSyncOn(mgr);
    const second = runSyncOn(mgr);
    resolveSync();
    await Promise.all([first, second]);

    // The second invoke joined the in-flight run rather than starting a second sync.
    expect(sync).toHaveBeenCalledTimes(1);
  });

  // A project picked mid-run cannot be in the running scope, which was resolved before the pick, so it
  // is not allowed to join: it earns exactly one follow-up whose scope covers it.
  it("reruns once for a project picked while a sync is in flight, with the picked key in scope", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const resolvers: Array<() => void> = [];
    const sync = vi.fn((_scope: SyncScope) => new Promise<void>((resolve) => resolvers.push(resolve)));
    const mgr = managerFor(syncSubsystem({ sync }));
    const { autoSync } = boardLoads(mgr);

    const first = runSyncOn(mgr);
    void autoSync("PAY");
    void autoSync("PAY");
    expect(sync).toHaveBeenCalledTimes(1);

    resolvers[0]!();
    await first;
    await flush();

    expect(sync).toHaveBeenCalledTimes(2);
    expect(sync.mock.calls[0]![0]).toEqual({ testKeys: [], projectKeys: [] });
    expect(sync.mock.calls[1]![0]).toEqual({ testKeys: [], projectKeys: ["PAY"] });

    // One slot, so the two picks produced one follow-up and that follow-up queues nothing further.
    resolvers[1]!();
    await flush();
    expect(sync).toHaveBeenCalledTimes(2);
    // Only the run the user asked for spoke; the load it replayed stayed quiet.
    expect(info).toHaveBeenCalledOnce();
    expect(info).toHaveBeenCalledWith("Synced 0 remote tests.");
  });

  // The gates belong to the moment the follow-up runs, not the moment it was queued: the run in flight
  // may well be the one that catalogues the picked project.
  it("re-checks the gates when it replays a queued pick, so nothing is fetched twice", async () => {
    const catalogueProjects: string[] = [];
    const resolvers: Array<() => void> = [];
    const sync = vi.fn((_scope: SyncScope) => new Promise<void>((resolve) => resolvers.push(resolve)));
    const mgr = managerFor(syncSubsystem({ sync, catalogueProjects }));

    const first = runSyncOn(mgr);
    void boardLoads(mgr).autoSync("PAY");
    catalogueProjects.push("PAY");
    resolvers[0]!();
    await first;
    await flush();

    expect(sync).toHaveBeenCalledOnce();
  });

  it("loads a project the catalogue has never held, quietly", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const mgr = managerFor(syncSubsystem({ sync, tagDerived: ["CALC"] }));

    await boardLoads(mgr).autoSync("PAY");

    expect(sync).toHaveBeenCalledWith({ testKeys: [], projectKeys: ["CALC", "PAY"] }, expect.anything(), expect.anything());
    expect(info).not.toHaveBeenCalled();
  });

  it("loads nothing for a project an earlier sync already catalogued", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const mgr = managerFor(syncSubsystem({ sync, catalogueProjects: ["PAY"] }));

    await boardLoads(mgr).autoSync("PAY");

    expect(sync).not.toHaveBeenCalled();
  });

  // A quiet load that fails is a log line, not a notification: nobody asked for it, and a stale
  // connection verdict would raise the same red toast on every board open.
  it("logs a quiet load's failure rather than raising a notification", async () => {
    const errorToast = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);
    const logger = Logger.create();
    const warn = vi.spyOn(logger, "warn");
    const mgr = managerFor(syncSubsystem({ snapshotErrors: ["boom"] }), {}, logger);

    await boardLoads(mgr).autoSync("PAY");

    expect(errorToast).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith("A board load's sync failed", {
      error: "Sync completed with errors: see the output channel for details.",
    });
  });

  it("loads nothing while the tracker is not known to be reachable", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const mgr = managerFor(syncSubsystem({ sync, connected: false }));

    await boardLoads(mgr).autoSync("PAY");

    expect(sync).not.toHaveBeenCalled();
    expect(info).not.toHaveBeenCalled();
  });

  it("wires the board's Sync now button to the serialized sync, so two clicks share one run", async () => {
    let resolveSync!: () => void;
    const sync = vi.fn(() => new Promise<void>((resolve) => { resolveSync = resolve; }));
    const mgr = managerFor(syncSubsystem({ sync }));
    const { runSync } = boardLoads(mgr);

    const first = runSync();
    const second = runSync();
    resolveSync();
    await Promise.all([first, second]);

    // Rewiring the button to the unserialized command path would start a second, overlapping sync.
    expect(sync).toHaveBeenCalledTimes(1);
  });

  it("reports a finished sync as an information toast, zero tests included", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");

    await runSyncOn(managerFor(syncSubsystem()));

    expect(info).toHaveBeenCalledWith("Synced 0 remote tests.");
  });

  it("reports a cancelled sync as information rather than an error", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const errorToast = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);
    // A token that is already cancelled aborts the run's signal the moment the task subscribes.
    vi.spyOn(vscode.window, "withProgress").mockImplementation((_opts, task) =>
      (task as (p: unknown, t: unknown) => Thenable<unknown>)(
        { report: () => {} },
        { isCancellationRequested: true, onCancellationRequested: (cb: () => void) => { cb(); return { dispose: () => {} }; } }
      )
    );

    await runSyncOn(managerFor(syncSubsystem()));

    expect(info).toHaveBeenCalledWith("Sync cancelled.");
    expect(errorToast).not.toHaveBeenCalled();
  });

  // The strip's whole lifecycle: the pages it counts, the handover to the repaint, and the clear that
  // keeps a failed run from stranding it.
  async function openBoardFor(mgr: CommandManager): Promise<StubBoardPanel> {
    traceabilityCommands(mgr).openBoard();
    const panel = win.__webviewPanels[0]!;
    await panel.__receive({ type: "ready" });
    return panel;
  }

  const strips = (panel: StubBoardPanel): Array<string | undefined> =>
    panel.webview.__posted.filter((m) => m.type === "syncProgress").map((m) => m.text);

  const reportingSync = (): ((scope: SyncScope, signal?: AbortSignal, onProgress?: SyncProgress) => Promise<void>) =>
    (_scope, _signal, onProgress) => {
      onProgress?.({ projectKey: "PAY", fetched: 100, total: 350 });
      return Promise.resolve();
    };

  it("counts a sync's pages onto the board's strip, then hands over to the repaint", async () => {
    const mgr = managerFor(syncSubsystem({ sync: reportingSync(), tagDerived: ["PAY"] }));
    const panel = await openBoardFor(mgr);

    await runSyncOn(mgr);

    expect(strips(panel)).toEqual(["Syncing PAY: 100 of 350 tests", "Rendering…"]);
  });

  it("clears the strip when the sync reports errors, so a failed run cannot strand it", async () => {
    vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);
    const mgr = managerFor(syncSubsystem({ sync: reportingSync(), tagDerived: ["PAY"], snapshotErrors: ["boom"] }));
    const panel = await openBoardFor(mgr);

    await runSyncOn(mgr);

    expect(strips(panel).at(-1)).toBe("");
  });

  it("posts only a clear when a sync reported no pages at all", async () => {
    const mgr = managerFor(syncSubsystem());
    const panel = await openBoardFor(mgr);

    await runSyncOn(mgr);

    expect(strips(panel)).toEqual([""]);
  });

  // A run that fetched pages and then discarded them (a credential change mid-sync) commits nothing and
  // fires no change event, so there is no repaint to hand over to.
  it("clears the strip when a run counted pages but committed nothing", async () => {
    const mgr = managerFor(syncSubsystem({ sync: reportingSync(), tagDerived: ["PAY"], commits: false }));
    const panel = await openBoardFor(mgr);

    await runSyncOn(mgr);

    expect(strips(panel).at(-1)).toBe("");
  });

  it("still counts a quiet load onto the strip, since that is all it says", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const mgr = managerFor(syncSubsystem({ sync: reportingSync() }));
    const panel = await openBoardFor(mgr);

    await boardLoads(mgr).autoSync("PAY");

    expect(strips(panel)).toEqual(["Syncing PAY: 100 of 350 tests", "Rendering…"]);
    expect(info).not.toHaveBeenCalled();
  });

  it("passes the resolved sync scope into the board model, so the empty available group says the right thing", () => {
    const built = (settings: Record<string, unknown>, tagDerived: string[] = []): BoardViewModel =>
      traceabilityBoardDeps(
        managerFor(syncSubsystem({ tagDerived, completeProjects: [] }), settings)
      ).buildModel();

    // Either half catches an inverted scope bit at the call site, since it flips both branches at once.
    expect(built({ "xray.syncProjectKeys": ["CALC"] })).toMatchObject({
      availableEmptyText: "No synced tests yet.",
      offerSync: true,
    });
    // The setting is only one rung: a tag-derived project is scope enough for a sync to be worth offering.
    expect(built({}, ["CALC"])).toMatchObject({ availableEmptyText: "No synced tests yet.", offerSync: true });
    expect(built({})).toMatchObject({
      availableEmptyText: "Pick a project in the header to load its tests.",
      offerSync: false,
    });
  });
});

describe("traceability sync contributions", () => {
  interface Pkg {
    contributes: {
      commands: Array<{ command: string; category?: string; icon?: string }>;
      menus: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
    };
  }
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf-8")
  ) as Pkg;
  const CMD = "playwrightBddRunner.traceability.sync";

  it("declares the sync command under the Specwright category with a sync icon", () => {
    const command = pkg.contributes.commands.find((c) => c.command === CMD);
    expect(command?.category).toBe("Specwright");
    expect(command?.icon).toBe("$(sync)");
  });

  it("gates the palette entry and the view-title button on the connected context key", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    expect(palette.find((e) => e.command === CMD)?.when).toBe("playwrightBddRunner.traceability.connected");

    const button = pkg.contributes.menus["view/title"]!.find((e) => e.command === CMD);
    expect(button?.when).toBe(
      "view == playwrightBddRunner.traceability && playwrightBddRunner.traceability.connected"
    );
  });
});

describe("traceability runAndPublish: preflight batch flow", () => {
  afterEach(() => vi.restoreAllMocks());

  const A: ScenarioRef = { filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" };
  const B: ScenarioRef = { filePath: "/ws/a.feature", line: 8, name: "B", kind: "scenario" };
  const READY_LINK: TraceLink = { testKey: "CALC-1", scenario: A, reqKeys: [], meta: { key: "CALC-1", testType: { name: "Cucumber", kind: "Gherkin" } } };
  const READY_B_LINK: TraceLink = { testKey: "CALC-2", scenario: B, reqKeys: [], meta: { key: "CALC-2", testType: { name: "Cucumber", kind: "Gherkin" } } };
  const FLAGGED_LINK: TraceLink = { testKey: "CALC-2", scenario: B, reqKeys: [], remoteMissing: true };

  function snapshot(links: TraceLink[]): TraceabilitySnapshot {
    return { links, untraced: [], orphans: [], stale: false, completeProjects: ["CALC"], errors: [] };
  }

  function harness(links: TraceLink[]) {
    const store = new RunArtifactStore(memento(), Logger.create());
    const runScenarioWithOutput = vi.fn((_options: unknown, _target?: ArtifactCaptureTarget) =>
      Promise.resolve({ success: true, output: "", error: "", duration: 1 })
    );
    const runGrepWithOutput = vi.fn((_names: readonly string[]) => Promise.resolve({ success: true, output: "", error: "", duration: 1 }));
    const executor = { runScenarioWithOutput, runGrepWithOutput, runPathFilterWithOutput: vi.fn(), runAllTestsWithTagsOutput: vi.fn() };
    const config = ExtensionConfig.create();
    const mgr = CommandManager.create(makeContext({
      testExecutor: executor as unknown as TestExecutor,
      runArtifactStore: store,
    }));
    const subsystem = {
      getSnapshot: () => snapshot(links),
      getActiveAdapter: () => new XrayAdapter(config),
      rebuildNow: () => Promise.resolve(),
    } as unknown as TraceabilitySubsystem;
    mgr.setTraceabilitySubsystem(subsystem);
    return { mgr, store, runScenarioWithOutput, runGrepWithOutput };
  }

  function pickBy(predicate: (c: PreflightChoice) => boolean): void {
    vi.spyOn(vscode.window, "showQuickPick").mockImplementation((items) => {
      const rows = items as unknown as Array<{ choice?: PreflightChoice }>;
      const picked = rows.find((r) => r.choice !== undefined && predicate(r.choice));
      return Promise.resolve(picked as unknown as vscode.QuickPickItem | undefined);
    });
  }

  it("runs each mapped scenario in a tree multi-selection once", async () => {
    const { mgr, store, runScenarioWithOutput, runGrepWithOutput } = harness([READY_LINK, READY_B_LINK]);
    const first = { kind: "link", link: READY_LINK };
    const second = { kind: "link", link: READY_B_LINK };
    const untraced = {
      kind: "untraced",
      item: { scenario: { ...B, line: 12, name: "Untraced" } },
    };

    await traceabilityCommands(mgr).runAndPublish(
      first,
      [first, { kind: "testKey", testKey: "CALC-1" }, untraced, second, first, second]
    );

    expect(runGrepWithOutput).not.toHaveBeenCalled();
    expect(runScenarioWithOutput).toHaveBeenCalledTimes(2);
    expect(runScenarioWithOutput.mock.calls.map(([options]) =>
      (options as { scenarioName?: string }).scenarioName
    )).toEqual(["A", "B"]);
    expect(runScenarioWithOutput.mock.calls.map(([, target]) => target)).toEqual([
      { scenario: A, resultLines: [3] },
      { scenario: B, resultLines: [8] },
    ]);
    expect(store.latest()?.selection).toEqual({ kind: "multi-select", scenarios: [A, B] });
  });

  it("keeps a single selected tree row on the single-scenario path", async () => {
    const { mgr, store, runScenarioWithOutput, runGrepWithOutput } = harness([READY_LINK]);
    const node = { kind: "link", link: READY_LINK };

    await traceabilityCommands(mgr).runAndPublish(node, [node, { kind: "section" }]);

    expect(runGrepWithOutput).not.toHaveBeenCalled();
    expect(runScenarioWithOutput).toHaveBeenCalledOnce();
    expect(store.latest()?.selection).toEqual({ kind: "scenario", scenario: A });
  });

  it("captures disjoint rows for a selected outline and two Examples blocks", async () => {
    const filePath = writeTempFeature([
      "Feature: Calculator",
      "",
      "@TEST_CALC-1",
      "Scenario Outline: Divide",
      "  Given <n>",
      "",
      "  Examples: common",
      "    | n |",
      "    | 1 |",
      "",
      "  @TEST_CALC-2",
      "  Examples: edge cases",
      "    | n |",
      "    | 0 |",
      "    | 2 |",
      "",
      "  @TEST_CALC-3",
      "  Examples: edge cases",
      "    | n |",
      "    | -1 |",
    ].join("\n"));
    const outline: ScenarioRef = {
      filePath,
      line: 4,
      name: "Divide",
      kind: "outline",
      outlineName: "Divide",
    };
    const block: ScenarioRef = {
      filePath,
      line: 12,
      name: "Divide · edge cases",
      kind: "examplesBlock",
      outlineName: "Divide",
      examplesBlockName: "edge cases",
    };
    const siblingBlock: ScenarioRef = {
      filePath,
      line: 18,
      name: "Divide · edge cases",
      kind: "examplesBlock",
      outlineName: "Divide",
      examplesBlockName: "edge cases",
    };
    const outlineLink: TraceLink = { ...READY_LINK, scenario: outline };
    const blockLink: TraceLink = { ...READY_B_LINK, scenario: block };
    const siblingLink: TraceLink = {
      ...READY_LINK,
      testKey: "CALC-3",
      scenario: siblingBlock,
      meta: { key: "CALC-3", testType: { name: "Cucumber", kind: "Gherkin" } },
    };
    const { mgr, runScenarioWithOutput } = harness([outlineLink, blockLink, siblingLink]);
    const first = { kind: "link", link: outlineLink };
    const second = { kind: "link", link: blockLink };
    const third = { kind: "link", link: siblingLink };

    try {
      await traceabilityCommands(mgr).runAndPublish(first, [first, second, third]);
    } finally {
      fs.rmSync(path.dirname(filePath), { recursive: true, force: true });
    }

    expect(runScenarioWithOutput.mock.calls.map(([, target]) => target)).toEqual([
      { scenario: outline, resultLines: [9] },
      { scenario: block, resultLines: [14, 15] },
      { scenario: siblingBlock, resultLines: [20] },
    ]);
  });

  it("resolves all-mapped, classifies, and runs the whole set in one combined-grep on local-only", async () => {
    const { mgr, store, runGrepWithOutput } = harness([READY_LINK, FLAGGED_LINK]);
    pickBy((c) => c.kind === "run" && c.outcome === "local-only");
    await traceabilityCommands(mgr).runAndPublish();
    expect(runGrepWithOutput).toHaveBeenCalledTimes(1);
    expect(runGrepWithOutput.mock.calls[0]![0]).toEqual(["A", "B"]);
    expect(store.latest()?.preflight).toEqual([
      { scenario: B, testKey: "CALC-2", state: "invalid-key", outcome: "local-only" },
    ]);
  });

  it("rebuilds the grep without the flagged scenario and records its exclusion on exclude", async () => {
    const { mgr, store, runGrepWithOutput } = harness([READY_LINK, FLAGGED_LINK]);
    pickBy((c) => c.kind === "run" && c.outcome === "exclude");
    await traceabilityCommands(mgr).runAndPublish();
    // The combined grep runs only the ready scenario; the flagged one is surgically removed.
    expect(runGrepWithOutput).toHaveBeenCalledTimes(1);
    expect(runGrepWithOutput.mock.calls[0]![0]).toEqual(["A"]);
    expect(store.latest()?.preflight).toEqual([
      { scenario: B, testKey: "CALC-2", state: "invalid-key", outcome: "exclude" },
    ]);
  });

  it("runs nothing and seals nothing when the preflight is cancelled", async () => {
    const { mgr, store, runGrepWithOutput } = harness([READY_LINK, FLAGGED_LINK]);
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    await traceabilityCommands(mgr).runAndPublish();
    expect(runGrepWithOutput).not.toHaveBeenCalled();
    expect(store.latest()).toBeUndefined();
    expect(String(info.mock.calls.at(-1)?.[0])).toContain("cancelled");
  });

  it("runs directly with no quick-pick when every scenario is ready", async () => {
    const { mgr, store, runGrepWithOutput } = harness([READY_LINK]);
    const quickPick = vi.spyOn(vscode.window, "showQuickPick");
    await traceabilityCommands(mgr).runAndPublish();
    expect(quickPick).not.toHaveBeenCalled();
    expect(runGrepWithOutput).toHaveBeenCalledTimes(1);
    expect(runGrepWithOutput.mock.calls[0]![0]).toEqual(["A"]);
    expect(store.latest()?.preflight).toEqual([]);
  });

  it("wires the progress cancel token to the abort controller and seals cancelled", async () => {
    const { mgr, store, runGrepWithOutput } = harness([READY_LINK]);
    // A cancelled progress token fires immediately; the batch must abort before dispatching and seal
    // the artifact `cancelled`.
    vi.spyOn(vscode.window, "withProgress").mockImplementation((_opts, task) =>
      (task as (p: unknown, t: unknown) => Thenable<unknown>)(
        { report: () => {} },
        { isCancellationRequested: true, onCancellationRequested: (cb: () => void) => { cb(); return { dispose: () => {} }; } }
      )
    );
    await traceabilityCommands(mgr).runAndPublish();
    expect(runGrepWithOutput).not.toHaveBeenCalled();
    expect(store.latest()?.state).toBe("cancelled");
  });
});

describe("traceability openBoard command handler", () => {
  afterEach(() => {
    win.__resetWebviewPanels();
    vi.restoreAllMocks();
  });

  function fakeSubsystem(
    panelActive = true,
    catalogueProjects: string[] = [],
    derivesProjects = true,
    ladder: { tagDerived?: string[]; directory?: string[] } = {}
  ): TraceabilitySubsystem {
    const directory = ladder.directory;
    return {
      traceabilityPanelActive: panelActive,
      getSnapshot: () => ({ links: [], untraced: [], orphans: [], stale: false, completeProjects: ["CALC"], errors: [] }),
      getActiveAdapter: () => ({
        label: "Xray",
        keyGrammar: { testPrefix: "TEST_", ...(derivesProjects ? { projectOf: (k: string) => k.split("-")[0] } : {}) },
        metadata: { snapshot: () => ({ catalogueProjects }) },
        ...(directory
          ? {
              projectDirectory: {
                cached: () => ({ projects: directory.map((key) => ({ key, name: key })), truncated: false }),
                list: () => Promise.resolve({ projects: [], truncated: false }),
              },
            }
          : {}),
      }),
      tagDerivedProjectKeys: () => ladder.tagDerived ?? [],
      projectScope: () => NO_PROJECT_SCOPE,
      mappingPageSize: () => NO_MAPPING_PAGE_SIZE,
      onDidChangeSnapshot: new vscode.EventEmitter<void>().event,
    } as unknown as TraceabilitySubsystem;
  }

  const boardDeps = (mgr: CommandManager): { knownProjects: () => readonly string[]; projectScope: ProjectScopeStore } =>
    traceabilityBoardDeps(mgr);

  const openBoard = (mgr: CommandManager): void =>
    traceabilityCommands(mgr).openBoard();

  it("opens the Coverage Board webview when the panel is active", () => {
    const mgr = CommandManager.create(makeContext());
    mgr.setTraceabilitySubsystem(fakeSubsystem());
    openBoard(mgr);
    expect(win.__webviewPanels).toHaveLength(1);
    expect(win.__webviewPanels[0]!.title).toBe("Coverage Board");
  });

  it("reveals the existing board instead of opening a second (singleton surface)", () => {
    const mgr = CommandManager.create(makeContext());
    mgr.setTraceabilitySubsystem(fakeSubsystem());
    openBoard(mgr);
    openBoard(mgr);
    expect(win.__webviewPanels).toHaveLength(1);
    expect(win.__webviewPanels[0]!.__revealCount).toBe(1);
  });

  it("guides the user and opens nothing when the traceability subsystem is not wired", () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const mgr = CommandManager.create(makeContext());
    openBoard(mgr);
    expect(win.__webviewPanels).toHaveLength(0);
    expect(String(info.mock.calls[0]?.[0])).toContain("Coverage Board");
  });

  it("seeds the board's scope selector from the sync config, the catalogue snapshot and the default key", async () => {
    const workspaceConfig = {
      get: (key: string, fallback: unknown) => {
        if (key === "xray.syncProjectKeys") { return ["calc", "shop"]; }
        return key === "xray.defaultProjectKey" ? " pay " : fallback;
      },
    } as unknown as vscode.WorkspaceConfiguration;
    const mgr = CommandManager.create(makeContext({ config: ExtensionConfig.create(workspaceConfig, false) }));
    mgr.setTraceabilitySubsystem(fakeSubsystem(true, ["SHOP", "MATH"]));

    openBoard(mgr);
    const panel = win.__webviewPanels[0]!;
    await panel.__receive({ type: "ready" });

    const render = panel.webview.__posted.find((m) => m.surface === "board" && m.type === "render");
    expect(render?.projects).toEqual(["CALC", "MATH", "PAY", "SHOP"]);
  });

  it("offers every project the connection can reach, plus the keys the workspace's own tags name", async () => {
    const mgr = CommandManager.create(makeContext());
    mgr.setTraceabilitySubsystem(fakeSubsystem(true, [], true, { tagDerived: ["CALC"], directory: ["OPS", "pay"] }));

    openBoard(mgr);
    const panel = win.__webviewPanels[0]!;
    await panel.__receive({ type: "ready" });

    const render = panel.webview.__posted.find((m) => m.surface === "board" && m.type === "render");
    expect(render?.projects).toEqual(["CALC", "OPS", "PAY"]);
  });

  it("offers the tag-derived keys alone when the connection enumerates no projects", () => {
    const mgr = CommandManager.create(makeContext());
    mgr.setTraceabilitySubsystem(fakeSubsystem(true, [], true, { tagDerived: ["calc"] }));

    expect(boardDeps(mgr).knownProjects()).toEqual(["CALC"]);
  });

  it("offers no scope options when the provider's grammar derives no project, since nothing could match", () => {
    const workspaceConfig = {
      get: (key: string, fallback: unknown) => (key === "xray.syncProjectKeys" ? ["CALC"] : fallback),
    } as unknown as vscode.WorkspaceConfiguration;
    const mgr = CommandManager.create(makeContext({ config: ExtensionConfig.create(workspaceConfig, false) }));
    mgr.setTraceabilitySubsystem(fakeSubsystem(true, ["SHOP"], false));

    expect(boardDeps(mgr).knownProjects()).toEqual([]);
  });

  it("hands the board the null scope store and no options when no subsystem is wired", () => {
    const deps = boardDeps(CommandManager.create(makeContext()));

    expect(deps.projectScope).toBe(NO_PROJECT_SCOPE);
    expect(deps.knownProjects()).toEqual([]);
  });

  it("guides the user and opens nothing when the panel is disabled (no live model)", () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const mgr = CommandManager.create(makeContext());
    mgr.setTraceabilitySubsystem(fakeSubsystem(false));
    openBoard(mgr);
    expect(win.__webviewPanels).toHaveLength(0);
    expect(String(info.mock.calls[0]?.[0])).toContain("Enable the Traceability panel");
  });
});

describe("traceability publishLastRun: Publish tab", () => {
  const win = vscode.window as unknown as {
    __webviewPanels: Array<{
      title: string;
      webview: { __posted: Array<{ surface?: string; type: string; tab?: string }> };
      __receive: (message: unknown) => Promise<void>;
      dispose: () => void;
    }>;
    __resetWebviewPanels: () => void;
  };
  const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  afterEach(() => {
    win.__resetWebviewPanels();
    vi.restoreAllMocks();
  });

  function publishableArtifact(): RunArtifact {
    return {
      id: "run-1",
      createdAt: Date.UTC(2026, 6, 22, 9, 0, 0),
      results: [
        {
          scenario: { filePath: "/ws/a.feature", line: 3, name: "a", kind: "scenario" },
          testKey: "CALC-1",
          outcome: "passed",
          durationMs: 10,
          attempts: 1,
          flaky: false,
          evidenceRefs: [],
        },
      ],
      shards: [],
      selection: { kind: "all-mapped" },
      preflight: [],
      state: "complete",
    };
  }

  function scopedTo(project: string): ProjectScopeStore {
    const scope = projectScopeStore(memento(), () => undefined);
    scope.set(project);
    return scope;
  }

  function connectedSubsystem(
    catalogueProjects: string[] = [],
    scope: ProjectScopeStore = NO_PROJECT_SCOPE,
    publish: () => Promise<unknown> = () =>
      Promise.resolve({ ref: { kind: "execution", key: "XNP-1" }, imported: 1, warnings: [] })
  ): TraceabilitySubsystem {
    const adapter = {
      id: "xray",
      label: "Xray",
      keyGrammar: { testPrefix: "TEST_", reqPrefix: "REQ_", projectOf: (k: string) => k.split("-")[0] },
      browseUrl: () => undefined,
      metadata: { snapshot: () => ({ catalogueProjects }) },
      resultPublishing: {
        searchTargets: () => Promise.resolve([]),
        publish,
      },
    } as unknown as TraceabilityAdapter;
    return {
      traceabilityPanelActive: true,
      getActiveAdapter: () => adapter,
      getSnapshot: () => undefined,
      tagDerivedProjectKeys: () => [],
      projectScope: () => scope,
      mappingPageSize: () => NO_MAPPING_PAGE_SIZE,
      onDidChangeSnapshot: new vscode.EventEmitter<void>().event,
    } as unknown as TraceabilitySubsystem;
  }

  it("opens the board and presents the run model on the Publish tab", async () => {
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(makeContext({ runArtifactStore: store }));
    mgr.setTraceabilitySubsystem(connectedSubsystem());

    const promise = publishCommands(mgr).runPublish();
    await flush();

    const panel = win.__webviewPanels[0]!;
    expect(panel.title).toBe("Coverage Board");
    await panel.__receive({ type: "ready" });
    expect(panel.webview.__posted.find((m) => m.surface === "publish" && m.type === "model")).toBeDefined();

    // Cancel resolves the present so the flow (and its finally) unwinds.
    await panel.__receive({ surface: "publish", type: "cancel" });
    await promise;
  });

  it("seeds the dialog's project keys from the sync config, the catalogue snapshot and the default key", async () => {
    const workspaceConfig = {
      get: (key: string, fallback: unknown) => {
        if (key === "xray.syncProjectKeys") { return ["calc", "shop"]; }
        return key === "xray.defaultProjectKey" ? " pay " : fallback;
      },
    } as unknown as vscode.WorkspaceConfiguration;
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(
      makeContext({ runArtifactStore: store, config: ExtensionConfig.create(workspaceConfig, false) })
    );
    mgr.setTraceabilitySubsystem(connectedSubsystem(["SHOP", "MATH"]));

    const promise = publishCommands(mgr).runPublish();
    await flush();
    const panel = win.__webviewPanels[0]!;
    await panel.__receive({ type: "ready" });

    const model = panel.webview.__posted.find((m) => m.surface === "publish" && m.type === "model") as unknown as {
      model: { knownProjectKeys: string[] };
    };
    expect(model.model.knownProjectKeys).toEqual(["CALC", "MATH", "PAY", "SHOP"]);

    await panel.__receive({ surface: "publish", type: "cancel" });
    await promise;
  });

  // The run's only key is CALC-1, so a scope of SHOP is the sole source of a SHOP prefill and the
  // dropdown's CALC is the sole proof the derived key survived the override.
  const syncKeysConfig = (keys: string[]): ExtensionConfig =>
    ExtensionConfig.create(
      {
        get: (key: string, fallback: unknown) => (key === "xray.syncProjectKeys" ? keys : fallback),
      } as unknown as vscode.WorkspaceConfiguration,
      false
    );

  async function publishModel(mgr: CommandManager): Promise<{
    knownProjectKeys: string[];
    runs: Array<{ project: { value: string; fromDerivation: boolean; fromScope?: boolean } }>;
  }> {
    const promise = publishCommands(mgr).runPublish();
    await flush();
    const panel = win.__webviewPanels[0]!;
    await panel.__receive({ type: "ready" });
    const posted = panel.webview.__posted.find((m) => m.surface === "publish" && m.type === "model") as unknown as {
      model: {
        knownProjectKeys: string[];
        runs: Array<{ project: { value: string; fromDerivation: boolean; fromScope?: boolean } }>;
      };
    };
    await panel.__receive({ surface: "publish", type: "cancel" });
    await promise;
    return posted.model;
  }

  it("prefills the dialog from the board's persisted scope, keeping the derived key in the dropdown", async () => {
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(makeContext({ runArtifactStore: store, config: syncKeysConfig(["shop"]) }));
    mgr.setTraceabilitySubsystem(connectedSubsystem([], scopedTo("SHOP")));

    const model = await publishModel(mgr);

    expect(model.runs[0]!.project).toEqual({ value: "SHOP", fromDerivation: false, fromScope: true });
    expect(model.knownProjectKeys).toContain("CALC");
  });

  it("falls back to the derived prefill when the persisted scope is no longer a known project", async () => {
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(makeContext({ runArtifactStore: store, config: syncKeysConfig(["shop"]) }));
    mgr.setTraceabilitySubsystem(connectedSubsystem([], scopedTo("PAY")));

    const model = await publishModel(mgr);

    expect(model.runs[0]!.project).toEqual({ value: "CALC", fromDerivation: true });
  });

  it("leaves the prefill on the run's derived key when the board has no scope store", async () => {
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(makeContext({ runArtifactStore: store }));
    mgr.setTraceabilitySubsystem(connectedSubsystem());

    const model = await publishModel(mgr);

    expect(model.runs[0]!.project).toEqual({ value: "CALC", fromDerivation: true });
  });

  const CONFIRM = {
    type: "confirm",
    runId: "run-1",
    request: { mode: "create-new", project: "CALC", summary: "Nightly" },
    attachments: [] as string[],
  };

  // One publish driven to completion: open the dialog and answer it with each reply in turn (a failed
  // import leaves the dialog live on the picked run, so its retry takes an answer of its own), then report
  // the tabs the shell was told to activate and how many board rebuilds the flow forced.
  async function publishOnce(
    replies: Array<Record<string, unknown>>,
    over: { publish?: () => Promise<unknown>; rebuild?: () => Promise<void> } = {}
  ): Promise<{ tabs: Array<string | undefined>; rebuilds: number }> {
    let rebuilds = 0;
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(makeContext({ runArtifactStore: store }));
    mgr.setTraceabilitySubsystem({
      ...connectedSubsystem([], NO_PROJECT_SCOPE, over.publish),
      rebuildNow: () => {
        rebuilds += 1;
        return over.rebuild?.() ?? Promise.resolve();
      },
    } as unknown as TraceabilitySubsystem);

    const promise = publishCommands(mgr).runPublish();
    await flush();
    const panel = win.__webviewPanels[0]!;
    await panel.__receive({ type: "ready" });
    for (const reply of replies) {
      await panel.__receive({ surface: "publish", ...reply });
    }
    await expect(promise).resolves.toBeUndefined();
    return { tabs: panel.webview.__posted.filter((m) => m.type === "activate").map((m) => m.tab), rebuilds };
  }

  // The settle leaves the Publish tab on its idle hint, so a publish that landed has to hand the user the
  // row it just created: rebuild the board first, then bring the Executions tab forward.
  it("rebuilds the board and shows the Executions tab after a successful publish", async () => {
    const { tabs, rebuilds } = await publishOnce([CONFIRM]);

    expect(rebuilds).toBe(1);
    expect(tabs.at(-1)).toBe("executions");
  });

  // A partial upload still landed the import, so the row is real and the board must carry it. The tab
  // stays put: the warning toast owns the retry.
  it("rebuilds the board but stays off the Executions tab when attachments partly fail", async () => {
    const { tabs, rebuilds } = await publishOnce([{ ...CONFIRM, attachments: ["/ws/evidence.png"] }]);

    expect(rebuilds).toBe(1);
    expect(tabs).not.toContain("executions");
  });

  // A failed import keeps the dialog on the run the user picked, so the flow ends only once they answer
  // the retry; cancelling it settles the tab with nothing rebuilt.
  it("neither rebuilds nor switches tabs when the publish fails", async () => {
    const { tabs, rebuilds } = await publishOnce([CONFIRM, { type: "cancel" }], {
      publish: () => Promise.reject(new Error("HTTP 400")),
    });

    expect(rebuilds).toBe(0);
    expect(tabs).not.toContain("executions");
  });

  it("publishes the picked run again on the retry that follows a failure", async () => {
    let attempts = 0;
    const { tabs, rebuilds } = await publishOnce([CONFIRM, CONFIRM], {
      publish: () => {
        attempts += 1;
        return attempts === 1
          ? Promise.reject(new Error("HTTP 400"))
          : Promise.resolve({ ref: { kind: "execution", key: "XNP-1" }, imported: 1, warnings: [] });
      },
    });

    expect(attempts).toBe(2);
    expect(rebuilds).toBe(1);
    expect(tabs.at(-1)).toBe("executions");
  });

  it("neither rebuilds nor switches tabs on cancel, routing back to the Mapping tab", async () => {
    const { tabs, rebuilds } = await publishOnce([{ type: "cancel" }]);

    expect(rebuilds).toBe(0);
    expect(tabs.at(-1)).toBe("mapping");
  });

  // A repaint that faulted has no new row on it, so the user is left on the Publish tab with the toast
  // rather than in front of an Executions table that is missing what they just published.
  it("stays off the Executions tab when the board rebuild fails", async () => {
    const { tabs, rebuilds } = await publishOnce([CONFIRM], {
      rebuild: () => Promise.reject(new Error("discovery down")),
    });

    expect(rebuilds).toBe(1);
    expect(tabs).not.toContain("executions");
  });

  // Closing the board is the publish's cancellation: the controller it opened with aborts, the import
  // that was in flight comes back rejected, and the flow says cancelled rather than raising a failure.
  it("cancels an in-flight publish when the board closes, reporting cancellation not a failure", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const store = { list: () => [publishableArtifact()] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(makeContext({ runArtifactStore: store }));
    mgr.setTraceabilitySubsystem(
      connectedSubsystem([], NO_PROJECT_SCOPE, () => {
        win.__webviewPanels[0]!.dispose();
        return Promise.reject(new Error("The operation was aborted"));
      })
    );

    const promise = publishCommands(mgr).runPublish();
    await flush();
    const panel = win.__webviewPanels[0]!;
    await panel.__receive({ type: "ready" });
    await panel.__receive({ surface: "publish", ...CONFIRM });
    await promise;

    expect(info.mock.calls.map((call) => String(call[0]))).toContain("Publish cancelled.");
    expect(error).not.toHaveBeenCalled();
  });

  it("guides the user and opens no board when no publishing capability is connected", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const mgr = CommandManager.create(makeContext());
    await publishCommands(mgr).runPublish();
    expect(win.__webviewPanels).toHaveLength(0);
    expect(String(info.mock.calls[0]?.[0])).toContain("Connect");
  });

  it("shows the no-runs toast without opening the board when nothing is publishable", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const store = { list: () => [] } as unknown as RunArtifactStore;
    const mgr = CommandManager.create(makeContext({ runArtifactStore: store }));
    mgr.setTraceabilitySubsystem(connectedSubsystem());

    await publishCommands(mgr).runPublish();

    expect(win.__webviewPanels).toHaveLength(0);
    expect(String(info.mock.calls[0]?.[0])).toContain("No local runs to publish");
  });
});

describe("traceability coverage board contributions", () => {
  interface Pkg {
    contributes: {
      commands: Array<{ command: string; category?: string; icon?: string }>;
      menus: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
    };
  }
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf-8")
  ) as Pkg;
  const CMD = "playwrightBddRunner.traceability.openBoard";

  it("declares the open-board command with a project-board icon under Specwright", () => {
    const command = pkg.contributes.commands.find((c) => c.command === CMD);
    expect(command?.category).toBe("Specwright");
    expect(command?.icon).toBe("$(project)");
  });

  it("slots an ungated open-board button right after sync in the traceability title bar", () => {
    const button = pkg.contributes.menus["view/title"]!.find((e) => e.command === CMD);
    expect(button?.when).toBe("view == playwrightBddRunner.traceability");
    expect(button?.group).toBe("navigation@1");
  });

  it("gates the palette entry on the traceability panel being enabled", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    expect(palette.find((e) => e.command === CMD)?.when).toBe(
      "config.playwrightBddRunner.traceability.enablePanel"
    );
  });
});

describe("traceability board drag-to-link drop handler", () => {
  afterEach(() => vi.restoreAllMocks());

  const A: ScenarioRef = { filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" };

  function dropSnapshot(): TraceabilitySnapshot {
    return {
      links: [],
      untraced: [{ scenario: A, reqKeys: [] }],
      orphans: [{ testKey: "5", meta: { key: "5" } }],
      stale: false,
      completeProjects: ["CALC"],
      errors: [],
    };
  }

  function harness(snapshot: TraceabilitySnapshot) {
    const adapter = new InMemoryTraceabilityAdapter();
    const doc = {
      uri: vscode.Uri.file("/ws/a.feature"),
      getText: () => "Feature: F\n\nScenario: A\n  Given x\n",
      save: () => Promise.resolve(true),
    };
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(doc as unknown as vscode.TextDocument);
    const applied: Array<{ __entries: Array<{ op: string; text: string }> }> = [];
    vi.spyOn(vscode.workspace, "applyEdit").mockImplementation((edit) => {
      applied.push(edit as unknown as { __entries: Array<{ op: string; text: string }> });
      return Promise.resolve(true);
    });
    const mgr = CommandManager.create(makeContext({ traceabilityAdapter: adapter }));
    const subsystem = {
      getActiveAdapter: () => adapter,
      getSnapshot: () => snapshot,
    } as unknown as TraceabilitySubsystem;
    mgr.setTraceabilitySubsystem(subsystem);
    return { mgr, applied };
  }

  const drop = (mgr: CommandManager, dropId: string, key: string): Promise<void> =>
    linkCommands(mgr).applyBoardDrop(dropId, key);

  it("writes the tag via a single WorkspaceEdit inserting the grammar-built tag", async () => {
    const { mgr, applied } = harness(dropSnapshot());
    await drop(mgr, scenarioDropId(A), "5");
    expect(applied).toHaveLength(1);
    expect(applied[0]!.__entries).toHaveLength(1);
    expect(applied[0]!.__entries[0]).toMatchObject({ op: "insert", text: "@TC-5\n" });
  });

  it("routes through the shared applyTagInsert rather than duplicating the insert", async () => {
    const { mgr, applied } = harness(dropSnapshot());
    const insert = vi.spyOn(
      linkCommands(mgr) as unknown as { applyTagInsert: (...a: unknown[]) => Promise<unknown> },
      "applyTagInsert"
    );
    await drop(mgr, scenarioDropId(A), "5");
    expect(insert).toHaveBeenCalledOnce();
    expect(insert.mock.calls[0]![0]).toMatchObject({ filePath: "/ws/a.feature", line: 3 });
    expect(insert.mock.calls[0]![1]).toBe("5");
    expect(applied).toHaveLength(1);
  });

  it("rejects a stale drop with a toast and no edit when the scenario is gone from the snapshot", async () => {
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { mgr, applied } = harness(dropSnapshot());
    await drop(mgr, scenarioDropId({ ...A, line: 999 }), "5");
    expect(applied).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("rejects a drop naming a key the snapshot no longer knows", async () => {
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { mgr, applied } = harness(dropSnapshot());
    await drop(mgr, scenarioDropId(A), "NOPE-1");
    expect(applied).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });

  it("surfaces a failed write as an error toast without crashing", async () => {
    const adapter = new InMemoryTraceabilityAdapter();
    const doc = {
      uri: vscode.Uri.file("/ws/a.feature"),
      getText: () => "Feature: F\n\nScenario: A\n  Given x\n",
      save: () => Promise.resolve(true),
    };
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(doc as unknown as vscode.TextDocument);
    vi.spyOn(vscode.workspace, "applyEdit").mockRejectedValue(new Error("disk full"));
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const mgr = CommandManager.create(makeContext({ traceabilityAdapter: adapter }));
    mgr.setTraceabilitySubsystem({
      getActiveAdapter: () => adapter,
      getSnapshot: () => dropSnapshot(),
    } as unknown as TraceabilitySubsystem);

    await expect(drop(mgr, scenarioDropId(A), "5")).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledOnce();
  });

  it("surfaces a refused write, which resolves rather than throwing, as an error toast", async () => {
    const { mgr } = harness(dropSnapshot());
    vi.spyOn(vscode.workspace, "applyEdit").mockResolvedValue(false);
    const error = vi.spyOn(vscode.window, "showErrorMessage");

    await drop(mgr, scenarioDropId(A), "5");

    expect(error.mock.calls[0]?.[0]).toBe("Could not link 5: the feature file edit was not applied");
  });
});

describe("traceability board unlink handler", () => {
  afterEach(() => vi.restoreAllMocks());

  const SOURCE = "Feature: F\n\n@TC-1 @TC-2\nScenario: A\n  Given x\n";
  const A: ScenarioRef = { filePath: "/ws/a.feature", line: 4, name: "A", kind: "scenario" };

  function unlinkSnapshot(): TraceabilitySnapshot {
    return {
      links: [
        { testKey: "1", scenario: A, reqKeys: [] },
        { testKey: "2", scenario: A, reqKeys: [] },
      ],
      untraced: [],
      orphans: [],
      stale: false,
      completeProjects: ["CALC"],
      errors: [],
    };
  }

  function harness(snapshot: TraceabilitySnapshot) {
    const adapter = new InMemoryTraceabilityAdapter();
    const lines = SOURCE.split("\n");
    const doc = {
      uri: vscode.Uri.file("/ws/a.feature"),
      eol: vscode.EndOfLine.LF,
      getText: () => SOURCE,
      lineAt: (n: number) => ({ text: lines[n] ?? "", rangeIncludingLineBreak: new vscode.Range(n, 0, n + 1, 0) }),
      save: () => Promise.resolve(true),
    };
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(doc as unknown as vscode.TextDocument);
    const applied: Array<{ __entries: Array<{ op: string; text: string }> }> = [];
    vi.spyOn(vscode.workspace, "applyEdit").mockImplementation((edit) => {
      applied.push(edit as unknown as { __entries: Array<{ op: string; text: string }> });
      return Promise.resolve(true);
    });
    const mgr = CommandManager.create(makeContext({ traceabilityAdapter: adapter }));
    mgr.setTraceabilitySubsystem({
      getActiveAdapter: () => adapter,
      getSnapshot: () => snapshot,
    } as unknown as TraceabilitySubsystem);
    return { mgr, applied };
  }

  const unlink = (mgr: CommandManager, dropId: string, key: string): Promise<void> =>
    linkCommands(mgr).applyBoardUnlink(dropId, key);

  it("routes a valid pair through applyTagRemove with the exact ref and key", async () => {
    const { mgr } = harness(unlinkSnapshot());
    const remove = vi.spyOn(
      linkCommands(mgr) as unknown as { applyTagRemove: (...a: unknown[]) => Promise<unknown> },
      "applyTagRemove"
    );
    await unlink(mgr, scenarioDropId(A), "1");
    expect(remove).toHaveBeenCalledOnce();
    expect(remove.mock.calls[0]![0]).toMatchObject({ filePath: "/ws/a.feature", line: 4 });
    expect(remove.mock.calls[0]![1]).toBe("1");
  });

  it("removes only the named key from a two-link scenario, leaving the other tag", async () => {
    const { mgr, applied } = harness(unlinkSnapshot());
    await unlink(mgr, scenarioDropId(A), "1");
    expect(applied).toHaveLength(1);
    expect(applied[0]!.__entries).toHaveLength(1);
    expect(applied[0]!.__entries[0]).toMatchObject({ op: "replace", text: "@TC-2" });
  });

  it("rejects a stale pair with a toast and no edit when no live link matches", async () => {
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { mgr, applied } = harness(unlinkSnapshot());
    await unlink(mgr, scenarioDropId({ ...A, line: 999 }), "1");
    expect(applied).toHaveLength(0);
    expect(warn).toHaveBeenCalledOnce();
  });
});

describe("traceability bulkCreateTests wiring", () => {
  const win = vscode.window as unknown as {
    __webviewPanels: Array<{ webview: { __posted: unknown[] }; __receive: (message: unknown) => Promise<void> }>;
    __resetWebviewPanels: () => void;
  };

  afterEach(() => {
    win.__resetWebviewPanels();
    vi.restoreAllMocks();
  });

  const A: ScenarioRef = { filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" };

  function subsystemWithAuthoring(): TraceabilitySubsystem {
    return {
      traceabilityPanelActive: true,
      getSnapshot: () => ({ links: [], untraced: [{ scenario: A, reqKeys: [] }], orphans: [], stale: false, completeProjects: ["CALC"], errors: [] }),
      getActiveAdapter: () => ({
        label: "Xray",
        keyGrammar: { testPrefix: "TEST_", projectOf: (key: string) => key.split("-")[0] },
        testAuthoring: { createTest: () => Promise.resolve({ key: "CALC-1", warnings: [] }) },
      }),
      tagDerivedProjectKeys: () => [],
      projectScope: () => NO_PROJECT_SCOPE,
      mappingPageSize: () => NO_MAPPING_PAGE_SIZE,
      onDidChangeSnapshot: new vscode.EventEmitter<void>().event,
    } as unknown as TraceabilitySubsystem;
  }

  // The command reads its selection off the open board, so drive one check through the panel.
  async function selectOnBoard(mgr: CommandManager): Promise<void> {
    BoardPanel.open(traceabilityBoardDeps(mgr));
    const panel = win.__webviewPanels[0]!;
    await panel.__receive({ type: "ready" });
    await panel.__receive({ surface: "board", type: "select", id: scenarioDropId(A), on: true });
  }

  it("reads an unconfigured site as not connected instead of letting the credential lookup reject", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const mgr = CommandManager.create(makeContext());
    mgr.setTraceabilitySubsystem(subsystemWithAuthoring());
    // The real store throws on a site that normalizes empty, which is exactly the default config here.
    mgr.setCredentialStore(new XrayCredentialStore({
      get: () => Promise.resolve(undefined),
      store: () => Promise.resolve(),
      delete: () => Promise.resolve(),
    } as unknown as vscode.SecretStorage));
    await selectOnBoard(mgr);

    const run = (
      traceabilityCommands(mgr) as unknown as {
        getAuthoringCommands: () => { bulkCreateTests: () => Promise<void> };
      }
    ).getAuthoringCommands();

    await expect(run.bulkCreateTests()).resolves.toBeUndefined();
    expect(String(info.mock.calls.at(-1)?.[0])).toContain("Connect to your test tracker");
  });
});

// The board is rebuilt from settings, so a settings edit only reaches an open one through a rebuild.
describe("board refresh on a settings change", () => {
  const registered: Array<{ dispose: () => void }> = [];

  afterEach(() => {
    // The host allows one serializer per view type, so each wiring retires with its test.
    for (const subscription of registered.splice(0)) {
      subscription.dispose();
    }
    win.__resetWebviewPanels();
    vi.restoreAllMocks();
  });

  // A config whose xray.syncProjectKeys the test can move under an open board, which is what a settings
  // edit does.
  function movingConfig(keys: () => string[]): ExtensionConfig {
    return ExtensionConfig.create(
      {
        get: (key: string, fallback: unknown) => (key === "xray.syncProjectKeys" ? keys() : fallback),
      } as unknown as vscode.WorkspaceConfiguration,
      false
    );
  }

  function boardSubsystem(scope: ProjectScopeStore, onRebuild: () => void): TraceabilitySubsystem {
    return {
      traceabilityPanelActive: true,
      getActiveAdapter: () => ({
        label: "Xray",
        keyGrammar: { testPrefix: "TEST_", reqPrefix: "REQ_", projectOf: (k: string) => k.split("-")[0] },
      }),
      getSnapshot: () => undefined,
      tagDerivedProjectKeys: () => [],
      projectScope: () => scope,
      mappingPageSize: () => NO_MAPPING_PAGE_SIZE,
      onDidChangeSnapshot: new vscode.EventEmitter<void>().event,
      // Stands in for the debounced, serialized rebuild the real subsystem runs.
      scheduleRebuild: onRebuild,
    } as unknown as TraceabilitySubsystem;
  }

  // Wire the board the way activation does, with the config listener captured so a test can fire it.
  function wireBoard(
    subsystem: TraceabilitySubsystem,
    config?: ExtensionConfig
  ): { openBoard: () => void; fire: (...changed: string[]) => void } {
    let listener: ((event: vscode.ConfigurationChangeEvent) => void) | undefined;
    vi.spyOn(vscode.workspace, "onDidChangeConfiguration").mockImplementation((handler) => {
      listener = handler as (event: vscode.ConfigurationChangeEvent) => void;
      return { dispose: () => undefined };
    });
    const mgr = CommandManager.create(makeContext(config ? { config } : undefined));
    mgr.setTraceabilitySubsystem(subsystem);
    mgr.registerBoardSerializer({ subscriptions: registered } as unknown as vscode.ExtensionContext);
    return {
      openBoard: () => traceabilityCommands(mgr).openBoard(),
      fire: (...changed: string[]) => listener?.({ affectsConfiguration: (key: string) => changed.includes(key) }),
    };
  }

  it("requests a rebuild when a setting the board renders changes", () => {
    const rebuild = vi.fn();
    const { openBoard, fire } = wireBoard(boardSubsystem(NO_PROJECT_SCOPE, rebuild));
    openBoard();

    fire("playwrightBddRunner.xray.syncProjectKeys");

    expect(rebuild).toHaveBeenCalledOnce();
  });

  it("ignores config noise, so an unrelated edit cannot thrash the board", () => {
    const rebuild = vi.fn();
    const { openBoard, fire } = wireBoard(boardSubsystem(NO_PROJECT_SCOPE, rebuild));
    openBoard();

    fire("playwrightBddRunner.playwrightCommand");
    fire("editor.fontSize");

    expect(rebuild).not.toHaveBeenCalled();
  });

  // A board opened later builds itself from the settings as they stand, so rebuilding for one that is not
  // on screen is work nobody would see.
  it("asks for no rebuild while no board is open", () => {
    const rebuild = vi.fn();
    const { fire } = wireBoard(boardSubsystem(NO_PROJECT_SCOPE, rebuild));

    fire("playwrightBddRunner.xray.syncProjectKeys");

    expect(rebuild).not.toHaveBeenCalled();
  });

  // The whole seam end to end: a settings edit reaches the board only through the rebuild it asks for, and
  // what the board then paints is the REAL scope store's coercion against the universe those settings
  // build. The store coerces, it never erases, so putting the project back restores the selection.
  it("coerces a scope whose project left the settings, and restores it when the setting comes back", async () => {
    let keys = ["calc", "pay"];
    const scope = projectScopeStore(memento(), () => undefined);
    scope.set("PAY");
    const snapshotChanged = new vscode.EventEmitter<void>();
    const subsystem = {
      ...boardSubsystem(scope, () => snapshotChanged.fire()),
      onDidChangeSnapshot: snapshotChanged.event,
    } as unknown as TraceabilitySubsystem;
    const { openBoard, fire } = wireBoard(subsystem, movingConfig(() => keys));
    openBoard();
    const panel = win.__webviewPanels[0]!;
    await panel.__receive({ type: "ready" });
    const rendered = (): unknown => [...panel.webview.__posted].reverse().find((m) => m.type === "render");
    expect(rendered()).toMatchObject({ project: "PAY", scoped: true, projects: ["CALC", "PAY"] });

    keys = ["calc"];
    fire("playwrightBddRunner.xray.syncProjectKeys");
    expect(rendered()).toMatchObject({ project: "", scoped: false, projects: ["CALC"] });

    keys = ["calc", "pay"];
    fire("playwrightBddRunner.xray.syncProjectKeys");

    expect(rendered()).toMatchObject({ project: "PAY", scoped: true });
  });
});

describe("traceability clearLocalRunHistory", () => {
  afterEach(() => vi.restoreAllMocks());

  const SITE = "acme.atlassian.net";

  function harness(runs = 2, ledgerEntries = 1) {
    const store = new RunArtifactStore(memento(), Logger.create());
    for (let i = 0; i < runs; i += 1) {
      store.append({ id: `run-${i}`, createdAt: i, results: [], shards: [], selection: { kind: "all-mapped" }, preflight: [], state: "complete" });
    }
    const ledger = new PublishLedger(memento(), Logger.create());
    for (let i = 0; i < ledgerEntries; i += 1) {
      ledger.record({ artifactId: `run-${i}`, executionRef: `XNP-${i}`, site: SITE, account: "id", publishedAt: i, pendingAttachments: [] });
    }
    const rebuildNow = vi.fn(() => Promise.resolve());
    const mgr = CommandManager.create(makeContext({ runArtifactStore: store }));
    mgr.setPublishLedger(ledger);
    mgr.setTraceabilitySubsystem({ rebuildNow } as unknown as TraceabilitySubsystem);
    return { mgr, store, ledger, rebuildNow };
  }

  const clear = (mgr: CommandManager): Promise<void> =>
    publishCommands(mgr).clearLocalRunHistory();

  it("clears nothing when the confirm is dismissed", async () => {
    const { mgr, store, ledger } = harness();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined as never);
    await clear(mgr);
    expect(store.list()).toHaveLength(2);
    expect(ledger.entriesForSite(SITE)).toHaveLength(1);
  });

  it("asks once, with the consequences in the modal detail and both clear actions", async () => {
    const { mgr } = harness();
    const warn = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined as never);
    await clear(mgr);
    expect(warn).toHaveBeenCalledWith(
      "Clear this workspace's local run history?",
      {
        modal: true,
        detail: expect.stringContaining("forfeits those warnings for past executions"),
      },
      "Clear runs",
      "Clear runs and ledger"
    );
  });

  it("wipes the runs only on Clear runs, keeping the ledger's republish warnings", async () => {
    const { mgr, store, ledger, rebuildNow } = harness();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Clear runs" as never);
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    await clear(mgr);
    expect(store.list()).toEqual([]);
    expect(ledger.entriesForSite(SITE)).toHaveLength(1);
    expect(info).toHaveBeenCalledWith("Cleared 2 local runs.");
    // The board repaints off the subsystem's snapshot-change event, which this rebuild fires.
    expect(rebuildNow).toHaveBeenCalledOnce();
  });

  it("wipes both stores on Clear runs and ledger", async () => {
    const { mgr, store, ledger } = harness();
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Clear runs and ledger" as never);
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    await clear(mgr);
    expect(store.list()).toEqual([]);
    expect(ledger.entriesForSite(SITE)).toEqual([]);
    expect(info).toHaveBeenCalledWith("Cleared 2 local runs and 1 ledger entry.");
  });

  it("names the ledger alone when there were no local runs to clear", async () => {
    const { mgr, ledger, rebuildNow } = harness(0, 1);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Clear runs and ledger" as never);
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    await clear(mgr);
    expect(ledger.entriesForSite(SITE)).toEqual([]);
    expect(info).toHaveBeenCalledWith("Cleared 1 ledger entry.");
    expect(rebuildNow).toHaveBeenCalledOnce();
  });

  it("reports an already-empty history and skips the board refresh", async () => {
    const { mgr, rebuildNow } = harness(0, 0);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Clear runs and ledger" as never);
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    await clear(mgr);
    expect(info).toHaveBeenCalledWith("Local run history is already empty.");
    expect(rebuildNow).not.toHaveBeenCalled();
  });

  it("reports the clear even when the board refresh fails", async () => {
    const { mgr, store } = harness();
    mgr.setTraceabilitySubsystem({
      rebuildNow: () => Promise.reject(new Error("discovery down")),
    } as unknown as TraceabilitySubsystem);
    vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue("Clear runs" as never);
    const info = vi.spyOn(vscode.window, "showInformationMessage");

    await expect(clear(mgr)).resolves.toBeUndefined();
    expect(store.list()).toEqual([]);
    expect(info).toHaveBeenCalledWith("Cleared 2 local runs.");
  });
});

// An older ledger entry can carry a blank reference (a publish whose import response named no execution),
// and a POST to /issue//attachments can only 404, so both replay paths refuse it and say why.
describe("traceability pending attachments against a reference the response never named", () => {
  afterEach(() => vi.restoreAllMocks());

  const SITE = "acme.atlassian.net";

  function harness(): { mgr: CommandManager; ledger: PublishLedger } {
    const ledger = new PublishLedger(memento(), Logger.create());
    ledger.record({
      artifactId: "run-1",
      executionRef: "",
      site: SITE,
      account: "id",
      publishedAt: 1,
      pendingAttachments: ["/ws/report.zip"],
    });
    const mgr = CommandManager.create(makeContext());
    mgr.setPublishLedger(ledger);
    return { mgr, ledger };
  }

  it("leaves the banner's files pending and warns instead of uploading", async () => {
    const { mgr, ledger } = harness();
    const warn = vi.spyOn(vscode.window, "showWarningMessage");

    const result = await (
      publishCommands(mgr) as unknown as {
        attachPendingForRun: (id: string, site: string) => Promise<{ remaining: number }>;
      }
    ).attachPendingForRun("run-1", SITE);

    expect(result).toEqual({ remaining: 1 });
    expect(String(warn.mock.calls.at(-1)?.[0])).toContain("an execution with no key");
    expect(ledger.find("run-1", SITE)?.pendingAttachments).toEqual(["/ws/report.zip"]);
  });

  it("refuses the toast Retry the same way, leaving the ledger untouched", async () => {
    const { mgr, ledger } = harness();
    const warn = vi.spyOn(vscode.window, "showWarningMessage");

    await (
      publishCommands(mgr) as unknown as {
        retryAttachments: (id: string, site: string, key: string, files: readonly string[]) => Promise<void>;
      }
    ).retryAttachments("run-1", SITE, "", ["/ws/report.zip"]);

    expect(String(warn.mock.calls.at(-1)?.[0])).toContain("an execution with no key");
    expect(ledger.find("run-1", SITE)?.pendingAttachments).toEqual(["/ws/report.zip"]);
  });
});
