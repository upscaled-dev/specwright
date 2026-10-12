import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it, expect, vi } from "vitest";
import * as vscode from "vscode";
import { CommandManager } from "../../commands/command-manager";
import type {
  ExecutionGateway,
  ExecutionOptions,
  RunCompletion,
  RunIntent,
} from "../../core/run-contracts";
import { Logger } from "../../utils/logger";
import { ExtensionConfig } from "../../core/extension-config";
import type { TraceabilitySubsystem } from "../../traceability/traceability-subsystem";
import { captureHandlers, fakeDoc, makeContext } from "./helpers/command-manager-harness";

const EXECUTION_IDENTITY = { engine: "legacy-direct", schemaProfile: "legacy.v1" } as const;

function testGateway(
  execute: (intent: RunIntent, options?: ExecutionOptions) => Promise<RunCompletion>
): ExecutionGateway {
  return {
    running: false,
    diagnose: vi.fn(() => Promise.resolve([])),
    discover: vi.fn(() => Promise.resolve({ cases: [], diagnostics: [] })),
    prepare: vi.fn(async (intent) => ({
      operationId: "command-manager-test",
      identity: EXECUTION_IDENTITY,
      intent,
    })),
    run: vi.fn((prepared, options) => execute(prepared.intent, options)),
    debug: vi.fn((prepared, options) => execute(prepared.intent, options)),
    cancel: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(),
  };
}








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

describe("Create Step Definition For Step command arguments", () => {
  const feature = vscode.Uri.file("/ws/checkout.feature");
  const step = { line: 4, text: "I pay 12 dollars", keyword: "When", effectiveKeyword: "When" };

  it.each(["Given", "When", "Then"])("accepts a resolved %s step and reaches the generator", async (effectiveKeyword) => {
    const logger = Logger.create();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const message = vi.spyOn(vscode.window, "showWarningMessage");
    vi.spyOn(vscode.workspace, "getWorkspaceFolder").mockReturnValue(undefined);
    const handler = captureHandlers(makeContext({ logger })).get("playwrightBddRunner.generateStepDefinitionForStep")!;

    try {
      await handler(feature, { ...step, effectiveKeyword });
      expect(warn).not.toHaveBeenCalledWith(expect.stringContaining("generateStepDefinitionForStep"), expect.anything());
      expect(message).toHaveBeenCalledWith("Generate Step Definitions requires an open workspace folder.");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it.each([
    { name: "missing feature", args: [undefined, step], warning: "missing or invalid featureUri" },
    { name: "plain path in place of a URI", args: ["/ws/checkout.feature", step], warning: "missing or invalid featureUri" },
    { name: "missing step", args: [feature, undefined], warning: "missing or invalid step info" },
    { name: "non-numeric source line", args: [feature, { ...step, line: "4" }], warning: "missing or invalid step info" },
    { name: "missing step text", args: [feature, { ...step, text: undefined }], warning: "missing or invalid step info" },
    { name: "missing source keyword", args: [feature, { ...step, keyword: undefined }], warning: "missing or invalid step info" },
    { name: "unresolved effective keyword", args: [feature, { ...step, effectiveKeyword: "And" }], warning: "invalid effectiveKeyword" },
  ])("ignores $name without opening or editing a step file", async ({ args, warning }) => {
    const logger = Logger.create();
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const open = vi.spyOn(vscode.workspace, "openTextDocument");
    const edit = vi.spyOn(vscode.workspace, "applyEdit");
    const handler = captureHandlers(makeContext({ logger })).get("playwrightBddRunner.generateStepDefinitionForStep")!;

    try {
      await handler(...args);
      expect(warn).toHaveBeenCalledWith(`generateStepDefinitionForStep: ${warning}`, { args });
      expect(open).not.toHaveBeenCalled();
      expect(edit).not.toHaveBeenCalled();
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("Go to Step Definition command context", () => {
  it("guides an editor-free invocation and rejects a non-feature editor", async () => {
    const editorHost = vscode.window as unknown as { activeTextEditor: unknown };
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const files = vi.spyOn(vscode.workspace, "findFiles");
    const command = captureHandlers(makeContext()).get("playwrightBddRunner.goToStepDefinition")!;

    try {
      editorHost.activeTextEditor = undefined;
      await command();
      expect(error).toHaveBeenCalledWith("Go to Step Definition: open a .feature file and place the cursor on a step.");

      editorHost.activeTextEditor = {
        document: Object.assign(fakeDoc("export const step = 1;", "/ws/steps.ts"), {
          languageId: "typescript", fileName: "/ws/steps.ts",
        }),
        selection: { active: new vscode.Position(0, 0) },
      };
      await command();
      expect(error).toHaveBeenCalledWith("Go to Step Definition only works inside .feature files.");
      expect(files).not.toHaveBeenCalled();
    } finally {
      editorHost.activeTextEditor = undefined;
      vi.restoreAllMocks();
    }
  });
});

describe("Refresh Steps Panel command", () => {
  it("rescans the active usage index so its change event can repaint the tree", async () => {
    const rescan = vi.fn();
    const handlers = captureHandlers(makeContext(), (manager) => manager.setUsageIndexHost({
      getUsageIndex: () => ({ rescan }) as never,
      projectCapabilities: () => Promise.resolve({
        workspace: true,
        featureFiles: 1,
        stepDefinitions: 1,
        stepDefinitionPaths: ["steps/**/*.ts"],
      }),
    }));

    await handlers.get("playwrightBddRunner.refreshStepsPanel")!();

    expect(rescan).toHaveBeenCalledOnce();
  });
});

describe("Insert Step command from the Steps panel", () => {
  it.each([true, false])("inserts a matching step into the feature editor (context node: %s)", async (fromNode) => {
    const editorHost = vscode.window as unknown as { activeTextEditor: unknown };
    const insertSnippet = vi.fn().mockResolvedValue(true);
    const step = { pattern: "I pay {int} dollars", isRegex: false, keyword: "When", filePath: "/ws/steps.ts" };
    const getAllUsages = vi.fn().mockResolvedValue(new Map([[step, []]]));
    const quickPick = vi.spyOn(vscode.window, "showQuickPick").mockImplementation(
      ((items: Array<{ snippet: string }>) => Promise.resolve(items[0])) as never
    );
    editorHost.activeTextEditor = {
      document: Object.assign(fakeDoc("Feature: Checkout\nScenario: pay\n  When I pay", "/ws/checkout.feature"), {
        languageId: "gherkin", fileName: "/ws/checkout.feature",
      }),
      insertSnippet,
    };
    const handlers = captureHandlers(makeContext(), (manager) => manager.setUsageIndexHost({
      getUsageIndex: () => ({ getAllUsages }) as never,
      projectCapabilities: () => Promise.resolve({
        workspace: true,
        featureFiles: 1,
        stepDefinitions: 1,
        stepDefinitionPaths: ["steps/**/*.ts"],
      }),
    }));
    const node = {
      kind: "stepDefinition", ...step, humanized: "I pay {int} dollars", usageCount: 0, line: 1,
    };

    try {
      await handlers.get("playwrightBddRunner.insertStep")!(fromNode ? node : undefined);
      expect(insertSnippet).toHaveBeenCalledOnce();
      expect((insertSnippet.mock.calls[0]?.[0] as vscode.SnippetString).value).toContain("I pay");
      expect(quickPick).toHaveBeenCalledTimes(fromNode ? 0 : 1);
      expect(getAllUsages).toHaveBeenCalledTimes(fromNode ? 0 : 1);
    } finally {
      editorHost.activeTextEditor = undefined;
      vi.restoreAllMocks();
    }
  });
});

describe("Steps panel scaffold commands", () => {
  it("uses the selected unmatched step and ignores a different tree node", async () => {
    const message = vi.spyOn(vscode.window, "showWarningMessage");
    vi.spyOn(vscode.workspace, "getWorkspaceFolder").mockReturnValue(undefined);
    const handler = captureHandlers(makeContext()).get("playwrightBddRunner.scaffoldStepFromPanel")!;
    const node = {
      kind: "unmatchedStep", featurePath: "/ws/checkout.feature",
      step: { line: 4, text: "I pay 12 dollars", keyword: "When", effectiveKeyword: "When" },
    };

    try {
      await handler({ kind: "section" });
      expect(message).not.toHaveBeenCalled();
      await handler(node);
      expect(message).toHaveBeenCalledWith("Generate Step Definitions requires an open workspace folder.");
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("reads the selected unmatched feature and ignores a different tree node", async () => {
    const open = vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(
      fakeDoc("Feature: Checkout\nScenario: pay\n  Given a basket\n", "/ws/checkout.feature")
    );
    const message = vi.spyOn(vscode.window, "showWarningMessage");
    vi.spyOn(vscode.workspace, "findFiles").mockResolvedValue([]);
    vi.spyOn(vscode.workspace, "getWorkspaceFolder").mockReturnValue(undefined);
    const handler = captureHandlers(makeContext()).get("playwrightBddRunner.scaffoldFeatureFromPanel")!;

    try {
      await handler({ kind: "section" });
      expect(open).not.toHaveBeenCalled();
      await handler({ kind: "unmatchedFile", featurePath: "/ws/checkout.feature", steps: [] });
      expect(open).toHaveBeenCalledWith(expect.objectContaining({ fsPath: "/ws/checkout.feature" }));
      expect(message).toHaveBeenCalledWith("Generate Step Definitions requires an open workspace folder.");
    } finally {
      vi.restoreAllMocks();
    }
  });
});

describe("Command diagnostics", () => {
  it("shows every configuration error from Validate Configuration", async () => {
    const context = makeContext();
    vi.spyOn(context.config, "getValidationErrors").mockReturnValue([
      "stepDefinitionPaths must contain a glob",
      "maxParallelProcesses must be positive",
    ]);
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const handlers = captureHandlers(context);

    try {
      await handlers.get("playwrightBddRunner.validateConfiguration")!();
      expect(error).toHaveBeenCalledWith(
        "Configuration validation failed:\nstepDefinitionPaths must contain a glob\nmaxParallelProcesses must be positive"
      );
    } finally {
      vi.restoreAllMocks();
    }
  });

  it("reports a rejected Discover Tests request to the user", async () => {
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const handlers = captureHandlers(makeContext(), (manager) => manager.setTestProvider({
      discoverTests: () => Promise.reject(new Error("the feature scanner stopped")),
    }));

    try {
      await handlers.get("playwrightBddRunner.discoverTests")!();
      expect(error).toHaveBeenCalledWith("Failed to discover tests: the feature scanner stopped");
    } finally {
      error.mockRestore();
    }
  });
});

describe("CommandManager onboarding discovery ordering", () => {
  it("keeps the real discovery handler pending before diagnosis focuses Testing", async () => {
    const events: string[] = [];
    let finishDiscovery: (() => void) | undefined;
    const discovery = new Promise<void>((resolve) => {finishDiscovery = resolve;});
    const context = makeContext({
      executionGateway: testGateway(vi.fn(() => Promise.reject(new Error("not used")))),
    });
    const manager = CommandManager.create(context);
    manager.setUsageIndexHost({
      getUsageIndex: () => undefined as never,
      projectCapabilities: () => Promise.resolve({
        workspace: true,
        featureFiles: 1,
        stepDefinitions: 1,
        stepDefinitionPaths: ["steps/**/*.ts"],
      }),
    });
    manager.setTestProvider({
      discoverTests: () => {
        events.push("discovery:start");
        return discovery.then(() => {events.push("discovery:end");});
      },
    });
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue("Open Testing" as never);
    const registered = new Map<string, (...args: unknown[]) => Promise<void>>();
    vi.spyOn(vscode.commands, "registerCommand").mockImplementation((command, handler) => {
      registered.set(command, handler as (...args: unknown[]) => Promise<void>);
      return { dispose: () => {} };
    });
    vi.spyOn(vscode.commands, "executeCommand").mockImplementation((async (command: string) => {
      events.push(`execute:${command}`);
      return registered.get(command)?.();
    }) as typeof vscode.commands.executeCommand);
    manager.registerCommands({
      subscriptions: [],
      extensionUri: vscode.Uri.file("/extension"),
      globalStorageUri: vscode.Uri.file("/tmp/specwright-command-tests"),
    } as unknown as vscode.ExtensionContext);

    const diagnosis = registered.get("playwrightBddRunner.diagnoseWorkspace")!();
    await vi.waitFor(() => expect(events).toContain("discovery:start"));

    expect(events).not.toContain("execute:workbench.view.testing.focus");
    finishDiscovery?.();
    await diagnosis;
    expect(events).toEqual([
      "execute:playwrightBddRunner.discoverTests",
      "discovery:start",
      "discovery:end",
      "execute:workbench.view.testing.focus",
    ]);
  });
});

describe("command contributions ↔ handler registrations parity", () => {
  interface PackageJson {
    contributes: {
      commands: Array<{ command: string; title: string; category?: string; icon?: string }>;
      menus: Record<string, Array<{ command?: string; when?: string; submenu?: string; group?: string }>>;
      views: Record<string, Array<{ id: string; when?: string }>>;
      submenus: Array<{ id: string; label: string }>;
    };
  }
  const pkg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf-8")
  ) as PackageJson;

  const paletteCommands = {
    visible: [
      "playwrightBddRunner.diagnoseWorkspace",
      "playwrightBddRunner.discoverTests",
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
      "playwrightBddRunner.openSupportSnapshot",
      "playwrightBddRunner.validateConfiguration",
      "playwrightBddRunner.generateStepDefinitions",
      "playwrightBddRunner.goToStepDefinition",
      "playwrightBddRunner.refreshStepsPanel",
      "playwrightBddRunner.exportSteps",
      "playwrightBddRunner.exportScenarios",
      "playwrightBddRunner.insertStep",
      "playwrightBddRunner.traceability.runAndPublishByTagExpression",
      "playwrightBddRunner.traceability.publishLastRun",
      "playwrightBddRunner.traceability.sync",
      "playwrightBddRunner.traceability.openBoard",
      "playwrightBddRunner.traceability.manageConnection",
      "playwrightBddRunner.traceability.showPanel",
      "playwrightBddRunner.traceability.connect",
      "playwrightBddRunner.traceability.disconnect",
      "playwrightBddRunner.traceability.testConnection",
      "playwrightBddRunner.traceability.toggleGrouping",
      "playwrightBddRunner.traceability.switchDefaultProject",
      "playwrightBddRunner.traceability.selectSyncProjects",
      "playwrightBddRunner.traceability.clearLocalRunHistory",
      "playwrightBddRunner.traceability.bulkCreateTests",
      "playwrightBddRunner.traceability.createTestSet",
      "playwrightBddRunner.traceability.createTestPlan",
      "playwrightBddRunner.traceability.createTestExecution",
    ],
    hidden: [
      "playwrightBddRunner.openTesting",
      "playwrightBddRunner.openSteps",
      "playwrightBddRunner.configureStepPaths",
      "playwrightBddRunner.refreshTests",
      "playwrightBddRunner.runScenarioWithContext",
      "playwrightBddRunner.debugScenarioWithContext",
      "playwrightBddRunner.runFeatureFileWithContext",
      "playwrightBddRunner.generateStepDefinitionForStep",
      "playwrightBddRunner.scaffoldStepFromPanel",
      "playwrightBddRunner.scaffoldFeatureFromPanel",
      "playwrightBddRunner.traceability.openIssue",
      "playwrightBddRunner.traceability.copyKey",
      "playwrightBddRunner.traceability.linkScenario",
      "playwrightBddRunner.traceability.runAndPublish",
      "playwrightBddRunner.traceability.runAndPublishFeature",
      "playwrightBddRunner.traceability.runAndPublishFolder",
      "playwrightBddRunner.traceability.hidePanel",
      "playwrightBddRunner.traceability.setupSaved",
      "playwrightBddRunner.traceability.runAndPublishAllMapped",
      "playwrightBddRunner.traceability.find",
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

  it("groups the support snapshot command with Specwright in the Command Palette", () => {
    expect(pkg.contributes.commands.find(({ command }) => command === "playwrightBddRunner.openSupportSnapshot")?.category)
      .toBe("Specwright");
  });

  // A failure message names the registered title. A title the manifest never declares sends the user
  // looking for a command that appears nowhere in the UI.
  it("registers each command under the title the manifest declares", () => {
    const mgr = CommandManager.create(makeContext());
    try {
      mgr.registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext);
      const registered = [...mgr.registeredTitles].sort(([a], [b]) => a.localeCompare(b));
      const manifest = pkg.contributes.commands
        .map((c) => [c.command, c.title] as const)
        .sort(([a], [b]) => a.localeCompare(b));
      expect(registered).toEqual(manifest.map(([command, title]) => [command, title]));
    } finally {
      mgr.dispose();
    }
  });

  function effectiveVisibleCommands(): string[] {
    const palette = pkg.contributes.menus["commandPalette"]!;
    return pkg.contributes.commands
      .map((c) => c.command)
      .filter((command) => {
        const entries = palette.filter((entry) => entry.command === command);
        return entries.length === 0 || entries.some((entry) => entry.when !== "false");
      })
      .sort();
  }

  it("classifies every contributed command as palette-visible or explicitly hidden", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    const paletteIds = palette.flatMap((entry) => entry.command === undefined ? [] : [entry.command]);
    const contributed = pkg.contributes.commands.map((c) => c.command).sort();
    const classified = [...paletteCommands.visible, ...paletteCommands.hidden].sort();

    expect(new Set(paletteIds).size).toBe(paletteIds.length);
    expect(classified).toEqual(contributed);
    expect(effectiveVisibleCommands()).toEqual([...paletteCommands.visible].sort());
    for (const command of paletteCommands.hidden) {
      const entries = palette.filter((entry) => entry.command === command);
      expect(entries).toHaveLength(1);
      expect(entries.every((entry) => entry.when === "false")).toBe(true);
    }
  });

  it("keeps Discover Tests canonical and refreshTests as a hidden compatibility alias", async () => {
    const discoverTests = vi.fn().mockResolvedValue(undefined);
    const handlers = new Map<string, (...args: unknown[]) => Promise<void>>();
    const registration = vi.spyOn(vscode.commands, "registerCommand").mockImplementation(
      (command, handler) => {
        handlers.set(command, handler as (...args: unknown[]) => Promise<void>);
        return { dispose: () => {} };
      }
    );
    const manager = CommandManager.create(makeContext());
    manager.setTestProvider({ discoverTests });
    manager.registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    try {
      await handlers.get("playwrightBddRunner.discoverTests")!();
      await handlers.get("playwrightBddRunner.refreshTests")!();
    } finally {
      registration.mockRestore();
    }

    expect(discoverTests).toHaveBeenCalledTimes(2);
    const palette = pkg.contributes.menus["commandPalette"]!;
    expect(palette.find((entry) =>
      entry.command === "playwrightBddRunner.refreshTests"
    )?.when).toBe("false");
    const nonPaletteRefresh = Object.entries(pkg.contributes.menus)
      .filter(([menu]) => menu !== "commandPalette")
      .flatMap(([, entries]) => entries)
      .filter((entry) => entry.command === "playwrightBddRunner.refreshTests");
    expect(nonPaletteRefresh).toEqual([]);
    expect(pkg.contributes.menus["testing/view/context"]).toBeUndefined();
  });

  it("scopes test grouping to this Testing controller", () => {
    expect(pkg.contributes.menus["testing/item/context"]).toEqual([{
      submenu: "playwrightBddRunner.organizationSubmenu",
      when: "controllerId == playwrightBddRunner",
      group: "playwrightBddRunner@1",
    }]);
  });

  it("uses the same concise test-grouping labels in commands, submenu, and Quick Pick", async () => {
    const commandIds = [
      "playwrightBddRunner.setTagBasedOrganization",
      "playwrightBddRunner.setFileBasedOrganization",
      "playwrightBddRunner.setScenarioTypeOrganization",
      "playwrightBddRunner.setFlatOrganization",
      "playwrightBddRunner.setFeatureBasedOrganization",
    ];
    expect(commandIds.map((id) =>
      pkg.contributes.commands.find(({ command }) => command === id)?.title
    )).toEqual(["Tags", "File", "Scenario type", "None", "Feature"]);
    expect(pkg.contributes.commands.find(({ command }) =>
      command === "playwrightBddRunner.setOrganizationStrategy"
    )?.title).toBe("Group tests by");
    expect(pkg.contributes.submenus.find(({ id }) =>
      id === "playwrightBddRunner.organizationSubmenu"
    )?.label).toBe("Group tests by");

    const quickPick = vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.setOrganizationStrategy")!();
    expect((quickPick.mock.calls[0]?.[0] as Array<{ label: string }>).map(({ label }) => label))
      .toEqual(["Tags", "File", "Scenario type", "None", "Feature"]);
    expect(quickPick.mock.calls[0]?.[1]).toMatchObject({ placeHolder: "Group tests by" });
    quickPick.mockRestore();
  });

  it.each([
    ["setTagBasedOrganization", "TagBasedOrganization", ["@smoke", "@regression", "Untagged"]],
    ["setOrganizationStrategy", "TagBasedOrganization", ["@smoke", "@regression", "Untagged"]],
    ["setFileBasedOrganization", "FileBasedOrganization", ["a.feature", "b.feature"]],
    ["setScenarioTypeOrganization", "ScenarioTypeOrganization", ["Regular Scenarios", "Scenario Outlines"]],
    ["setFlatOrganization", "FlatOrganization", ["All Scenarios"]],
    ["setFeatureBasedOrganization", "FeatureBasedOrganization", ["a.feature", "b.feature"]],
  ])("rebuilds populated Test Explorer groups through %s", async (name, strategyType, labels) => {
    const context = makeContext();
    const parse = (source: string, filePath: string) =>
      context.featureParser.parseFeatureContent(source)!.scenarios.map((scenario) => ({ ...scenario, filePath }));
    const scenarios = [
      ...parse("Feature: A\n@smoke\nScenario: checkout\n  Given a cart\n@regression\nScenario Outline: totals\n  Given <count> items\nExamples:\n  | count |\n  | 2 |", "/ws/a.feature"),
      ...parse("Feature: B\nScenario: refund\n  Given an order", "/ws/b.feature"),
    ];
    const clearCache = vi.fn();
    const persist = vi.fn();
    const groups: string[][] = [];
    const picker = vi.spyOn(vscode.window, "showQuickPick").mockImplementation(async (choices) => (await choices)[0] as never);
    const info = vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined);
    const handlers = captureHandlers(context, (manager) => manager.setTestProvider({
      organizationManager: context.organizationManager,
      discoveryManager: { clearCache },
      persistOrganizationStrategy: persist,
      discoverTests: () => {
        groups.push(context.organizationManager.organizeTests(scenarios).map(({ label }) => label));
        return Promise.resolve();
      },
    }));
    try {
      await handlers.get(`playwrightBddRunner.${name}`)!();
      expect(context.organizationManager.getStrategy().strategyType).toBe(strategyType);
      expect(groups).toEqual([labels]);
      expect(clearCache).toHaveBeenCalledTimes(1);
      expect(persist).toHaveBeenCalledWith(strategyType);
      expect(info).toHaveBeenCalledWith(expect.stringContaining("Tests grouped by:"));
    } finally {
      picker.mockRestore();
      info.mockRestore();
    }
  });

  it("reports the current test grouping from the connected provider", async () => {
    const context = makeContext();
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const handlers = captureHandlers(context, (manager) => manager.setTestProvider({ organizationManager: context.organizationManager }));
    try {
      await handlers.get("playwrightBddRunner.debugOrganization")!();
      expect(info).toHaveBeenCalledWith(`Current test grouping: ${context.organizationManager.getStrategy().strategyType}`);
    } finally {info.mockRestore();}
  });

  it("navigates to one step definition, offers ambiguous matches, and explains missing matches", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "specwright-command-navigation-"));
    const first = path.join(directory, "checkout.steps.ts");
    const second = path.join(directory, "payment.steps.ts");
    fs.writeFileSync(first, "Given('I have a cart', async () => {});\nGiven('I pay', async () => {});\n");
    fs.writeFileSync(second, "Given('I pay', async () => {});\n");
    const document = Object.assign(fakeDoc("Feature: Checkout\nScenario: pay\n  Given I have a cart\n  Given I pay\n  Given unknown"), {
      languageId: "gherkin", fileName: "/ws/checkout.feature",
    });
    const selection = { active: new vscode.Position(2, 8) };
    const editorHost = vscode.window as unknown as { activeTextEditor: unknown };
    const openedEditor = { selection: undefined as vscode.Selection | undefined, revealRange: vi.fn() };
    const files = vi.spyOn(vscode.workspace, "findFiles").mockResolvedValue([vscode.Uri.file(first), vscode.Uri.file(second)]);
    const open = vi.spyOn(vscode.workspace, "openTextDocument").mockResolvedValue(document);
    const show = vi.spyOn(vscode.window, "showTextDocument").mockResolvedValue(openedEditor as never);
    const execute = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    const info = vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined);
    const errors = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);
    editorHost.activeTextEditor = { document, selection };
    let manager!: CommandManager;
    const command = captureHandlers(makeContext(), (value) => {manager = value;}).get("playwrightBddRunner.goToStepDefinition")!;

    try {
      await command();
      expect(open).toHaveBeenCalledWith(expect.objectContaining({ fsPath: first }));
      expect(show).toHaveBeenCalledWith(document);
      expect(errors.mock.calls).toEqual([]);
      expect(openedEditor.selection?.active.line).toBe(0);
      expect(openedEditor.revealRange).toHaveBeenCalledWith(expect.objectContaining({ start: expect.objectContaining({ line: 0 }) }), vscode.TextEditorRevealType.InCenter);

      selection.active = new vscode.Position(3, 8);
      await command();
      const picker = execute.mock.calls.find(([id]) => id === "editor.action.goToLocations");
      expect(picker?.[1]).toBe(document.uri);
      expect(picker?.[2]).toBe(selection.active);
      expect((picker?.[3] as vscode.Location[]).map(({ uri }) => uri.fsPath)).toEqual([first, second]);
      expect(picker?.slice(4)).toEqual(["goto", "No matching step definition found."]);

      selection.active = new vscode.Position(4, 8);
      await command();
      expect(info).toHaveBeenCalledWith("No matching step definition found for the step under the cursor.");
      expect(errors).not.toHaveBeenCalled();
      expect(files).toHaveBeenCalled();
    } finally {
      manager.dispose();
      editorHost.activeTextEditor = undefined;
      for (const spy of [files, open, show, execute, info, errors]) {spy.mockRestore();}
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  // The palette invokes with no arguments. A command that needs one belongs in the hidden list, so
  // every visible handler is run bare: it must reach the user (a message, a prompt, a run), never
  // fail for a missing argument and never return in silence.
  it("gives every palette-visible command an observable effect with no arguments", async () => {
    const logger = Logger.create();
    const showOutput = vi.spyOn(logger, "showOutput").mockImplementation(() => {});
    const execute = vi.fn().mockResolvedValue({
      state: "complete", results: [], output: "", passed: 0, failed: 0, durationMs: 1,
    });
    const errors = vi.spyOn(vscode.window, "showErrorMessage");
    const surfaced = [
      errors,
      vi.spyOn(vscode.window, "showInformationMessage"),
      vi.spyOn(vscode.window, "showWarningMessage"),
      vi.spyOn(vscode.window, "showQuickPick"),
      vi.spyOn(vscode.window, "showInputBox"),
    ];
    // The palette gates a few commands on an open .feature file; run the sweep in the context that
    // makes every visible command reachable.
    const editorHost = vscode.window as unknown as { activeTextEditor: unknown };
    editorHost.activeTextEditor = {
      document: fakeDoc("Feature: Palette\n\nScenario: chosen\n  Given a step\n"),
      selection: { active: { line: 2 } },
    };
    const handlers = captureHandlers(makeContext({
      logger,
      executionGateway: { execute } as never,
      testExecutor: { discoverFeatureFiles: vi.fn().mockResolvedValue([]) } as never,
    }));

    try {
      for (const command of effectiveVisibleCommands()) {
        const handler = handlers.get(command);
        expect(handler, `${command} has no registered handler`).toBeDefined();
        for (const spy of [...surfaced, execute, showOutput]) {spy.mockClear();}

        await handler!();

        const observed = [...surfaced, execute, showOutput].some((spy) => spy.mock.calls.length > 0);
        expect(observed, `${command} did nothing observable when invoked with no arguments`).toBe(true);
        expect(errors.mock.calls.map(([message]) => String(message)))
          .not.toContainEqual(expect.stringMatching(/is required/i));
      }
    } finally {
      // A failed assertion must not leak this editor into every later test in the file.
      editorHost.activeTextEditor = undefined;
    }
  });

  it("places run-and-publish on feature files and folders in the Explorer", () => {
    const explorer = pkg.contributes.menus["explorer/context"]!;
    expect(explorer.find((entry) =>
      entry.command === "playwrightBddRunner.traceability.runAndPublishFeature"
    )?.when).toContain("resourceExtname == .feature");
    expect(explorer.find((entry) =>
      entry.command === "playwrightBddRunner.traceability.runAndPublishFolder"
    )?.when).toContain("explorerResourceIsFolder");
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
    expect(stepsTitle.map((entry) => entry.group)).toEqual([
      "navigation@1",
      "playwrightBddRunner@1",
      "playwrightBddRunner@2",
    ]);
    expect(pkg.contributes.views["specwright"]?.find((view) =>
      view.id === "playwrightBddRunner.stepsExplorer"
    )?.when).toBe("config.playwrightBddRunner.enableStepsPanel");

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

  it("moves traceability node commands into the webview and hides them from the palette", () => {
    const itemContext = pkg.contributes.menus["view/item/context"]!;
    const traceabilityItems = itemContext.filter((e) => e.when?.includes("traceabilityTestKey"));
    expect(traceabilityItems).toEqual([]);

    const palette = pkg.contributes.menus["commandPalette"]!;
    for (const command of ["playwrightBddRunner.traceability.openIssue", "playwrightBddRunner.traceability.copyKey"]) {
      expect(palette.find((e) => e.command === command)?.when).toBe("false");
    }
  });

  // Each of these acts on what the caller passed: a tree node, an Explorer resource. The palette
  // passes nothing, so a bare invocation would name nothing to run and report that it ran nothing.
  // The palette's own run-and-publish route is runAndPublishByTagExpression, which prompts;
  // runAndPublishAllMapped is the traceability view's title-bar button and is hidden here too.
  it("hides every argument-taking run-and-publish command from the palette", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    for (const command of [
      "playwrightBddRunner.traceability.runAndPublish",
      "playwrightBddRunner.traceability.runAndPublishFeature",
      "playwrightBddRunner.traceability.runAndPublishFolder",
    ]) {
      expect(palette.find((e) => e.command === command)?.when).toBe("false");
    }
  });

  it("leaves clear-run-history in the palette unconditionally (the stores fill with the panel off)", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    expect(palette.find((e) => e.command === "playwrightBddRunner.traceability.clearLocalRunHistory")).toBeUndefined();
  });

  it("puts connection management in the traceability overflow menu", () => {
    const viewTitle = pkg.contributes.menus["view/title"]!;
    const plug = viewTitle.find((e) => e.command === "playwrightBddRunner.traceability.manageConnection");
    expect(plug?.when).toBe("view == playwrightBddRunner.traceability");
  });

  // Clearing run history is destructive, so it sits last in the overflow menu rather than next to a
  // button someone reaches for often.
  it("ends the traceability overflow menu with clear-run-history", () => {
    const viewTitle = pkg.contributes.menus["view/title"]!;
    const slots = viewTitle
      .filter((e) =>
        e.command?.startsWith("playwrightBddRunner.traceability.") &&
        e.group?.startsWith("playwrightBddRunner@")
      )
      .map((e) => [e.command, e.group] as const);

    expect(slots).toEqual([
      ["playwrightBddRunner.traceability.toggleGrouping", "playwrightBddRunner@1"],
      ["playwrightBddRunner.traceability.runAndPublishAllMapped", "playwrightBddRunner@2"],
      ["playwrightBddRunner.traceability.publishLastRun", "playwrightBddRunner@3"],
      ["playwrightBddRunner.traceability.manageConnection", "playwrightBddRunner@4"],
      ["playwrightBddRunner.traceability.clearLocalRunHistory", "playwrightBddRunner@5"],
    ]);
    expect(viewTitle.find((e) => e.command === "playwrightBddRunner.traceability.clearLocalRunHistory")?.when)
      .toBe("view == playwrightBddRunner.traceability");
  });

  it("keeps Coverage Board, Sync, and Find as primary traceability title actions", () => {
    const viewTitle = pkg.contributes.menus["view/title"]!;
    const slots = viewTitle
      .filter((e) =>
        e.command?.startsWith("playwrightBddRunner.traceability.") &&
        e.group?.startsWith("navigation")
      )
      .map((e) => [e.command, e.group] as const);

    expect(slots).toEqual([
      ["playwrightBddRunner.traceability.sync", "navigation@2"],
      ["playwrightBddRunner.traceability.openBoard", "navigation@1"],
      ["playwrightBddRunner.traceability.find", "navigation@3"],
    ]);
    expect(viewTitle.find((entry) => entry.command === "playwrightBddRunner.traceability.find")?.when)
      .toBe("view == playwrightBddRunner.traceability");
    expect(pkg.contributes.commands.find((entry) => entry.command === "playwrightBddRunner.traceability.find"))
      .toMatchObject({ title: "Find in Traceability", icon: "$(search)" });
  });

  it("focuses Traceability before asking the webview to focus its filter", async () => {
    const execute = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    const focusFilter = vi.fn();
    try {
      const handlers = captureHandlers(makeContext(), (manager) => {
        manager.setTraceabilitySubsystem({ focusFilter } as unknown as TraceabilitySubsystem);
      });

      await handlers.get("playwrightBddRunner.traceability.find")!();

      expect(execute.mock.calls.map(([command]) => command)).toEqual(["playwrightBddRunner.traceability.focus"]);
      expect(focusFilter).toHaveBeenCalledOnce();
    } finally {
      execute.mockRestore();
    }
  });

  it("does not request filter focus when VS Code cannot focus the webview", async () => {
    const execute = vi.spyOn(vscode.commands, "executeCommand").mockRejectedValue(new Error("focus failed"));
    const focusFilter = vi.fn();
    try {
      const handlers = captureHandlers(makeContext(), (manager) => {
        manager.setTraceabilitySubsystem({ focusFilter } as unknown as TraceabilitySubsystem);
      });

      await handlers.get("playwrightBddRunner.traceability.find")!();

      expect(focusFilter).not.toHaveBeenCalled();
    } finally {
      execute.mockRestore();
    }
  });

  // Adjacent duplicates read as one button pressed twice, so the toolbar's glyphs must all differ.
  it("paints every title-bar button with a distinct icon", () => {
    const iconOf = (command: string): string | undefined =>
      pkg.contributes.commands.find((c) => c.command === command)?.icon;
    const icons = pkg.contributes.menus["view/title"]!
      .filter((e) => e.command?.startsWith("playwrightBddRunner.traceability."))
      .map((e) => iconOf(e.command!));

    expect(icons).toEqual(["$(list-tree)", "$(sync)", "$(play-circle)", "$(cloud-upload)", "$(plug)", "$(clear-all)", "$(project)", "$(search)"]);
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

  it("keeps switch-default-project out of native item menus", () => {
    const entries = pkg.contributes.menus["view/item/context"]!.filter(
      (e) =>
        e.command === "playwrightBddRunner.traceability.switchDefaultProject" &&
        e.when === "view == playwrightBddRunner.traceability && viewItem == traceabilityConnection"
    );

    expect(entries).toEqual([]);
  });
});
