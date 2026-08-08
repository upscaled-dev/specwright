import type { Memento } from "vscode";
import { Logger } from "../utils/logger";
import { isAttachmentSnapshot, type AttachmentSnapshot } from "./attachment-spool";

export type PendingAttachment = AttachmentSnapshot;

// One recorded publish. `account` is the non-secret clientId (§7, never derived from a secret);
// `site` scopes the entry so a stale-site key never confuses the current connection. `executionRef`
// is the created/appended execution KEY (the browse-link identity). `pendingAttachments` are opaque
// sealed snapshot records; the resume/retry routine replays them WITHOUT re-importing or rereading a
// mutable user path, and clears the ones that then succeed.
//
// `summary`, `mode`, the passed/failed/skipped counts, and `total` back the Executions board (what
// this workspace has published). They are optional because entries written before the ledger recorded
// them have none; readers render a dash rather than migrating the store. `total` is the whole
// publishable count: it can exceed passed+failed+skipped when a result timed out or was interrupted,
// so the board reads it for Imported and dashes the pass rate when the three counts do not add up.
export interface LedgerEntry {
  readonly artifactId: string;
  readonly kind?: "published" | "outcome-unknown" | undefined;
  readonly executionRef?: string | undefined;
  readonly site: string;
  readonly account: string;
  readonly publishedAt: number;
  readonly pendingAttachments: readonly PendingAttachment[];
  readonly operationId?: string | undefined;
  readonly summary?: string | undefined;
  // `created-empty` is a standalone execution create: no run behind it, no results, nothing attached.
  readonly mode?: "create-new" | "append" | "created-empty" | undefined;
  readonly passed?: number | undefined;
  readonly failed?: number | undefined;
  readonly skipped?: number | undefined;
  readonly total?: number | undefined;
}

export interface OutcomeUnknownLedgerEntry extends LedgerEntry {
  readonly kind: "outcome-unknown";
  readonly executionRef?: undefined;
  readonly operationId: string;
  readonly mode: "create-new" | "append";
  readonly pendingAttachments: readonly PendingAttachment[];
}

export function isOutcomeUnknownEntry(entry: LedgerEntry): entry is OutcomeUnknownLedgerEntry {
  return entry.kind === "outcome-unknown";
}

const MAX_ENTRIES = 50;

// A standalone execution create has no run artifact, so it borrows the `artifactId` slot under this
// namespace: `standalone:<KEY>`. Run artifacts are `randomUUID` values, which can never start with it, so
// every artifactId reader here and on the board (`findLedgerEntry`, `withUpdatedPending`, and by
// extension the republish banner and the pending-attachment replay) is looking up an id a real run gave
// it and can never resolve to a standalone entry.
export const STANDALONE_ARTIFACT_PREFIX = "standalone:";

// Prepend the newest entry and cap the list. At 50 the ledger is both the idempotency source (the
// re-publish banner reads the matching entry) and the Executions board's local publish history.
export function withLedgerEntry(entries: readonly LedgerEntry[], entry: LedgerEntry): LedgerEntry[] {
  return [entry, ...entries].slice(0, MAX_ENTRIES);
}

// The most recent entry for this artifact ON THE CURRENT SITE; the idempotency banner reads it.
// Site-scoping is deliberate: a key published under a different site says nothing about this one.
export function findLedgerEntry(
  entries: readonly LedgerEntry[],
  artifactId: string,
  site: string
): LedgerEntry | undefined {
  return entries.find((entry) => entry.artifactId === artifactId && entry.site === site);
}

// Replaces the pending list of the NEWEST matching entry only (order preserved); the resume/retry
// routine records which files are still pending after a replay. A republished run has one entry per
// publish (recordPublish prepends), so touching only the first match keeps an earlier publish's
// pending record intact. A no-op when nothing matches.
export function withUpdatedPending(
  entries: readonly LedgerEntry[],
  artifactId: string,
  site: string,
  pendingAttachments: readonly AttachmentSnapshot[]
): LedgerEntry[] {
  const newest = entries.findIndex((entry) => entry.artifactId === artifactId && entry.site === site);
  return entries.map((entry, index) => (index === newest ? { ...entry, pendingAttachments } : entry));
}

function isOptional(value: unknown, guard: (value: unknown) => boolean): boolean {
  return value === undefined || guard(value);
}

interface StoredPublishedLedgerEntry extends Omit<LedgerEntry, "pendingAttachments"> {
  readonly pendingAttachments: readonly (AttachmentSnapshot | string)[];
}

type StoredLedgerEntry = StoredPublishedLedgerEntry | OutcomeUnknownLedgerEntry;

function isValidEntry(value: unknown): value is StoredLedgerEntry {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const entry = value as Record<string, unknown>;
  const isNumber = (v: unknown): boolean => typeof v === "number";
  const common = (
    typeof entry["artifactId"] === "string" &&
    typeof entry["site"] === "string" &&
    typeof entry["account"] === "string" &&
    typeof entry["publishedAt"] === "number" &&
    Array.isArray(entry["pendingAttachments"]) &&
    entry["pendingAttachments"].every((item) => typeof item === "string" || isAttachmentSnapshot(item)) &&
    isOptional(entry["operationId"], (v) => typeof v === "string")
  );
  if (!common) {return false;}
  if (entry["kind"] === "outcome-unknown") {
    return entry["executionRef"] === undefined
      && typeof entry["operationId"] === "string"
      && (entry["mode"] === "create-new" || entry["mode"] === "append")
      && (entry["pendingAttachments"] as unknown[]).length === 0;
  }
  return typeof entry["executionRef"] === "string" &&
    (entry["kind"] === undefined || entry["kind"] === "published") &&
    isOptional(entry["summary"], (v) => typeof v === "string") &&
    isOptional(entry["mode"], (v) => v === "create-new" || v === "append" || v === "created-empty") &&
    isOptional(entry["passed"], isNumber) &&
    isOptional(entry["failed"], isNumber) &&
    isOptional(entry["skipped"], isNumber) &&
    isOptional(entry["total"], isNumber);
}

// The Memento-backed publish ledger (mirrors RunArtifactStore): the last few publishes, newest
// first, persisted so the idempotency banner survives a reload. Logic lives in the pure functions
// above; this thin adapter only reads/writes the store.
export class PublishLedger {
  private static readonly STORAGE_KEY = "specwright.publishLedger";

  private entries: LedgerEntry[];
  private mutation: Promise<void> = Promise.resolve();
  private readonly initialization: Promise<void>;

  constructor(
    private readonly memento: Memento,
    private readonly logger: Logger
  ) {
    const stored = memento.get<unknown>(PublishLedger.STORAGE_KEY);
    const entries = (Array.isArray(stored) ? stored : []).filter(isValidEntry).slice(0, MAX_ENTRIES);
    const legacyCount = entries.reduce(
      (count, entry) => count + entry.pendingAttachments.filter((item) => typeof item === "string").length,
      0
    );
    this.entries = entries.map((entry): LedgerEntry => {
      return entry.kind === "outcome-unknown"
        ? entry as OutcomeUnknownLedgerEntry
        : { ...entry, pendingAttachments: entry.pendingAttachments.filter(isAttachmentSnapshot) };
    });
    if (legacyCount > 0) {
      this.logger.warn("Discarded legacy pending attachment paths; select the files again", { discarded: legacyCount });
      this.initialization = this.persist(this.entries);
      // Construction cannot await Memento. Keep the rejection observable through `ready` and every
      // mutation while attaching a handler now so an unopened ledger cannot leak an unhandled rejection.
      this.initialization.catch(() => undefined);
    } else {
      this.initialization = Promise.resolve();
    }
  }

  public ready(): Promise<void> {
    return this.initialization;
  }

  public find(artifactId: string, site: string): LedgerEntry | undefined {
    return findLedgerEntry(this.entries, artifactId, site);
  }

  // Entries for the current site only; the tree/board never renders another site's keys.
  public entriesForSite(site: string): LedgerEntry[] {
    return this.entries.filter((entry) => entry.site === site);
  }

  public record(entry: LedgerEntry): Promise<AttachmentSnapshot[]> {
    return this.update((current) => {
      const next = withLedgerEntry(current, entry);
      const retained = new Set(next.flatMap((item) => item.pendingAttachments.map((snapshot) => snapshot.ref)));
      const evicted = current.flatMap((item) => item.pendingAttachments).filter((snapshot) => !retained.has(snapshot.ref));
      return { next, result: evicted };
    });
  }

  // Replay result for the resume/retry routine: the still-pending files replace the entry's list, so a
  // fully-cleared upload leaves an empty `pendingAttachments` and a reload shows no outstanding work.
  public setPendingAttachments(
    artifactId: string,
    site: string,
    pendingAttachments: readonly AttachmentSnapshot[]
  ): Promise<AttachmentSnapshot[]> {
    return this.update((current) => {
      const before = findLedgerEntry(current, artifactId, site)?.pendingAttachments ?? [];
      const next = withUpdatedPending(current, artifactId, site, pendingAttachments);
      const retained = new Set(pendingAttachments.map((snapshot) => snapshot.ref));
      return { next, result: before.filter((snapshot) => !retained.has(snapshot.ref)) };
    });
  }

  public pendingSnapshots(): AttachmentSnapshot[] {
    return this.entries.flatMap((entry) => entry.pendingAttachments.filter(isAttachmentSnapshot));
  }

  public async discardSnapshotRefs(refs: readonly string[]): Promise<void> {
    if (refs.length === 0) {return;}
    const removed = new Set(refs);
    await this.update((current) => ({
      next: current.map((entry) => ({
        ...entry,
        pendingAttachments: entry.pendingAttachments.filter((item) => !removed.has(item.ref)),
      })),
      result: undefined,
    }));
    this.logger.warn("Expired pending attachment snapshots were discarded", { discarded: refs.length });
  }

  // Drops every site's entries and returns how many went. Site-wide on purpose: this is machine-local
  // history, and the command that calls it asks for the whole ledger explicitly.
  public clear(): Promise<{ readonly removed: number; readonly snapshots: readonly AttachmentSnapshot[] }> {
    return this.update((current) => ({
      next: [],
      result: { removed: current.length, snapshots: current.flatMap((entry) => entry.pendingAttachments) },
    }));
  }

  private update<T>(
    transform: (current: readonly LedgerEntry[]) => { readonly next: LedgerEntry[]; readonly result: T }
  ): Promise<T> {
    const task = Promise.all([this.initialization, this.mutation]).then(async () => {
      const { next, result } = transform(this.entries);
      await this.persist(next);
      this.entries = next;
      return result;
    });
    this.mutation = task.then(() => undefined, () => undefined);
    return task;
  }

  private async persist(entries: readonly LedgerEntry[]): Promise<void> {
    try {
      await Promise.resolve(this.memento.update(PublishLedger.STORAGE_KEY, entries));
    } catch (error) {
      this.logger.error("Failed to persist the publish ledger", { error: String(error) });
      throw new PublishLedgerPersistenceError(error);
    }
  }
}

export class PublishLedgerPersistenceError extends Error {
  constructor(cause: unknown) {
    super(`Publish recovery state could not be saved: ${cause instanceof Error ? cause.message : String(cause)}`);
    this.name = "PublishLedgerPersistenceError";
  }
}
