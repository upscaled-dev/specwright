import * as vscode from "vscode";
import { configurationTarget, ExtensionConfig } from "../core/extension-config";
import { Logger } from "../utils/logger";
import { normalizeSiteUrl } from "./xray-adapter";
import { XrayCredentialStore } from "./xray-credential-store";
import {
  runXrayConnectionTest,
  XrayConnectionOutcome,
  XrayConnectionTestDeps,
  XrayProbe,
  XrayProbeOptions,
} from "./xray-connection-test";
import { parseXrayRegion } from "./xray-region";
import { XraySetupPanel, type XraySetupSave } from "./xray-setup-panel";
import type { WorkspaceTrust } from "../core/workspace-trust";

const CONFIG_NAMESPACE = "playwrightBddRunner";
const SITE_URL_SETTING = "xray.siteUrl";
const API_REGION_SETTING = "xray.apiRegion";
const SETTINGS_QUERY = "playwrightBddRunner.traceability";

const COMMAND = {
  connect: "playwrightBddRunner.traceability.connect",
  disconnect: "playwrightBddRunner.traceability.disconnect",
  testConnection: "playwrightBddRunner.traceability.testConnection",
  setupSaved: "playwrightBddRunner.traceability.setupSaved",
} as const;

interface StoredHostState {
  readonly xray: Awaited<ReturnType<XrayCredentialStore["getCredentials"]>>;
  readonly jira: Awaited<ReturnType<XrayCredentialStore["getJiraCredentials"]>>;
}

interface StoredSetting<T> {
  readonly target: vscode.ConfigurationTarget;
  readonly value: T | undefined;
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
    private readonly knownTestKeys: () => string[],
    // Injected so the setup surface owns its cancellation independently from the live adapter.
    private readonly probe: XrayProbe,
    private readonly workspaceTrust: WorkspaceTrust,
    private readonly webviewAssetRoot: vscode.Uri
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
      workspaceAvailable: () => this.workspaceTrust.available,
      currentSite: () => this.config.xraySiteUrl,
      currentRegion: () => parseXrayRegion(this.config.xrayApiRegion),
      hasCredentials: (site) => this.credentialStore.hasCredentials(site),
      getCredentials: (site) => this.credentialStore.getCredentials(site),
      saveSetup: (input) => this.saveSetup(input),
      hasJiraCredentials: (site) => this.credentialStore.hasJiraCredentials(site),
      getJiraCredentials: (site) => this.credentialStore.getJiraCredentials(site),
      didSave: async () => {await vscode.commands.executeCommand(COMMAND.setupSaved);},
      // The panel renders the outcome inline, so it calls the probe directly, going through the
      // testConnection command would fire the standalone command's toasts on top.
      probeConnection: (site, region, signal) => this.workspaceTrust.run(
        (trusted) => this.probeConnection(site, undefined, trusted, region),
        signal
      ),
      verifyConnection: (site, region, signal) => this.workspaceTrust.run(
        (trusted) => this.probeConnection(site, { authOnly: true }, trusted, region),
        signal
      ),
    }, this.webviewAssetRoot);
  }

  // Site is the just-saved host when the panel supplies it; otherwise read fresh from the config
  // store (never the ExtensionConfig snapshot, which only refreshes on config-change).
  public probeConnection(
    site?: string,
    options?: XrayProbeOptions,
    signal?: AbortSignal,
    region = this.freshRegion()
  ): Promise<XrayConnectionOutcome> {
    return this.probe(this.testDeps(site ?? this.freshSite(), region), options, signal);
  }

  private freshSite(): string {
    return vscode.workspace.getConfiguration(CONFIG_NAMESPACE).get<string>(SITE_URL_SETTING, "");
  }

  // Region is threaded the same fresh way as the site (never the ExtensionConfig snapshot), so a
  // probe fired right after a settings edit reads the just-selected region.
  private freshRegion(): ReturnType<typeof parseXrayRegion> {
    const raw = vscode.workspace.getConfiguration(CONFIG_NAMESPACE).get<string>(API_REGION_SETTING, "global");
    return parseXrayRegion(raw);
  }

  public async saveConnection(site: string, clientId: string, clientSecret: string): Promise<string> {
    const jira = normalizeSiteUrl(site) === ""
      ? undefined
      : await this.credentialStore.getJiraCredentials(site);
    return this.saveSetup({
      site,
      region: this.freshRegion(),
      clientId,
      clientSecret,
      jira,
    });
  }

  public async saveSetup(input: XraySetupSave): Promise<string> {
    const trimmedSite = input.site.trim();
    if (normalizeSiteUrl(trimmedSite) === "") {
      throw new Error(`Cannot save Xray credentials: ${trimmedSite} is not a valid site host`);
    }
    const wsConfig = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    // ExtensionConfig wraps a captured snapshot that only refreshes on config-change; read the
    // current site from this fresh getConfiguration() snapshot so back-to-back saves from the
    // retained panel can't strand the intermediate host's credentials on a stale previous site.
    const currentSite = wsConfig.get<string>(SITE_URL_SETTING, "");
    const currentRegion = parseXrayRegion(
      wsConfig.get<string>(API_REGION_SETTING, "global")
    );
    const siteSetting = this.readSetting<string>(wsConfig, SITE_URL_SETTING);
    const regionSetting = this.readSetting<string>(wsConfig, API_REGION_SETTING);
    const targetState = await this.readHostState(trimmedSite);
    const previousState = normalizeSiteUrl(currentSite) === normalizeSiteUrl(trimmedSite)
      ? targetState
      : await this.readHostState(currentSite);
    let siteWritten = false;
    let regionWritten = false;
    try {
      await this.credentialStore.setCredentials(
        trimmedSite,
        input.clientId.trim(),
        input.clientSecret.trim()
      );
      if (input.jira) {
        await this.credentialStore.setJiraCredentials(
          trimmedSite,
          input.jira.email.trim(),
          input.jira.token.trim()
        );
      } else if (await this.credentialStore.hasJiraCredentials(trimmedSite)) {
        await this.credentialStore.clearJiraCredentials(trimmedSite);
      }
      if (trimmedSite !== currentSite) {
        siteWritten = true;
        await wsConfig.update(SITE_URL_SETTING, trimmedSite, siteSetting.target);
      }
      if (input.region !== currentRegion) {
        regionWritten = true;
        await wsConfig.update(API_REGION_SETTING, input.region, regionSetting.target);
      }

      const previousSite = normalizeSiteUrl(currentSite);
      if (previousSite !== "" && previousSite !== normalizeSiteUrl(trimmedSite)) {
        await this.credentialStore.clearCredentials(currentSite);
        this.logger.info(`Removed stored Xray credentials for previous site ${previousSite}`);
      }
    } catch (error) {
      const recoveries: Promise<void>[] = [this.restoreHostState(trimmedSite, targetState)];
      if (normalizeSiteUrl(currentSite) !== normalizeSiteUrl(trimmedSite)) {
        recoveries.push(this.restoreHostState(currentSite, previousState));
      }
      if (siteWritten) {
        recoveries.push(Promise.resolve(
          wsConfig.update(SITE_URL_SETTING, siteSetting.value, siteSetting.target)
        ));
      }
      if (regionWritten) {
        recoveries.push(Promise.resolve(
          wsConfig.update(API_REGION_SETTING, regionSetting.value, regionSetting.target)
        ));
      }
      const settled = await Promise.allSettled(recoveries);
      const recoveryErrors = settled.flatMap((result) => {
        return result.status === "rejected" ? [result.reason as unknown] : [];
      });
      if (recoveryErrors.length > 0) {
        throw new AggregateError(
          [error, ...recoveryErrors],
          "Xray setup failed and its previous state could not be fully restored."
        );
      }
      throw error;
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

  public async testConnection(signal?: AbortSignal): Promise<void> {
    await runXrayConnectionTest(this.testDeps(this.freshSite()), signal);
  }

  private testDeps(site: string, region = this.freshRegion()): XrayConnectionTestDeps {
    return {
      site,
      region,
      credentialStore: this.credentialStore,
      logger: this.logger,
      knownTestKeys: this.knownTestKeys,
    };
  }

  private readSetting<T>(
    config: vscode.WorkspaceConfiguration,
    setting: string
  ): StoredSetting<T> {
    const target = configurationTarget(config, setting);
    const inspected = config.inspect<T>(setting);
    return {
      target,
      value: target === vscode.ConfigurationTarget.Workspace
        ? inspected?.workspaceValue
        : inspected?.globalValue,
    };
  }

  private async readHostState(site: string): Promise<StoredHostState> {
    if (normalizeSiteUrl(site) === "") {
      return { xray: undefined, jira: undefined };
    }
    const [xray, jira] = await Promise.all([
      this.credentialStore.getCredentials(site),
      this.credentialStore.getJiraCredentials(site),
    ]);
    return { xray, jira };
  }

  private async restoreHostState(site: string, state: StoredHostState): Promise<void> {
    if (normalizeSiteUrl(site) === "") {return;}
    if (state.xray) {
      await this.credentialStore.setCredentials(site, state.xray.clientId, state.xray.clientSecret);
    } else {
      await this.credentialStore.clearCredentials(site);
    }
    if (state.jira) {
      await this.credentialStore.setJiraCredentials(site, state.jira.email, state.jira.token);
    } else if (await this.credentialStore.hasJiraCredentials(site)) {
      await this.credentialStore.clearJiraCredentials(site);
    }
  }
}
