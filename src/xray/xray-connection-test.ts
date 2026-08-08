import * as vscode from "vscode";
import { Logger } from "../utils/logger";
import { errMsg, maskValues, scrubJwtLike, serverMessage, serverText } from "../utils/text";
import { normalizeSiteUrl, projectFromKey } from "./xray-adapter";
import { XrayCredentialStore, XrayJiraCredentials } from "./xray-credential-store";
import { XrayRegion, xrayBaseUrl } from "./xray-region";
import { JiraAccessError, JiraProject, fetchJiraIdentity, searchJiraProjects } from "./jira-project-search";
import { describeJwt, describeShape, graphqlErrorSummaries } from "./xray-diagnostics";
import { buildKeysJql, jqlString } from "./xray-search";
import {
  abortableRemoteSleep,
  operationIdentity,
  RetryableRemoteError,
  retryAfterMilliseconds,
  runRemoteOperation,
  type RemoteOperationName,
} from "./remote-operation";

const FETCH_TIMEOUT_MS = 30_000;
const CONNECT_COMMAND = "playwrightBddRunner.traceability.connect";

const MAX_PROBE_KEYS = 20;
const NETWORK_FAILURE = "Could not reach Xray: check your network connection.";
const MAX_PROJECT_PROBES = 3;

export function rateLimitHeaders(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    if (/rate|limit|retry/i.test(key)) {
      out[key] = value;
    }
  });
  return out;
}

export interface XrayConnectionTestDeps {
  // Passed explicitly (never read from an ExtensionConfig snapshot) so a probe fired right after a
  // save reads the just-written host/region rather than a stale cached one.
  site: string;
  region: XrayRegion;
  credentialStore: XrayCredentialStore;
  logger: Logger;
  knownTestKeys: () => string[];
}

export interface XrayProbeOptions {
  // Auth-only: run the handshake and stop, skipping the key/GraphQL/project probes. Drives the
  // panel's connection dot, which means "authenticated", not "credentials stored".
  authOnly?: boolean | undefined;
}

export interface XrayProjectSummary {
  project: string;
  totalTests: number;
  // Set only when a Jira project list was available to cross-check against: true = the key exists on
  // the site, false = absent (so the 0-total is "no such project", not "no tests"). Undefined means
  // no Jira access this run, so a 0-total stays ambiguous (§5 wire fact).
  existsOnSite?: boolean | undefined;
}

export interface XrayConnectionOutcome {
  ok: boolean;
  stage: "auth" | "graphql" | "network" | "ok";
  site: string;
  message: string;
  projects?: XrayProjectSummary[] | undefined;
  // Optional Jira-access enrichment. Never flips `ok` or the stage/dot: a failed Jira call degrades
  // the project view only (§5, Jira credentials are optional).
  jiraProjects?: JiraProject[] | undefined;
  // True when the Jira list hit the enumeration cap, so absence from it is not proof of non-existence.
  jiraTruncated?: boolean | undefined;
  jiraError?: string | undefined;
}

// The probe as a value, so a single-flight wrapper can be injected wherever `probeXrayConnection`
// would otherwise be called module-level; the factory `verify` and the connection commands share
// one wrapped instance so coincident verifies collapse onto one handshake.
export type XrayProbe = (
  deps: XrayConnectionTestDeps,
  options?: XrayProbeOptions,
  signal?: AbortSignal
) => Promise<XrayConnectionOutcome>;

interface TimedResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  bodyText: string;
}

// The body read stays inside the timed window: a server that returns headers and then stalls the
// stream must trip the 30s abort instead of hanging the command with the timer already cleared.
async function timedFetch(
  url: string,
  init: RequestInit,
  signal?: AbortSignal
): Promise<TimedResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  const onAbort = (): void => controller.abort(signal?.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) {onAbort();}
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const bodyText = await response.text();
    return { status: response.status, ok: response.ok, headers: response.headers, bodyText };
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function classifiedFetch(
  operation: RemoteOperationName,
  url: string,
  init: RequestInit,
  logger: Logger,
  signal?: AbortSignal
): Promise<TimedResponse> {
  return runRemoteOperation(async () => {
    try {
      const response = await timedFetch(url, init, signal);
      if (response.status === 429 || response.status >= 500) {
        throw new RetryableRemoteError(
          `HTTP ${response.status}`,
          retryAfterMilliseconds(response.headers.get("retry-after"))
        );
      }
      return response;
    } catch (error) {
      if (signal?.aborted) {throw signal.reason ?? error;}
      throw error instanceof RetryableRemoteError ? error : new RetryableRemoteError(scrubJwtLike(errMsg(error)));
    }
  }, {
    identity: operationIdentity(operation),
    logger,
    signal,
    sleep: abortableRemoteSleep,
    random: Math.random,
    abortError: () => signal?.reason ?? new Error("Aborted"),
  });
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

async function showErrorWithOutput(logger: Logger, message: string): Promise<void> {
  const pick = await vscode.window.showErrorMessage(message, "Show Output");
  if (pick === "Show Output") {
    logger.showOutput();
  }
}

function testsQuery(jql: string): string {
  return `{ getTests(jql: ${JSON.stringify(jql)}, limit: 100) { total results { issueId testType { name kind } status { name color } jira(fields: ["key", "summary", "status", "issuetype"]) } } }`;
}

function coverageQuery(jql: string): string {
  return `{ getTests(jql: ${JSON.stringify(jql)}, limit: 100) { results { issueId jira(fields: ["key"]) coverableIssues(limit: 20) { total results { issueId jira(fields: ["key", "summary", "status"]) } } } } }`;
}

// `limit: Int!` is required on getTests (schema max 100); a per-project count only needs `total`, so
// a single-item page is the cheapest legal request.
function projectCountQuery(project: string): string {
  const jql = `project = ${jqlString(project)}`;
  return `{ getTests(jql: ${JSON.stringify(jql)}, limit: 1) { total } }`;
}

// `__specwright_probe` is a bogus selection field: the GraphQL spec forces the server to reject it
// during pre-execution validation, so the JQL string is never evaluated and only needs to be
// syntactically valid.
function errorShapeQuery(): string {
  return `{ getTests(jql: "project is not empty", limit: 1) { total __specwright_probe } }`;
}

interface GraphqlResult {
  ok: boolean;
  status: number;
  bodyText: string;
  body: unknown;
  errors: string[];
}

async function graphqlRequest(
  base: string,
  logger: Logger,
  jwt: string,
  label: string,
  query: string,
  signal?: AbortSignal
): Promise<GraphqlResult> {
  const response = await classifiedFetch("xray.graphql.read", `${base}/graphql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ query }),
  }, logger, signal);
  const body = parseBody(response.bodyText);
  logger.info(`POST /graphql (${label}) → ${response.status}; response shape:\n${stringifyShape(body)}`);
  if (!response.ok) {
    // A rejected data call is where the region/license/permission truth lives, and the shape alone
    // never carried it, so the server's own words go to the output channel verbatim.
    logger.error(`POST /graphql (${label}) → ${response.status}; response body:\n${serverText(response.bodyText)}`);
  }
  const headers = rateLimitHeaders(response.headers);
  if (Object.keys(headers).length > 0) {
    logger.info(`Rate/limit headers (${label}):\n${JSON.stringify(headers, null, 2)}`);
  }
  const errorSummaries = graphqlErrorSummaries(body);
  for (const summary of errorSummaries) {
    logger.error(`GraphQL (${label}) ${summary}`);
  }
  const data =
    body !== null && typeof body === "object" ? (body as { data?: unknown }).data : undefined;
  const hasData = data !== null && data !== undefined;
  return {
    ok: response.ok && errorSummaries.length === 0 && hasData,
    status: response.status,
    bodyText: response.bodyText,
    body,
    errors: errorSummaries,
  };
}

/**
 * One sentence per distinct way a GraphQL probe can fail, so the toast and the setup panel say what
 * the data host actually did instead of folding every case into "non-OK status or GraphQL errors".
 */
export function graphqlFailureMessage(probe: Pick<GraphqlResult, "status" | "bodyText" | "errors">): string {
  if (probe.status === 401) {
    return "Xray authenticated the client, but the data host rejected the call (HTTP 401): check the playwrightBddRunner.xray.apiRegion setting and that this site has an Xray license.";
  }
  if (probe.status === 429) {
    return "Xray rate-limited the connection test (HTTP 429): wait a minute before testing again.";
  }
  const first = probe.errors[0];
  if (first !== undefined) {
    return `Xray accepted the login but refused the query, usually a permission problem: ${first}`;
  }
  const body = serverMessage(probe.bodyText);
  return body === undefined
    ? `Xray GraphQL probe failed (HTTP ${probe.status}): see output for details.`
    : `Xray GraphQL probe failed (HTTP ${probe.status}): ${body}`;
}

export function extractTotal(body: unknown): number | undefined {
  if (body !== null && typeof body === "object") {
    const data = (body as { data?: { getTests?: { total?: unknown } } }).data;
    if (typeof data?.getTests?.total === "number") {
      return data.getTests.total;
    }
  }
  return undefined;
}

interface ProjectProbeResult {
  summaries: XrayProjectSummary[];
  failed: number;
}

// A project probe that is not ok (non-OK status or GraphQL errors) or whose total isn't a number is
// excluded from the reported totals; a false "0 tests" for a project that actually errored is worse
// than saying nothing. The failure count surfaces in the summary; graphqlRequest already logs why.
// Cross-check against `jiraKeys` when supplied: a project absent from a COMPLETE Jira list is reported
// as not-found (§5 wire fact: a nonexistent project's JQL returns 200/total 0), skipping its Xray
// probe. Absence from a TRUNCATED list is inconclusive, so the Xray total is still probed and
// existsOnSite is left unset; the honest can't-verify caveat applies rather than a false not-found.
async function probeProjects(
  base: string,
  logger: Logger,
  jwt: string,
  keys: readonly string[],
  jiraKeys?: ReadonlySet<string> | undefined,
  jiraTruncated = false,
  signal?: AbortSignal
): Promise<ProjectProbeResult> {
  const projects: string[] = [];
  for (const key of keys) {
    const project = projectFromKey(key);
    if (!projects.includes(project)) {
      projects.push(project);
    }
  }
  const summaries: XrayProjectSummary[] = [];
  let failed = 0;
  for (const project of projects.slice(0, MAX_PROJECT_PROBES)) {
    const present = jiraKeys?.has(project.toUpperCase());
    if (present === false && !jiraTruncated) {
      summaries.push({ project, totalTests: 0, existsOnSite: false });
      continue;
    }
    const { ok, body } = await graphqlRequest(
      base,
      logger,
      jwt,
      `project ${project}`,
      projectCountQuery(project),
      signal
    );
    const total = extractTotal(body);
    if (!ok || total === undefined) {
      failed += 1;
      continue;
    }
    summaries.push(present ? { project, totalTests: total, existsOnSite: true } : { project, totalTests: total });
  }
  return { summaries, failed };
}

// Purely diagnostic: fires a query with a deliberately invalid GraphQL selection field so the error
// envelope lands in the output channel deterministically; the GraphQL spec forces pre-execution
// validation to reject an unknown field. A bad JQL clause can't be used here: Xray tolerates an
// unknown JQL field (returns 200 with a total, no errors) and so never forces an error. Never returns
// anything the outcome depends on; graphqlRequest already logs the response shape + scrubbed summaries.
async function probeErrorShape(
  base: string,
  logger: Logger,
  jwt: string,
  signal?: AbortSignal
): Promise<void> {
  try {
    await graphqlRequest(
      base,
      logger,
      jwt,
      "invalid-field error-shape probe",
      errorShapeQuery(),
      signal
    );
  } catch (error) {
    if (signal?.aborted) {throw signal.reason ?? error;}
    logger.error(`invalid-field error-shape probe request error: ${scrubJwtLike(errMsg(error))}`);
  }
}

type AuthResult = { ok: true; jwt: string } | { ok: false; status: number };

async function authenticate(
  base: string,
  logger: Logger,
  credentials: { clientId: string; clientSecret: string },
  signal?: AbortSignal
): Promise<AuthResult> {
  const response = await classifiedFetch("xray.authenticate", `${base}/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: credentials.clientId, client_secret: credentials.clientSecret }),
  }, logger, signal);
  logger.info(`POST /authenticate → ${response.status}`);
  if (!response.ok) {
    // §5 leaves the bad-credential body undocumented and it may echo the request, so the credentials
    // just sent are masked out of it; what is left is the server's own account of the refusal.
    logger.error(
      `Authentication failed (HTTP ${response.status}); response body:\n${serverText(maskValues(response.bodyText, [credentials.clientSecret, credentials.clientId]))}`
    );
    return { ok: false, status: response.status };
  }
  const raw = response.bodyText;
  let token: string;
  try {
    const parsed: unknown = JSON.parse(raw);
    token = typeof parsed === "string" ? parsed : raw.trim();
  } catch {
    token = raw.trim();
  }
  logger.info(describeJwt(token));
  logger.info(
    `/authenticate body arrived ${raw.trim().startsWith('"') ? "quote-wrapped (JSON string)" : "NOT quote-wrapped"}`
  );
  return { ok: true, jwt: token };
}

function uniqueKeys(keys: readonly string[]): string[] {
  const out: string[] = [];
  for (const key of keys) {
    if (!out.includes(key)) {
      out.push(key);
    }
  }
  return out;
}

function projectPhrase(p: XrayProjectSummary): string {
  if (p.existsOnSite === false) {
    return `project ${p.project}: not found on this site`;
  }
  if (p.existsOnSite === undefined && p.totalTests === 0) {
    return `project ${p.project}: 0 Xray tests (project may not exist, can't verify without Jira access)`;
  }
  return `project ${p.project}: ${p.totalTests} Xray tests`;
}

// What the optional Jira leg of a probe found: who the credentials authenticate as, the accessible
// project list, and the one failure that ends the leg. None of it flips the Xray outcome (§5, Jira
// credentials are optional).
interface JiraOutcome {
  identity?: string | undefined;
  projects?: JiraProject[] | undefined;
  truncated: boolean;
  error?: string | undefined;
}

function successMessage(
  site: string,
  projects: readonly XrayProjectSummary[],
  failed: number,
  jira: JiraOutcome
): string {
  const parts = projects.map(projectPhrase).join(", ");
  let base = projects.length === 0
    ? `Connected to ${site}; authentication OK`
    : `Connected to ${site}; ${parts}`;
  if (failed > 0) {
    base = `${base}; ${failed} project probe(s) failed, see output`;
  }
  if (jira.identity !== undefined) {
    base = `${base}; Jira authenticated as ${jira.identity}`;
  }
  if (jira.error !== undefined) {
    base = `${base}; ${jira.error}`;
  } else if (jira.projects !== undefined) {
    base = jira.truncated
      ? `${base}; ${jira.projects.length}+ Jira projects accessible (list truncated)`
      : `${base}; ${jira.projects.length} Jira project(s) accessible`;
  }
  return base;
}

// Identity first: a wrong token or a missing Browse permission answers /myself before the project
// list ever runs, and the display name is the confirmation a user can act on. The first failure ends
// the leg, since the project list would only repeat it.
async function probeJira(
  site: string,
  credentials: XrayJiraCredentials,
  logger: Logger,
  signal?: AbortSignal
): Promise<JiraOutcome> {
  const jira: JiraOutcome = { truncated: false };
  try {
    jira.identity = await fetchJiraIdentity({ site, credentials, logger, signal });
    const result = await searchJiraProjects({ site, credentials, logger, signal });
    jira.projects = result.projects;
    jira.truncated = result.truncated;
    logger.info(
      `Jira project search returned ${result.projects.length} accessible project(s)${result.truncated ? " (list truncated at the cap)" : ""}`
    );
  } catch (error) {
    if (signal?.aborted) {throw signal.reason ?? error;}
    jira.error = error instanceof JiraAccessError ? error.message : "Jira access unavailable.";
    logger.error(`Jira access error: ${scrubJwtLike(errMsg(error))}`);
  }
  return jira;
}

// Indicative, value-free auth messages shared by the toast and the panel status area (§5: no
// credential/JWT value ever appears here).
function authFailureMessage(status: number): string {
  return status === 401
    ? "Authentication failed: check your client ID and secret."
    : `Authentication failed (HTTP ${status}).`;
}

/**
 * Runs the handshake and shape probes and returns a structured outcome without any UI. Test keys
 * come from the workspace (the `@TEST_` tag scan), never a prompt; nothing runs after a failed
 * handshake. With `authOnly`, stops after the handshake. Callers own presentation (toasts for the
 * command, an inline status for the panel).
 */
export async function probeXrayConnection(
  deps: XrayConnectionTestDeps,
  options: XrayProbeOptions = {},
  signal?: AbortSignal
): Promise<XrayConnectionOutcome> {
  const { credentialStore, logger, knownTestKeys } = deps;
  const site = normalizeSiteUrl(deps.site);
  const base = xrayBaseUrl(deps.region);
  const credentials = await credentialStore.getCredentials(deps.site);
  if (!credentials) {
    return { ok: false, stage: "auth", site, message: "No stored Xray credentials for this site." };
  }

  logger.info(`Xray connection test starting for ${site} (region ${deps.region})`);

  let auth: AuthResult;
  try {
    auth = await authenticate(base, logger, credentials, signal);
  } catch (error) {
    if (signal?.aborted) {throw signal.reason ?? error;}
    logger.error(`Authentication request error: ${scrubJwtLike(errMsg(error))}`);
    return {
      ok: false,
      stage: "network",
      site,
      message: NETWORK_FAILURE,
    };
  }
  if (!auth.ok) {
    return { ok: false, stage: "auth", site, message: authFailureMessage(auth.status) };
  }
  const jwt = auth.jwt;

  if (options.authOnly) {
    return { ok: true, stage: "ok", site, message: `Connected to ${site}` };
  }

  // Optional Jira leg (§5 project-view bullet). This never flips ok/stage; a Jira failure degrades
  // the project view only. Run before the GraphQL probes so the cross-check can run and so the view
  // still populates even on a later GraphQL-stage failure.
  const jiraCredentials = await credentialStore.getJiraCredentials(deps.site);
  const jira: JiraOutcome = jiraCredentials
    ? await probeJira(site, jiraCredentials, logger, signal)
    : { truncated: false };
  const jiraKeys = jira.projects ? new Set(jira.projects.map((p) => p.key.toUpperCase())) : undefined;
  const finish = (partial: XrayConnectionOutcome): XrayConnectionOutcome => ({
    ...partial,
    ...(jira.projects !== undefined ? { jiraProjects: jira.projects } : {}),
    ...(jira.truncated ? { jiraTruncated: true } : {}),
    ...(jira.error !== undefined ? { jiraError: jira.error } : {}),
  });

  const keys = uniqueKeys(knownTestKeys()).slice(0, MAX_PROBE_KEYS);
  if (keys.length === 0) {
    logger.info("no @TEST_ tags found in workspace; skipped GraphQL probes");
    return finish({
      ok: true,
      stage: "ok",
      site,
      message: successMessage(site, [], 0, jira),
    });
  }

  const leg = await runGraphqlLeg(base, logger, jwt, keys, jiraKeys, jira.truncated, signal);
  if (!leg.ok) {
    return finish({ ok: false, stage: leg.stage, site, message: leg.message });
  }

  return finish({
    ok: true,
    stage: "ok",
    site,
    message: successMessage(site, leg.projects, leg.failed, jira),
    projects: leg.projects,
  });
}

type GraphqlLegResult =
  | { readonly ok: true; readonly projects: XrayProjectSummary[]; readonly failed: number }
  | { readonly ok: false; readonly stage: "graphql" | "network"; readonly message: string };

/** The GraphQL probe sequence: two shape probes, the error-shape probe, then per-project counts. */
async function runGraphqlLeg(
  base: string,
  logger: Logger,
  jwt: string,
  keys: string[],
  jiraKeys: Set<string> | undefined,
  jiraTruncated: boolean,
  signal?: AbortSignal
): Promise<GraphqlLegResult> {
  const jql = buildKeysJql(keys);
  try {
    const probeA = await graphqlRequest(base, logger, jwt, "getTests", testsQuery(jql), signal);
    const probeB = await graphqlRequest(
      base,
      logger,
      jwt,
      "getTests + coverableIssues",
      coverageQuery(jql),
      signal
    );
    if (!probeA.ok || !probeB.ok) {
      return { ok: false, stage: "graphql", message: graphqlFailureMessage(probeA.ok ? probeB : probeA) };
    }
    await probeErrorShape(base, logger, jwt, signal);
    const probed = await probeProjects(base, logger, jwt, keys, jiraKeys, jiraTruncated, signal);
    return { ok: true, projects: probed.summaries, failed: probed.failed };
  } catch (error) {
    if (signal?.aborted) {throw signal.reason ?? error;}
    logger.error(`GraphQL request error: ${scrubJwtLike(errMsg(error))}`);
    return { ok: false, stage: "network", message: NETWORK_FAILURE };
  }
}

// Command wrapper: keeps the connect-before-testing gate and the toast presentation. The panel
// delegate calls probeXrayConnection directly so its result renders inline without a double toast.
export async function runXrayConnectionTest(
  deps: XrayConnectionTestDeps,
  signal?: AbortSignal
): Promise<void> {
  const { credentialStore, logger } = deps;
  const normalizedSite = normalizeSiteUrl(deps.site);
  const credentials = normalizedSite ? await credentialStore.getCredentials(deps.site) : undefined;

  if (!normalizedSite || !credentials) {
    const pick = await vscode.window.showWarningMessage(
      "Connect to Xray before running a connection test.",
      "Connect"
    );
    if (pick === "Connect") {
      await vscode.commands.executeCommand(CONNECT_COMMAND);
    }
    return;
  }

  const outcome = await probeXrayConnection(deps, {}, signal);
  if (!outcome.ok) {
    await showErrorWithOutput(logger, outcome.message);
    return;
  }
  const pick = await vscode.window.showInformationMessage(outcome.message, "Show Output");
  if (pick === "Show Output") {
    logger.showOutput();
  }
}
