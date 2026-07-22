import type { Memento } from "vscode";
import { Logger } from "../utils/logger";

// One recorded publish. `account` is the non-secret clientId (§7 — never derived from a secret);
// `site` scopes the entry so a stale-site key never confuses the current connection. `executionRef`
// is the created/appended execution KEY (the browse-link identity). `pendingAttachments` are the
// absolute file paths that failed to upload after a successful import — the resume/retry routine
// replays them WITHOUT re-importing, and clears the ones that then succeed.
export interface LedgerEntry {
  readonly artifactId: string;
  readonly executionRef: string;
  readonly site: string;
  readonly account: string;
  readonly publishedAt: number;
  readonly pendingAttachments: readonly string[];
}

const MAX_ENTRIES = 10;

// Prepend the newest entry and cap the list — the ledger is an idempotency buffer, not a history.
export function withLedgerEntry(entries: readonly LedgerEntry[], entry: LedgerEntry): LedgerEntry[] {
  return [entry, ...entries].slice(0, MAX_ENTRIES);
}

// The most recent entry for this artifact ON THE CURRENT SITE — the idempotency banner reads it.
// Site-scoping is deliberate: a key published under a different site says nothing about this one.
export function findLedgerEntry(
  entries: readonly LedgerEntry[],
  artifactId: string,
  site: string
): LedgerEntry | undefined {
  return entries.find((entry) => entry.artifactId === artifactId && entry.site === site);
}

// Replaces the matching entry's `pendingAttachments` in place (order preserved) — the resume/retry
// routine records which files are still pending after a replay. A no-op when nothing matches.
export function withUpdatedPending(
  entries: readonly LedgerEntry[],
  artifactId: string,
  site: string,
  pendingAttachments: readonly string[]
): LedgerEntry[] {
  return entries.map((entry) => {
    if (entry.artifactId === artifactId && entry.site === site) {
      return { ...entry, pendingAttachments };
    }
    return entry;
  });
}

function isValidEntry(value: unknown): value is LedgerEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  return (
    typeof entry["artifactId"] === "string" &&
    typeof entry["executionRef"] === "string" &&
    typeof entry["site"] === "string" &&
    typeof entry["account"] === "string" &&
    typeof entry["publishedAt"] === "number" &&
    Array.isArray(entry["pendingAttachments"])
  );
}

// The Memento-backed publish ledger (mirrors RunArtifactStore): the last few publishes, newest
// first, persisted so the idempotency banner survives a reload. Logic lives in the pure functions
// above; this thin adapter only reads/writes the store.
export class PublishLedger {
  private static readonly STORAGE_KEY = "specwright.publishLedger";

  private entries: LedgerEntry[];

  constructor(
    private readonly memento: Memento,
    private readonly logger: Logger
  ) {
    const stored = memento.get<unknown>(PublishLedger.STORAGE_KEY);
    this.entries = (Array.isArray(stored) ? stored : []).filter(isValidEntry).slice(0, MAX_ENTRIES);
  }

  public find(artifactId: string, site: string): LedgerEntry | undefined {
    return findLedgerEntry(this.entries, artifactId, site);
  }

  // Entries for the current site only — the tree/board never renders another site's keys.
  public entriesForSite(site: string): LedgerEntry[] {
    return this.entries.filter((entry) => entry.site === site);
  }

  public record(entry: LedgerEntry): void {
    this.entries = withLedgerEntry(this.entries, entry);
    this.persist();
  }

  // Replay result for the resume/retry routine: the still-pending files replace the entry's list, so a
  // fully-cleared upload leaves an empty `pendingAttachments` and a reload shows no outstanding work.
  public setPendingAttachments(artifactId: string, site: string, pendingAttachments: readonly string[]): void {
    this.entries = withUpdatedPending(this.entries, artifactId, site, pendingAttachments);
    this.persist();
  }

  private persist(): void {
    Promise.resolve(this.memento.update(PublishLedger.STORAGE_KEY, this.entries)).catch((error: unknown) => {
      this.logger.warn("Failed to persist the publish ledger", { error: String(error) });
    });
  }
}
