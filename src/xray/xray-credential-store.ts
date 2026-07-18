import * as vscode from "vscode";
import { normalizeSiteUrl } from "./xray-adapter";

export interface XrayCredentials {
  clientId: string;
  clientSecret: string;
}

const SECRET_KEY_PREFIX = "specwright.xray:";

// Plan §6: `specwright.xray:{siteUrl}:{field}`, site normalized so a pasted scheme/trailing slash
// resolves to the same entry as the bare host. An empty normalized host would produce a degenerate
// shared key (`specwright.xray::…`) that no command could ever address again — refuse it.
function credentialKey(siteUrl: string, field: "clientId" | "clientSecret"): string {
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
  // most two stale entries, cleared on the next write.
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

  public async clearCredentials(siteUrl: string): Promise<void> {
    const idKey = credentialKey(siteUrl, "clientId");
    const secretKey = credentialKey(siteUrl, "clientSecret");
    this.trackSelfWrites(idKey, secretKey);
    await this.secrets.delete(idKey);
    await this.secrets.delete(secretKey);
    this._onDidChange.fire();
  }

  public async hasCredentials(siteUrl: string): Promise<boolean> {
    return (await this.getCredentials(siteUrl)) !== undefined;
  }

  public dispose(): void {
    this.secretsSubscription?.dispose();
    this._onDidChange.dispose();
  }
}
