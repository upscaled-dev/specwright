import { Logger } from "../utils/logger";
import { errMsg, scrubJwtLike } from "../utils/text";
import { XrayJiraCredentials } from "./xray-credential-store";
import { describeShape } from "./xray-diagnostics";
import { FetchLike, JiraAccessError } from "./jira-project-search";

const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 50;
// Hard ceiling on issues enumerated per search (mirrors the 200-project cap): a very large result set
// renders truncated and honest rather than paging forever.
const MAX_ISSUES = 200;
const MAX_PAGES = Math.ceil(MAX_ISSUES / PAGE_SIZE) + 1;
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 300;
const BACKOFF_CAP_MS = 8_000;

// The container kinds pin the search to one Xray issue type; a requirement is any issue type the
// project uses for its stories, so that kind names none and searches on scope alone. Because scope is
// all it has, a requirement search REQUIRES a project key: an unscoped one would sweep the whole site.
export type JiraIssueKind = "execution" | "test-plan" | "requirement";

// The Jira issuetype names Xray provisions for each container kind. The execution name is only the
// default: a project can map a differently named work type, so `xray.executionIssueType` overrides it.
export const ISSUE_TYPE_NAME: Record<Exclude<JiraIssueKind, "requirement">, string> = {
  execution: "Test Execution",
  "test-plan": "Test Plan",
};

export interface JiraIssue {
  readonly key: string;
  readonly summary: string;
}

export interface JiraIssueSearchResult {
  readonly issues: JiraIssue[];
  // True when the cap cut the list short (more matches exist); the picker must not treat absence
  // from a truncated list as "no such execution".
  readonly truncated: boolean;
}

export interface JiraIssueSearchDeps {
  // Normalized bare host (e.g. acme.atlassian.net). Read fresh, never from a snapshot.
  site: string;
  credentials: XrayJiraCredentials;
  kind: JiraIssueKind;
  // A project key that scopes the search (the brief's `project = <key>` clause). Empty = unscoped.
  query: string;
  // The configured execution work type name. Every kind passes it; only the execution kind reads it.
  executionIssueType: string;
  logger: Logger;
  fetchImpl?: FetchLike | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  random?: (() => number) | undefined;
  signal?: AbortSignal | undefined;
}

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

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function basicAuthHeader(credentials: XrayJiraCredentials): string {
  const encoded = Buffer.from(`${credentials.email}:${credentials.token}`).toString("base64");
  return `Basic ${encoded}`;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

interface IssuePage {
  issues: JiraIssue[];
  isLast: boolean;
  nextPageToken: string | undefined;
}

function parsePage(body: unknown): IssuePage {
  const record =
    body !== null && typeof body === "object"
      ? (body as { issues?: unknown; isLast?: unknown; nextPageToken?: unknown })
      : {};
  const issues: JiraIssue[] = [];
  for (const entry of Array.isArray(record.issues) ? record.issues : []) {
    const key = readString((entry as { key?: unknown } | null)?.key);
    const summary = readString((entry as { fields?: { summary?: unknown } } | null)?.fields?.summary);
    if (key) {
      issues.push({ key, summary: summary ?? key });
    }
  }
  return {
    issues,
    isLast: record.isLast === true,
    nextPageToken: readString(record.nextPageToken),
  };
}

function accessErrorFor(status: number): JiraAccessError {
  if (status === 400) {
    return new JiraAccessError("Jira rejected the search: check the project key.");
  }
  if (status === 401) {
    return new JiraAccessError("Jira authentication failed: check your Jira email and API token.");
  }
  if (status === 403) {
    return new JiraAccessError("Jira denied access: the API token lacks permission to search issues.");
  }
  if (status === 404) {
    return new JiraAccessError("Jira search endpoint not found: check the site host.");
  }
  return new JiraAccessError(`Jira issue search failed (HTTP ${status}).`);
}

// JQL metacharacters that would break out of the quoted clause; only `"` and `\` need escaping inside
// a double-quoted JQL string value.
function escapeJql(value: string): string {
  return value.replaceAll("\\", String.raw`\\`).replaceAll('"', String.raw`\"`);
}

function buildJql(kind: JiraIssueKind, query: string, executionIssueType: string): string {
  const project = query.trim();
  const clauses: string[] = [];
  if (project !== "") {
    clauses.push(`project = "${escapeJql(project)}"`);
  }
  if (kind !== "requirement") {
    const issueType = kind === "execution" ? executionIssueType : ISSUE_TYPE_NAME[kind];
    clauses.push(`issuetype = "${escapeJql(issueType)}"`);
  }
  const where = clauses.length === 0 ? "" : `${clauses.join(" AND ")} `;
  return `${where}ORDER BY created DESC`;
}

class JiraIssueSearch {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly authHeader: string;
  private readonly jql: string;

  constructor(private readonly deps: JiraIssueSearchDeps) {
    this.fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.authHeader = basicAuthHeader(deps.credentials);
    this.jql = buildJql(deps.kind, deps.query, deps.executionIssueType);
  }

  public async run(): Promise<JiraIssueSearchResult> {
    const issues: JiraIssue[] = [];
    let nextPageToken: string | undefined;
    const url = `https://${this.deps.site}/rest/api/3/search/jql`;
    for (let requested = 0; requested < MAX_PAGES; requested++) {
      const page = await this.requestPage(url, nextPageToken);
      for (const issue of page.issues) {
        if (issues.length >= MAX_ISSUES) {
          return { issues, truncated: true };
        }
        issues.push(issue);
      }
      if (issues.length >= MAX_ISSUES) {
        return { issues, truncated: !page.isLast && page.nextPageToken !== undefined };
      }
      if (page.isLast || page.nextPageToken === undefined) {
        return { issues, truncated: false };
      }
      nextPageToken = page.nextPageToken;
    }
    return { issues, truncated: true };
  }

  private async requestPage(url: string, nextPageToken: string | undefined): Promise<IssuePage> {
    const response = await this.withBackoff(() => this.timedFetch(url, nextPageToken));
    if (response.status === 400 || response.status === 401 || response.status === 403 || response.status === 404) {
      // The 4xx body may echo request/account details, so only its shape is logged, never values.
      this.deps.logger.error(
        `Jira issue search failed (HTTP ${response.status}); response body shape:\n${stringifyShape(parseBody(response.bodyText))}`
      );
      throw accessErrorFor(response.status);
    }
    if (!response.ok) {
      throw accessErrorFor(response.status);
    }
    const body = parseBody(response.bodyText);
    const page = parsePage(body);
    this.deps.logger.info(
      `POST /rest/api/3/search/jql → ${response.status}; page shape:\n${stringifyShape(body)}`
    );
    return page;
  }

  private async withBackoff(run: () => Promise<TimedResponse>): Promise<TimedResponse> {
    let attempt = 0;
    for (;;) {
      try {
        return await run();
      } catch (error) {
        if (error instanceof JiraAccessError) {
          throw error;
        }
        attempt += 1;
        if (!(error instanceof RetryableError) || attempt >= MAX_ATTEMPTS) {
          throw error instanceof RetryableError
            ? new JiraAccessError("Could not reach Jira: check your network connection.")
            : error;
        }
        await this.sleep(this.backoffDelay(attempt));
      }
    }
  }

  private backoffDelay(attempt: number): number {
    const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
    return base + Math.floor(this.random() * BACKOFF_BASE_MS);
  }

  private async timedFetch(url: string, nextPageToken: string | undefined): Promise<TimedResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onAbort = (): void => controller.abort();
    this.deps.signal?.addEventListener("abort", onAbort);
    const body: Record<string, unknown> = {
      jql: this.jql,
      maxResults: PAGE_SIZE,
      fields: ["summary"],
    };
    if (nextPageToken !== undefined) {
      body["nextPageToken"] = nextPageToken;
    }
    try {
      const response = await this.fetchImpl(url, {
        method: "POST",
        headers: { Accept: "application/json", "Content-Type": "application/json", Authorization: this.authHeader },
        body: JSON.stringify(body),
        signal: controller.signal,
      });
      const bodyText = await response.text();
      if (response.status === 429 || response.status >= 500) {
        throw new RetryableError(`HTTP ${response.status}`);
      }
      return { status: response.status, ok: response.ok, bodyText };
    } catch (error) {
      if (error instanceof RetryableError) {
        throw error;
      }
      throw new RetryableError(scrubJwtLike(errMsg(error)));
    } finally {
      clearTimeout(timer);
      this.deps.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Searches the Jira issues of one {@link JiraIssueKind} via `POST /rest/api/3/search/jql` (basic auth,
 * JQL `project = <key> AND issuetype = "<type>" ORDER BY created DESC` with each clause dropped when
 * it does not apply, `nextPageToken` pagination, capped at {@link MAX_ISSUES}). Returns `{ issues,
 * truncated }`. Throws {@link JiraAccessError} with a value-free message on a terminal failure. An
 * unscoped requirement search is refused here, before any request leaves. Diagnostics are allowlisted
 * shape/status/count only; the token and basic-auth header never log.
 */
export function searchJiraIssues(deps: JiraIssueSearchDeps): Promise<JiraIssueSearchResult> {
  if (deps.kind === "requirement" && deps.query.trim() === "") {
    return Promise.reject(new JiraAccessError("Searching requirements needs a project key to scope the search."));
  }
  return new JiraIssueSearch(deps).run();
}
