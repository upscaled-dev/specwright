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
import { ExternalRef, TraceabilityAdapter } from "../../traceability/contracts";
import { XrayAdapter } from "../../xray/xray-adapter";
import { InMemoryTraceabilityAdapter } from "../../traceability/in-memory-adapter";
import type { TraceabilitySubsystem } from "../../traceability/traceability-subsystem";
import { RunArtifactStore } from "../../traceability/run-artifact-store";
import type { TraceabilitySnapshot, TraceLink } from "../../traceability/traceability-model";
import type { ScenarioRef } from "../../traceability/scenario-ref";
import type { PreflightChoice } from "../../traceability/preflight-flow";
import type { Memento } from "vscode";

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

describe("traceability linkScenario command", () => {
  afterEach(() => vi.restoreAllMocks());

  const untracedNode = {
    kind: "untraced",
    item: { scenario: { filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" } },
  };

  async function syncedAdapter(): Promise<InMemoryTraceabilityAdapter> {
    const adapter = new InMemoryTraceabilityAdapter();
    adapter.seedCatalogue([{ key: "5", summary: "Five" }], "complete");
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
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(
      { label: "5", description: "Five", key: "5" } as unknown as vscode.QuickPickItem
    );
    const applied: Array<{ __entries: Array<{ op: string; text: string }> }> = [];
    vi.spyOn(vscode.workspace, "applyEdit").mockImplementation((edit) => {
      applied.push(edit as unknown as { __entries: Array<{ op: string; text: string }> });
      return Promise.resolve(true);
    });

    const handlers = captureHandlers(makeContext({ traceabilityAdapter: adapter }));
    await handlers.get("playwrightBddRunner.traceability.linkScenario")!(untracedNode);

    expect(applied).toHaveLength(1);
    expect(applied[0]!.__entries).toHaveLength(1);
    expect(applied[0]!.__entries[0]).toMatchObject({ op: "insert", text: "@TC-5\n" });
  });

  interface EditEntry {
    op: string;
    range?: { start: { line: number } };
    position?: { line: number };
    text: string;
  }

  function fakeDoc(text: string): vscode.TextDocument {
    const sep = text.includes("\r\n") ? "\r\n" : "\n";
    return {
      uri: vscode.Uri.file("/ws/a.feature"),
      eol: sep === "\r\n" ? vscode.EndOfLine.CRLF : vscode.EndOfLine.LF,
      getText: () => text,
      lineAt: (n: number) => ({ text: text.split(sep)[n] ?? "" }),
      save: () => Promise.resolve(true),
    } as unknown as vscode.TextDocument;
  }

  function applyWsEdit(text: string, entries: EditEntry[]): string {
    const eol = text.includes("\r\n") ? "\r\n" : "\n";
    const parts = text.split(eol);
    for (const e of entries) {
      if (e.op === "insert" && e.position) {
        const content = e.text.endsWith(eol) ? e.text.slice(0, -eol.length) : e.text;
        parts.splice(e.position.line, 0, content);
      } else if (e.op === "replace" && e.range) {
        parts[e.range.start.line] = e.text;
      }
    }
    return parts.join(eol);
  }

  async function reMap(feature: string): Promise<string> {
    const adapter = new InMemoryTraceabilityAdapter();
    adapter.seedCatalogue([{ key: "9", summary: "Nine" }], "complete");
    await adapter.metadata.sync({ testKeys: ["9"] });
    vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(fakeDoc(feature));
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(
      { label: "9", key: "9" } as unknown as vscode.QuickPickItem
    );
    const applied: EditEntry[][] = [];
    vi.spyOn(vscode.workspace, "applyEdit").mockImplementation((edit) => {
      applied.push((edit as unknown as { __entries: EditEntry[] }).__entries);
      return Promise.resolve(true);
    });
    const handlers = captureHandlers(makeContext({ traceabilityAdapter: adapter }));
    await handlers.get("playwrightBddRunner.traceability.linkScenario")!({
      kind: "link",
      link: { scenario: { filePath: "/ws/a.feature", line: 4, name: "A", kind: "scenario" } },
    });
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

  it("gates the palette entry on the traceability panel being enabled", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    expect(palette.find((e) => e.command === CMD)?.when).toBe(
      "config.playwrightBddRunner.traceability.enablePanel"
    );
  });
});

describe("traceability sync command handler", () => {
  afterEach(() => vi.restoreAllMocks());

  it("guides the user when no metadata capability is active", async () => {
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.sync")!();
    expect(String(info.mock.calls[0]?.[0])).toContain("Connect");
  });

  it("syncs with the workspace + configured project scope and surfaces snapshot errors as a toast", async () => {
    const sync = vi.fn(() => Promise.resolve());
    const adapter = {
      metadata: {
        sync,
        snapshot: () => ({ tests: new Map(), fetchedScopes: [], catalogueProjects: [], verifiedAbsentKeys: [], stale: false, completeness: "unknown", errors: ["boom"] }),
      },
    };
    const subsystem = {
      getActiveAdapter: () => adapter,
      knownTestKeys: () => ["CALC-1"],
    } as unknown as TraceabilitySubsystem;
    const errorToast = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);

    const mgr = CommandManager.create(makeContext());
    mgr.setTraceabilitySubsystem(subsystem);
    await (mgr as unknown as { syncTraceability: () => Promise<void> }).syncTraceability();

    expect(sync).toHaveBeenCalledWith({ testKeys: ["CALC-1"], projectKeys: [] }, expect.anything());
    expect(errorToast).toHaveBeenCalled();
  });

  it("coalesces concurrent invocations into a single in-flight run", async () => {
    let resolveSync!: () => void;
    const sync = vi.fn(() => new Promise<void>((resolve) => { resolveSync = resolve; }));
    const adapter = {
      metadata: {
        sync,
        snapshot: () => ({ tests: new Map(), fetchedScopes: [], catalogueProjects: [], verifiedAbsentKeys: [], stale: false, completeness: "unknown", errors: [] }),
      },
    };
    const subsystem = {
      getActiveAdapter: () => adapter,
      knownTestKeys: () => [],
    } as unknown as TraceabilitySubsystem;

    const mgr = CommandManager.create(makeContext());
    mgr.setTraceabilitySubsystem(subsystem);
    const run = mgr as unknown as { syncTraceability: () => Promise<void> };

    const first = run.syncTraceability();
    const second = run.syncTraceability();
    resolveSync();
    await Promise.all([first, second]);

    // The second invoke joined the in-flight run rather than starting a second sync.
    expect(sync).toHaveBeenCalledTimes(1);
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

describe("traceability runAndPublish — preflight batch flow", () => {
  afterEach(() => vi.restoreAllMocks());

  function memento(): Memento {
    const store = new Map<string, unknown>();
    return {
      keys: () => [...store.keys()],
      get: (k: string, d?: unknown) => (store.has(k) ? store.get(k) : d),
      update: (k: string, v: unknown) => { store.set(k, JSON.parse(JSON.stringify(v))); return Promise.resolve(); },
    } as unknown as Memento;
  }

  const A: ScenarioRef = { filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" };
  const B: ScenarioRef = { filePath: "/ws/a.feature", line: 8, name: "B", kind: "scenario" };
  const READY_LINK: TraceLink = { testKey: "CALC-1", scenario: A, reqKeys: [], meta: { key: "CALC-1", testType: { name: "Cucumber", kind: "Gherkin" } } };
  const FLAGGED_LINK: TraceLink = { testKey: "CALC-2", scenario: B, reqKeys: [], remoteMissing: true };

  function snapshot(links: TraceLink[]): TraceabilitySnapshot {
    return { links, untraced: [], orphans: [], stale: false, completeness: "complete", errors: [] };
  }

  function harness(links: TraceLink[]) {
    const store = new RunArtifactStore(memento(), Logger.create());
    const runScenarioWithOutput = vi.fn(() => Promise.resolve({ success: true, output: "", error: "", duration: 1 }));
    const executor = { runScenarioWithOutput, runPathFilterWithOutput: vi.fn(), runAllTestsWithTagsOutput: vi.fn() };
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
    return { mgr, store, runScenarioWithOutput };
  }

  function pickBy(predicate: (c: PreflightChoice) => boolean): void {
    vi.spyOn(vscode.window, "showQuickPick").mockImplementation((items) => {
      const rows = items as unknown as Array<{ choice?: PreflightChoice }>;
      const picked = rows.find((r) => r.choice !== undefined && predicate(r.choice));
      return Promise.resolve(picked as unknown as vscode.QuickPickItem | undefined);
    });
  }

  it("resolves all-mapped, classifies, and runs every scenario on local-only", async () => {
    const { mgr, store, runScenarioWithOutput } = harness([READY_LINK, FLAGGED_LINK]);
    pickBy((c) => c.kind === "run" && c.outcome === "local-only");
    await mgr.runAndPublish();
    expect(runScenarioWithOutput).toHaveBeenCalledTimes(2);
    expect(store.latest()?.preflight).toEqual([
      { scenario: B, testKey: "CALC-2", state: "invalid-key", outcome: "local-only" },
    ]);
  });

  it("drops the flagged scenario's run and records its exclusion on exclude", async () => {
    const { mgr, store, runScenarioWithOutput } = harness([READY_LINK, FLAGGED_LINK]);
    pickBy((c) => c.kind === "run" && c.outcome === "exclude");
    await mgr.runAndPublish();
    // Only the ready scenario ran; the flagged one was excluded.
    expect(runScenarioWithOutput).toHaveBeenCalledTimes(1);
    expect(store.latest()?.preflight).toEqual([
      { scenario: B, testKey: "CALC-2", state: "invalid-key", outcome: "exclude" },
    ]);
  });

  it("runs nothing and seals nothing when the preflight is cancelled", async () => {
    const { mgr, store, runScenarioWithOutput } = harness([READY_LINK, FLAGGED_LINK]);
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    await mgr.runAndPublish();
    expect(runScenarioWithOutput).not.toHaveBeenCalled();
    expect(store.latest()).toBeUndefined();
    expect(String(info.mock.calls.at(-1)?.[0])).toContain("cancelled");
  });

  it("runs directly with no quick-pick when every scenario is ready", async () => {
    const { mgr, store, runScenarioWithOutput } = harness([READY_LINK]);
    const quickPick = vi.spyOn(vscode.window, "showQuickPick");
    await mgr.runAndPublish();
    expect(quickPick).not.toHaveBeenCalled();
    expect(runScenarioWithOutput).toHaveBeenCalledTimes(1);
    expect(store.latest()?.preflight).toEqual([]);
  });

  it("wires the progress cancel token to the abort controller and seals cancelled", async () => {
    const { mgr, store, runScenarioWithOutput } = harness([READY_LINK]);
    // A cancelled progress token fires immediately; the batch must abort before dispatching and seal
    // the artifact `cancelled`.
    vi.spyOn(vscode.window, "withProgress").mockImplementation((_opts, task) =>
      (task as (p: unknown, t: unknown) => Thenable<unknown>)(
        { report: () => {} },
        { isCancellationRequested: true, onCancellationRequested: (cb: () => void) => { cb(); return { dispose: () => {} }; } }
      )
    );
    await mgr.runAndPublish();
    expect(runScenarioWithOutput).not.toHaveBeenCalled();
    expect(store.latest()?.state).toBe("cancelled");
  });
});
