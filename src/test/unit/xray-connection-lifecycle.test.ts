import { describe, it, expect, vi, afterEach } from "vitest";
import * as vscode from "vscode";

import * as xray from "./helpers/xray-setup-driver";

const { stubWorkspaceConfig, makeCommands } = xray;

afterEach(() => {
  xray.resetSetupDriver();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("XrayConnectionCommands.disconnect", () => {
  it("reports when nothing is stored and never shows the confirm dialog", async () => {
    stubWorkspaceConfig({}, { "xray.siteUrl": "acme.atlassian.net" });
    const { commands } = makeCommands("acme.atlassian.net");
    const info = vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined);
    const warn = vi.spyOn(vscode.window, "showWarningMessage");

    await commands.disconnect();

    expect(info).toHaveBeenCalledWith("No Xray credentials are stored for this site.");
    expect(warn).not.toHaveBeenCalled();
  });

  it("clears credentials only after the modal confirm", async () => {
    stubWorkspaceConfig({}, { "xray.siteUrl": "acme.atlassian.net" });
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

  it("acts on the freshly-configured host, not the stale ExtensionConfig snapshot", async () => {
    stubWorkspaceConfig({}, { "xray.siteUrl": "new.atlassian.net" });
    const { commands, store } = makeCommands("old.atlassian.net");
    await store.setCredentials("old.atlassian.net", "old-id", "old-secret");
    await store.setCredentials("new.atlassian.net", "new-id", "new-secret");
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue(undefined);
    const warn = vi
      .spyOn(vscode.window, "showWarningMessage")
      .mockResolvedValue("Disconnect" as never);

    await commands.disconnect();

    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("new.atlassian.net"),
      { modal: true },
      "Disconnect"
    );
    expect(await store.getCredentials("new.atlassian.net")).toBeUndefined();
    expect(await store.getCredentials("old.atlassian.net")).toEqual({
      clientId: "old-id",
      clientSecret: "old-secret",
    });
  });
});

describe("XrayConnectionCommands.manageConnection", () => {
  async function pickedItems(site: string, seed: boolean): Promise<string[]> {
    stubWorkspaceConfig({}, { "xray.siteUrl": site });
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

  it("reads the freshly-configured host, not the stale ExtensionConfig snapshot", async () => {
    stubWorkspaceConfig({}, { "xray.siteUrl": "new.atlassian.net" });
    const { commands, store } = makeCommands("old.atlassian.net");
    await store.setCredentials("new.atlassian.net", "id", "secret");
    let labels: string[] = [];
    let placeHolder = "";
    vi.spyOn(vscode.window, "showQuickPick").mockImplementation((items, options) => {
      labels = (items as vscode.QuickPickItem[]).map((item) => item.label);
      placeHolder = (options as vscode.QuickPickOptions | undefined)?.placeHolder ?? "";
      return Promise.resolve(undefined);
    });

    await commands.manageConnection();

    expect(placeHolder).toBe("Connected to new.atlassian.net");
    expect(labels).toContain("$(sign-out) Disconnect");
  });
});
