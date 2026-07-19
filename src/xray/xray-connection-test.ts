import * as vscode from "vscode";
import { Logger } from "../utils/logger";
import { normalizeSiteUrl, projectFromKey } from "./xray-adapter";
import { XrayCredentialStore } from "./xray-credential-store";
import { XrayRegion, xrayBaseUrl } from "./xray-region";

const FETCH_TIMEOUT_MS = 30_000;
const CONNECT_COMMAND = "playwrightBddRunner.traceability.connect";

const DEPTH_CAP = 6;
const ERROR_MESSAGE_CLIP = 160;
const MAX_PROBE_KEYS = 20;
const MAX_PROJECT_PROBES = 3;

// Connection diagnostics log allowlisted information only: status, field names, value types,
// lengths/counts, and rate-limit headers (docs/requirements/traceability-integration-recommendations.md
// — truncating arbitrary values is not redaction). The type skeleton is exactly what the §5 wire-shape
// review needs; response values never reach the output channel.
export function describeShape(value: unknown, depth = 0): unknown {
  if (depth >= DEPTH_CAP) {
    return "…";
  }
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return `string(${value.length})`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return typeof value;
  }
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return ["(empty)"];
    }
    const skeleton = describeShape(value[0], depth + 1);
    return value.length === 1 ? [skeleton] : [skeleton, `… ${value.length} items total`];
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      out[key] = describeShape(item, depth + 1);
    }
    return out;
  }
  return typeof value;
}

// Anything shaped like a JWT (three consecutive long base64url segments) is masked before a
// diagnostic string is logged — a defense for the one place we do emit text (GraphQL error
// messages). Single-quantifier regex; the segment-shape check lives in code to stay linear.
const TOKEN_RUN = /[A-Za-z0-9_.-]+/g;
const JWT_SEGMENT_MIN = 8;

function isJwtLike(run: string): boolean {
  const segments = run.split(".");
  for (let i = 0; i + 2 < segments.length; i++) {
    if (
      (segments[i] ?? "").length >= JWT_SEGMENT_MIN &&
      (segments[i + 1] ?? "").length >= JWT_SEGMENT_MIN &&
      (segments[i + 2] ?? "").length >= JWT_SEGMENT_MIN
    ) {
      return true;
    }
  }
  return false;
}

export function scrubJwtLike(text: string): string {
  return text.replace(TOKEN_RUN, (run) => (isJwtLike(run) ? "[jwt-like-token]" : run));
}

// GraphQL failures arrive as HTTP 200 with an `errors` array. Error `message` and `extensions.code`
// are the diagnostic payload the connection test exists to capture (§5 marks the error shape as a
// live-verification item), so they are the deliberate exception to types-only logging: clipped and
// JWT-scrubbed, nothing else from the error object.
export function graphqlErrorSummaries(body: unknown): string[] {
  if (body === null || typeof body !== "object") {
    return [];
  }
  const errors = (body as { errors?: unknown }).errors;
  if (!Array.isArray(errors) || errors.length === 0) {
    return [];
  }
  return errors.map((entry, index) => {
    const record = (entry ?? {}) as { message?: unknown; extensions?: { code?: unknown } };
    const message =
      typeof record.message === "string"
        ? scrubJwtLike(record.message).slice(0, ERROR_MESSAGE_CLIP)
        : "(no message)";
    const code = typeof record.extensions?.code === "string" ? ` [${record.extensions.code}]` : "";
    return `errors[${index}]${code}: ${message}`;
  });
}

// Describes a JWT for the log without ever emitting it — length and segment count are enough to
// verify the wire shape.
export function describeJwt(jwt: string): string {
  const segments = jwt.split(".").length;
  return `JWT received (length ${jwt.length}, ${segments} dot-separated segment(s), three-segment shape: ${segments === 3})`;
}

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
}

export interface XrayConnectionOutcome {
  ok: boolean;
  stage: "auth" | "graphql" | "network" | "ok";
  site: string;
  message: string;
  projects?: XrayProjectSummary[] | undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

interface TimedResponse {
  status: number;
  ok: boolean;
  headers: Headers;
  bodyText: string;
}

// The body read stays inside the timed window: a server that returns headers and then stalls the
// stream must trip the 30s abort instead of hanging the command with the timer already cleared.
async function timedFetch(url: string, init: RequestInit): Promise<TimedResponse> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    const bodyText = await response.text();
    return { status: response.status, ok: response.ok, headers: response.headers, bodyText };
  } finally {
    clearTimeout(timer);
  }
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
  const jql = `project = ${project}`;
  return `{ getTests(jql: ${JSON.stringify(jql)}, limit: 1) { total } }`;
}

interface GraphqlResult {
  ok: boolean;
  body: unknown;
}

async function graphqlRequest(base: string, logger: Logger, jwt: string, label: string, query: string): Promise<GraphqlResult> {
  const response = await timedFetch(`${base}/graphql`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${jwt}`,
    },
    body: JSON.stringify({ query }),
  });
  const body = parseBody(response.bodyText);
  logger.info(`POST /graphql (${label}) → ${response.status}; response shape:\n${stringifyShape(body)}`);
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
  return { ok: response.ok && errorSummaries.length === 0 && hasData, body };
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
// excluded from the reported totals — a false "0 tests" for a project that actually errored is worse
// than saying nothing. The failure count surfaces in the summary; graphqlRequest already logs why.
async function probeProjects(base: string, logger: Logger, jwt: string, keys: readonly string[]): Promise<ProjectProbeResult> {
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
    const { ok, body } = await graphqlRequest(base, logger, jwt, `project ${project}`, projectCountQuery(project));
    const total = extractTotal(body);
    if (!ok || total === undefined) {
      failed += 1;
      continue;
    }
    summaries.push({ project, totalTests: total });
  }
  return { summaries, failed };
}

type AuthResult = { ok: true; jwt: string } | { ok: false; status: number };

async function authenticate(
  base: string,
  logger: Logger,
  credentials: { clientId: string; clientSecret: string }
): Promise<AuthResult> {
  const response = await timedFetch(`${base}/authenticate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: credentials.clientId, client_secret: credentials.clientSecret }),
  });
  logger.info(`POST /authenticate → ${response.status}`);
  if (!response.ok) {
    // §5 leaves the bad-credential body undocumented; it may echo the request, so only its field
    // names and value types are logged — never values.
    logger.error(
      `Authentication failed (HTTP ${response.status}); response body shape:\n${stringifyShape(parseBody(response.bodyText))}`
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

function successMessage(site: string, projects: readonly XrayProjectSummary[], failed: number): string {
  const parts = projects.map((p) => `project ${p.project}: ${p.totalTests} Xray tests`).join(", ");
  const base = projects.length === 0
    ? `Connected to ${site} — authentication OK`
    : `Connected to ${site} — ${parts}`;
  return failed > 0 ? `${base} — ${failed} project probe(s) failed, see output` : base;
}

// Indicative, value-free auth messages shared by the toast and the panel status area (§5: no
// credential/JWT value ever appears here).
function authFailureMessage(status: number): string {
  return status === 401
    ? "Authentication failed — check your client ID and secret."
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
  options: XrayProbeOptions = {}
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
    auth = await authenticate(base, logger, credentials);
  } catch (error) {
    logger.error(`Authentication request error: ${scrubJwtLike(errorMessage(error))}`);
    return {
      ok: false,
      stage: "network",
      site,
      message: "Could not reach Xray — check your network connection.",
    };
  }
  if (!auth.ok) {
    return { ok: false, stage: "auth", site, message: authFailureMessage(auth.status) };
  }
  const jwt = auth.jwt;

  if (options.authOnly) {
    return { ok: true, stage: "ok", site, message: `Connected to ${site}` };
  }

  const keys = uniqueKeys(knownTestKeys()).slice(0, MAX_PROBE_KEYS);
  if (keys.length === 0) {
    logger.info("no @TEST_ tags found in workspace — skipped GraphQL probes");
    return { ok: true, stage: "ok", site, message: `Connected to ${site} — authentication OK` };
  }

  const jql = `key in (${keys.join(", ")})`;
  let projects: XrayProjectSummary[];
  let projectFailures: number;
  try {
    const probeA = await graphqlRequest(base, logger, jwt, "getTests", testsQuery(jql));
    const probeB = await graphqlRequest(base, logger, jwt, "getTests + coverableIssues", coverageQuery(jql));
    if (!probeA.ok || !probeB.ok) {
      return {
        ok: false,
        stage: "graphql",
        site,
        message: "Xray GraphQL probe failed (non-OK status or GraphQL errors) — see output for details.",
      };
    }
    const probed = await probeProjects(base, logger, jwt, keys);
    projects = probed.summaries;
    projectFailures = probed.failed;
  } catch (error) {
    logger.error(`GraphQL request error: ${scrubJwtLike(errorMessage(error))}`);
    return {
      ok: false,
      stage: "network",
      site,
      message: "Could not reach Xray — check your network connection.",
    };
  }

  return {
    ok: true,
    stage: "ok",
    site,
    message: successMessage(site, projects, projectFailures),
    projects,
  };
}

// Command wrapper: keeps the connect-before-testing gate and the toast presentation. The panel
// delegate calls probeXrayConnection directly so its result renders inline without a double toast.
export async function runXrayConnectionTest(deps: XrayConnectionTestDeps): Promise<void> {
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

  const outcome = await probeXrayConnection(deps);
  if (!outcome.ok) {
    await showErrorWithOutput(logger, outcome.message);
    return;
  }
  const pick = await vscode.window.showInformationMessage(outcome.message, "Show Output");
  if (pick === "Show Output") {
    logger.showOutput();
  }
}
