import { createHash } from "node:crypto";
import * as vscode from "vscode";
import { TestCaseMetadata } from "../traceability/contracts";
import { XrayCachePage } from "./xray-client";

// Bump to invalidate every persisted snapshot when the stored shape changes. It is the last segment
// of the storage key, so old-schema entries become unreachable rather than mis-parsed.
export const CACHE_SCHEMA_VERSION = 3;

export interface CachedMetadata {
  schemaVersion: number;
  syncedAt: number;
  completeness: "complete" | "partial" | "unknown";
  fetchedScopes: string[];
  catalogueProjects: string[];
  verifiedAbsentKeys: string[];
  errors: string[];
  // Stored as an array (each entry carries its own key) so a plain Memento round-trips it as JSON.
  tests: TestCaseMetadata[];
  pages: XrayCachePage[];
}

export interface XrayCacheIdentity {
  // Region host (e.g. xray.cloud.getxray.app) — the `{endpoint}` segment.
  readonly endpoint: string;
  // A non-secret account identifier (the Xray client id). Never derived by hashing a secret.
  readonly account: () => Promise<string | undefined>;
  readonly workspaceId: string;
}

// §7 identity: traceability:{provider}:{endpoint}:{account}:{workspace}:{schemaVersion}. Keying on
// account + endpoint is what stops one account's cache from surfacing under another's credentials.
export function metadataCacheStorageKey(parts: {
  endpoint: string;
  account: string;
  workspaceId: string;
}): string {
  return `traceability:xray:${parts.endpoint}:${parts.account}:${parts.workspaceId}:${CACHE_SCHEMA_VERSION}`;
}

// A stable per-workspace segment from the folder paths (not secret — a plain hash keeps the key
// bounded and separator-safe). No folders open → a fixed sentinel.
export function currentWorkspaceId(): string {
  const paths = (vscode.workspace.workspaceFolders ?? [])
    .map((folder) => folder.uri.fsPath)
    .sort((a, b) => a.localeCompare(b));
  if (paths.length === 0) {
    return "no-workspace";
  }
  return createHash("sha1").update(paths.join("|")).digest("hex").slice(0, 16);
}

export class XrayMetadataCache {
  constructor(
    private readonly memento: vscode.Memento,
    private readonly identity: XrayCacheIdentity
  ) {}

  private keyFor(account: string | undefined): string | undefined {
    if (!account) {
      return undefined;
    }
    return metadataCacheStorageKey({
      endpoint: this.identity.endpoint,
      account,
      workspaceId: this.identity.workspaceId,
    });
  }

  public async load(): Promise<CachedMetadata | undefined> {
    const key = this.keyFor(await this.identity.account());
    if (!key) {
      return undefined;
    }
    const stored = this.memento.get<CachedMetadata>(key);
    if (stored?.schemaVersion !== CACHE_SCHEMA_VERSION) {
      return undefined;
    }
    return stored;
  }

  public save(data: CachedMetadata): Promise<void> {
    return this.identity.account().then((account) => this.saveForAccount(account, data));
  }

  // Writes under an explicitly-supplied account, never a live read — the caller captures the account
  // at the start of its work so a cross-window rotation mid-write can't retarget the key (§7 TOCTOU).
  public async saveForAccount(account: string | undefined, data: CachedMetadata): Promise<void> {
    const key = this.keyFor(account);
    if (!key) {
      return;
    }
    await this.memento.update(key, data);
  }
}
