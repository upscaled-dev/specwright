import * as vscode from "vscode";
import { normalizeSiteUrl } from "./xray-adapter";

export interface XrayCredentials {
  clientId: string;
  clientSecret: string;
}

// Optional Jira basic-auth pair (§6 reserved slots). Both-or-neither: the store never holds a lone
// half, so a project view either has real Jira access or falls back to tag-derived probes.
export interface XrayJiraCredentials {
  email: string;
  token: string;
}

const SECRET_KEY_PREFIX = "specwright.xray:";

type CredentialField = "clientId" | "clientSecret" | "jiraEmail" | "jiraToken";

// Plan §6: `specwright.xray:{siteUrl}:{field}`, site normalized so a pasted scheme/trailing slash
// resolves to the same entry as the bare host. An empty normalized host would produce a degenerate
// shared key (`specwright.xray::…`) that no command could ever address again — refuse it.
function credentialKey(siteUrl: string, field: CredentialField): string {
  const normalized = normalizeSiteUrl(siteUrl);
  if (normalized === "") {
    throw new Error("Xray site URL normalizes to an empty host");
  }
  return `${SECRET_KEY_PREFIX}${normalized}:${field}`;
}

export class XrayCredentialStore implements vscode.Disposable {
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  // The credential store is the source of truth for connection state (§6); consumers reconcile off
  // this event instead of polling.
  public readonly onDidChange = this._onDidChange.event;
  private readonly secretsSubscription: vscode.Disposable | undefined;
  // Keys this store just wrote itself. An own write fires onDidChange directly; the bridged
  // SecretStorage event for the same key would double-fire, so we consume one bridged event per key.
  private readonly selfWrittenKeys = new Set<string>();

  constructor(private readonly secrets: vscode.SecretStorage) {
    // Credential edits from another window arrive through SecretStorage; re-surface them as our own
    // change so every window's connection state stays in sync (own writes fire onDidChange directly).
    this.secretsSubscription = this.secrets.onDidChange?.((event) => {
      if (!event.key.startsWith(SECRET_KEY_PREFIX)) {
        return;
      }
      if (this.selfWrittenKeys.delete(event.key)) {
        return;
      }
      this._onDidChange.fire();
    });
  }

  // Bounded to the last write's keys; a coalescing host that never re-delivers per-key leaves at
  // most a handful of stale entries, cleared on the next write.
  private trackSelfWrites(...keys: string[]): void {
    if (!this.secretsSubscription) {
      return;
    }
    this.selfWrittenKeys.clear();
    for (const key of keys) {
      this.selfWrittenKeys.add(key);
    }
  }

  public async getCredentials(siteUrl: string): Promise<XrayCredentials | undefined> {
    const clientId = await this.secrets.get(credentialKey(siteUrl, "clientId"));
    const clientSecret = await this.secrets.get(credentialKey(siteUrl, "clientSecret"));
    if (!clientId || !clientSecret) {
      return undefined;
    }
    return { clientId, clientSecret };
  }

  public async setCredentials(siteUrl: string, clientId: string, clientSecret: string): Promise<void> {
    const idKey = credentialKey(siteUrl, "clientId");
    const secretKey = credentialKey(siteUrl, "clientSecret");
    this.trackSelfWrites(idKey, secretKey);
    await this.secrets.store(idKey, clientId);
    await this.secrets.store(secretKey, clientSecret);
    this._onDidChange.fire();
  }

  // Full teardown for a host: the Xray pair AND the optional Jira pair. Disconnect and a site switch
  // both go through here so no half of either pair is left stranded under a key no command can reach.
  public async clearCredentials(siteUrl: string): Promise<void> {
    const keys = [
      credentialKey(siteUrl, "clientId"),
      credentialKey(siteUrl, "clientSecret"),
      credentialKey(siteUrl, "jiraEmail"),
      credentialKey(siteUrl, "jiraToken"),
    ];
    this.trackSelfWrites(...keys);
    for (const key of keys) {
      await this.secrets.delete(key);
    }
    this._onDidChange.fire();
  }

  public async hasCredentials(siteUrl: string): Promise<boolean> {
    return (await this.getCredentials(siteUrl)) !== undefined;
  }

  public async getJiraCredentials(siteUrl: string): Promise<XrayJiraCredentials | undefined> {
    const email = await this.secrets.get(credentialKey(siteUrl, "jiraEmail"));
    const token = await this.secrets.get(credentialKey(siteUrl, "jiraToken"));
    if (!email || !token) {
      return undefined;
    }
    return { email, token };
  }

  public async setJiraCredentials(siteUrl: string, email: string, token: string): Promise<void> {
    const emailKey = credentialKey(siteUrl, "jiraEmail");
    const tokenKey = credentialKey(siteUrl, "jiraToken");
    this.trackSelfWrites(emailKey, tokenKey);
    await this.secrets.store(emailKey, email);
    await this.secrets.store(tokenKey, token);
    this._onDidChange.fire();
  }

  public async clearJiraCredentials(siteUrl: string): Promise<void> {
    const emailKey = credentialKey(siteUrl, "jiraEmail");
    const tokenKey = credentialKey(siteUrl, "jiraToken");
    this.trackSelfWrites(emailKey, tokenKey);
    await this.secrets.delete(emailKey);
    await this.secrets.delete(tokenKey);
    this._onDidChange.fire();
  }

  public async hasJiraCredentials(siteUrl: string): Promise<boolean> {
    return (await this.getJiraCredentials(siteUrl)) !== undefined;
  }

  public dispose(): void {
    this.secretsSubscription?.dispose();
    this._onDidChange.dispose();
  }
}
