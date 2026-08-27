import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import * as vscode from "vscode";
import { CommandManager } from "../../commands/command-manager";
import { XrayCredentialStore } from "../../xray/xray-credential-store";
import { JiraAccessError, searchJiraProjects } from "../../xray/jira-project-search";
import { captureHandlers, makeContext, memento } from "./helpers/command-manager-harness";
import { NO_PROJECT_SCOPE, projectScopeStore, type ProjectScopeStore } from "../../traceability/project-scope";
import type { TraceabilitySubsystem } from "../../traceability/traceability-subsystem";

vi.mock("../../xray/jira-project-search", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../xray/jira-project-search")>();
  return { ...actual, searchJiraProjects: vi.fn() };
});

interface Pkg {
  contributes: {
    commands: Array<{ command: string; category?: string; icon?: string }>;
    menus: Record<string, Array<{ command?: string; when?: string; group?: string }>>;
  };
}

const pkg = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf-8")
) as Pkg;

interface Update {
  key: string;
  value: unknown;
  target: vscode.ConfigurationTarget;
}

// One stub serves the config reads (ExtensionConfig captures the configuration at construction) and the
// write-back capture, so it must be installed before the manager is built.
function stubConfig(values: Record<string, unknown>, inspected: Record<string, unknown> = {}): Update[] {
  const updates: Update[] = [];
  const wsConfig = {
    get: (key: string, dflt?: unknown): unknown => (key in values ? values[key] : dflt),
    inspect: (): Record<string, unknown> => inspected,
    update: (key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void> => {
      updates.push({ key, value, target });
      return Promise.resolve();
    },
  } as unknown as vscode.WorkspaceConfiguration;
  vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(wsConfig);
  return updates;
}

describe("traceability grouping toggle contributions", () => {
  const CMD = "playwrightBddRunner.traceability.toggleGrouping";

  it("declares the toggle command under Specwright with the list-tree icon", () => {
    const command = pkg.contributes.commands.find((c) => c.command === CMD);
    expect(command?.category).toBe("Specwright");
    expect(command?.icon).toBe("$(list-tree)");
  });

  it("keeps the connected-only toggle in the title-bar overflow menu", () => {
    const button = pkg.contributes.menus["view/title"]!.find((e) => e.command === CMD);
    expect(button?.when).toBe(
      "view == playwrightBddRunner.traceability && playwrightBddRunner.traceability.connected"
    );
    expect(button?.group).toBe("playwrightBddRunner@1");
    const sync = pkg.contributes.menus["view/title"]!.find(
      (e) => e.command === "playwrightBddRunner.traceability.sync"
    );
    expect(sync?.group).toBe("navigation@2");
  });

  it("gates the palette entry on the traceability panel being enabled", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    expect(palette.find((e) => e.command === CMD)?.when).toBe(
      "playwrightBddRunner.traceability.enabled"
    );
  });
});

describe("toggleGrouping command handler", () => {
  const CMD = "playwrightBddRunner.traceability.toggleGrouping";

  afterEach(() => vi.restoreAllMocks());

  function toggleWith(subsystem: TraceabilitySubsystem | undefined) {
    let toggled = 0;
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const manager = CommandManager.create(makeContext());
    if (subsystem) {
      manager.setTraceabilitySubsystem({
        ...subsystem,
        toggleGrouping: () => {toggled += 1;},
      } as unknown as TraceabilitySubsystem);
    }
    const commands = (manager as unknown as {
      traceabilityCommands: { toggleGrouping: () => void };
    }).traceabilityCommands;
    commands.toggleGrouping();
    return { info, toggled: () => toggled };
  }

  it("is registered under the traceability commands", () => {
    expect(captureHandlers(makeContext()).has(CMD)).toBe(true);
  });

  it("asks for the panel when no subsystem exists", () => {
    const { info, toggled } = toggleWith(undefined);
    expect(toggled()).toBe(0);
    expect(info).toHaveBeenCalledWith("Enable the Traceability panel to change how it groups.");
  });

  it("asks for the panel when the subsystem is wired but its panel is off", () => {
    const { info, toggled } = toggleWith({ traceabilityPanelActive: false } as TraceabilitySubsystem);
    expect(toggled()).toBe(0);
    expect(info).toHaveBeenCalledWith("Enable the Traceability panel to change how it groups.");
  });

  it("toggles when the panel is active", () => {
    const { info, toggled } = toggleWith({ traceabilityPanelActive: true } as TraceabilitySubsystem);
    expect(toggled()).toBe(1);
    expect(info).not.toHaveBeenCalled();
  });
});

describe("traceability switch-default-project contributions", () => {
  const CMD = "playwrightBddRunner.traceability.switchDefaultProject";

  it("declares the command under Specwright", () => {
    expect(pkg.contributes.commands.find((c) => c.command === CMD)?.category).toBe("Specwright");
  });

  it("gates the palette entry on the traceability panel being enabled", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    expect(palette.find((e) => e.command === CMD)?.when).toBe(
      "playwrightBddRunner.traceability.enabled"
    );
  });

  it("keeps the command out of native item menus", () => {
    const items = pkg.contributes.menus["view/item/context"]!.filter((e) => e.command === CMD);
    expect(items).toEqual([]);
  });
});

describe("switchDefaultProject command handler", () => {
  afterEach(() => vi.restoreAllMocks());

  it("writes the uppercased key to Global via the input box when no Jira credentials exist", async () => {
    const updates = stubConfig({}, {});
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("calc");
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.switchDefaultProject")!();
    expect(updates).toEqual([
      { key: "xray.defaultProjectKey", value: "CALC", target: vscode.ConfigurationTarget.Global },
    ]);
  });

  it("writes the key back to the Workspace when the setting is pinned there", async () => {
    const updates = stubConfig({}, { workspaceValue: "OLD" });
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("new");
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.switchDefaultProject")!();
    expect(updates[0]).toEqual({
      key: "xray.defaultProjectKey",
      value: "NEW",
      target: vscode.ConfigurationTarget.Workspace,
    });
  });

  it("writes nothing when the input box is cancelled", async () => {
    const updates = stubConfig({}, {});
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue(undefined);
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.switchDefaultProject")!();
    expect(updates).toEqual([]);
  });
});

describe("switchDefaultProject: Jira project QuickPick branch", () => {
  const CMD = "playwrightBddRunner.traceability.switchDefaultProject";
  const mockSearch = vi.mocked(searchJiraProjects);

  interface DriveablePick {
    title: string;
    placeholder: string;
    items: ReadonlyArray<unknown>;
    activeItems: ReadonlyArray<unknown>;
    selectedItems: ReadonlyArray<unknown>;
    __accept: (selection?: ReadonlyArray<unknown>) => void;
    __hide: () => void;
  }

  const win = vscode.window as unknown as {
    __quickPicks: DriveablePick[];
    __resetQuickPicks: () => void;
  };

  function withJira(): Map<string, (...a: unknown[]) => Promise<void>> {
    const store = {
      getJiraCredentials: () => Promise.resolve({ email: "e@x", token: "t" }),
    } as unknown as XrayCredentialStore;
    const handlers = new Map<string, (...a: unknown[]) => Promise<void>>();
    const commandsApi = vscode.commands as unknown as { registerCommand: unknown };
    const original = commandsApi.registerCommand;
    commandsApi.registerCommand = (cmd: string, cb: (...a: unknown[]) => Promise<void>): { dispose: () => void } => {
      handlers.set(cmd, cb);
      return { dispose: () => {} };
    };
    try {
      const mgr = CommandManager.create(makeContext());
      mgr.setCredentialStore(store);
      mgr.registerCommands({ subscriptions: [] } as unknown as vscode.ExtensionContext);
    } finally {
      commandsApi.registerCommand = original;
    }
    return handlers;
  }

  const SITE = { "xray.siteUrl": "acme.atlassian.net", "xray.defaultProjectKey": "CALC" };

  afterEach(() => {
    vi.restoreAllMocks();
    mockSearch.mockReset();
    win.__resetQuickPicks();
  });

  it("preselects the current default and writes the uppercased picked key", async () => {
    const updates = stubConfig(SITE);
    mockSearch.mockResolvedValue({
      projects: [{ key: "CALC", name: "Calc" }, { key: "pay", name: "Pay" }],
      truncated: false,
    });
    const handlers = withJira();

    const pending = handlers.get(CMD)!();
    await vi.waitFor(() => expect(win.__quickPicks.length).toBeGreaterThan(0));
    const picker = win.__quickPicks.at(-1)!;
    expect((picker.activeItems[0] as { key: string }).key).toBe("CALC");
    picker.__accept([picker.items.find((i) => (i as { key: string }).key === "pay")!]);
    await pending;

    expect(updates).toEqual([
      { key: "xray.defaultProjectKey", value: "PAY", target: vscode.ConfigurationTarget.Global },
    ]);
  });

  it("writes nothing when the QuickPick is dismissed", async () => {
    const updates = stubConfig(SITE);
    mockSearch.mockResolvedValue({ projects: [{ key: "CALC", name: "Calc" }], truncated: false });
    const handlers = withJira();

    const pending = handlers.get(CMD)!();
    await vi.waitFor(() => expect(win.__quickPicks.length).toBeGreaterThan(0));
    win.__quickPicks.at(-1)!.__hide();
    await pending;

    expect(updates).toEqual([]);
  });

  it("degrades to the manual input box when Jira access fails", async () => {
    const updates = stubConfig(SITE);
    mockSearch.mockRejectedValue(new JiraAccessError("forbidden"));
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const input = vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("pay");
    const handlers = withJira();

    await handlers.get(CMD)!();

    expect(warn).toHaveBeenCalledOnce();
    expect(input).toHaveBeenCalledOnce();
    expect(win.__quickPicks).toHaveLength(0);
    expect(updates).toEqual([
      { key: "xray.defaultProjectKey", value: "PAY", target: vscode.ConfigurationTarget.Global },
    ]);
  });

  it("falls back to the input box when the project list is empty", async () => {
    const updates = stubConfig(SITE);
    mockSearch.mockResolvedValue({ projects: [], truncated: false });
    const input = vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("pay");
    const handlers = withJira();

    await handlers.get(CMD)!();

    expect(input).toHaveBeenCalledOnce();
    expect(win.__quickPicks).toHaveLength(0);
    expect(updates).toEqual([
      { key: "xray.defaultProjectKey", value: "PAY", target: vscode.ConfigurationTarget.Global },
    ]);
  });
});

describe("traceability select-sync-projects contributions", () => {
  const CMD = "playwrightBddRunner.traceability.selectSyncProjects";

  it("declares the command under Specwright with the checklist icon", () => {
    const command = pkg.contributes.commands.find((c) => c.command === CMD);
    expect(command?.category).toBe("Specwright");
    expect(command?.icon).toBe("$(checklist)");
  });

  it("gates the palette entry on the traceability panel being enabled", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    expect(palette.find((e) => e.command === CMD)?.when).toBe(
      "playwrightBddRunner.traceability.enabled"
    );
  });

  it("keeps the command out of native item menus", () => {
    expect(pkg.contributes.menus["view/item/context"]!.filter((e) => e.command === CMD)).toEqual([]);
  });
});

describe("selectSyncProjects command handler", () => {
  const CMD = "playwrightBddRunner.traceability.selectSyncProjects";

  interface PickItem {
    label: string;
    description: string;
    picked: boolean;
  }

  const directoryOf = (keys: readonly string[]): unknown => ({
    projects: keys.map((key) => ({ key, name: key })),
    truncated: false,
  });

  // Only what the picker reads: the ladder rungs and the grammar that says the provider has projects.
  // The directory cache starts cold, as it is before any surface has enumerated the site, so a test that
  // sees a directory project saw it come off the live list.
  function subsystemWith(ladder: {
    tagDerived?: string[];
    catalogue?: string[];
    directory?: string[];
    cachedDirectory?: string[];
    directoryFails?: boolean;
    scope?: ProjectScopeStore;
  }): TraceabilitySubsystem {
    return {
      traceabilityPanelActive: true,
      getActiveAdapter: () => ({
        label: "Xray",
        keyGrammar: { testPrefix: "TEST_", projectOf: (key: string) => key.split("-")[0] },
        metadata: { snapshot: () => ({ catalogueProjects: ladder.catalogue ?? [] }) },
        projectDirectory: {
          cached: () => directoryOf(ladder.cachedDirectory ?? []),
          list: () =>
            (ladder.directoryFails
              ? Promise.reject(new Error("the site is unreachable"))
              : Promise.resolve(directoryOf(ladder.directory ?? []))),
        },
      }),
      tagDerivedProjectKeys: () => ladder.tagDerived ?? [],
      projectScope: () => ladder.scope ?? NO_PROJECT_SCOPE,
    } as unknown as TraceabilitySubsystem;
  }

  function pickerItems(calls: ReadonlyArray<ReadonlyArray<unknown>>): PickItem[] {
    return (calls[0]?.[0] ?? []) as PickItem[];
  }

  const workspace = vscode.workspace as { workspaceFolders: unknown };

  beforeEach(() => {
    workspace.workspaceFolders = [{ uri: vscode.Uri.file("/ws") }];
  });

  afterEach(() => {
    workspace.workspaceFolders = undefined;
    vi.restoreAllMocks();
  });

  // The site rung comes off a live enumeration, so a workspace that has never opened the board still
  // sees every project it could pin.
  it("offers every known project, says where each came from, and checks the ones in scope today", async () => {
    stubConfig({ "xray.defaultProjectKey": "PAY" });
    const quickPick = vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    const handlers = captureHandlers(makeContext(), (manager) =>
      manager.setTraceabilitySubsystem(
        subsystemWith({ tagDerived: ["CALC"], catalogue: ["MATH"], directory: ["OPS"] })
      )
    );

    await handlers.get(CMD)!();

    expect(pickerItems(quickPick.mock.calls)).toEqual([
      { label: "CALC", description: "referenced by workspace tags", picked: true },
      { label: "MATH", description: "synced earlier", picked: true },
      { label: "OPS", description: "from site directory", picked: false },
      { label: "PAY", description: "default project", picked: true },
    ]);
    expect(quickPick.mock.calls[0]?.[1]).toMatchObject({
      canPickMany: true,
      ignoreFocusOut: true,
      title: "Select Projects to Sync",
    });
  });

  // The board's working project is not a rung of the standing scope, so the project the board is showing
  // is offered by whatever rung actually names it and is checked only if that rung is in scope. A
  // site-only project the board happens to be working in stays unchecked until the user pins it here.
  it("neither checks nor relabels a project just because the board is working in it", async () => {
    stubConfig({});
    const quickPick = vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    const scope = projectScopeStore(memento(), () => undefined);
    scope.set("OPS");
    const handlers = captureHandlers(makeContext(), (manager) =>
      manager.setTraceabilitySubsystem(subsystemWith({ tagDerived: ["CALC"], directory: ["OPS"], scope }))
    );

    await handlers.get(CMD)!();

    expect(pickerItems(quickPick.mock.calls)).toEqual([
      { label: "CALC", description: "referenced by workspace tags", picked: true },
      { label: "OPS", description: "from site directory", picked: false },
    ]);
  });

  it("still opens on the last known projects when the site cannot be enumerated", async () => {
    stubConfig({ "xray.defaultProjectKey": "PAY" });
    const quickPick = vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    const handlers = captureHandlers(makeContext(), (manager) =>
      manager.setTraceabilitySubsystem(
        subsystemWith({ cachedDirectory: ["OPS"], directoryFails: true })
      )
    );

    await handlers.get(CMD)!();

    expect(pickerItems(quickPick.mock.calls).map((item) => item.label)).toEqual(["OPS", "PAY"]);
  });

  it("writes exactly the checked set when the user accepts the picker unchanged", async () => {
    const updates = stubConfig({ "xray.defaultProjectKey": "PAY" });
    const quickPick = vi.spyOn(vscode.window, "showQuickPick").mockImplementation(
      ((items: PickItem[]) => Promise.resolve(items.filter((item) => item.picked))) as never
    );
    const handlers = captureHandlers(makeContext(), (manager) =>
      manager.setTraceabilitySubsystem(
        subsystemWith({ tagDerived: ["CALC"], catalogue: ["MATH"], directory: ["OPS"] })
      )
    );

    await handlers.get(CMD)!();

    const checked = pickerItems(quickPick.mock.calls).filter((item) => item.picked).map((item) => item.label);
    expect(checked).toEqual(["CALC", "MATH", "PAY"]);
    expect(updates).toEqual([
      { key: "xray.syncProjectKeys", value: checked, target: vscode.ConfigurationTarget.Workspace },
    ]);
  });

  it("checks only the setting's projects once it names the scope", async () => {
    stubConfig({ "xray.defaultProjectKey": "PAY", "xray.syncProjectKeys": ["math"] });
    const quickPick = vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    const handlers = captureHandlers(makeContext(), (manager) =>
      manager.setTraceabilitySubsystem(subsystemWith({ tagDerived: ["CALC"], catalogue: ["MATH"] }))
    );

    await handlers.get(CMD)!();

    expect(pickerItems(quickPick.mock.calls).filter((item) => item.picked).map((item) => item.label)).toEqual(["MATH"]);
  });

  // The scope belongs to the repo, so it lands in the workspace even when nothing is pinned there yet:
  // a list chosen for one checkout must not follow the user into the next one.
  it("writes the checked projects to the workspace rather than the user's settings", async () => {
    const updates = stubConfig({ "xray.defaultProjectKey": "PAY" });
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue([
      { label: "CALC", description: "referenced by workspace tags", picked: true },
      { label: "OPS", description: "from site directory", picked: false },
    ] as never);
    const handlers = captureHandlers(makeContext(), (manager) =>
      manager.setTraceabilitySubsystem(subsystemWith({ tagDerived: ["CALC"], directory: ["OPS"] }))
    );

    await handlers.get(CMD)!();

    expect(updates).toEqual([
      {
        key: "xray.syncProjectKeys",
        value: ["CALC", "OPS"],
        target: vscode.ConfigurationTarget.Workspace,
      },
    ]);
  });

  it("writes an empty list when every box is cleared, which restores the derived scope", async () => {
    const updates = stubConfig({ "xray.defaultProjectKey": "PAY", "xray.syncProjectKeys": ["PAY"] });
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue([] as never);
    const handlers = captureHandlers(makeContext(), (manager) =>
      manager.setTraceabilitySubsystem(subsystemWith({}))
    );

    await handlers.get(CMD)!();

    expect(updates).toEqual([
      { key: "xray.syncProjectKeys", value: [], target: vscode.ConfigurationTarget.Workspace },
    ]);
  });

  it("falls back to the user's settings when no folder is open to hold the list", async () => {
    workspace.workspaceFolders = undefined;
    const updates = stubConfig({ "xray.defaultProjectKey": "PAY" });
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue([
      { label: "PAY", description: "default project", picked: true },
    ] as never);
    const handlers = captureHandlers(makeContext(), (manager) =>
      manager.setTraceabilitySubsystem(subsystemWith({}))
    );

    await handlers.get(CMD)!();

    expect(updates).toEqual([
      { key: "xray.syncProjectKeys", value: ["PAY"], target: vscode.ConfigurationTarget.Global },
    ]);
  });

  it("writes nothing when the picker is dismissed", async () => {
    const updates = stubConfig({ "xray.defaultProjectKey": "PAY" });
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValue(undefined);
    const handlers = captureHandlers(makeContext(), (manager) =>
      manager.setTraceabilitySubsystem(subsystemWith({ tagDerived: ["CALC"] }))
    );

    await handlers.get(CMD)!();

    expect(updates).toEqual([]);
  });

  it("names the way out instead of opening an empty picker", async () => {
    const updates = stubConfig({});
    const quickPick = vi.spyOn(vscode.window, "showQuickPick");
    const info = vi.spyOn(vscode.window, "showInformationMessage");
    const handlers = captureHandlers(makeContext());

    await handlers.get(CMD)!();

    expect(quickPick).not.toHaveBeenCalled();
    expect(updates).toEqual([]);
    expect(String(info.mock.calls[0]?.[0])).toContain("No projects to choose from yet");
  });
});
