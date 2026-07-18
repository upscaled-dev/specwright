import * as vscode from "vscode";
import { ExtensionConfig } from "../core/extension-config";
import { Logger } from "../utils/logger";
import { JIRA_KEY_SHAPE, normalizeSiteUrl } from "./xray-adapter";
import { XrayCredentialStore } from "./xray-credential-store";

const XRAY_BASE = "https://xray.cloud.getxray.app/api/v2";
const FETCH_TIMEOUT_MS = 30_000;
const CONNECT_COMMAND = "playwrightBddRunner.traceability.connect";

const DEPTH_CAP = 6;
const ERROR_MESSAGE_CLIP = 160;

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

export interface KeyListResult {
  keys: string[];
  invalid: string[];
}

export function parseKeyList(input: string): KeyListResult {
  const keys: string[] = [];
  const invalid: string[] = [];
  for (const raw of input.split(",")) {
    const token = raw.trim();
    if (token === "") {
      continue;
    }
    if (JIRA_KEY_SHAPE.test(token)) {
      keys.push(token);
    } else {
      invalid.push(token);
    }
  }
  return { keys, invalid };
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
  config: ExtensionConfig;
  credentialStore: XrayCredentialStore;
  logger: Logger;
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

async function runGraphqlProbe(logger: Logger, jwt: string, label: string, query: string): Promise<boolean> {
  const response = await timedFetch(`${XRAY_BASE}/graphql`, {
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
  return response.ok && errorSummaries.length === 0 && hasData;
}

async function authenticate(logger: Logger, credentials: { clientId: string; clientSecret: string }): Promise<string | undefined> {
  const response = await timedFetch(`${XRAY_BASE}/authenticate`, {
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
    await showErrorWithOutput(logger, "Xray authentication failed — see output for details.");
    return undefined;
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
  return token;
}

export async function runXrayConnectionTest(deps: XrayConnectionTestDeps): Promise<void> {
  const { config, credentialStore, logger } = deps;
  const site = config.xraySiteUrl;
  const normalizedSite = normalizeSiteUrl(site);
  const credentials = normalizedSite ? await credentialStore.getCredentials(site) : undefined;

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

  logger.info(`Xray connection test starting for ${normalizedSite}`);

  let jwt: string | undefined;
  try {
    jwt = await authenticate(logger, credentials);
  } catch (error) {
    logger.error(`Authentication request error: ${scrubJwtLike(errorMessage(error))}`);
    await showErrorWithOutput(logger, "Xray authentication request failed — see output for details.");
    return;
  }
  if (jwt === undefined) {
    return;
  }

  const keyInput = await vscode.window.showInputBox({
    title: "Xray Connection Test",
    prompt: "Enter comma-separated Xray test issue keys to query",
    placeHolder: "CALC-1043, CALC-1051",
    ignoreFocusOut: true,
    validateInput: (value) => {
      const { keys, invalid } = parseKeyList(value);
      if (invalid.length > 0) {
        return `Not a valid Jira key: ${invalid.join(", ")}`;
      }
      return keys.length === 0 ? "Enter at least one Jira key" : undefined;
    },
  });
  if (keyInput === undefined) {
    return;
  }
  const jql = `key in (${parseKeyList(keyInput).keys.join(", ")})`;

  let okA: boolean;
  let okB: boolean;
  try {
    okA = await runGraphqlProbe(logger, jwt, "getTests", testsQuery(jql));
    okB = await runGraphqlProbe(logger, jwt, "getTests + coverableIssues", coverageQuery(jql));
  } catch (error) {
    logger.error(`GraphQL request error: ${scrubJwtLike(errorMessage(error))}`);
    await showErrorWithOutput(logger, "Xray GraphQL request failed — see output for details.");
    return;
  }
  if (!okA || !okB) {
    await showErrorWithOutput(
      logger,
      "Xray GraphQL probe failed (non-OK status or GraphQL errors) — see output for details."
    );
    return;
  }

  const pick = await vscode.window.showInformationMessage(
    "Xray connection OK — shapes written to output",
    "Show Output"
  );
  if (pick === "Show Output") {
    logger.showOutput();
  }
}
