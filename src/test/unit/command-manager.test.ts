import * as fs from "node:fs";
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
      manager.dispose();
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
    expect(plug?.group).toBe("playwrightBddRunner@4");
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

    expect(icons).toEqual(["$(list-tree)", "$(sync)", "$(play-circle)", "$(cloud-upload)", "$(plug)", "$(project)", "$(search)"]);
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
