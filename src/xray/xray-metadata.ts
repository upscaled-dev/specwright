import * as vscode from "vscode";
import { ExtensionConfig } from "../core/extension-config";
import { Logger } from "../utils/logger";
import {
  MetadataCapability,
  ProjectDirectory,
  ProjectDirectoryCapability,
  RemoteMetadataSnapshot,
  RemoteSearchCapability,
  RemoteSearchResult,
  SyncProgress,
  SyncScope,
  TestCaseMetadata,
} from "../traceability/contracts";
import { normalizeProjectKeys } from "../traceability/project-scope";
import { XrayAbortError, XrayCachePage, XrayClient, XrayFetchOutcome } from "./xray-client";
import { JiraProjectSearchResult } from "./jira-project-search";
import { CachedMetadata, CACHE_SCHEMA_VERSION, XrayMetadataCache } from "./xray-metadata-cache";
import { buildSearchJql } from "./xray-search";

const GHERKIN_KEYWORD =
  /^(Feature|Background|Scenario Outline|Scenario|Examples|Given|When|Then|And|But)\b/;

interface MetadataState {
  tests: Map<string, TestCaseMetadata>;
  fetchedScopes: string[];
  catalogueProjects: string[];
  completeProjects: string[];
  verifiedAbsentKeys: string[];
  syncedAt: number | undefined;
  errors: string[];
  pages: XrayCachePage[];
}

function emptyState(): MetadataState {
  return {
    tests: new Map(),
    fetchedScopes: [],
    catalogueProjects: [],
    completeProjects: [],
    verifiedAbsentKeys: [],
    syncedAt: undefined,
    errors: [],
    pages: [],
  };
}

function stateFromCached(cached: CachedMetadata): MetadataState {
  return {
    tests: new Map(cached.tests.map((test) => [test.key, test])),
    fetchedScopes: [...cached.fetchedScopes],
    catalogueProjects: [...(cached.catalogueProjects ?? [])],
    completeProjects: [...(cached.completeProjects ?? [])],
    verifiedAbsentKeys: [...(cached.verifiedAbsentKeys ?? [])],
    syncedAt: cached.syncedAt,
    errors: [...cached.errors],
    pages: [...cached.pages],
  };
}

const EMPTY_DIRECTORY: ProjectDirectory = { projects: [], truncated: false };
const MIN_DIRECTORY_TTL_MS = 60_000;

function dedupe(keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    if (!out.includes(key)) {
      out.push(key);
    }
  }
  return out;
}

export interface XrayMetadataDeps {
  client: XrayClient;
  cache: XrayMetadataCache;
  config: ExtensionConfig;
  logger: Logger;
  // The non-secret account identifier (Xray client id) the current state must belong to. Read live
  // so a credential change re-evaluates it; `undefined` when no credentials are stored.
  account: () => Promise<string | undefined>;
  onCredentialsChange: vscode.Event<void>;
  // Lists the projects the connection's Jira credentials can reach, or `undefined` when the connection
  // has no Jira access at all: the directory then stays empty and the project universe falls back to
  // the workspace's own keys.
  listProjects: (signal?: AbortSignal) => Promise<JiraProjectSearchResult | undefined>;
  now?: (() => number) | undefined;
  // The active grammar's key canonicalization, so absent-set and catalogue keying match the keys the
  // model derives from tags. Defaults to the Xray rule (keys are definitionally uppercase).
  canonicalizeKey?: ((key: string) => string) | undefined;
}

/**
 * The Xray `metadata` capability. Offline-first: it loads last-known state from the cache on
 * construction (rendering the tree instantly without a network call), then `sync` batch-fetches
 * test keys plus the configured project catalogue, maps to a neutral snapshot with honest
 * `completeProjects`/`errors`, persists it, and fires `onDidChange`. A project whose catalogue paged
 * short or errored is left out of `completeProjects`, so the model derives no orphans for it while
 * its siblings keep theirs.
 *
 * State is stamped with the account it belongs to and guarded by an account epoch, so an account
 * switch on the same site never surfaces the prior account's metadata: the JWT is dropped, in-memory
 * state is reset and reloaded for the new account, and any sync that straddles the switch is
 * discarded wholesale (no commit, no persist, no fire).
 */
export class XrayMetadataCapability
  implements MetadataCapability, RemoteSearchCapability, ProjectDirectoryCapability, vscode.Disposable
{
  private readonly _onDidChange = new vscode.EventEmitter<void>();
  public readonly onDidChange = this._onDidChange.event;
  private readonly now: () => number;
  private readonly canonicalizeKey: (key: string) => string;
  private readonly credentialsSub: vscode.Disposable;
  private state: MetadataState = emptyState();
  // The project directory, cached in memory per connection (never persisted: it is a cheap list and it
  // must not outlive the credentials that could read it).
  private directory: ProjectDirectory = EMPTY_DIRECTORY;
  private directoryFetchedAt: number | undefined;
  private directoryInFlight: Promise<ProjectDirectory> | undefined;
  // The account the in-memory state belongs to, and an epoch bumped on every credential change.
  private accountStamp: string | undefined;
  private accountEpoch = 0;

  constructor(private readonly deps: XrayMetadataDeps) {
    this.now = deps.now ?? ((): number => Date.now());
    this.canonicalizeKey = deps.canonicalizeKey ?? ((key): string => key.toUpperCase());
    this.credentialsSub = deps.onCredentialsChange(() => this.onCredentialsChanged());
    // Fire-and-forget: loadFromCache swallows and logs its own failures, so nothing here can reject.
    this.loadFromCache().catch(() => undefined);
  }

  // Any credential-store change drops the JWT (covers same-account secret rotation) and, if the
  // account actually changed or was cleared, resets and reloads state for the new account.
  public onCredentialsChanged(): void {
    this.deps.client.invalidateAuth();
    this.accountEpoch += 1;
    // The directory is per connection: the next credentials may reach a different set of projects, so
    // the list is dropped rather than aged out.
    this.directory = EMPTY_DIRECTORY;
    this.directoryFetchedAt = undefined;
    this.reconcileAccount().catch((error) => {
      this.deps.logger.warn(`Xray metadata account reconcile failed: ${String(error)}`);
    });
  }

  private async reconcileAccount(): Promise<void> {
    const epoch = this.accountEpoch;
    const account = await this.deps.account();
    if (epoch !== this.accountEpoch) {
      return;
    }
    if (account === this.accountStamp) {
      return; // same account (secret rotation only); keep the in-memory state
    }
    // Account switched or cleared: drop the prior account's state before anything can render it.
    this.state = emptyState();
    this.accountStamp = account;
    if (account !== undefined) {
      let cached: CachedMetadata | undefined;
      try {
        cached = await this.deps.cache.load();
      } catch (error) {
        this.deps.logger.warn(`Xray metadata cache load failed: ${String(error)}`);
      }
      if (epoch !== this.accountEpoch) {
        return;
      }
      if (cached) {
        this.state = stateFromCached(cached);
      }
    }
    this._onDidChange.fire();
  }

  public snapshot(): RemoteMetadataSnapshot {
    const ttlMs = Math.max(0, this.deps.config.xrayCacheTtlMinutes) * 60_000;
    const stale =
      this.state.syncedAt !== undefined && this.now() - this.state.syncedAt > ttlMs;
    return {
      tests: new Map(this.state.tests),
      fetchedScopes: [...this.state.fetchedScopes],
      catalogueProjects: [...this.state.catalogueProjects],
      completeProjects: [...this.state.completeProjects],
      verifiedAbsentKeys: [...this.state.verifiedAbsentKeys],
      syncedAt: this.state.syncedAt,
      stale,
      errors: [...this.state.errors],
    };
  }

  // The last-known project list, right now. The trusted adapter owns background refresh so every
  // transport call has a trust-owned signal; this raw cache read must never start work by itself.
  public cached(): ProjectDirectory {
    return this.directory;
  }

  // One enumeration at a time: a repaint and an explicit call share the in-flight promise rather than
  // walking the whole site twice. The first caller's signal is therefore the only one honored, which
  // holds while the refresh is the sole production caller.
  public list(signal?: AbortSignal): Promise<ProjectDirectory> {
    if (!this.directoryStale()) {
      return Promise.resolve(this.directory);
    }
    this.directoryInFlight ??= this.fetchDirectory(signal).finally(() => {
      this.directoryInFlight = undefined;
    });
    return this.directoryInFlight;
  }

  // Floored, because this is what makes the read/refresh loop terminate: `cached` kicks a refresh
  // whenever the list is stale and the refresh repaints, so a zero TTL (the setting has no minimum)
  // would re-enumerate the whole site on every repaint, forever.
  private directoryStale(): boolean {
    const ttlMs = Math.max(MIN_DIRECTORY_TTL_MS, this.deps.config.xrayCacheTtlMinutes * 60_000);
    return this.directoryFetchedAt === undefined || this.now() - this.directoryFetchedAt > ttlMs;
  }

  private async fetchDirectory(signal?: AbortSignal): Promise<ProjectDirectory> {
    const epoch = this.accountEpoch;
    let result: JiraProjectSearchResult | undefined;
    try {
      result = await this.deps.listProjects(signal);
    } catch (error) {
      this.deps.logger.warn(`Jira project directory refresh failed: ${String(error)}`);
    }
    // A credential change during the fetch supersedes it: that connection's list is not this one's.
    if (epoch !== this.accountEpoch) {
      return this.directory;
    }
    // Stamped even when the fetch failed or the connection has no Jira access, so a surface repainting
    // on every snapshot change cannot turn a stale directory into a request loop: the TTL is the retry
    // window.
    this.directoryFetchedAt = this.now();
    if (result === undefined) {
      return this.directory;
    }
    this.directory = { projects: result.projects, truncated: result.truncated };
    this._onDidChange.fire();
    return this.directory;
  }

  // The projects a remote search may match a summary in: the sync setting union the already-synced
  // catalogue, which is the widest scope this layer can know (tag-derived keys live in the workspace
  // model, above it, and reach here only once a sync has catalogued them). Never the project directory,
  // since a summary match across every accessible project is a crawl, not a search.
  private searchProjects(): string[] {
    return normalizeProjectKeys([...this.deps.config.xraySyncProjectKeys, ...this.state.catalogueProjects]);
  }

  // Remote free-text/key search beyond the synced snapshot. The neutral JQL builder scopes a summary
  // match to the projects `searchProjects` resolves (or a direct key lookup for a key-shaped input); §5 leniency
  // means an empty `tests` is an honest "no matches", never an invalid query. The JQL carries only
  // the user's search text (a repo tag, not a secret), so logging it at debug is safe.
  public async search(text: string, signal?: AbortSignal): Promise<RemoteSearchResult> {
    const jql = buildSearchJql(this.searchProjects(), text);
    if (jql === undefined) {
      return { tests: [], complete: true };
    }
    this.deps.logger.debug(`Xray remote search: ${jql}`);
    const outcome = await this.deps.client.searchTests(jql, signal);
    return { tests: outcome.tests, complete: outcome.complete && outcome.errors.length === 0 };
  }

  // Additive background merge for a test picked from remote search: fetch its metadata and fold it
  // into the in-memory snapshot without disturbing the catalogue scope (like a key batch). No per-key
  // fallback; `fetchTestsByKeys` batches, and one stale key never poisons it.
  public async mergeKeys(keys: readonly string[], signal?: AbortSignal): Promise<void> {
    const wanted = dedupe(keys.map((key) => this.canonicalizeKey(key))).filter((key) => key !== "");
    if (wanted.length === 0) {
      return;
    }
    // Capture epoch AND account at entry (mirrors `sync`): the account is what persist keys off, and
    // the stamp-drift check below closes the window where this merge authenticated fresh with the NEW
    // account's creds while capturing the OLD stamp; persisting its data under the old cache key
    // would leak across accounts (§7).
    const epoch = this.accountEpoch;
    const account = this.accountStamp ?? (await this.deps.account());
    let outcome: XrayFetchOutcome;
    try {
      outcome = await this.deps.client.fetchTestsByKeys(wanted, signal);
    } catch (error) {
      if (error instanceof XrayAbortError || signal?.aborted) {
        return;
      }
      throw error;
    }
    if (signal?.aborted || outcome.tests.length === 0) {
      return;
    }
    if (epoch !== this.accountEpoch || (this.accountStamp !== undefined && this.accountStamp !== account)) {
      return;
    }
    const merged = new Map(this.state.tests);
    const found = new Set<string>();
    for (const record of outcome.tests) {
      merged.set(record.key, record);
      found.add(record.key);
    }
    // A key the merge just found can't also be "verified absent"; drop it from the absent set so the
    // snapshot never carries a key in both (internally inconsistent, even if model precedence hides it).
    const verifiedAbsentKeys = this.state.verifiedAbsentKeys.filter((key) => !found.has(key));
    this.state = { ...this.state, tests: merged, verifiedAbsentKeys };
    await this.persist(account);
    this._onDidChange.fire();
  }

  public async sync(scope: SyncScope, signal?: AbortSignal, onProgress?: SyncProgress): Promise<void> {
    if (signal?.aborted) {
      return;
    }
    const projectKeys = dedupe(scope.projectKeys ?? []);
    const testKeys = dedupe(scope.testKeys ?? []);
    if (projectKeys.length === 0 && testKeys.length === 0) {
      // Nothing to fetch and no errors possible; leave state, persistence, and listeners untouched.
      return;
    }
    // Capture the account and epoch at entry: the epoch guards against a mid-sync switch, and the
    // captured account is what persist keys off (never a live read at write time), so a cross-window
    // rotation landing between the guard and the write can't retarget the cache key (§7 TOCTOU). The
    // stamp is the account whose cached token/state we hold; before the first stamp is established a
    // live read is correct, since the first sync authenticates fresh with the current credentials.
    const epoch = this.accountEpoch;
    const account = this.accountStamp ?? (await this.deps.account());

    const merged = new Map<string, TestCaseMetadata>();
    const pages: XrayCachePage[] = [];
    const errors: string[] = [];
    const completeProjects: string[] = [];
    let verifiedAbsent: string[] = [];

    try {
      for (const projectKey of projectKeys) {
        const outcome = await this.deps.client.fetchProjectCatalogue(projectKey, signal, (fetched, total) =>
          onProgress?.({ projectKey, fetched, total })
        );
        this.absorb(merged, pages, errors, outcome);
        // Per project: a catalogue that paged short or reported an error authorizes nothing for its
        // own project and says nothing about the others, which keep whatever they earned.
        if (outcome.complete && outcome.errors.length === 0) {
          completeProjects.push(this.canonicalizeKey(projectKey));
        }
      }
      if (testKeys.length > 0) {
        const outcome = await this.deps.client.fetchTestsByKeys(testKeys, signal);
        // The key batch supplements the catalogue with out-of-scope keys; its presence or failure
        // never affects catalogue completeness. Its errors surface in `errors` only.
        this.absorb(merged, pages, errors, outcome);
        // §5 key-batch leniency: getTests silently omits nonexistent keys and still returns 200, so a
        // trustworthy batch (whole outcome complete, no errors) that queried a key and did not get it
        // back is authoritative absence evidence. fetchTestsByKeys merges its internal chunks into one
        // outcome with no per-chunk attribution, so only trust the batch when the whole outcome is
        // clean. A failed or partial batch proves nothing.
        if (outcome.complete && outcome.errors.length === 0) {
          const returned = new Set(outcome.tests.map((test) => this.canonicalizeKey(test.key)));
          verifiedAbsent = testKeys.map((key) => this.canonicalizeKey(key)).filter((key) => !returned.has(key));
        }
      }
    } catch (error) {
      if (error instanceof XrayAbortError || signal?.aborted) {
        return;
      }
      throw error;
    }
    if (signal?.aborted) {
      return;
    }
    // Discard everything this sync fetched (no state commit, no persist, no fire) on either
    // mid-sync account-change window:
    //   (a) the epoch moved: a credential change landed after entry;
    //   (b) the stamp drifted from the captured account: this sync entered after the epoch bump but
    //       before reconcile's restamp, so its JWT had been invalidated and it authenticated fresh
    //       with the NEW account's credentials while capturing the OLD stamp; its data belongs to
    //       the new account and must not land under the old one.
    if (
      epoch !== this.accountEpoch ||
      (this.accountStamp !== undefined && this.accountStamp !== account)
    ) {
      return;
    }

    this.logDriftBasis(merged);

    // A run that errored and learned nothing at all (no catalogue landed, no absence proved, no
    // metadata fetched) is not a sync: keep the last-known state whole, stamp no `syncedAt`, and
    // surface the errors alone. With data already on screen that avoids blanking the panel; on a first
    // sync it is what keeps an unknown catalogue from presenting as "synced just now". A run that
    // learned anything commits it, so one project's failure never discards its siblings' work.
    if (completeProjects.length === 0 && verifiedAbsent.length === 0 && merged.size === 0 && errors.length > 0) {
      this.state = { ...this.state, errors };
      this._onDidChange.fire();
      return;
    }

    this.state = {
      tests: merged,
      fetchedScopes: [...projectKeys, ...testKeys],
      catalogueProjects: projectKeys.map((key) => this.canonicalizeKey(key)),
      completeProjects,
      verifiedAbsentKeys: verifiedAbsent,
      syncedAt: this.now(),
      errors,
      pages,
    };
    await this.persist(account);
    this._onDidChange.fire();
  }

  private absorb(
    merged: Map<string, TestCaseMetadata>,
    pages: XrayCachePage[],
    errors: string[],
    outcome: XrayFetchOutcome
  ): void {
    for (const record of outcome.tests) {
      merged.set(record.key, record);
    }
    pages.push(...outcome.pages);
    errors.push(...outcome.errors);
  }

  // §8-P1 drift-basis guard: for the user's first real sync, confirm the local reconstruction's
  // comparison basis against real stored-gherkin shapes, logging only booleans/counts, never the
  // Gherkin text (the key is a tag already in the repo, not a secret).
  private logDriftBasis(tests: Map<string, TestCaseMetadata>): void {
    for (const test of tests.values()) {
      if (test.gherkin === undefined) {
        continue;
      }
      const lines = test.gherkin.replaceAll("\r\n", "\n").split("\n");
      const firstContent = lines.find((line) => line.trim() !== "") ?? "";
      const startsWithKeyword = GHERKIN_KEYWORD.test(firstContent.trim());
      const tagLineCount = lines.filter((line) => line.trim().startsWith("@")).length;
      const leadingIndent = lines.some((line) => line.trim() !== "" && /^\s/.test(line));
      this.deps.logger.info(
        `drift-basis ${test.key}: startsWithKeyword=${startsWithKeyword} tagLines=${tagLineCount} lines=${lines.length} leadingIndent=${leadingIndent}`
      );
    }
  }

  private async loadFromCache(): Promise<void> {
    const epoch = this.accountEpoch;
    const account = await this.deps.account();
    let cached: CachedMetadata | undefined;
    try {
      cached = await this.deps.cache.load();
    } catch (error) {
      this.deps.logger.warn(`Xray metadata cache load failed: ${String(error)}`);
      return;
    }
    // A credential change during the load supersedes it; reconcileAccount owns the state now.
    if (epoch !== this.accountEpoch) {
      return;
    }
    this.accountStamp = account;
    if (!cached) {
      return;
    }
    this.state = stateFromCached(cached);
    this._onDidChange.fire();
  }

  // `account` is the identifier captured at sync entry, not a live read; the data belongs to that
  // account, so it is keyed there even if the live credentials have since rotated.
  private async persist(account: string | undefined): Promise<void> {
    if (this.state.syncedAt === undefined) {
      return;
    }
    const data: CachedMetadata = {
      schemaVersion: CACHE_SCHEMA_VERSION,
      syncedAt: this.state.syncedAt,
      fetchedScopes: [...this.state.fetchedScopes],
      catalogueProjects: [...this.state.catalogueProjects],
      completeProjects: [...this.state.completeProjects],
      verifiedAbsentKeys: [...this.state.verifiedAbsentKeys],
      errors: [...this.state.errors],
      tests: [...this.state.tests.values()],
      pages: [...this.state.pages],
    };
    try {
      await this.deps.cache.saveForAccount(account, data);
    } catch (error) {
      this.deps.logger.warn(`Xray metadata cache save failed: ${String(error)}`);
    }
  }

  public dispose(): void {
    this.credentialsSub.dispose();
    this._onDidChange.dispose();
  }
}
