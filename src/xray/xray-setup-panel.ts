import * as vscode from "vscode";
import { createNonce } from "../utils/webview";
import { serverText } from "../utils/text";
import {
  parseSetupClientEnvelope,
  XRAY_SETUP_MASK as MASK,
  type SetupClientMessage,
  type SetupHostMessage,
} from "../webview/setup-protocol";
import { normalizeSiteUrl } from "./xray-adapter";
import { XrayConnectionOutcome } from "./xray-connection-test";
import { XrayCredentials, XrayJiraCredentials } from "./xray-credential-store";
import { parseXrayRegion, type XrayRegion } from "./xray-region";
import { XraySetupChannel } from "./xray-setup-channel";
import { renderXraySetupDocument } from "./xray-setup-document";
import { validateXraySetupInput, type XraySetupValidationErrors } from "./xray-setup-validation";
import { VerificationRedaction } from "./xray-setup-verification";

const VIEW_TYPE = "playwrightBddRunner.xraySetup";

export interface XraySetupDelegate {
  workspaceAvailable(): boolean;
  currentSite(): string;
  currentRegion(): XrayRegion;
  hasCredentials(site: string): Promise<boolean>;
  getCredentials(site: string): Promise<XrayCredentials | undefined>;
  saveSetup(input: XraySetupSave): Promise<string>;
  // Optional Jira access (§6 reserved slots): both-or-neither, stored/cleared for the saved host.
  hasJiraCredentials(site: string): Promise<boolean>;
  getJiraCredentials(site: string): Promise<XrayJiraCredentials | undefined>;
  didSave?(): Promise<void>;
  // Full handshake + shape/project probes (Save & Test).
  probeConnection(site: string, region: XrayRegion, signal?: AbortSignal): Promise<XrayConnectionOutcome>;
  // Cheap auth-only handshake; drives the connection dot on open and after a plain Save.
  verifyConnection(site: string, region: XrayRegion, signal?: AbortSignal): Promise<XrayConnectionOutcome>;
}

export interface XraySetupSave {
  readonly site: string;
  readonly region: XrayRegion;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly jira: XrayJiraCredentials | undefined;
}

type SaveMessage = Extract<SetupClientMessage, { type: "save" }>;

interface ResolvedJira {
  email: string;
  token: string;
  // true → both present, store; false → both absent, clear/skip.
  store: boolean;
  emailError?: string | undefined;
  tokenError?: string | undefined;
}

interface VerifyOptions {
  announceChecking: boolean;
  statusOnSuccess: boolean;
  throwPrefix: string;
}

interface ResolvedCredentials {
  clientId: string;
  clientSecret: string;
  clientIdError?: string | undefined;
  clientSecretError?: string | undefined;
}

export class XraySetupPanel {
  private static current: XraySetupPanel | undefined;
  private static closing: Promise<void> | undefined;
  private static opening: Promise<void> | undefined;

  private readonly disposables: vscode.Disposable[] = [];
  private readonly session = createNonce();
  // A submitted mask is valid only for the normalized host it was rendered for.
  private maskIssuedSite: string | undefined;
  // A save invalidates the open verify; the guard owns its replacement through settlement.
  private verifyEpoch = 0;
  private verifyAbort: AbortController | undefined;
  private readonly pendingVerifications = new Set<Promise<void>>();
  private saveInFlight = false;
  private saveTask: Promise<void> | undefined;
  private channel: XraySetupChannel | undefined;
  private shutdownPromise: Promise<void> | undefined;
  private disposed = false;

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    private readonly deps: XraySetupDelegate,
    private readonly assetRoot: vscode.Uri
  ) {
    this.disposables.push(
      this.panel.onDidDispose(() => {
        this.shutdown(false).catch(() => undefined);
      }),
      this.panel.webview.onDidReceiveMessage((message) => this.handleMessage(message))
    );
  }

  public static close(): Promise<void> {
    if (XraySetupPanel.current) {return XraySetupPanel.current.shutdown(true);}
    if (XraySetupPanel.opening) {
      return XraySetupPanel.opening.then(() => XraySetupPanel.close());
    }
    return XraySetupPanel.closing ?? Promise.resolve();
  }

  public static show(deps: XraySetupDelegate, assetRoot: vscode.Uri): Promise<void> {
    if (XraySetupPanel.current) {
      XraySetupPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return XraySetupPanel.current.channel?.rehydrate() ?? Promise.resolve();
    }
    if (XraySetupPanel.opening) {return XraySetupPanel.opening;}
    const opening = XraySetupPanel.open(deps, assetRoot);
    XraySetupPanel.opening = opening;
    const clearOpening = (): void => {
      if (XraySetupPanel.opening === opening) {XraySetupPanel.opening = undefined;}
    };
    opening.then(clearOpening, clearOpening);
    return opening;
  }

  private static async open(deps: XraySetupDelegate, assetRoot: vscode.Uri): Promise<void> {
    await XraySetupPanel.closing;
    if (XraySetupPanel.current) {
      XraySetupPanel.current.panel.reveal(vscode.ViewColumn.Active);
      return;
    }
    // retainContextWhenHidden keeps typed-but-unsaved secrets in memory across tab switches.
    // Webview state persists only the credential-free document id needed to recognize a reload.
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, "Set up Xray", vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [assetRoot],
    });
    const instance = new XraySetupPanel(panel, deps, assetRoot);
    XraySetupPanel.current = instance;
    try {
      await instance.render();
    } catch (error) {
      await instance.shutdown(true);
      throw error;
    }
  }

  private async render(): Promise<void> {
    const site = this.deps.currentSite();
    const normalized = normalizeSiteUrl(site);
    const presence = normalized === "" ? [] : await Promise.allSettled([
      Promise.resolve().then(() => this.deps.hasCredentials(site)),
      Promise.resolve().then(() => this.deps.hasJiraCredentials(site)),
    ]);
    const hasCredentials = presence[0]?.status === "fulfilled" && presence[0].value === true;
    const hasJira = presence[1]?.status === "rejected" ||
      (presence[1]?.status === "fulfilled" && presence[1].value === true);
    const presenceFailed = presence.some((result) => result.status === "rejected");
    if (this.stale(this.verifyEpoch)) {return;}
    // A Jira presence failure stays masked so save re-reads rather than clearing a stored pair.
    this.maskIssuedSite = hasCredentials || hasJira ? normalized : undefined;
    const region = this.deps.currentRegion();
    this.channel = new XraySetupChannel(
      this.panel.webview,
      this.session,
      () => this.deps.workspaceAvailable(),
      { site: serverText(site), region, credentials: hasCredentials, jira: hasJira }
    );
    this.panel.webview.html = renderXraySetupDocument(
      this.panel.webview,
      this.assetRoot,
      this.session,
      site,
      region,
      hasCredentials,
      hasJira
    );
    if (presenceFailed) {
      await this.post({
        type: "error",
        message: "Could not read stored credential status. Enter credentials to continue.",
      });
    }
    // Verify stored Xray credentials in the background; otherwise leave the disconnected state.
    if (hasCredentials) {
      this.startStoredVerify(normalized, region, {
        announceChecking: false,
        statusOnSuccess: false,
        throwPrefix: "Could not verify connection",
      });
    }
  }

  private startStoredVerify(site: string, region: XrayRegion, options: VerifyOptions): void {
    const epoch = this.verifyEpoch;
    const task = this.runStoredVerify(epoch, site, region, options);
    this.trackVerification(task);
  }

  private async runStoredVerify(
    epoch: number,
    site: string,
    region: XrayRegion,
    options: VerifyOptions
  ): Promise<void> {
    let credentials: XrayCredentials | undefined;
    try {
      credentials = await this.deps.getCredentials(site);
    } catch {
      if (!this.stale(epoch)) {await this.storedCredentialReadFailed(options);}
      return;
    }
    if (this.stale(epoch)) {return;}
    if (credentials === undefined) {
      await this.storedCredentialReadFailed(options);
      return;
    }
    await this.runVerify(
      site,
      region,
      false,
      options,
      new VerificationRedaction([credentials.clientId, credentials.clientSecret])
    );
  }

  private async storedCredentialReadFailed(options: VerifyOptions): Promise<void> {
    await this.post({ type: "conn-state", state: "disconnected", label: "Not connected" });
    await this.post({
      type: "error",
      message: `${options.throwPrefix}: stored credentials could not be read.`,
    });
  }

  // Each mask keeps that stored field only for its issued host, allowing one-field rotation without
  // carrying a credential to a changed host.
  private async resolveCredentials(message: SaveMessage): Promise<ResolvedCredentials> {
    const idIsMask = message.clientId === MASK;
    const secretIsMask = message.clientSecret === MASK;
    if (!idIsMask && !secretIsMask) {
      return { clientId: message.clientId, clientSecret: message.clientSecret };
    }
    const submittedHost = normalizeSiteUrl(message.site);
    const sameHost = submittedHost !== "" && this.maskIssuedSite === submittedHost;
    const hostChanged = this.maskIssuedSite !== undefined && !sameHost;
    const stored = sameHost ? await this.deps.getCredentials(message.site) : undefined;

    const result: ResolvedCredentials = {
      clientId: message.clientId,
      clientSecret: message.clientSecret,
    };
    if (idIsMask) {
      if (stored) {
        result.clientId = stored.clientId;
      } else {
        result.clientIdError = hostChanged
          ? "Enter the credentials for the new site"
          : "Enter your Xray client id";
      }
    }
    if (secretIsMask) {
      if (stored) {
        result.clientSecret = stored.clientSecret;
      } else {
        result.clientSecretError = hostChanged
          ? "Enter the credentials for the new site"
          : "Enter your Xray client secret";
      }
    }
    return result;
  }

  // Jira adds a both-or-neither rule; both blank means no Jira access and clears the stored pair.
  private async resolveJira(message: SaveMessage): Promise<ResolvedJira> {
    let email = message.jiraEmail;
    let token = message.jiraToken;
    let emailError: string | undefined;
    let tokenError: string | undefined;

    if (email === MASK || token === MASK) {
      const submittedHost = normalizeSiteUrl(message.site);
      const sameHost = submittedHost !== "" && this.maskIssuedSite === submittedHost;
      const hostChanged = this.maskIssuedSite !== undefined && !sameHost;
      const stored = sameHost ? await this.deps.getJiraCredentials(message.site) : undefined;
      const missing = hostChanged ? "Enter the Jira credentials for the new site" : undefined;
      if (email === MASK) {
        if (stored) {
          email = stored.email;
        } else {
          email = "";
          emailError = missing ?? "Enter your Jira email";
        }
      }
      if (token === MASK) {
        if (stored) {
          token = stored.token;
        } else {
          token = "";
          tokenError = missing ?? "Enter your Jira API token";
        }
      }
    }

    email = email.trim();
    token = token.trim();
    const bothOrNeither = "Enter both a Jira email and API token, or leave both blank";
    if (email !== "" && token === "" && tokenError === undefined) {
      tokenError = bothOrNeither;
    }
    if (token !== "" && email === "" && emailError === undefined) {
      emailError = bothOrNeither;
    }
    const store = email !== "" && token !== "" && emailError === undefined && tokenError === undefined;
    return {
      email,
      token,
      store,
      ...(emailError ? { emailError } : {}),
      ...(tokenError ? { tokenError } : {}),
    };
  }

  private combinedErrors(
    message: SaveMessage,
    resolved: ResolvedCredentials,
    jira: ResolvedJira
  ): XraySetupValidationErrors | undefined {
    const errors: XraySetupValidationErrors =
      validateXraySetupInput(message.site, resolved.clientId, resolved.clientSecret, message.region) ?? {};
    if (resolved.clientIdError) {
      errors.clientId = resolved.clientIdError;
    }
    if (resolved.clientSecretError) {
      errors.clientSecret = resolved.clientSecretError;
    }
    if (jira.emailError) {
      errors.jiraEmail = jira.emailError;
    }
    if (jira.tokenError) {
      errors.jiraToken = jira.tokenError;
    }
    return errors.site || errors.region || errors.clientId || errors.clientSecret || errors.jiraEmail || errors.jiraToken
      ? errors
      : undefined;
  }

  private handleMessage(message: unknown): Promise<void> {
    if (this.disposed) {
      return Promise.resolve();
    }
    const envelope = parseSetupClientEnvelope(message);
    if (envelope?.session !== this.session) {return Promise.resolve();}
    if (envelope.body.type === "ready") {
      return envelope.revision === 0
        ? this.channel?.hydrate(envelope.document, envelope.body.previousDocument) ?? Promise.resolve()
        : Promise.resolve();
    }
    if (this.saveInFlight) {return Promise.resolve();}
    if (this.channel?.accepts(envelope) !== true) {
      return this.channel?.recover(envelope) ?? Promise.resolve();
    }
    const request = envelope.body;
    this.saveInFlight = true;
    this.cancelVerification();
    const task = this.runSave(request);
    this.saveTask = task;
    return task;
  }

  private async runSave(message: SaveMessage): Promise<void> {
    try {
      const admitted = await this.post({ type: "busy", busy: true, testing: message.test });
      if (!admitted || this.channel?.canMutate() !== true) {return;}
      await this.save(message);
    } finally {
      this.saveInFlight = false;
      await this.post({ type: "busy", busy: false, testing: message.test });
      this.saveTask = undefined;
    }
  }

  private async save(message: SaveMessage): Promise<void> {
    let committed = false;
    let redaction = new VerificationRedaction([
      message.clientId,
      message.clientSecret,
      message.jiraEmail,
      message.jiraToken,
    ]);
    try {
      let resolved: ResolvedCredentials;
      let jira: ResolvedJira;
      try {
        resolved = await this.resolveCredentials(message);
        jira = await this.resolveJira(message);
      } catch {
        await this.post(
          { type: "error", message: "Could not save: stored credentials could not be read." },
          false
        );
        return;
      }
      redaction = new VerificationRedaction([
        message.clientId,
        message.clientSecret,
        message.jiraEmail,
        message.jiraToken,
        resolved.clientId,
        resolved.clientSecret,
        jira.email,
        jira.token,
      ]);
      const errors = this.combinedErrors(message, resolved, jira);
      if (errors) {
        await this.post({ type: "validation", errors }, false);
        return;
      }
      if (this.channel?.canMutate() !== true) {return;}
      const region = parseXrayRegion(message.region);
      const site = await this.deps.saveSetup({
        site: message.site,
        region,
        clientId: resolved.clientId,
        clientSecret: resolved.clientSecret,
        jira: jira.store ? { email: jira.email, token: jira.token } : undefined,
      });
      committed = true;
      this.maskIssuedSite = site;
      await this.post({
        type: "saved",
        site: redaction.text(site, "Saved site"),
        region,
        jira: jira.store,
      });
      try {
        await this.deps.didSave?.();
      } catch {
        // Walkthrough completion is optional notification after the setup transaction committed.
      }
      // The save guard owns the full or auth-only replacement probe through settlement.
      await this.startVerify(site, region, message.test, {
        announceChecking: true,
        statusOnSuccess: true,
        throwPrefix: "Saved, but the connection test failed to run",
      }, redaction);
    } catch (error) {
      const reason = redaction.error(error);
      const prefix = committed ? "Saved, but setup could not update" : "Could not save";
      await this.post({ type: "error", message: `${prefix}: ${reason}` }, committed);
    }
  }

  private startVerify(
    site: string,
    region: XrayRegion,
    full: boolean,
    options: VerifyOptions,
    redaction: VerificationRedaction
  ): Promise<void> {
    const task = this.runVerify(site, region, full, options, redaction);
    this.trackVerification(task);
    return task;
  }

  private trackVerification(task: Promise<void>): void {
    this.pendingVerifications.add(task);
    task.then(
      () => this.pendingVerifications.delete(task),
      () => this.pendingVerifications.delete(task)
    );
  }

  private async runVerify(
    site: string,
    region: XrayRegion,
    full: boolean,
    options: VerifyOptions,
    redaction: VerificationRedaction
  ): Promise<void> {
    const epoch = ++this.verifyEpoch;
    this.verifyAbort?.abort();
    const controller = new AbortController();
    this.verifyAbort = controller;
    if (options.announceChecking) {
      await this.post({ type: "conn-state", state: "checking", label: "Checking connection…" });
    }
    if (this.stale(epoch)) {return;}
    let run: Promise<XrayConnectionOutcome>;
    // A synchronous throw from the delegate (not just a rejected promise) would otherwise escape
    // handleMessage and strand the form at "Checking…" with both buttons disabled. Post the same
    // terminal pair settleVerify's async-failure path posts.
    try {
      run = full
        ? this.deps.probeConnection(site, region, controller.signal)
        : this.deps.verifyConnection(site, region, controller.signal);
    } catch (error) {
      if (this.stale(epoch)) {
        return;
      }
      const reason = redaction.error(error);
      await this.post({ type: "conn-state", state: "disconnected", label: "Not connected" });
      await this.post({ type: "error", message: `${options.throwPrefix}: ${reason}` });
      return;
    }
    try {
      await this.settleVerify(epoch, run, options, full, redaction);
    } finally {
      if (this.verifyAbort === controller) {this.verifyAbort = undefined;}
    }
  }

  private async settleVerify(
    epoch: number,
    run: Promise<XrayConnectionOutcome>,
    options: VerifyOptions,
    full: boolean,
    redaction: VerificationRedaction
  ): Promise<void> {
    let outcome: XrayConnectionOutcome;
    try {
      outcome = await run;
    } catch (error) {
      if (this.stale(epoch)) {
        return;
      }
      const reason = redaction.error(error);
      await this.post({ type: "conn-state", state: "disconnected", label: "Not connected" });
      await this.post({ type: "error", message: `${options.throwPrefix}: ${reason}` });
      return;
    }
    if (this.stale(epoch)) {
      return;
    }
    // Connected == the whole probe passed. A GraphQL-stage failure means the handshake worked but no
    // data call does, which is not a working connection, so the dot goes red and the label says which
    // half failed.
    await this.post({
      type: "conn-state",
      state: outcome.ok ? "connected" : "disconnected",
      label: redaction.connectionLabel(outcome),
    });
    if (!outcome.ok || options.statusOnSuccess) {
      await this.post({
        type: "test-result",
        ok: outcome.ok,
        message: redaction.text(outcome.message, "Connection test returned no detail."),
      });
    }
    // Only the full probe carries project/Jira data; the auth-only open verify never does, so it
    // leaves the neutral initial view in place.
    if (full && this.hasProjectData(outcome)) {
      await this.post(redaction.projectView(outcome));
    }
  }

  private hasProjectData(outcome: XrayConnectionOutcome): boolean {
    return (
      outcome.projects !== undefined ||
      outcome.jiraProjects !== undefined ||
      outcome.jiraError !== undefined
    );
  }

  private stale(epoch: number): boolean {
    return this.disposed || !this.deps.workspaceAvailable() || epoch !== this.verifyEpoch;
  }

  private async post(message: SetupHostMessage, retain = true): Promise<boolean> {
    return await this.channel?.post(message, retain) ?? false;
  }

  private cancelVerification(): void {
    this.verifyEpoch += 1;
    this.verifyAbort?.abort();
    this.verifyAbort = undefined;
  }

  private shutdown(disposePanel: boolean): Promise<void> {
    if (this.shutdownPromise) {return this.shutdownPromise;}
    this.disposed = true;
    this.cancelVerification();
    XraySetupPanel.current = undefined;
    while (this.disposables.length > 0) {
      this.disposables.pop()?.dispose();
    }
    const pending = new Set<Promise<void>>(this.pendingVerifications);
    if (this.saveTask) {pending.add(this.saveTask);}
    if (this.channel) {pending.add(this.channel.dispose());}
    this.shutdownPromise = Promise.allSettled([...pending]).then(() => undefined);
    XraySetupPanel.closing = this.shutdownPromise;
    const clearClosing = (): void => {
      if (XraySetupPanel.closing === this.shutdownPromise) {XraySetupPanel.closing = undefined;}
    };
    this.shutdownPromise.then(clearClosing, clearClosing);
    if (disposePanel) {this.panel.dispose();}
    return this.shutdownPromise;
  }
}
