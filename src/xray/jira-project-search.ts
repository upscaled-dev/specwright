import { Logger } from "../utils/logger";
import { errMsg, maskValues, scrubJwtLike, serverMessageOf, serverText } from "../utils/text";
import { XrayJiraCredentials } from "./xray-credential-store";
import { describeShape } from "./xray-diagnostics";

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
  // Endpoint-side filter, matched case-insensitively against key AND name by Jira. Absent = the whole
  // accessible list, so a filtered search still sees matches beyond the MAX_PROJECTS cap.
  query?: string | undefined;
  fetchImpl?: FetchLike | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  random?: (() => number) | undefined;
  signal?: AbortSignal | undefined;
}

// Non-retryable Jira access failure (bad credentials, forbidden, not found). The message is
// user-facing: status-only from the search paths, and from the identity check the envelope's own text
// after credential masking and JWT scrubbing, clipped at 300.
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

// Basic auth per Jira REST v3. The base64 of `email:token` is the credential in transit and is never
// logged: a response body reaches the output channel only after {@link jiraSecrets} has masked it out.
function basicAuthValue(credentials: XrayJiraCredentials): string {
  return Buffer.from(`${credentials.email}:${credentials.token}`).toString("base64");
}

function basicAuthHeader(credentials: XrayJiraCredentials): string {
  return `Basic ${basicAuthValue(credentials)}`;
}

/**
 * Everything a Jira response body must not echo back into the log: the API token, the base64 the
 * Authorization header carries (so an echoed header reads `Basic [redacted]`), and the account email.
 * Pass it to `maskValues` before any verbatim body is logged or quoted.
 */
export function jiraSecrets(credentials: XrayJiraCredentials): string[] {
  return [credentials.token, basicAuthValue(credentials), credentials.email];
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
    return new JiraAccessError("Jira authentication failed: check your Jira email and API token.");
  }
  if (status === 403) {
    return new JiraAccessError("Jira denied access: the API token lacks permission to list projects.");
  }
  if (status === 404) {
    return new JiraAccessError("Jira project search endpoint not found: check the site host.");
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
    const query = this.deps.query?.trim() ?? "";
    const filter = query === "" ? "" : `&query=${encodeURIComponent(query)}`;
    let url = `https://${this.deps.site}/rest/api/3/project/search?startAt=0&maxResults=${PAGE_SIZE}${filter}`;
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
    // Exhausted the page budget before the site said isLast; treat the list as truncated.
    return { projects, truncated: true };
  }

  private async requestPage(url: string): Promise<JiraPage> {
    const response = await this.withBackoff(() => this.timedFetch(url));
    if (!response.ok) {
      // The user-facing message stays value-free, so the server's own account of the refusal only
      // exists here: verbatim, with the token masked out in case the body echoes it back.
      this.deps.logger.error(
        `Jira project search failed (HTTP ${response.status}); response body:\n${serverText(maskValues(response.bodyText, jiraSecrets(this.deps.credentials)))}`
      );
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

  private async timedFetch(url: string): Promise<TimedResponse> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onAbort = (): void => controller.abort();
    this.deps.signal?.addEventListener("abort", onAbort);
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
      throw new RetryableError(scrubJwtLike(errMsg(error)));
    } finally {
      clearTimeout(timer);
      this.deps.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Lists the Jira projects the supplied credentials can access via `GET /rest/api/3/project/search`
 * (basic auth, `values[].{key,name}`, paginated by `isLast`/`nextPage`, capped at {@link MAX_PROJECTS}),
 * narrowed server-side by the optional `query` (Jira matches key and name, case-insensitively).
 * Returns `{ projects, truncated }`: `truncated` is true when the cap cut the list short, so callers
 * never treat absence from a partial list as proof a project is missing. Throws {@link JiraAccessError}
 * with a value-free message on a terminal failure. A refused response is logged with its body verbatim,
 * masked by {@link jiraSecrets}, JWT-scrubbed and clipped at 300; a page that succeeds is logged as
 * shape/status/count only.
 */
export function searchJiraProjects(deps: JiraProjectSearchDeps): Promise<JiraProjectSearchResult> {
  return new JiraProjectSearch(deps).run();
}

/**
 * Confirms who the stored Jira credentials authenticate as via `GET /rest/api/3/myself`, returning the
 * display name the site knows them by. Throws {@link JiraAccessError} carrying the status and the
 * server's own words when the site refuses, which is where a missing permission shows up first.
 */
export async function fetchJiraIdentity(
  deps: Pick<JiraProjectSearchDeps, "site" | "credentials" | "logger" | "fetchImpl" | "signal">
): Promise<string> {
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  const onAbort = (): void => controller.abort();
  deps.signal?.addEventListener("abort", onAbort);
  let status: number;
  let ok: boolean;
  let bodyText: string;
  try {
    const response = await fetchImpl(`https://${deps.site}/rest/api/3/myself`, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: basicAuthHeader(deps.credentials) },
      signal: controller.signal,
    });
    status = response.status;
    ok = response.ok;
    bodyText = await response.text();
  } catch (error) {
    deps.logger.error(`Jira identity check request error: ${scrubJwtLike(errMsg(error))}`);
    throw new JiraAccessError("Could not reach Jira: check your network connection.");
  } finally {
    clearTimeout(timer);
    deps.signal?.removeEventListener("abort", onAbort);
  }
  const body = maskValues(bodyText, jiraSecrets(deps.credentials));
  if (!ok) {
    deps.logger.error(`GET /rest/api/3/myself → ${status}; response body:\n${serverText(body)}`);
    const message = serverMessageOf(parseBody(body));
    throw new JiraAccessError(
      message === undefined
        ? `Jira identity check failed (HTTP ${status}).`
        : `Jira identity check failed (HTTP ${status}): ${message}`
    );
  }
  const parsed = parseBody(bodyText);
  const record = parsed !== null && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
  const name = readString(record["displayName"]) ?? readString(record["emailAddress"]) ?? "an unnamed account";
  deps.logger.info(`GET /rest/api/3/myself → ${status}; authenticated as ${name}`);
  return name;
}
