import * as vscode from "vscode";
import { ExtensionConfig } from "../core/extension-config";
import { Logger } from "../utils/logger";
import { normalizeSiteUrl } from "./xray-adapter";
import { XrayCredentialStore } from "./xray-credential-store";
import {
  probeXrayConnection,
  runXrayConnectionTest,
  XrayConnectionOutcome,
  XrayConnectionTestDeps,
  XrayProbeOptions,
} from "./xray-connection-test";
import { XraySetupPanel } from "./xray-setup-panel";

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
    private readonly logger: Logger,
    // Call-time supplier: the traceability subsystem is set on the CommandManager after this is
    // constructed, so the test keys must be read when a probe runs, not captured here.
    private readonly knownTestKeys: () => string[]
  ) {}

  public async manageConnection(): Promise<void> {
    const site = this.freshSite();
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
    await XraySetupPanel.show({
      currentSite: () => this.config.xraySiteUrl,
      hasCredentials: (site) => this.credentialStore.hasCredentials(site),
      getCredentials: (site) => this.credentialStore.getCredentials(site),
      saveConnection: (site, clientId, clientSecret) => this.saveConnection(site, clientId, clientSecret),
      // The panel renders the outcome inline, so it calls the probe directly — going through the
      // testConnection command would fire the standalone command's toasts on top.
      probeConnection: (site) => this.probeConnection(site),
      verifyConnection: (site) => this.probeConnection(site, { authOnly: true }),
    });
  }

  // Site is the just-saved host when the panel supplies it; otherwise read fresh from the config
  // store (never the ExtensionConfig snapshot, which only refreshes on config-change).
  public probeConnection(site?: string, options?: XrayProbeOptions): Promise<XrayConnectionOutcome> {
    return probeXrayConnection(this.testDeps(site ?? this.freshSite()), options);
  }

  private freshSite(): string {
    return vscode.workspace.getConfiguration(CONFIG_NAMESPACE).get<string>(SITE_URL_SETTING, "");
  }

  public async saveConnection(site: string, clientId: string, clientSecret: string): Promise<string> {
    const trimmedSite = site.trim();
    if (normalizeSiteUrl(trimmedSite) === "") {
      throw new Error(`Cannot save Xray credentials: ${trimmedSite} is not a valid site host`);
    }
    const wsConfig = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    // ExtensionConfig wraps a captured snapshot that only refreshes on config-change; read the
    // current site from this fresh getConfiguration() snapshot so back-to-back saves from the
    // retained panel can't strand the intermediate host's credentials on a stale previous site.
    const currentSite = wsConfig.get<string>(SITE_URL_SETTING, "");

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
    return normalizeSiteUrl(trimmedSite);
  }

  public async disconnect(): Promise<void> {
    const site = this.freshSite();
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
    await runXrayConnectionTest(this.testDeps(this.freshSite()));
  }

  private testDeps(site: string): XrayConnectionTestDeps {
    return {
      site,
      credentialStore: this.credentialStore,
      logger: this.logger,
      knownTestKeys: this.knownTestKeys,
    };
  }
}
