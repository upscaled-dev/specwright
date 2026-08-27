import * as vscode from "vscode";
import type { ExtensionConfig } from "../core/extension-config";
import {
  ORGANIZATION_ITEM_LIMIT,
  type MetadataCapability,
  type OrganizationCapability,
  type OrganizationSnapshot,
  type RemoteTestSet,
  type RemoteTestSetMember,
  type RepositoryProject,
  type TestSetProject,
  type TestSetRefreshResult,
} from "../traceability/contracts";
import type { Logger } from "../utils/logger";
import { graphqlErrorSummaries } from "./xray-diagnostics";
import { XrayAbortError, type XrayClient } from "./xray-client";
import type { XrayCacheIdentity } from "./xray-metadata-cache";
import { jqlString } from "./xray-search";

const LIST_LIMIT = 50;
const LIST_MEMBER_LIMIT = 50;
const MEMBER_PAGE_LIMIT = 100;
const MAX_MEMBERS = 10_000;
export const ORGANIZATION_SYNC_PROJECT_LIMIT = 3;
const CACHE_SCHEMA_VERSION = 1;

interface CachedOrganization {
  readonly schemaVersion: typeof CACHE_SCHEMA_VERSION;
  readonly syncedAt: number;
  readonly projects: readonly TestSetProject[];
  readonly omittedTestSetProjectCount: number;
}

interface OrganizationState {
  readonly syncedAt?: number | undefined;
  readonly projects: readonly TestSetProject[];
  // How many projects the current state leaves out, never a running total: every site that re-bounds
  // the same state combines with Math.max, so bounding it again cannot inflate the count.
  readonly omittedTestSetProjectCount: number;
}

function boundProjects(
  source: readonly TestSetProject[],
  preferredSetKey?: string
): { projects: TestSetProject[]; omitted: number } {
  let remaining = ORGANIZATION_ITEM_LIMIT;
  const preferredProject = preferredSetKey
    ? source.find((project) => project.testSets.some((set) => set.key === preferredSetKey))
    : undefined;
  const ordered = preferredProject
    ? [preferredProject, ...source.filter((project) => project !== preferredProject)]
    : [...source];
  const projects: TestSetProject[] = [];
  for (const project of ordered.slice(0, ORGANIZATION_SYNC_PROJECT_LIMIT)) {
    if (remaining <= 0) {break;}
    remaining -= 1;
    const preferred = preferredSetKey ? project.testSets.find((set) => set.key === preferredSetKey) : undefined;
    const sets = preferred ? [preferred, ...project.testSets.filter((set) => set !== preferred)] : [...project.testSets];
    const testSets: RemoteTestSet[] = [];
    let truncated = false;
    for (const set of sets) {
      if (remaining <= 0) {truncated = true; break;}
      remaining -= 1;
      const hydrated = set.members.slice(0, remaining);
      remaining -= hydrated.length;
      const complete = hydrated.length === set.members.length;
      testSets.push(complete ? set : {
        ...set,
        members: hydrated,
        membershipComplete: false,
        truncated: true,
        errors: [...set.errors, `Organization cache reached the ${ORGANIZATION_ITEM_LIMIT}-item limit.`],
      });
      if (!complete) {truncated = true; break;}
    }
    projects.push(truncated || testSets.length < project.testSets.length
      ? { ...project, testSets, complete: false, truncated: true, errors: [...project.errors, `Organization cache reached the ${ORGANIZATION_ITEM_LIMIT}-item limit.`] }
      : { ...project, testSets });
  }
  return { projects, omitted: Math.max(0, source.length - projects.length) };
}

export class XrayOrganizationCache {
  constructor(private readonly memento: vscode.Memento, private readonly identity: XrayCacheIdentity) {}

  private keyFor(account: string | undefined): string | undefined {
    return account
      ? `traceability:xray-organization:${this.identity.endpoint}:${account}:${this.identity.workspaceId}:${CACHE_SCHEMA_VERSION}`
      : undefined;
  }

  public loadForAccount(account: string | undefined): CachedOrganization | undefined {
    const key = this.keyFor(account);
    const value = key ? this.memento.get<CachedOrganization>(key) : undefined;
    if (value?.schemaVersion !== CACHE_SCHEMA_VERSION) {return undefined;}
    const bounded = boundProjects(value.projects);
    return {
      ...value,
      projects: bounded.projects,
      omittedTestSetProjectCount: Math.max(value.omittedTestSetProjectCount ?? 0, bounded.omitted),
    };
  }

  public async save(account: string | undefined, state: OrganizationState): Promise<void> {
    if (state.syncedAt === undefined) {return;}
    const key = this.keyFor(account);
    if (key) {
      const bounded = boundProjects(state.projects);
      await this.memento.update(key, {
        schemaVersion: CACHE_SCHEMA_VERSION,
        syncedAt: state.syncedAt,
        projects: bounded.projects,
        omittedTestSetProjectCount: Math.max(state.omittedTestSetProjectCount, bounded.omitted),
      } satisfies CachedOrganization);
    }
  }
}

interface RawMember { jira?: { key?: unknown; summary?: unknown } | null; }
interface RawSet {
  issueId?: unknown;
  jira?: { key?: unknown; summary?: unknown; description?: unknown } | null;
  tests?: { total?: unknown; results?: unknown } | null;
}

function string(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function integer(value: unknown): number | undefined {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : undefined;
}

function members(value: unknown, limit = MAX_MEMBERS): { members: { key: string; summary?: string }[]; malformed: boolean } {
  if (!Array.isArray(value)) {return { members: [], malformed: true };}
  const output: { key: string; summary?: string }[] = [];
  const seen = new Set<string>();
  let malformed = false;
  if (value.length > limit) {malformed = true;}
  for (const raw of (value as (RawMember | null)[]).slice(0, limit)) {
    const key = string(raw?.jira?.key)?.toUpperCase();
    if (!key) {malformed = true; continue;}
    if (seen.has(key)) {continue;}
    seen.add(key);
    const summary = string(raw?.jira?.summary);
    output.push(summary ? { key, summary } : { key });
  }
  return { members: output, malformed };
}

function parseSet(raw: RawSet | null, memberLimit = MAX_MEMBERS): RemoteTestSet | undefined {
  const key = string(raw?.jira?.key)?.toUpperCase();
  const issueId = string(raw?.issueId);
  if (!key || !issueId) {return undefined;}
  const total = integer(raw?.tests?.total);
  const parsed = members(raw?.tests?.results, memberLimit);
  const errors: string[] = [];
  if (total === undefined || parsed.malformed) {errors.push("Xray returned incomplete Test Set membership data.");}
  const complete = total !== undefined && !parsed.malformed && parsed.members.length === total;
  const summary = string(raw?.jira?.summary);
  const description = string(raw?.jira?.description);
  return {
    key,
    issueId,
    ...(summary ? { summary } : {}),
    ...(description ? { description } : {}),
    members: parsed.members,
    remoteMemberCount: total ?? parsed.members.length,
    membershipComplete: complete,
    truncated: total !== undefined && parsed.members.length < total,
    errors,
  };
}

function listQuery(projectKey: string): string {
  return `{ getTestSets(jql: ${JSON.stringify(`project = ${jqlString(projectKey)}`)}, limit: ${LIST_LIMIT}, start: 0) { total results { issueId jira(fields: ["key", "summary", "description"]) tests(limit: ${LIST_MEMBER_LIMIT}, start: 0) { total results { jira(fields: ["key", "summary"]) } } } } }`;
}

function exactQuery(key: string): string {
  return `{ getTestSets(jql: ${JSON.stringify(`key = ${jqlString(key)}`)}, limit: 1, start: 0) { total results { issueId jira(fields: ["key", "summary", "description"]) tests(limit: ${LIST_MEMBER_LIMIT}, start: 0) { total results { jira(fields: ["key", "summary"]) } } } } }`;
}

function memberPageQuery(issueId: string, start: number): string {
  return `{ getTestSet(issueId: ${JSON.stringify(issueId)}) { issueId jira(fields: ["key", "summary", "description"]) tests(limit: ${MEMBER_PAGE_LIMIT}, start: ${start}) { total results { jira(fields: ["key", "summary"]) } } } }`;
}

function dataField(body: unknown, field: "getTestSets" | "getTestSet"): unknown {
  return body !== null && typeof body === "object"
    ? (body as { data?: Record<string, unknown> | null }).data?.[field]
    : undefined;
}

export class XrayOrganizationReader {
  constructor(private readonly client: Pick<XrayClient, "readGraphql">) {}

  public async list(projectKey: string, signal?: AbortSignal): Promise<TestSetProject> {
    const body = await this.client.readGraphql(listQuery(projectKey), signal);
    const graphqlErrors = graphqlErrorSummaries(body);
    const raw = dataField(body, "getTestSets") as { total?: unknown; results?: unknown } | undefined;
    const total = integer(raw?.total);
    const allRows = Array.isArray(raw?.results) ? raw.results as (RawSet | null)[] : [];
    const rows = allRows.slice(0, LIST_LIMIT);
    const testSets = rows.map((row) => parseSet(row, LIST_MEMBER_LIMIT)).filter((value): value is RemoteTestSet => value !== undefined);
    const errors = [...graphqlErrors];
    if (total === undefined || testSets.length !== rows.length) {
      errors.push("Xray returned an incomplete Test Set catalogue.");
    }
    const truncated = allRows.length > LIST_LIMIT || total !== undefined && total > LIST_LIMIT;
    if (truncated) {errors.push(`Test Set catalogue reached the ${LIST_LIMIT}-set display limit.`);}
    return {
      projectKey,
      testSets,
      complete: graphqlErrors.length === 0 && total !== undefined && !truncated && testSets.length === total,
      truncated,
      errors,
    };
  }

  public async refresh(key: string, signal?: AbortSignal): Promise<RemoteTestSet | undefined> {
    const initialBody = await this.client.readGraphql(exactQuery(key), signal);
    if (graphqlErrorSummaries(initialBody).length > 0) {return undefined;}
    const root = dataField(initialBody, "getTestSets") as { total?: unknown; results?: unknown } | undefined;
    const rows = Array.isArray(root?.results) ? root.results as (RawSet | null)[] : [];
    const initial = rows.length === 1 ? parseSet(rows[0] ?? null) : undefined;
    if (initial?.key !== key.toUpperCase() || integer(root?.total) !== 1) {return undefined;}
    if (initial.membershipComplete) {return initial;}
    if (initial.remoteMemberCount > MAX_MEMBERS) {
      return { ...initial, truncated: true, errors: [`Test Set membership exceeds the ${MAX_MEMBERS}-member run limit.`] };
    }
    const all = new Map<string, RemoteTestSetMember>();
    let last: RemoteTestSet | undefined;
    for (let start = 0; start < initial.remoteMemberCount; start += MEMBER_PAGE_LIMIT) {
      if (signal?.aborted) {throw new XrayAbortError();}
      const body = await this.client.readGraphql(memberPageQuery(initial.issueId, start), signal);
      if (graphqlErrorSummaries(body).length > 0) {return undefined;}
      const next = parseSet(dataField(body, "getTestSet") as RawSet | null);
      if (next?.key !== initial.key || next.remoteMemberCount !== initial.remoteMemberCount) {return undefined;}
      for (const member of next.members) {all.set(member.key, member);}
      last = next;
      if (next.members.length === 0 && all.size < next.remoteMemberCount) {return undefined;}
    }
    if (!last || all.size !== initial.remoteMemberCount) {return undefined;}
    return { ...last, members: [...all.values()], membershipComplete: true, truncated: false, errors: [] };
  }
}

export interface XrayOrganizationDeps {
  readonly reader: XrayOrganizationReader;
  readonly metadata: MetadataCapability;
  readonly cache: XrayOrganizationCache;
  readonly config: ExtensionConfig;
  readonly logger: Logger;
  readonly account: () => Promise<string | undefined>;
  readonly onCredentialsChange: vscode.Event<void>;
  readonly projectOf: (key: string) => string;
  readonly now?: (() => number) | undefined;
}

function retainComplete(next: RemoteTestSet, previous: RemoteTestSet | undefined): RemoteTestSet {
  if (next.membershipComplete || !previous?.membershipComplete) {return next;}
  return {
    ...next,
    members: previous.members,
    membershipComplete: false,
    truncated: next.truncated || previous.members.length < next.remoteMemberCount,
    errors: [...next.errors, "Showing last-known member details; exact membership requires refresh."],
    membersLastKnown: true,
  };
}

export class XrayOrganizationCapability implements OrganizationCapability, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  public readonly onDidChange = this.emitter.event;
  private readonly lifecycle = new AbortController();
  private readonly subscription: vscode.Disposable;
  private readonly now: () => number;
  private state: OrganizationState = { projects: [], omittedTestSetProjectCount: 0 };
  private accountStamp: string | undefined;
  private epoch = 0;
  private readonly refreshes = new Map<string, Promise<TestSetRefreshResult>>();

  constructor(private readonly deps: XrayOrganizationDeps) {
    this.now = deps.now ?? Date.now;
    this.subscription = deps.onCredentialsChange(() => this.credentialsChanged());
    this.load(this.lifecycle.signal).catch((error) => {
      if (!this.lifecycle.signal.aborted) {
        this.deps.logger.warn(`Xray organization cache account lookup failed: ${String(error)}`);
      }
    });
  }

  private async load(signal: AbortSignal): Promise<void> {
    const epoch = this.epoch;
    const account = await this.deps.account();
    const cached = await Promise.resolve().then(() => this.deps.cache.loadForAccount(account)).catch((error) => {
      this.deps.logger.warn(`Xray organization cache load failed: ${String(error)}`);
      return undefined;
    });
    if (signal.aborted || epoch !== this.epoch || (this.accountStamp !== undefined && this.accountStamp !== account)) {return;}
    this.accountStamp = account;
    if (cached) {
      const bounded = boundProjects(cached.projects);
      this.state = {
        syncedAt: cached.syncedAt,
        projects: bounded.projects,
        omittedTestSetProjectCount: Math.max(
          cached.omittedTestSetProjectCount ?? 0,
          bounded.omitted
        ),
      };
      this.emitter.fire();
    }
  }

  private credentialsChanged(): void {
    this.epoch += 1;
    this.state = { projects: [], omittedTestSetProjectCount: 0 };
    this.accountStamp = undefined;
    this.emitter.fire();
    this.load(this.lifecycle.signal).catch((error) => {
      if (!this.lifecycle.signal.aborted) {
        this.deps.logger.warn(`Xray organization cache account lookup failed: ${String(error)}`);
      }
    });
  }

  public snapshot(): OrganizationSnapshot {
    const metadata = this.deps.metadata.snapshot();
    const testSetItems = this.state.projects.reduce(
      (total, project) => total + 1 + project.testSets.reduce((sets, set) => sets + 1 + set.members.length, 0),
      0
    );
    let remaining = Math.max(0, ORGANIZATION_ITEM_LIMIT - testSetItems);
    let omittedRepositoryProjectCount = 0;
    const repositories: RepositoryProject[] = [];
    for (const projectKey of metadata.catalogueProjects) {
      if (remaining <= 0) {omittedRepositoryProjectCount += 1; continue;}
      remaining -= 1;
      const allTests = [...metadata.tests.values()].filter((test) => this.deps.projectOf(test.key) === projectKey);
      const tests = allTests.slice(0, remaining);
      remaining -= tests.length;
      const complete = metadata.completeProjects.includes(projectKey);
      const bounded = tests.length === allTests.length;
      repositories.push({
        projectKey,
        tests,
        complete: complete && bounded,
        truncated: !bounded || !complete && metadata.errors.some((error) => error.includes("pagination cap")),
        errors: bounded ? (complete ? [] : metadata.errors) : [...metadata.errors, `Organization snapshot reached the ${ORGANIZATION_ITEM_LIMIT}-item limit.`],
      });
    }
    const ttl = Math.max(0, this.deps.config.xrayCacheTtlMinutes) * 60_000;
    return {
      repositories,
      testSetProjects: this.state.projects,
      syncedAt: this.state.syncedAt,
      stale: this.state.syncedAt !== undefined && this.now() - this.state.syncedAt > ttl,
      omittedTestSetProjectCount: this.state.omittedTestSetProjectCount,
      omittedRepositoryProjectCount,
    };
  }

  public async sync(projectKeys: readonly string[], signal?: AbortSignal): Promise<void> {
    const combined = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
    const epoch = this.epoch;
    const account = this.accountStamp ?? await this.deps.account();
    if (combined.aborted || epoch !== this.epoch) {return;}
    this.accountStamp ??= account;
    if (this.accountStamp !== account) {return;}
    const projects: TestSetProject[] = [];
    const requested = [...new Set(projectKeys.map((key) => key.toUpperCase()))];
    const hydrated = requested.slice(0, ORGANIZATION_SYNC_PROJECT_LIMIT);
    for (const projectKey of hydrated) {
      if (combined.aborted) {return;}
      try {
        const next = await this.deps.reader.list(projectKey, combined);
        const previous = this.state.projects.find((project) => project.projectKey === projectKey);
        const oldSets = new Map(previous?.testSets.map((set) => [set.key, set]));
        const testSets = next.testSets.map((set) => retainComplete(set, oldSets.get(set.key)));
        if (!next.complete) {
          for (const old of previous?.testSets ?? []) {
            if (old.membershipComplete && !testSets.some((set) => set.key === old.key)) {testSets.push(old);}
          }
        }
        projects.push({ ...next, testSets });
      } catch (error) {
        if (combined.aborted) {return;}
        this.deps.logger.warn(`Xray Test Set sync failed for ${projectKey}: ${String(error)}`);
        const previous = this.state.projects.find((project) => project.projectKey === projectKey);
        projects.push(previous
          ? { ...previous, complete: false, errors: ["Test Set refresh failed; showing last-known data."] }
          : { projectKey, testSets: [], complete: false, truncated: false, errors: ["Test Set refresh failed."] });
      }
    }
    if (combined.aborted || epoch !== this.epoch || this.accountStamp !== account) {return;}
    const nextState = {
      syncedAt: this.now(),
      projects,
      omittedTestSetProjectCount: Math.max(0, requested.length - hydrated.length),
    } satisfies OrganizationState;
    await this.deps.cache.save(account, nextState).catch((error) => this.deps.logger.warn(`Xray organization cache save failed: ${String(error)}`));
    if (combined.aborted || epoch !== this.epoch || this.accountStamp !== account) {return;}
    this.state = nextState;
    this.emitter.fire();
  }

  public refreshTestSet(key: string, signal?: AbortSignal): Promise<TestSetRefreshResult> {
    const canonical = key.toUpperCase();
    const current = this.refreshes.get(canonical);
    if (current) {return current;}
    const task = this.refreshNow(canonical, signal);
    this.refreshes.set(canonical, task);
    task.finally(() => {if (this.refreshes.get(canonical) === task) {this.refreshes.delete(canonical);}}).catch(() => undefined);
    return task;
  }

  private async refreshNow(key: string, signal?: AbortSignal): Promise<TestSetRefreshResult> {
    const combined = signal ? AbortSignal.any([signal, this.lifecycle.signal]) : this.lifecycle.signal;
    const epoch = this.epoch;
    const account = this.accountStamp ?? await this.deps.account();
    if (combined.aborted || epoch !== this.epoch) {return { status: "failed", testSet: this.findSet(key) };}
    this.accountStamp ??= account;
    if (this.accountStamp !== account) {return { status: "failed", testSet: this.findSet(key) };}
    let refreshed: RemoteTestSet | undefined;
    try {
      refreshed = await this.deps.reader.refresh(key, combined);
    } catch (error) {
      if (!combined.aborted) {this.deps.logger.warn(`Xray Test Set refresh failed for ${key}: ${String(error)}`);}
      return { status: "failed", testSet: this.findSet(key) };
    }
    if (combined.aborted
      || epoch !== this.epoch
      || this.accountStamp !== account
      || !refreshed) {
      return { status: "failed", testSet: this.findSet(key) };
    }
    if (!refreshed.membershipComplete) {
      return { status: "incomplete", testSet: this.findSet(key) ?? refreshed };
    }
    const projectKey = this.deps.projectOf(key);
    const projects = this.state.projects.map((project) => (project.projectKey === projectKey
      ? { ...project, testSets: [...project.testSets.filter((set) => set.key !== key), refreshed].sort((a, b) => a.key.localeCompare(b.key)) }
      : project));
    if (!projects.some((project) => project.projectKey === projectKey)) {
      projects.push({ projectKey, testSets: [refreshed], complete: false, truncated: false, errors: [] });
    }
    const bounded = boundProjects(projects, key);
    const nextState = {
      ...this.state,
      projects: bounded.projects,
      omittedTestSetProjectCount: Math.max(this.state.omittedTestSetProjectCount, bounded.omitted),
    };
    await this.deps.cache.save(account, nextState).catch((error) => this.deps.logger.warn(`Xray organization cache save failed: ${String(error)}`));
    if (combined.aborted || epoch !== this.epoch || this.accountStamp !== account) {
      return { status: "failed", testSet: this.findSet(key) };
    }
    this.state = nextState;
    this.emitter.fire();
    return { status: "complete", testSet: refreshed };
  }

  private findSet(key: string): RemoteTestSet | undefined {
    return this.state.projects.flatMap((project) => project.testSets).find((set) => set.key === key);
  }

  public dispose(): void {
    this.lifecycle.abort();
    this.subscription.dispose();
    this.emitter.dispose();
  }
}
