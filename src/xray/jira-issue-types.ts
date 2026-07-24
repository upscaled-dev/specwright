import { Logger } from "../utils/logger";
import { XrayJiraCredentials } from "./xray-credential-store";
import { describeShape, scrubJwtLike } from "./xray-diagnostics";
import { FetchLike } from "./jira-project-search";
import { ISSUE_TYPE_NAME } from "./jira-issue-search";

const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RESULTS = 200;
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 300;
const BACKOFF_CAP_MS = 8_000;

// Resolution is a best-effort diagnosis, not a gate. A transient Jira failure must never block a
// publish that might still succeed, but a successful createmeta listing that lacks the type is
// authoritative proof the create would 400, so the caller can fail fast instead of guessing.
export type IssueTypeResolution =
  | { readonly kind: "resolved"; readonly name: string }
  | { readonly kind: "unavailable"; readonly availableNames: string[]; readonly teamManaged: boolean }
  | { readonly kind: "unknown" };

export interface IssueTypeResolverDeps {
  // Normalized bare host (e.g. acme.atlassian.net). Read fresh, never from a snapshot.
  site: string;
  credentials: XrayJiraCredentials;
  projectKey: string;
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function tryParse(bodyText: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(bodyText) as unknown };
  } catch {
    return { ok: false };
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

interface IssueTypeEntry {
  name: string;
  untranslatedName: string | undefined;
  subtask: boolean;
  projectScoped: boolean;
}

function parseIssueTypes(body: unknown): IssueTypeEntry[] {
  const record = body !== null && typeof body === "object" ? (body as { issueTypes?: unknown }) : {};
  const entries: IssueTypeEntry[] = [];
  for (const entry of Array.isArray(record.issueTypes) ? record.issueTypes : []) {
    const name = readString((entry as { name?: unknown } | null)?.name);
    if (name === undefined) {
      continue;
    }
    entries.push({
      name,
      untranslatedName: readString((entry as { untranslatedName?: unknown } | null)?.untranslatedName),
      subtask: (entry as { subtask?: unknown } | null)?.subtask === true,
      projectScoped: readString((entry as { scope?: { type?: unknown } } | null)?.scope?.type) === "PROJECT",
    });
  }
  return entries;
}

// Subtask issue types can never host an execution, so they are excluded from both the match and the
// reported availableNames. The exact `name` is returned verbatim (the create payload must echo the
// project's own casing, not the canonical constant).
function resolveFrom(entries: IssueTypeEntry[]): IssueTypeResolution {
  const target = ISSUE_TYPE_NAME.execution.toLowerCase();
  const availableNames: string[] = [];
  let teamManaged = false;
  for (const entry of entries) {
    if (entry.projectScoped) {
      teamManaged = true;
    }
    if (entry.subtask) {
      continue;
    }
    if (entry.name.toLowerCase() === target || entry.untranslatedName?.toLowerCase() === target) {
      return { kind: "resolved", name: entry.name };
    }
    availableNames.push(entry.name);
  }
  return { kind: "unavailable", availableNames, teamManaged };
}

class IssueTypeResolver {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly authHeader: string;

  constructor(private readonly deps: IssueTypeResolverDeps) {
    this.fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.authHeader = basicAuthHeader(deps.credentials);
  }

  public async run(): Promise<IssueTypeResolution> {
    const url = `https://${this.deps.site}/rest/api/3/issue/createmeta/${encodeURIComponent(
      this.deps.projectKey
    )}/issuetypes?maxResults=${MAX_RESULTS}`;
    let response: TimedResponse;
    try {
      response = await this.withBackoff(() => this.timedFetch(url));
    } catch (error) {
      this.deps.logger.warn(`Issue-type resolution could not reach Jira: ${scrubJwtLike(errorMessage(error))}`);
      return { kind: "unknown" };
    }
    const parsed = tryParse(response.bodyText);
    if (!response.ok) {
      // The 4xx/5xx body may echo request/account details, so only its shape is logged, never values.
      this.deps.logger.warn(
        `Issue-type resolution failed (HTTP ${response.status}); response body shape:\n${stringifyShape(
          parsed.ok ? parsed.value : response.bodyText
        )}`
      );
      return { kind: "unknown" };
    }
    if (!parsed.ok) {
      this.deps.logger.warn(`Issue-type resolution returned an unparseable body (HTTP ${response.status}).`);
      return { kind: "unknown" };
    }
    this.deps.logger.info(
      `GET /rest/api/3/issue/createmeta/{projectKey}/issuetypes → ${response.status}; body shape:\n${stringifyShape(parsed.value)}`
    );
    return resolveFrom(parseIssueTypes(parsed.value));
  }

  private async withBackoff(run: () => Promise<TimedResponse>): Promise<TimedResponse> {
    let attempt = 0;
    for (;;) {
      try {
        return await run();
      } catch (error) {
        attempt += 1;
        if (!(error instanceof RetryableError) || attempt >= MAX_ATTEMPTS) {
          throw error;
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
      throw new RetryableError(scrubJwtLike(errorMessage(error)));
    } finally {
      clearTimeout(timer);
      this.deps.signal?.removeEventListener("abort", onAbort);
    }
  }
}

/**
 * Resolves the Jira issue type name a Test Execution create must carry FOR THE TARGET PROJECT via
 * `GET /rest/api/3/issue/createmeta/{projectKey}/issuetypes` (basic auth). Returns a total
 * {@link IssueTypeResolution}: `resolved` with the project's verbatim name when a non-subtask type
 * matches {@link ISSUE_TYPE_NAME.execution} case-insensitively (by `name` or `untranslatedName`),
 * `unavailable` with the project's non-subtask type names plus a `teamManaged` flag (true when any
 * listed type carries a `PROJECT`-scoped entry) when the listing succeeds but lacks it, and
 * `unknown` on any HTTP error, network fault, timeout, or unparseable body. Never throws. Diagnostics
 * are allowlisted status/shape only: the token and the basic-auth header never reach the logger.
 */
export function resolveExecutionIssueType(deps: IssueTypeResolverDeps): Promise<IssueTypeResolution> {
  return new IssueTypeResolver(deps).run();
}
