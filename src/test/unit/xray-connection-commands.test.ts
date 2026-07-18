import { describe, it, expect, vi, afterEach } from "vitest";
import * as vscode from "vscode";
import { ExtensionConfig } from "../../core/extension-config";
import { Logger, LogLevel } from "../../utils/logger";
import { XrayConnectionCommands } from "../../xray/xray-connection-commands";
import { XrayCredentialStore } from "../../xray/xray-credential-store";

function configWith(values: Record<string, unknown>): ExtensionConfig {
  const workspaceConfig = {
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      key in values ? (values[key] as T) : defaultValue,
    update: (): Promise<void> => Promise.resolve(),
    inspect: (key: string): { key: string } => ({ key }),
  } as unknown as vscode.WorkspaceConfiguration;
  return ExtensionConfig.create(workspaceConfig, false);
}

function mapCredentialStore(): { store: XrayCredentialStore; map: Map<string, string> } {
  const map = new Map<string, string>();
  const storage = {
    get: (key: string): Promise<string | undefined> => Promise.resolve(map.get(key)),
    store: (key: string, value: string): Promise<void> => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string): Promise<void> => {
      map.delete(key);
      return Promise.resolve();
    },
  } as unknown as vscode.SecretStorage;
  return { store: new XrayCredentialStore(storage), map };
}

function silentLogger(): Logger {
  const channel = {
    name: "test",
    append: () => { /* no-op */ },
    appendLine: () => { /* no-op */ },
    replace: () => { /* no-op */ },
    clear: () => { /* no-op */ },
    show: () => { /* no-op */ },
    hide: () => { /* no-op */ },
    dispose: () => { /* no-op */ },
  } as unknown as vscode.OutputChannel;
  return Logger.create(channel, LogLevel.ERROR);
}

interface WsConfigStub {
  wsConfig: vscode.WorkspaceConfiguration;
  updates: Array<{ key: string; value: unknown; target: vscode.ConfigurationTarget }>;
}

function stubWorkspaceConfig(inspected: Record<string, unknown> = {}): WsConfigStub {
  const updates: WsConfigStub["updates"] = [];
  const wsConfig = {
    get: (): unknown => undefined,
    inspect: (): Record<string, unknown> => inspected,
    update: (key: string, value: unknown, target: vscode.ConfigurationTarget): Promise<void> => {
      updates.push({ key, value, target });
      return Promise.resolve();
    },
  } as unknown as vscode.WorkspaceConfiguration;
  vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue(wsConfig);
  return { wsConfig, updates };
}

function makeCommands(site: string): {
  commands: XrayConnectionCommands;
  store: XrayCredentialStore;
  map: Map<string, string>;
} {
  const { store, map } = mapCredentialStore();
  return {
    commands: new XrayConnectionCommands(configWith({ "xray.siteUrl": site }), store, silentLogger()),
    store,
    map,
  };
}

type InputStep = { options: vscode.InputBoxOptions; value: string | undefined };

function scriptInputBoxes(values: Array<string | undefined>): InputStep[] {
  const steps: InputStep[] = [];
  let call = 0;
  vi.spyOn(vscode.window, "showInputBox").mockImplementation((options?: vscode.InputBoxOptions) => {
    const value = values[call];
    call += 1;
    steps.push({ options: options ?? {}, value });
    return Promise.resolve(value);
  });
  return steps;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("XrayConnectionCommands.connect", () => {
  it("site validation rejects input that normalizes to an empty or non-bare host", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("");
    const steps = scriptInputBoxes([undefined]);
    await commands.connect();

    const validate = steps[0]?.options.validateInput;
    expect(validate).toBeDefined();
    expect(validate!("https://")).toBeTruthy();
    expect(validate!("   ")).toBeTruthy();
    expect(validate!("acme.atlassian.net/jira")).toBeTruthy();
    expect(validate!("acme.atlassian.net:8080")).toBeTruthy();
    expect(validate!("acme.atlassian.net")).toBeUndefined();
    expect(validate!("https://acme.atlassian.net/")).toBeUndefined();
  });

  it("cancelling any step stores nothing and writes no settings", async () => {
    const { updates } = stubWorkspaceConfig();
    const { commands, map } = makeCommands("acme.atlassian.net");
    scriptInputBoxes(["acme.atlassian.net", "client-id", undefined]);
    await commands.connect();
    expect(map.size).toBe(0);
    expect(updates).toEqual([]);
  });

  it("stores trimmed credentials and skips the settings write when the site is unchanged", async () => {
    const { updates } = stubWorkspaceConfig();
    const { commands, map } = makeCommands("acme.atlassian.net");
    scriptInputBoxes(["acme.atlassian.net", "  id  ", "  secret  "]);
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined);

    await commands.connect();

    expect(updates).toEqual([]);
    expect(map.get("specwright.xray:acme.atlassian.net:clientId")).toBe("id");
    expect(map.get("specwright.xray:acme.atlassian.net:clientSecret")).toBe("secret");
  });

  it("writes a changed site to Global when the setting is not workspace-pinned", async () => {
    const { updates } = stubWorkspaceConfig({});
    const { commands } = makeCommands("old.atlassian.net");
    scriptInputBoxes(["new.atlassian.net", "id", "secret"]);
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined);

    await commands.connect();

    expect(updates).toEqual([
      { key: "xray.siteUrl", value: "new.atlassian.net", target: vscode.ConfigurationTarget.Global },
    ]);
  });

  it("writes a changed site back to the Workspace when pinned there", async () => {
    const { updates } = stubWorkspaceConfig({ workspaceValue: "old.atlassian.net" });
    const { commands } = makeCommands("old.atlassian.net");
    scriptInputBoxes(["new.atlassian.net", "id", "secret"]);
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined);

    await commands.connect();

    expect(updates[0]?.target).toBe(vscode.ConfigurationTarget.Workspace);
  });

  it("clears the previous site's credentials when switching hosts", async () => {
    stubWorkspaceConfig();
    const { commands, store, map } = makeCommands("old.atlassian.net");
    await store.setCredentials("old.atlassian.net", "old-id", "old-secret");
    scriptInputBoxes(["new.atlassian.net", "new-id", "new-secret"]);
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined);

    await commands.connect();

    expect(await store.getCredentials("old.atlassian.net")).toBeUndefined();
    expect(await store.getCredentials("new.atlassian.net")).toEqual({
      clientId: "new-id",
      clientSecret: "new-secret",
    });
    expect([...map.keys()].every((key) => key.includes(":new.atlassian.net:"))).toBe(true);
  });
});

describe("XrayConnectionCommands.disconnect", () => {
  it("reports when nothing is stored and never shows the confirm dialog", async () => {
    stubWorkspaceConfig();
    const { commands } = makeCommands("acme.atlassian.net");
    const info = vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined);
    const warn = vi.spyOn(vscode.window, "showWarningMessage");

    await commands.disconnect();

    expect(info).toHaveBeenCalledWith("No Xray credentials are stored for this site.");
    expect(warn).not.toHaveBeenCalled();
  });

  it("clears credentials only after the modal confirm", async () => {
    stubWorkspaceConfig();
    const { commands, store, map } = makeCommands("acme.atlassian.net");
    await store.setCredentials("acme.atlassian.net", "id", "secret");
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined);
    const warn = vi
      .spyOn(vscode.window, "showWarningMessage")
      .mockResolvedValue(undefined as never);

    await commands.disconnect();
    expect(map.size).toBe(2);

    warn.mockResolvedValue("Disconnect" as never);
    await commands.disconnect();
    expect(map.size).toBe(0);
  });
});

describe("XrayConnectionCommands.manageConnection", () => {
  async function pickedItems(site: string, seed: boolean): Promise<string[]> {
    stubWorkspaceConfig();
    const { commands, store } = makeCommands(site);
    if (seed) {
      await store.setCredentials(site, "id", "secret");
    }
    let captured: vscode.QuickPickItem[] = [];
    vi.spyOn(vscode.window, "showQuickPick").mockImplementation((items) => {
      captured = items as vscode.QuickPickItem[];
      return Promise.resolve(undefined);
    });
    await commands.manageConnection();
    return captured.map((item) => item.label);
  }

  it("offers the connected action set when credentials exist", async () => {
    const labels = await pickedItems("acme.atlassian.net", true);
    expect(labels).toEqual([
      "$(key) Update Credentials…",
      "$(plug) Test Connection",
      "$(sign-out) Disconnect",
      "$(settings-gear) Open Settings",
    ]);
  });

  it("offers only connect/settings when no credentials exist", async () => {
    const labels = await pickedItems("acme.atlassian.net", false);
    expect(labels).toEqual(["$(plug) Connect to Xray…", "$(settings-gear) Open Settings"]);
  });
});
