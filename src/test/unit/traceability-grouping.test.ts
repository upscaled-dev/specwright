import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, vi, afterEach } from "vitest";
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
import { XrayAdapter } from "../../xray/xray-adapter";
import { XrayCredentialStore } from "../../xray/xray-credential-store";
import { JiraAccessError, searchJiraProjects } from "../../xray/jira-project-search";

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

function makeContext(): PlaywrightBddExtensionContext {
  const logger = Logger.create();
  const config = ExtensionConfig.create();
  return {
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

describe("traceability grouping toggle contributions", () => {
  const CMD = "playwrightBddRunner.traceability.toggleGrouping";

  it("declares the toggle command under Specwright with the list-tree icon", () => {
    const command = pkg.contributes.commands.find((c) => c.command === CMD);
    expect(command?.category).toBe("Specwright");
    expect(command?.icon).toBe("$(list-tree)");
  });

  it("slots the toggle leftmost in the title bar, before sync, gated on connected", () => {
    const button = pkg.contributes.menus["view/title"]!.find((e) => e.command === CMD);
    expect(button?.when).toBe(
      "view == playwrightBddRunner.traceability && playwrightBddRunner.traceability.connected"
    );
    // navigation@-1 sorts ahead of sync's navigation@0 without renumbering the existing entries.
    expect(button?.group).toBe("navigation@-1");
    const sync = pkg.contributes.menus["view/title"]!.find(
      (e) => e.command === "playwrightBddRunner.traceability.sync"
    );
    expect(sync?.group).toBe("navigation@0");
  });

  it("gates the palette entry on the traceability panel being enabled", () => {
    const palette = pkg.contributes.menus["commandPalette"]!;
    expect(palette.find((e) => e.command === CMD)?.when).toBe(
      "config.playwrightBddRunner.traceability.enablePanel"
    );
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
      "config.playwrightBddRunner.traceability.enablePanel"
    );
  });

  // Twice on the same row: once inline, where the swap icon sits on hover, and once in the context menu,
  // which never renders the inline group.
  it("offers the command on the connection row, inline and in its context menu", () => {
    const items = pkg.contributes.menus["view/item/context"]!.filter((e) => e.command === CMD);
    const when = "view == playwrightBddRunner.traceability && viewItem == traceabilityConnection";
    expect(items.map((e) => [e.when, e.group])).toEqual([
      [when, undefined],
      [when, "inline@1"],
    ]);
  });
});

describe("switchDefaultProject command handler", () => {
  interface Update {
    key: string;
    value: unknown;
    target: vscode.ConfigurationTarget;
  }

  function stubWorkspaceConfig(inspected: Record<string, unknown>): Update[] {
    const updates: Update[] = [];
    const wsConfig = {
      get: (_key: string, dflt?: unknown): unknown => dflt,
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

  it("writes the uppercased key to Global via the input box when no Jira credentials exist", async () => {
    const updates = stubWorkspaceConfig({});
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("calc");
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.switchDefaultProject")!();
    expect(updates).toEqual([
      { key: "xray.defaultProjectKey", value: "CALC", target: vscode.ConfigurationTarget.Global },
    ]);
  });

  it("writes the key back to the Workspace when the setting is pinned there", async () => {
    const updates = stubWorkspaceConfig({ workspaceValue: "OLD" });
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
    const updates = stubWorkspaceConfig({});
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue(undefined);
    const handlers = captureHandlers(makeContext());
    await handlers.get("playwrightBddRunner.traceability.switchDefaultProject")!();
    expect(updates).toEqual([]);
  });
});

describe("switchDefaultProject: Jira project QuickPick branch", () => {
  const CMD = "playwrightBddRunner.traceability.switchDefaultProject";
  const mockSearch = vi.mocked(searchJiraProjects);

  interface Update {
    key: string;
    value: unknown;
    target: vscode.ConfigurationTarget;
  }

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

  // One stub serves both the config reads (site + current default, captured by ExtensionConfig at
  // construction) and the write-back capture, so it must be installed before the manager is built.
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
