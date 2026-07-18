import * as vscode from "vscode";
import { ExtensionConfig } from "../core/extension-config";
import { Logger } from "../utils/logger";
import { normalizeSiteUrl } from "./xray-adapter";
import { XrayCredentialStore } from "./xray-credential-store";
import { runXrayConnectionTest } from "./xray-connection-test";

const CONFIG_NAMESPACE = "playwrightBddRunner";
const SITE_URL_SETTING = "xray.siteUrl";
const SETTINGS_QUERY = "playwrightBddRunner.traceability";

const COMMAND = {
  connect: "playwrightBddRunner.traceability.connect",
  disconnect: "playwrightBddRunner.traceability.disconnect",
  testConnection: "playwrightBddRunner.traceability.testConnection",
} as const;

// The setting may be pinned in the workspace; write the edited value back to wherever it is
// already defined so we don't silently promote a workspace value to Global. An unscoped
// WorkspaceConfiguration can neither see nor write folder-level values (inspect() without a
// resource never surfaces workspaceFolderValue), so Workspace and Global are the only targets.
function siteUrlTarget(wsConfig: vscode.WorkspaceConfiguration): vscode.ConfigurationTarget {
  const inspected = wsConfig.inspect<string>(SITE_URL_SETTING);
  if (inspected?.workspaceValue !== undefined) {
    return vscode.ConfigurationTarget.Workspace;
  }
  return vscode.ConfigurationTarget.Global;
}

interface ManageItem extends vscode.QuickPickItem {
  action: "connect" | "update" | "test" | "disconnect" | "settings";
}

export class XrayConnectionCommands {
  constructor(
    private readonly config: ExtensionConfig,
    private readonly credentialStore: XrayCredentialStore,
    private readonly logger: Logger
  ) {}

  public async manageConnection(): Promise<void> {
    const site = this.config.xraySiteUrl;
    const normalized = normalizeSiteUrl(site);
    const connected = normalized !== "" && (await this.credentialStore.hasCredentials(site));

    const items: ManageItem[] = connected
      ? [
          { label: "$(key) Update Credentials…", action: "update" },
          { label: "$(plug) Test Connection", action: "test" },
          { label: "$(sign-out) Disconnect", action: "disconnect" },
          { label: "$(settings-gear) Open Settings", action: "settings" },
        ]
      : [
          { label: "$(plug) Connect to Xray…", action: "connect" },
          { label: "$(settings-gear) Open Settings", action: "settings" },
        ];

    const picked = await vscode.window.showQuickPick(items, {
      title: "Manage Xray Connection",
      placeHolder: connected ? `Connected to ${normalized}` : "Not connected to Xray",
    });
    if (!picked) {
      return;
    }
    switch (picked.action) {
      case "connect":
      case "update":
        await vscode.commands.executeCommand(COMMAND.connect);
        return;
      case "test":
        await vscode.commands.executeCommand(COMMAND.testConnection);
        return;
      case "disconnect":
        await vscode.commands.executeCommand(COMMAND.disconnect);
        return;
      case "settings":
        await vscode.commands.executeCommand("workbench.action.openSettings", SETTINGS_QUERY);
    }
  }

  public async connect(): Promise<void> {
    const wsConfig = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    const currentSite = this.config.xraySiteUrl;

    const site = await vscode.window.showInputBox({
      title: "Connect to Xray (1/3)",
      prompt: "Jira/Xray Cloud site host",
      placeHolder: "acme.atlassian.net",
      value: currentSite,
      ignoreFocusOut: true,
      // Validate the normalized host, not the raw string: "https://" trims non-empty but
      // normalizes to "", which would store secrets under a degenerate key no command can
      // ever address again. URL parsing rejects paths, ports, and embedded whitespace.
      validateInput: (value) => {
        const normalized = normalizeSiteUrl(value);
        if (normalized === "") {
          return "Enter a host like acme.atlassian.net";
        }
        try {
          if (new URL(`https://${normalized}`).hostname !== normalized) {
            return "Enter a bare host (no path or port), like acme.atlassian.net";
          }
        } catch {
          return "Not a valid host";
        }
        return undefined;
      },
    });
    if (site === undefined) {
      return;
    }
    const trimmedSite = site.trim();
    const hadCredentials = await this.credentialStore.hasCredentials(trimmedSite);

    const clientId = await vscode.window.showInputBox({
      title: "Connect to Xray (2/3)",
      prompt: "Xray API client id",
      placeHolder: hadCredentials ? "stored — enter to replace" : "client id",
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() === "" ? "Client id is required" : undefined),
    });
    if (clientId === undefined) {
      return;
    }

    const clientSecret = await vscode.window.showInputBox({
      title: "Connect to Xray (3/3)",
      prompt: "Xray API client secret",
      placeHolder: hadCredentials ? "stored — enter to replace" : "client secret",
      password: true,
      ignoreFocusOut: true,
      validateInput: (value) => (value.trim() === "" ? "Client secret is required" : undefined),
    });
    if (clientSecret === undefined) {
      return;
    }

    if (trimmedSite !== currentSite) {
      await wsConfig.update(SITE_URL_SETTING, trimmedSite, siteUrlTarget(wsConfig));
    }
    await this.credentialStore.setCredentials(trimmedSite, clientId.trim(), clientSecret.trim());
    // One site per workspace (§2): switching hosts must not leave the old host's secrets
    // stranded in SecretStorage with no command able to reach them.
    const previousSite = normalizeSiteUrl(currentSite);
    if (
      previousSite !== "" &&
      previousSite !== normalizeSiteUrl(trimmedSite) &&
      (await this.credentialStore.hasCredentials(currentSite))
    ) {
      await this.credentialStore.clearCredentials(currentSite);
      this.logger.info(`Removed stored Xray credentials for previous site ${previousSite}`);
    }
    const pick = await vscode.window.showInformationMessage(
      `Xray credentials saved for ${normalizeSiteUrl(trimmedSite)}`,
      "Test Connection"
    );
    if (pick === "Test Connection") {
      await vscode.commands.executeCommand(COMMAND.testConnection);
    }
  }

  public async disconnect(): Promise<void> {
    const site = this.config.xraySiteUrl;
    const normalized = normalizeSiteUrl(site);
    if (normalized === "" || !(await this.credentialStore.hasCredentials(site))) {
      vscode.window.showInformationMessage("No Xray credentials are stored for this site.");
      return;
    }
    const confirm = await vscode.window.showWarningMessage(
      `Disconnect from Xray and remove stored credentials for ${normalized}?`,
      { modal: true },
      "Disconnect"
    );
    if (confirm !== "Disconnect") {
      return;
    }
    await this.credentialStore.clearCredentials(site);
    vscode.window.showInformationMessage(`Disconnected from Xray (${normalized})`);
  }

  public async testConnection(): Promise<void> {
    await runXrayConnectionTest({
      config: this.config,
      credentialStore: this.credentialStore,
      logger: this.logger,
    });
  }
}
