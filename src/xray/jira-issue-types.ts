import { Logger } from "../utils/logger";
import { errMsg, maskValues, scrubJwtLike, serverText } from "../utils/text";
import { XrayJiraCredentials } from "./xray-credential-store";
import { describeShape } from "./xray-diagnostics";
import { FetchLike, jiraSecrets } from "./jira-project-search";

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
  | {
      readonly kind: "unavailable";
      readonly availableNames: string[];
      readonly subtaskNames: string[];
      // Display name of the subtask entry that matched the target, when one did. The match itself is
      // reported because it can hide behind a localized display name that subtaskNames alone cannot
      // reveal, so the caller must never re-derive it by comparing names.
      readonly subtaskMatch: string | undefined;
      readonly teamManaged: boolean;
    }
  | { readonly kind: "unknown" };

export interface IssueTypeResolverDeps {
  // Normalized bare host (e.g. acme.atlassian.net). Read fresh, never from a snapshot.
  site: string;
  credentials: XrayJiraCredentials;
  projectKey: string;
  // The work type name the project maps to Xray's Test Execution entity (`xray.executionIssueType`),
  // which is not always the Xray default: a team-managed project can map its own name instead.
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

// Subtask issue types can never host an execution, so they are excluded from the match and reported
// separately as subtaskNames plus the subtaskMatch fact: a project whose only execution work type is
// a subtask still fails, but the caller can say so instead of claiming the type is absent, and it can
// say so for a localized subtask entry too. The exact `name` is returned verbatim (the create payload
// must echo the project's own casing, not the canonical constant).
function resolveFrom(entries: IssueTypeEntry[], executionIssueType: string): IssueTypeResolution {
  const target = executionIssueType.toLowerCase();
  const matches = (entry: IssueTypeEntry): boolean =>
    entry.name.toLowerCase() === target || entry.untranslatedName?.toLowerCase() === target;
  const availableNames: string[] = [];
  const subtaskNames: string[] = [];
  let subtaskMatch: string | undefined;
  let teamManaged = false;
  for (const entry of entries) {
    if (entry.projectScoped) {
      teamManaged = true;
    }
    if (entry.subtask) {
      subtaskNames.push(entry.name);
      if (subtaskMatch === undefined && matches(entry)) {
        subtaskMatch = entry.name;
      }
      continue;
    }
    if (matches(entry)) {
      return { kind: "resolved", name: entry.name };
    }
    availableNames.push(entry.name);
  }
  return { kind: "unavailable", availableNames, subtaskNames, subtaskMatch, teamManaged };
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
      this.deps.logger.warn(`Issue-type resolution could not reach Jira: ${scrubJwtLike(errMsg(error))}`);
      return { kind: "unknown" };
    }
    const parsed = tryParse(response.bodyText);
    if (!response.ok) {
      // The refusal's own wording is the only account of why createmeta failed, so it is logged
      // verbatim, with the credentials masked out in case the body echoes them back.
      this.deps.logger.warn(
        `Issue-type resolution failed (HTTP ${response.status}); response body:\n${serverText(
          maskValues(response.bodyText, jiraSecrets(this.deps.credentials))
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
    return resolveFrom(parseIssueTypes(parsed.value), this.deps.executionIssueType);
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
      throw new RetryableError(scrubJwtLike(errMsg(error)));
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
 * matches `deps.executionIssueType` case-insensitively (by `name` or `untranslatedName`),
 * `unavailable` with the project's non-subtask type names, the excluded subtask names plus the one
 * that matched the target (`subtaskMatch`), and a `teamManaged` flag (true when any listed type
 * carries a `PROJECT`-scoped entry) when the listing succeeds but lacks it, and `unknown` on any HTTP
 * error, network fault, timeout, or unparseable body. Never throws. A refused response is logged with
 * its body verbatim, masked by {@link jiraSecrets}, JWT-scrubbed and clipped at 300; a successful one
 * is logged as status/shape only.
 */
export function resolveExecutionIssueType(deps: IssueTypeResolverDeps): Promise<IssueTypeResolution> {
  return new IssueTypeResolver(deps).run();
}
