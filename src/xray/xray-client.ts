import { Logger } from "../utils/logger";
import { NormalizedStatus } from "../traceability/contracts";
import { XrayCredentials } from "./xray-credential-store";
import { XrayRegion, xrayBaseUrl } from "./xray-region";
import { describeJwt, describeShape, graphqlErrorSummaries, scrubJwtLike } from "./xray-diagnostics";

const REQUEST_TIMEOUT_MS = 30_000;
// Proactively reuse the JWT well inside its ~24h life so an in-flight batch never trips the true
// expiry mid-pagination; a 401 still forces a refresh regardless.
const JWT_REUSE_MS = 23 * 60 * 60 * 1000;
// getTests page size (schema max 100). coverableIssues stays FLAT and small so the multiplicative
// item budget holds: 100 tests × 20 coverable = 2100 items, well under the 10 000 cap; resolver
// count is getTests + testType + status + coverableIssues = 4, well under 25 (§5).
const PAGE_LIMIT = 100;
const COVERABLE_LIMIT = 20;
// Hard ceiling on items paginated per scope (§5's documented 10 000-item budget). A server that
// reports monotonically growing totals would otherwise page forever; stop here, marked incomplete.
const MAX_SCOPE_ITEMS = 10_000;
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 300;
const BACKOFF_CAP_MS = 8_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

// The two JSON file parts of the Cucumber multipart import (`results` = Cucumber report, `info` = issue
// fields + xrayFields), each already serialized. postMultipart wraps them as `application/json` Blobs.
export interface MultipartParts {
  readonly results: string;
  readonly info: string;
}

// A page the cache records so it can reason about pagination completion and staleness per §7.
export interface XrayCachePage {
  readonly fetchedAt: number;
  readonly query: string;
  readonly start: number;
  readonly total?: number | undefined;
}

export interface XrayTestRecord {
  readonly key: string;
  // The remote issue id — Xray addresses mutations by `issueId`, not the Jira key. Already requested
  // in the getTests selection; retained for the authoring/push paths.
  readonly issueId?: string | undefined;
  readonly summary?: string | undefined;
  readonly status?: NormalizedStatus | undefined;
  readonly gherkin?: string | undefined;
  readonly coverageKeys?: readonly string[] | undefined;
  // Xray's `testType { name kind }` (kind ∈ Gherkin/Steps/Unstructured). The automation-binding
  // hook reads `kind` to classify preflight compatibility (Gherkin-only).
  readonly testType?: { readonly name: string; readonly kind: string } | undefined;
}

// The result of fetching one or more scopes. `complete` is false when any page failed or pagination
// was cut short — the capability demotes completeness so orphans are never derived from it.
export interface XrayFetchOutcome {
  readonly tests: XrayTestRecord[];
  readonly pages: XrayCachePage[];
  complete: boolean;
  readonly errors: string[];
}

export interface XrayClientDeps {
  region: XrayRegion;
  logger: Logger;
  credentials: () => Promise<XrayCredentials | undefined>;
  fetchImpl?: FetchLike | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  random?: (() => number) | undefined;
}

// Cancellation propagated from the caller's AbortSignal. Distinct from a timeout (which is a
// retryable transport fault) so backoff never keeps retrying a user-cancelled sync.
export class XrayAbortError extends Error {
  constructor() {
    super("Aborted");
    this.name = "XrayAbortError";
  }
}

// Bad credentials / non-retryable auth failures. Carries a value-free, user-facing message.
export class XrayAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XrayAuthError";
  }
}

// A GraphQL mutation that came back 200 but with a non-empty `errors` array (e.g. a bad project key
// or a permission denial). Carries the value-free, JWT-scrubbed error summaries for the toast.
export class XrayMutationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XrayMutationError";
  }
}

// A transient transport fault (429, 5xx, timeout, network) that backoff should retry.
class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
}

interface TimedResponse {
  status: number;
  ok: boolean;
  bodyText: string;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseBody(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return bodyText;
  }
}

function stringifyShape(value: unknown): string {
  return JSON.stringify(describeShape(value), null, 2);
}

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new XrayAbortError());
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new XrayAbortError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function dedupe(keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    if (!out.includes(key)) {
      out.push(key);
    }
  }
  return out;
}

function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function normalizeXrayStatus(name: string, color: string | undefined): NormalizedStatus {
  const upper = name.toUpperCase();
  let category: NormalizedStatus["category"];
  if (upper.includes("PASS")) {
    category = "passed";
  } else if (upper.includes("FAIL") || upper.includes("ABORT") || upper.includes("ERROR")) {
    category = "failed";
  } else if (upper.includes("TODO") || upper.includes("TO DO") || upper.includes("EXEC")) {
    category = "pending";
  } else {
    category = "unknown";
  }
  return color !== undefined
    ? { category, providerValue: name, color }
    : { category, providerValue: name };
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

interface RawTest {
  issueId?: unknown;
  gherkin?: unknown;
  status?: { name?: unknown; color?: unknown } | null;
  testType?: { name?: unknown; kind?: unknown } | null;
  jira?: { key?: unknown; summary?: unknown } | null;
  coverableIssues?: { results?: Array<{ jira?: { key?: unknown } | null } | null> | null } | null;
}

function toTestRecord(raw: RawTest | null): XrayTestRecord | undefined {
  const key = readString(raw?.jira?.key)?.toUpperCase();
  if (!key) {
    return undefined;
  }
  const record: {
    key: string;
    issueId?: string;
    summary?: string;
    status?: NormalizedStatus;
    gherkin?: string;
    coverageKeys?: string[];
    testType?: { name: string; kind: string };
  } = { key };
  const issueId = readString(raw?.issueId);
  if (issueId !== undefined) {
    record.issueId = issueId;
  }
  const summary = readString(raw?.jira?.summary);
  if (summary !== undefined) {
    record.summary = summary;
  }
  const statusName = readString(raw?.status?.name);
  if (statusName !== undefined) {
    record.status = normalizeXrayStatus(statusName, readString(raw?.status?.color));
  }
  const testTypeKind = readString(raw?.testType?.kind);
  if (testTypeKind !== undefined) {
    record.testType = { name: readString(raw?.testType?.name) ?? testTypeKind, kind: testTypeKind };
  }
  const gherkin = readString(raw?.gherkin);
  if (gherkin !== undefined) {
    record.gherkin = gherkin;
  }
  const coverageKeys: string[] = [];
  for (const entry of raw?.coverableIssues?.results ?? []) {
    const coverageKey = readString(entry?.jira?.key)?.toUpperCase();
    if (coverageKey && !coverageKeys.includes(coverageKey)) {
      coverageKeys.push(coverageKey);
    }
  }
  if (coverageKeys.length > 0) {
    record.coverageKeys = coverageKeys;
  }
  return record;
}

interface TestPage {
  total: number | undefined;
  results: (RawTest | null)[];
}

function parseTestPage(body: unknown): TestPage {
  const getTests =
    body !== null && typeof body === "object"
      ? (body as { data?: { getTests?: { total?: unknown; results?: unknown } } }).data?.getTests
      : undefined;
  const total = typeof getTests?.total === "number" ? getTests.total : undefined;
  const results = Array.isArray(getTests?.results) ? (getTests.results as (RawTest | null)[]) : [];
  return { total, results };
}

type PageTermination = { done: true; error?: string } | { done: false; nextStart: number };

// Decides whether pagination continues after a page. `start + count` is the index past this page's
// last item; reaching `total` means every item was seen. An empty page before `total`, or crossing
// the item cap, terminates the scope as incomplete (value-free diagnostic).
function pageTermination(jql: string, start: number, page: TestPage): PageTermination {
  const seen = start + page.results.length;
  if (page.total === undefined || seen >= page.total) {
    return { done: true };
  }
  if (page.results.length === 0) {
    return { done: true, error: `${jql}: empty page at start ${start} with total ${page.total} — pagination incomplete` };
  }
  const nextStart = start + PAGE_LIMIT;
  if (nextStart >= MAX_SCOPE_ITEMS) {
    return { done: true, error: `${jql}: reached the ${MAX_SCOPE_ITEMS}-item pagination cap — scope truncated, marked incomplete` };
  }
  return { done: false, nextStart };
}

function testsQuery(jql: string, start: number): string {
  return `{ getTests(jql: ${JSON.stringify(jql)}, limit: ${PAGE_LIMIT}, start: ${start}) { total results { issueId gherkin testType { name kind } status { name color final } jira(fields: ["key", "summary"]) coverableIssues(limit: ${COVERABLE_LIMIT}) { results { jira(fields: ["key"]) } } } } }`;
}

export interface XrayCreateTestSpec {
  readonly project: string;
  readonly summary: string;
  readonly gherkin: string;
}

// The created issue read back from the SAME mutation response (§ mutation extract): `CreateTestResult
// { test { issueId jira(fields:["key"]) } warnings }`, and the identical pair under `testSet`/`testPlan`
// for the container creates. `key` is absent when the response carried no readable one — the create
// still happened remotely, so the caller must not silently drop it.
export interface XrayCreatedTest {
  readonly key?: string | undefined;
  readonly issueId?: string | undefined;
  readonly warnings: readonly string[];
}

// Cucumber test = `testType { name: "Cucumber" }` (UpdateTestTypeInput has no `kind`); only `jira` is
// required, project + summary ride its `fields` object (Xray sets the Test issuetype). `jira` is a
// JSON! scalar, passed as an inline object literal; every string is JSON-escaped.
function createTestMutation(spec: XrayCreateTestSpec): string {
  const gherkin = JSON.stringify(spec.gherkin);
  const project = JSON.stringify(spec.project);
  const summary = JSON.stringify(spec.summary);
  return `mutation { createTest(testType: { name: "Cucumber" }, gherkin: ${gherkin}, jira: { fields: { project: { key: ${project} }, summary: ${summary} } }) { test { issueId jira(fields: ["key"]) } warnings } }`;
}

// `createTestSet(testIssueIds: [String], jira: JSON!)`, `createTestPlan(savedFilter, testIssueIds,
// jira: JSON!)` and `createTestExecution(testIssueIds, tests, testEnvironments, jira: JSON!)` take the
// same `jira` literal `createTestMutation` builds. `savedFilter` is never passed: it is mutually
// exclusive with `testIssueIds`. Absent `testIssueIds` omits the argument entirely, which is how the
// empty execution is created; `testEnvironments` is likewise never passed, since the publish dialog owns
// environments. The selection stops at the created issue: `tests(...)` is a connection needing its own
// limit, so reading the members back would burn item budget for nothing.
function createContainerMutation(
  mutation: string,
  field: string,
  project: string,
  summary: string,
  testIssueIds: readonly string[] | undefined
): string {
  const members =
    testIssueIds === undefined ? "" : `testIssueIds: [${testIssueIds.map((id) => JSON.stringify(id)).join(", ")}], `;
  return `mutation { ${mutation}(${members}jira: { fields: { project: { key: ${JSON.stringify(project)} }, summary: ${JSON.stringify(summary)} } }) { ${field} { issueId jira(fields: ["key"]) } warnings } }`;
}

// One parser for every create mutation: `mutation` names the field under `data`, `field` the created
// issue under it (test/testSet/testPlan/testExecution). The containers expose the same `issueId` +
// `jira(fields)` pair as Test, so only those two names differ.
function parseCreated(body: unknown, mutation: string, field: string): XrayCreatedTest {
  const data =
    body !== null && typeof body === "object"
      ? (body as { data?: Record<string, Record<string, unknown> | null> | null }).data
      : undefined;
  const result = data?.[mutation] ?? undefined;
  const issue = result?.[field] as { issueId?: unknown; jira?: { key?: unknown } | null } | null | undefined;
  const key = readString(issue?.jira?.key)?.toUpperCase();
  const issueId = readString(issue?.issueId);
  const rawWarnings = result?.["warnings"];
  const warnings = Array.isArray(rawWarnings)
    ? rawWarnings.filter((warning): warning is string => typeof warning === "string" && warning !== "")
    : [];
  const record: { key?: string; issueId?: string; warnings: string[] } = { warnings };
  if (key !== undefined) {
    record.key = key;
  }
  if (issueId !== undefined) {
    record.issueId = issueId;
  }
  return record;
}

// `updateGherkinTestDefinition(issueId: String!, versionId: Int, gherkin: String!): Test`: addressed
// by issue id, never a key, and returning the Test directly (no result wrapper, no warnings). The
// `versionId` argument is omitted so the write lands on the default version.
function updateGherkinMutation(issueId: string, gherkin: string): string {
  return `mutation { updateGherkinTestDefinition(issueId: ${JSON.stringify(issueId)}, gherkin: ${JSON.stringify(gherkin)}) { issueId gherkin } }`;
}

function parseUpdatedGherkin(body: unknown): string | undefined {
  const updated =
    body !== null && typeof body === "object"
      ? (body as { data?: { updateGherkinTestDefinition?: { gherkin?: unknown } | null } }).data?.updateGherkinTestDefinition
      : undefined;
  return readString(updated?.gherkin);
}

/**
 * Region-aware Xray Cloud transport. Owns the in-memory JWT (never persisted, never logged — only
 * `describeJwt` facts), batched/paginated `getTests`, flat `coverableIssues`, generic exponential
 * backoff with jitter, a 30s per-request timeout, and abort propagation on every call. All
 * diagnostics go through the allowlist helpers — no response value ever reaches the logger.
 */
export class XrayClient {
  private readonly base: string;
  private readonly fetchImpl: FetchLike;
  private readonly now: () => number;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;

  private jwt: string | undefined;
  private jwtObtainedAt = 0;
  private authInFlight: Promise<string> | undefined;

  constructor(private readonly deps: XrayClientDeps) {
    this.base = xrayBaseUrl(deps.region);
    this.fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
    this.now = deps.now ?? ((): number => Date.now());
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
  }

  // Drop the cached JWT so the next request re-authenticates. Called on any credential change —
  // cheap, and it covers both an account switch and a same-account secret rotation. Dropping the
  // in-flight authenticate too closes the cross-account window: a probe already fetching the prior
  // account's token is disowned (identity-guarded below) so it can neither install nor clear state.
  public invalidateAuth(): void {
    this.jwt = undefined;
    this.jwtObtainedAt = 0;
    this.authInFlight = undefined;
  }

  public async fetchTestsByKeys(keys: readonly string[], signal?: AbortSignal): Promise<XrayFetchOutcome> {
    const outcome: XrayFetchOutcome = { tests: [], pages: [], complete: true, errors: [] };
    for (const batch of chunk(dedupe([...keys]), PAGE_LIMIT)) {
      const jql = `key in (${batch.join(", ")})`;
      const page = await this.fetchScope(jql, signal);
      outcome.tests.push(...page.tests);
      outcome.pages.push(...page.pages);
      outcome.errors.push(...page.errors);
      if (!page.complete) {
        outcome.complete = false;
      }
    }
    return outcome;
  }

  public fetchProjectCatalogue(projectKey: string, signal?: AbortSignal): Promise<XrayFetchOutcome> {
    return this.fetchScope(`project = ${projectKey}`, signal);
  }

  // Forward a caller-built JQL through the shared scope engine (pagination/auth/backoff/normalization
  // for free). The neutral search/plan layer owns the JQL; the client only transports it. §5: a bad
  // clause still returns 200 with 0 rows — never an error — so an empty `tests` means "no matches",
  // which the caller must word honestly, never as an invalid query.
  public searchTests(jql: string, signal?: AbortSignal): Promise<XrayFetchOutcome> {
    return this.fetchScope(jql, signal);
  }

  private async fetchScope(jql: string, signal?: AbortSignal): Promise<XrayFetchOutcome> {
    const outcome: XrayFetchOutcome = { tests: [], pages: [], complete: true, errors: [] };
    let start = 0;
    for (;;) {
      if (signal?.aborted) {
        throw new XrayAbortError();
      }
      const page = await this.requestPage(jql, start, signal);
      if ("errors" in page) {
        outcome.errors.push(...page.errors);
        outcome.complete = false;
        return outcome;
      }
      for (const raw of page.results) {
        const record = toTestRecord(raw);
        if (record) {
          outcome.tests.push(record);
        }
      }
      outcome.pages.push({ fetchedAt: this.now(), query: jql, start, total: page.total });
      const next = pageTermination(jql, start, page);
      if (next.done) {
        if (next.error !== undefined) {
          this.deps.logger.warn(next.error);
          outcome.errors.push(next.error);
          outcome.complete = false;
        }
        return outcome;
      }
      start = next.nextStart;
    }
  }

  private async requestPage(
    jql: string,
    start: number,
    signal: AbortSignal | undefined
  ): Promise<TestPage | { errors: string[] }> {
    let body: unknown;
    try {
      body = await this.graphql(testsQuery(jql, start), signal);
    } catch (error) {
      if (error instanceof XrayAbortError) {
        throw error;
      }
      return { errors: [`${jql}: ${scrubJwtLike(errorMessage(error))}`] };
    }
    const errorSummaries = graphqlErrorSummaries(body);
    if (errorSummaries.length > 0) {
      for (const summary of errorSummaries) {
        this.deps.logger.error(`GraphQL (getTests) ${summary}`);
      }
      return { errors: errorSummaries };
    }
    return parseTestPage(body);
  }

  // A Bearer-authorized POST with a single refresh-on-401 retry, shared by graphql/postJson/postMultipart.
  // The init is rebuilt per attempt so the fresh JWT rides the retry. A 401 that survives a fresh token
  // is a real auth failure, not an empty page — surface it so the scope is recorded incomplete.
  private async sendAuthorized(
    url: string,
    buildInit: (jwt: string) => RequestInit,
    signal: AbortSignal | undefined
  ): Promise<TimedResponse> {
    let refreshed = false;
    for (;;) {
      const jwt = await this.getJwt(signal, refreshed);
      const response = await this.sendWithRetry(url, buildInit(jwt), signal);
      if (response.status === 401) {
        if (!refreshed) {
          this.jwt = undefined;
          refreshed = true;
          continue;
        }
        throw new XrayAuthError("Authentication failed — check your client ID and secret.");
      }
      return response;
    }
  }

  // Author a new Cucumber test and read its key/issueId back in the same response (no follow-up
  // fetch). A 200 with no readable key is NOT an error here — the create succeeded — so it returns a
  // keyless record the caller surfaces (never a silent orphan).
  public async createTest(spec: XrayCreateTestSpec, signal?: AbortSignal): Promise<XrayCreatedTest> {
    return parseCreated(await this.mutate("createTest", createTestMutation(spec), signal), "createTest", "test");
  }

  // Author a Test Set / Test Plan holding the given tests, addressed by their remote issue ids (never
  // keys). Same honest reading as createTest: a 200 with no readable key means the container exists but
  // could not be named back, which is never a failure.
  public createTestSet(
    project: string,
    summary: string,
    testIssueIds: readonly string[],
    signal?: AbortSignal
  ): Promise<XrayCreatedTest> {
    return this.createContainer("createTestSet", "testSet", project, summary, testIssueIds, signal);
  }

  public createTestPlan(
    project: string,
    summary: string,
    testIssueIds: readonly string[],
    signal?: AbortSignal
  ): Promise<XrayCreatedTest> {
    return this.createContainer("createTestPlan", "testPlan", project, summary, testIssueIds, signal);
  }

  // An EMPTY Test Execution: no members and no environments, so a later publish is what fills it. Passing
  // no `testIssueIds` at all is deliberate, since it is mutually exclusive with the `tests` argument.
  public createTestExecution(project: string, summary: string, signal?: AbortSignal): Promise<XrayCreatedTest> {
    return this.createContainer("createTestExecution", "testExecution", project, summary, undefined, signal);
  }

  private async createContainer(
    mutation: string,
    field: string,
    project: string,
    summary: string,
    testIssueIds: readonly string[] | undefined,
    signal: AbortSignal | undefined
  ): Promise<XrayCreatedTest> {
    const query = createContainerMutation(mutation, field, project, summary, testIssueIds);
    return parseCreated(await this.mutate(mutation, query, signal), mutation, field);
  }

  // Replace an existing test's Gherkin body and read the stored text back from the SAME response. An
  // `undefined` return means the 200 carried no readable text, so the caller can report the write as
  // unverified rather than claim a match it never saw.
  public async updateGherkinTestDefinition(
    issueId: string,
    gherkin: string,
    signal?: AbortSignal
  ): Promise<string | undefined> {
    const query = updateGherkinMutation(issueId, gherkin);
    return parseUpdatedGherkin(await this.mutate("updateGherkinTestDefinition", query, signal));
  }

  // Every mutation's shared envelope: a GraphQL `errors` array becomes an XrayMutationError, whose safe
  // reading is that the write never landed, and the raw body goes back for the caller's own parser.
  private async mutate(name: string, query: string, signal: AbortSignal | undefined): Promise<unknown> {
    const body = await this.graphql(query, signal);
    const summaries = graphqlErrorSummaries(body);
    if (summaries.length > 0) {
      for (const summary of summaries) {
        this.deps.logger.error(`GraphQL (${name}) ${summary}`);
      }
      throw new XrayMutationError(summaries.join("; "));
    }
    return body;
  }

  private async graphql(query: string, signal?: AbortSignal): Promise<unknown> {
    const response = await this.sendAuthorized(
      `${this.base}/graphql`,
      (jwt) => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify({ query }),
      }),
      signal
    );
    return parseBody(response.bodyText);
  }

  // Import execution results as Xray JSON (append via top-level `testExecutionKey`, or create via `info`).
  // A thin sibling of graphql: same bearer + refresh-once-on-401, riding the shared backoff/timeout/abort
  // layers. Returns `{status, ok, body}` so a non-2xx (e.g. 400 "No execution results…") reaches the
  // importer intact — the server message is never stripped here.
  public async postJson(path: string, body: unknown, signal?: AbortSignal): Promise<{ status: number; ok: boolean; body: unknown }> {
    const response = await this.sendAuthorized(
      `${this.base}${path}`,
      (jwt) => ({
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${jwt}` },
        body: JSON.stringify(body),
      }),
      signal
    );
    this.deps.logger.info(`POST ${path} → ${response.status}`);
    return { status: response.status, ok: response.ok, body: parseBody(response.bodyText) };
  }

  // Import Cucumber results as multipart/form-data. `results` and `info` ride as `application/json` file
  // parts (part names verbatim per the swagger extract); fetch sets the boundary/Content-Type, never us.
  public async postMultipart(path: string, parts: MultipartParts, signal?: AbortSignal): Promise<{ status: number; ok: boolean; body: unknown }> {
    const response = await this.sendAuthorized(
      `${this.base}${path}`,
      (jwt) => {
        const form = new FormData();
        form.append("results", new Blob([parts.results], { type: "application/json" }), "results.json");
        form.append("info", new Blob([parts.info], { type: "application/json" }), "info.json");
        return { method: "POST", headers: { Authorization: `Bearer ${jwt}` }, body: form };
      },
      signal
    );
    this.deps.logger.info(`POST ${path} → ${response.status}`);
    return { status: response.status, ok: response.ok, body: parseBody(response.bodyText) };
  }

  // Concurrent callers that all miss the cached JWT (or all force-refresh after a shared 401) ride
  // one /authenticate round-trip instead of each firing their own; the entry clears when it settles,
  // so the sequential reuse path above still owns the common case. The identity guards make a probe
  // that invalidateAuth disowned mid-flight inert — it neither installs its (now stale) JWT nor
  // clobbers a newer in-flight entry.
  private getJwt(signal: AbortSignal | undefined, force: boolean): Promise<string> {
    if (!force && this.jwt !== undefined && this.now() - this.jwtObtainedAt < JWT_REUSE_MS) {
      return Promise.resolve(this.jwt);
    }
    if (this.authInFlight) {
      return this.authInFlight;
    }
    const inFlight: Promise<string> = this.authenticate(signal)
      .then((jwt) => {
        if (this.authInFlight === inFlight) {
          this.jwt = jwt;
          this.jwtObtainedAt = this.now();
        }
        return jwt;
      })
      .finally(() => {
        if (this.authInFlight === inFlight) {
          this.authInFlight = undefined;
        }
      });
    this.authInFlight = inFlight;
    return inFlight;
  }

  private async authenticate(signal?: AbortSignal): Promise<string> {
    const credentials = await this.deps.credentials();
    if (!credentials) {
      throw new XrayAuthError("No stored Xray credentials for this site.");
    }
    const response = await this.sendWithRetry(
      `${this.base}/authenticate`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ client_id: credentials.clientId, client_secret: credentials.clientSecret }),
      },
      signal
    );
    if (!response.ok) {
      // The bad-credential body may echo the request, so only its shape is logged — never values.
      this.deps.logger.error(
        `Authentication failed (HTTP ${response.status}); response body shape:\n${stringifyShape(parseBody(response.bodyText))}`
      );
      throw new XrayAuthError(
        response.status === 401
          ? "Authentication failed — check your client ID and secret."
          : `Authentication failed (HTTP ${response.status}).`
      );
    }
    const raw = response.bodyText;
    let jwt: string;
    try {
      const parsed: unknown = JSON.parse(raw);
      jwt = typeof parsed === "string" ? parsed : raw.trim();
    } catch {
      jwt = raw.trim();
    }
    this.deps.logger.info(describeJwt(jwt));
    return jwt;
  }

  private sendWithRetry(url: string, init: RequestInit, signal?: AbortSignal): Promise<TimedResponse> {
    return this.withBackoff(async () => {
      const response = await this.timedFetch(url, init, signal);
      // A rate-limit or server fault is retryable; every other status (incl. 401/400) is handled by
      // the caller. Backoff never depends on rate-limit headers — none appear on the wire (§5).
      if (response.status === 429 || response.status >= 500) {
        throw new RetryableError(`HTTP ${response.status}`);
      }
      return response;
    }, signal);
  }

  private async withBackoff<T>(run: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    let attempt = 0;
    for (;;) {
      if (signal?.aborted) {
        throw new XrayAbortError();
      }
      try {
        return await run();
      } catch (error) {
        if (error instanceof XrayAbortError || error instanceof XrayAuthError) {
          throw error;
        }
        attempt += 1;
        if (!(error instanceof RetryableError) || attempt >= MAX_ATTEMPTS || signal?.aborted) {
          throw error;
        }
        await this.sleep(this.backoffDelay(attempt), signal);
      }
    }
  }

  private backoffDelay(attempt: number): number {
    const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
    return base + Math.floor(this.random() * BACKOFF_BASE_MS);
  }

  // The body read stays inside the timed window (matches the probe): a server that returns headers
  // then stalls the stream trips the 30s abort instead of hanging. The caller's signal aborting is a
  // hard cancel (XrayAbortError); a timeout or network error is retryable transport noise.
  private async timedFetch(url: string, init: RequestInit, signal?: AbortSignal): Promise<TimedResponse> {
    if (signal?.aborted) {
      throw new XrayAbortError();
    }
    const controller = new AbortController();
    const onAbort = (): void => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, { ...init, signal: controller.signal });
      const bodyText = await response.text();
      return { status: response.status, ok: response.ok, bodyText };
    } catch (error) {
      if (signal?.aborted) {
        throw new XrayAbortError();
      }
      throw new RetryableError(scrubJwtLike(errorMessage(error)));
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}
