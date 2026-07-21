import { Logger } from "../utils/logger";
import { XrayJiraCredentials } from "./xray-credential-store";
import { describeShape, scrubJwtLike } from "./xray-diagnostics";

const REQUEST_TIMEOUT_MS = 30_000;
const PAGE_SIZE = 50;
// Hard ceiling on projects enumerated per site (§5 project-view bullet). A site with more projects
// than this renders a truncated, honest list rather than paging a huge account forever.
const MAX_PROJECTS = 200;
const MAX_PAGES = Math.ceil(MAX_PROJECTS / PAGE_SIZE) + 1;
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 300;
const BACKOFF_CAP_MS = 8_000;

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

export interface JiraProject {
  readonly key: string;
  readonly name: string;
}

export interface JiraProjectSearchResult {
  readonly projects: JiraProject[];
  // True when the cap cut the list short (more projects exist on the site). The cross-check must not
  // treat absence from a truncated list as proof a project is missing.
  readonly truncated: boolean;
}

export interface JiraProjectSearchDeps {
  // Normalized bare host (e.g. acme.atlassian.net). Read fresh by the probe, never from a snapshot.
  site: string;
  credentials: XrayJiraCredentials;
  logger: Logger;
  fetchImpl?: FetchLike | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  random?: (() => number) | undefined;
}

// Non-retryable Jira access failure (bad credentials, forbidden, not found). Carries a value-free,
// user-facing message so the probe can degrade the project view without leaking response contents.
export class JiraAccessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JiraAccessError";
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

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Basic auth per Jira REST v3. The base64 of `email:token` is the credential in transit and must
// never be logged — every diagnostic in this module is shape/status/count only.
function basicAuthHeader(credentials: XrayJiraCredentials): string {
  const encoded = Buffer.from(`${credentials.email}:${credentials.token}`).toString("base64");
  return `Basic ${encoded}`;
}

interface JiraPage {
  projects: JiraProject[];
  isLast: boolean;
  nextPage: string | undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

function parsePage(body: unknown): JiraPage {
  const record =
    body !== null && typeof body === "object"
      ? (body as { values?: unknown; isLast?: unknown; nextPage?: unknown })
      : {};
  const projects: JiraProject[] = [];
  for (const entry of Array.isArray(record.values) ? record.values : []) {
    const key = readString((entry as { key?: unknown } | null)?.key);
    const name = readString((entry as { name?: unknown } | null)?.name);
    if (key) {
      projects.push({ key, name: name ?? key });
    }
  }
  return {
    projects,
    isLast: record.isLast === true,
    nextPage: readString(record.nextPage),
  };
}

// Value-free message for each terminal Jira status; the response body may echo account details, so
// only the status drives the wording.
function accessErrorFor(status: number): JiraAccessError {
  if (status === 401) {
    return new JiraAccessError("Jira authentication failed — check your Jira email and API token.");
  }
  if (status === 403) {
    return new JiraAccessError("Jira denied access — the API token lacks permission to list projects.");
  }
  if (status === 404) {
    return new JiraAccessError("Jira project search endpoint not found — check the site host.");
  }
  return new JiraAccessError(`Jira project list failed (HTTP ${status}).`);
}

class JiraProjectSearch {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly authHeader: string;

  constructor(private readonly deps: JiraProjectSearchDeps) {
    this.fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.authHeader = basicAuthHeader(deps.credentials);
  }

  public async run(): Promise<JiraProjectSearchResult> {
    const projects: JiraProject[] = [];
    let url = `https://${this.deps.site}/rest/api/3/project/search?startAt=0&maxResults=${PAGE_SIZE}`;
    for (let requested = 0; requested < MAX_PAGES; requested++) {
      const page = await this.requestPage(url);
      for (const project of page.projects) {
        if (projects.length >= MAX_PROJECTS) {
          return { projects, truncated: true };
        }
        projects.push(project);
      }
      if (projects.length >= MAX_PROJECTS) {
        return { projects, truncated: !page.isLast && page.nextPage !== undefined };
      }
      if (page.isLast || page.nextPage === undefined) {
        return { projects, truncated: false };
      }
      url = page.nextPage;
    }
    // Exhausted the page budget before the site said isLast — treat the list as truncated.
    return { projects, truncated: true };
  }

  private async requestPage(url: string): Promise<JiraPage> {
    const response = await this.withBackoff(() => this.timedFetch(url));
    if (response.status === 401 || response.status === 403 || response.status === 404) {
      // The 4xx body may echo request/account details, so only its shape is logged — never values.
      this.deps.logger.error(
        `Jira project search failed (HTTP ${response.status}); response body shape:\n${stringifyShape(parseBody(response.bodyText))}`
      );
      throw accessErrorFor(response.status);
    }
    if (!response.ok) {
      throw accessErrorFor(response.status);
    }
    const body = parseBody(response.bodyText);
    const page = parsePage(body);
    this.deps.logger.info(
      `GET /rest/api/3/project/search → ${response.status}; page shape:\n${stringifyShape(body)}`
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
            ? new JiraAccessError("Could not reach Jira — check your network connection.")
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

  private async timedFetch(url: string): Promise<TimedResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await this.fetchImpl(url, {
        method: "GET",
        headers: { Accept: "application/json", Authorization: this.authHeader },
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
      throw new RetryableError(scrubJwtLike(errorMessage(error)));
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Lists the Jira projects the supplied credentials can access via `GET /rest/api/3/project/search`
 * (basic auth, `values[].{key,name}`, paginated by `isLast`/`nextPage`, capped at {@link MAX_PROJECTS}).
 * Returns `{ projects, truncated }` — `truncated` is true when the cap cut the list short, so callers
 * never treat absence from a partial list as proof a project is missing. Throws {@link JiraAccessError}
 * with a value-free message on a terminal failure. Diagnostics are allowlisted shape/status/count only
 * — the token and the basic-auth header never reach the logger.
 */
export function searchJiraProjects(deps: JiraProjectSearchDeps): Promise<JiraProjectSearchResult> {
  return new JiraProjectSearch(deps).run();
}
