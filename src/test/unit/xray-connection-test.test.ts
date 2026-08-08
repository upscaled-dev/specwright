import { describe, it, expect, vi, afterEach } from "vitest";
import * as vscode from "vscode";
import { Logger, LogLevel } from "../../utils/logger";
import { XrayCredentialStore } from "../../xray/xray-credential-store";
import {
  extractTotal,
  graphqlFailureMessage,
  probeXrayConnection,
  rateLimitHeaders,
  runXrayConnectionTest,
} from "../../xray/xray-connection-test";
import { XrayRegion } from "../../xray/xray-region";
import { trustedWorkspace } from "./helpers/test-workspace-trust";

describe("extractTotal", () => {
  it("returns the numeric total when present", () => {
    expect(extractTotal({ data: { getTests: { total: 42 } } })).toBe(42);
    expect(extractTotal({ data: { getTests: { total: 0 } } })).toBe(0);
  });

  it("returns undefined for malformed bodies rather than a false zero", () => {
    expect(extractTotal({ data: { getTests: { total: "42" } } })).toBeUndefined();
    expect(extractTotal({ data: { getTests: {} } })).toBeUndefined();
    expect(extractTotal({ data: {} })).toBeUndefined();
    expect(extractTotal({ errors: [{ message: "boom" }] })).toBeUndefined();
    expect(extractTotal("plain text")).toBeUndefined();
    expect(extractTotal(null)).toBeUndefined();
  });
});

describe("rateLimitHeaders", () => {
  it("keeps only rate/limit/retry headers and drops auth", () => {
    const headers = new Headers({
      "X-RateLimit-Remaining": "42",
      "Retry-After": "30",
      "Content-Type": "application/json",
      Authorization: "Bearer secret",
    });
    const picked = rateLimitHeaders(headers);
    expect(picked["x-ratelimit-remaining"]).toBe("42");
    expect(picked["retry-after"]).toBe("30");
    expect(picked["content-type"]).toBeUndefined();
    expect(picked["authorization"]).toBeUndefined();
  });
});

describe("graphqlFailureMessage", () => {
  it("blames the data host and points at the region setting on a 401", () => {
    const message = graphqlFailureMessage({ status: 401, bodyText: "", errors: [] });
    expect(message).toContain("data host rejected the call");
    expect(message).toContain("xray.apiRegion");
  });

  it("says rate-limited and asks for a pause on a 429", () => {
    expect(graphqlFailureMessage({ status: 429, bodyText: "", errors: [] })).toContain("rate-limited");
  });

  it("quotes the first GraphQL error of a 200 as a likely permission problem", () => {
    const message = graphqlFailureMessage({
      status: 200,
      bodyText: '{"errors":[{"message":"denied"}]}',
      errors: ["errors[0] [FORBIDDEN]: denied", "errors[1]: also denied"],
    });
    expect(message).toBe(
      "Xray accepted the login but refused the query, usually a permission problem: errors[0] [FORBIDDEN]: denied"
    );
  });

  it("states the status and quotes the body for any other non-OK", () => {
    expect(graphqlFailureMessage({ status: 502, bodyText: "upstream exploded", errors: [] })).toBe(
      "Xray GraphQL probe failed (HTTP 502): upstream exploded"
    );
  });

  it("falls back to the output channel when the body is an HTML page", () => {
    expect(
      graphqlFailureMessage({ status: 502, bodyText: "<html><body>Bad Gateway</body></html>", errors: [] })
    ).toBe("Xray GraphQL probe failed (HTTP 502): see output for details.");
  });
});

function mapCredentialStore(): XrayCredentialStore {
  const map = new Map<string, string>();
  const storage = {
    get: (key: string): Promise<string | undefined> => Promise.resolve(map.get(key)),
    store: (key: string, value: string): Promise<void> => {
      map.set(key, value);
      return Promise.resolve();
    },
    delete: (key: string): Promise<void> => {
      map.delete(key);
      return Promise.resolve();
    },
  } as unknown as vscode.SecretStorage;
  return new XrayCredentialStore(storage, trustedWorkspace());
}

function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const channel = {
    name: "test",
    append: () => { /* no-op */ },
    appendLine: (line: string): void => { lines.push(line); },
    replace: () => { /* no-op */ },
    clear: () => { /* no-op */ },
    show: () => { /* no-op */ },
    hide: () => { /* no-op */ },
    dispose: () => { /* no-op */ },
  } as unknown as vscode.OutputChannel;
  return { logger: Logger.create(channel, LogLevel.DEBUG), lines };
}

function makeResponse(status: number, body: string, headers: Record<string, string> = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: (): Promise<string> => Promise.resolve(body),
    headers: new Headers(headers),
  } as unknown as Response;
}

const FAKE_JWT = `${"a".repeat(40)}.${"b".repeat(40)}.${"c".repeat(40)}`;
const FAKE_SECRET = "client-secret-value-must-never-be-logged";
const JIRA_EMAIL = "me@example.com";
const JIRA_TOKEN = "jira-api-token-must-never-be-logged";
const SITE = "acme.atlassian.net";

async function seededDeps(knownTestKeys: () => string[] = () => []): Promise<{
  site: string;
  region: XrayRegion;
  credentialStore: XrayCredentialStore;
  logger: Logger;
  knownTestKeys: () => string[];
  lines: string[];
}> {
  const { logger, lines } = capturingLogger();
  const credentialStore = mapCredentialStore();
  await credentialStore.setCredentials(SITE, "fake-client-id", FAKE_SECRET);
  return { site: SITE, region: "global", credentialStore, logger, knownTestKeys, lines };
}

// Auth returns the JWT; every /graphql POST is answered by `handler`, which sees the query so a test
// can key project-count probes off the `project = X` jql.
function jwtThenGraphql(
  handler: (query: string) => unknown,
  headers: Record<string, string> = {}
): ReturnType<typeof vi.fn> {
  return vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/authenticate")) {
      return Promise.resolve(makeResponse(200, JSON.stringify(FAKE_JWT)));
    }
    const parsed = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
    return Promise.resolve(makeResponse(200, JSON.stringify(handler(parsed.query ?? "")), headers));
  });
}

describe("runXrayConnectionTest: secret/JWT redaction invariant", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("never prompts, and never emits the raw JWT, its prefix, or the client secret on the happy path", async () => {
    const deps = await seededDeps(() => ["CALC-1"]);
    const { lines } = deps;

    const fetchMock = jwtThenGraphql(
      () => ({ data: { getTests: { total: 1, results: [{ issueId: "10", jira: { key: "CALC-1" } }] } } }),
      { "X-RateLimit-Remaining": "99" }
    );
    vi.stubGlobal("fetch", fetchMock);
    const inputBox = vi.spyOn(vscode.window, "showInputBox");

    await runXrayConnectionTest(deps);

    const emitted = lines.join("\n");
    expect(inputBox).not.toHaveBeenCalled();
    expect(emitted).not.toContain(FAKE_JWT);
    expect(emitted).not.toContain(FAKE_JWT.slice(0, 20));
    expect(emitted).not.toContain(FAKE_SECRET);
    expect(emitted).not.toContain(FAKE_SECRET.slice(0, 12));
    expect(emitted).toContain("JWT received");
    expect(emitted).toContain("quote-wrapped (JSON string)");
    // authenticate + two shape probes + invalid-field error-shape probe + one project-count probe.
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("keeps an echoed client secret out of the logs and reports the handshake status when auth fails", async () => {
    const deps = await seededDeps(() => ["CALC-1"]);
    const { lines } = deps;

    const echoBody = JSON.stringify({
      error: "bad request",
      request: { client_id: "fake-client-id", client_secret: FAKE_SECRET },
    });
    const fetchMock = vi.fn(() => Promise.resolve(makeResponse(400, echoBody)));
    vi.stubGlobal("fetch", fetchMock);
    const errorToast = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);

    await runXrayConnectionTest(deps);

    const emitted = lines.join("\n");
    expect(emitted).not.toContain(FAKE_SECRET);
    expect(emitted).not.toContain(FAKE_SECRET.slice(0, 12));
    // The credentials are masked out of the echo, but the server's own wording survives verbatim.
    expect(emitted).toContain("[redacted]");
    expect(emitted).toContain('"error":"bad request"');
    // Nothing runs after a failed handshake: only the /authenticate call was made.
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(errorToast).toHaveBeenCalledWith(
      expect.stringContaining("Authentication failed (HTTP 400)"),
      "Show Output"
    );
  });

  it("fails the probe and scrubs jwt-like strings when GraphQL returns 200 with errors", async () => {
    const deps = await seededDeps(() => ["CALC-1"]);
    const { lines } = deps;

    const fetchMock = jwtThenGraphql(() => ({
      errors: [{ message: `denied for token ${FAKE_JWT}`, extensions: { code: "FORBIDDEN" } }],
      data: null,
    }));
    vi.stubGlobal("fetch", fetchMock);
    const errorToast = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);

    await runXrayConnectionTest(deps);

    const emitted = lines.join("\n");
    expect(emitted).not.toContain(FAKE_JWT);
    expect(emitted).not.toContain(FAKE_JWT.slice(0, 20));
    expect(emitted).toContain("[jwt-like-token]");
    expect(emitted).toContain("FORBIDDEN");
    expect(errorToast).toHaveBeenCalledWith(
      expect.stringContaining("Xray accepted the login but refused the query"),
      "Show Output"
    );
  });

  it("aborts a stalled body read via the 30s timeout instead of hanging", async () => {
    vi.useFakeTimers();
    const deps = await seededDeps(() => ["CALC-1"]);
    const { lines } = deps;

    // 200 headers arrive, then the body stream stalls: text() settles only when the request
    // signal aborts, exactly the case the timer must still cover.
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init?: RequestInit) => {
        const signal = init?.signal;
        return Promise.resolve({
          status: 200,
          ok: true,
          headers: new Headers(),
          text: (): Promise<string> =>
            new Promise((_resolve, reject) => {
              signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
            }),
        } as unknown as Response);
      })
    );
    const errorToast = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);

    const run = runXrayConnectionTest(deps);
    await vi.advanceTimersByTimeAsync(130_000);
    await run;

    expect(lines.join("\n")).toContain("Authentication request error");
    expect(errorToast).toHaveBeenCalledWith(
      expect.stringContaining("Could not reach Xray"),
      "Show Output"
    );
  });

  it("warns and never authenticates when no credentials are stored", async () => {
    const { logger } = capturingLogger();
    const credentialStore = mapCredentialStore();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const warn = vi.spyOn(vscode.window, "showWarningMessage").mockResolvedValue(undefined);

    await runXrayConnectionTest({ site: SITE, region: "global", credentialStore, logger, knownTestKeys: () => [] });

    expect(warn).toHaveBeenCalledWith(
      "Connect to Xray before running a connection test.",
      "Connect"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("probeXrayConnection: structured outcome", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("aborts an in-flight authentication fetch through the caller signal", async () => {
    const deps = await seededDeps();
    let fetchSignal: AbortSignal | undefined;
    const fetchMock = vi.fn((_url: string, init?: RequestInit) => {
      fetchSignal = init?.signal as AbortSignal | undefined;
      return new Promise<Response>((_resolve, reject) => {
        fetchSignal?.addEventListener("abort", () => reject(fetchSignal?.reason), { once: true });
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const controller = new AbortController();
    const revoked = new Error("trust revoked");
    const pending = probeXrayConnection(deps, {}, controller.signal);
    await vi.waitFor(() => expect(fetchSignal).toBeDefined());

    controller.abort(revoked);

    await expect(pending).rejects.toBe(revoked);
    expect(fetchSignal?.aborted).toBe(true);
  });

  it("skips the GraphQL probes and returns an auth-only outcome when the workspace has no test keys", async () => {
    const deps = await seededDeps(() => []);
    const fetchMock = jwtThenGraphql(() => ({ data: { getTests: { total: 0 } } }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await probeXrayConnection(deps);

    expect(outcome).toEqual({
      ok: true,
      stage: "ok",
      site: SITE,
      message: `Connected to ${SITE}; authentication OK`,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(deps.lines.join("\n")).toContain("no @TEST_ tags found in workspace; skipped GraphQL probes");
  });

  it("groups keys by project and reports each project's total from a `project = X` probe", async () => {
    const deps = await seededDeps(() => ["CALC-1043", "CALC-1051", "MATH-2"]);
    const fetchMock = jwtThenGraphql((query) => {
      if (query.includes(String.raw`project = \"CALC\"`)) {
        return { data: { getTests: { total: 42 } } };
      }
      if (query.includes(String.raw`project = \"MATH\"`)) {
        return { data: { getTests: { total: 7 } } };
      }
      return { data: { getTests: { total: 3, results: [] } } };
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await probeXrayConnection(deps);

    expect(outcome.ok).toBe(true);
    expect(outcome.stage).toBe("ok");
    expect(outcome.projects).toEqual([
      { project: "CALC", totalTests: 42 },
      { project: "MATH", totalTests: 7 },
    ]);
    expect(outcome.message).toBe(
      `Connected to ${SITE}; project CALC: 42 Xray tests, project MATH: 7 Xray tests`
    );
    // authenticate + two shape probes + invalid-field probe + one probe per project.
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("quotes the key list and the project so a reserved word like IS is not a bare JQL token", async () => {
    const deps = await seededDeps(() => ["IS-1"]);
    const queries: string[] = [];
    const fetchMock = jwtThenGraphql((query) => {
      queries.push(query);
      return { data: { getTests: { total: 1, results: [] } } };
    });
    vi.stubGlobal("fetch", fetchMock);

    await probeXrayConnection(deps);

    expect(queries.some((query) => query.includes(String.raw`key in (\"IS-1\")`))).toBe(true);
    expect(queries.some((query) => query.includes(String.raw`project = \"IS\"`))).toBe(true);
  });

  it("probes at most three projects", async () => {
    const deps = await seededDeps(() => ["A-1", "B-1", "C-1", "D-1"]);
    const fetchMock = jwtThenGraphql(() => ({ data: { getTests: { total: 1 } } }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await probeXrayConnection(deps);

    expect(outcome.projects).toHaveLength(3);
    // authenticate + two shape probes + invalid-field probe + three project probes (D dropped by cap).
    expect(fetchMock).toHaveBeenCalledTimes(7);
  });

  it("returns an auth-stage failure and runs no further requests when authentication fails", async () => {
    const deps = await seededDeps(() => ["CALC-1"]);
    const fetchMock = vi.fn(() => Promise.resolve(makeResponse(401, "nope")));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await probeXrayConnection(deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.stage).toBe("auth");
    expect(outcome.message).toBe("Authentication failed: check your client ID and secret.");
    expect(outcome.projects).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("returns a graphql-stage failure when a shape probe reports GraphQL errors", async () => {
    const deps = await seededDeps(() => ["CALC-1"]);
    const fetchMock = jwtThenGraphql(() => ({ errors: [{ message: "bad" }], data: null }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await probeXrayConnection(deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.stage).toBe("graphql");
    // authenticate + both shape probes; the project probes never run.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stops after the handshake and skips every GraphQL probe in authOnly mode", async () => {
    const deps = await seededDeps(() => ["CALC-1", "MATH-2"]);
    const fetchMock = jwtThenGraphql(() => ({ data: { getTests: { total: 9 } } }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await probeXrayConnection(deps, { authOnly: true });

    expect(outcome).toEqual({ ok: true, stage: "ok", site: SITE, message: `Connected to ${SITE}` });
    // Only /authenticate, no shape or project probes.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("excludes a project whose probe returns 200-with-errors and notes the failure in the message", async () => {
    const deps = await seededDeps(() => ["CALC-1", "MATH-1"]);
    const fetchMock = jwtThenGraphql((query) => {
      if (query.includes(String.raw`project = \"CALC\"`)) {
        return { errors: [{ message: "boom" }], data: null };
      }
      if (query.includes(String.raw`project = \"MATH\"`)) {
        return { data: { getTests: { total: 5 } } };
      }
      return { data: { getTests: { total: 2, results: [] } } };
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await probeXrayConnection(deps);

    expect(outcome.ok).toBe(true);
    expect(outcome.projects).toEqual([{ project: "MATH", totalTests: 5 }]);
    expect(outcome.message).toBe(
      `Connected to ${SITE}; project MATH: 5 Xray tests; 1 project probe(s) failed, see output`
    );
    expect(outcome.message).not.toContain("project CALC");
  });

  it("caps the key list at 20, keeping the first 20 unique keys in first-seen order", async () => {
    const supplied = ["CALC-1", ...Array.from({ length: 25 }, (_v, i) => `CALC-${i + 1}`)];
    const deps = await seededDeps(() => supplied);
    let capturedJql = "";
    const fetchMock = jwtThenGraphql((query) => {
      if (query.includes("key in (")) {
        capturedJql = query;
      }
      return { data: { getTests: { total: 1, results: [] } } };
    });
    vi.stubGlobal("fetch", fetchMock);

    await probeXrayConnection(deps);

    const listed = (/key in \(([^)]*)\)/.exec(capturedJql)?.[1] ?? "").split(", ");
    expect(listed).toHaveLength(20);
    expect(listed[0]).toBe(String.raw`\"CALC-1\"`);
    expect(listed[19]).toBe(String.raw`\"CALC-20\"`);
    expect(capturedJql).not.toContain("CALC-21");
  });

  it("fires the deliberate invalid-field probe and logs its error shape without flipping ok", async () => {
    const deps = await seededDeps(() => ["CALC-1"]);
    // A GraphQL validation error carries no `data`, and its message (not extensions.classification) is
    // what graphqlErrorSummaries surfaces.
    const fetchMock = jwtThenGraphql((query) => {
      if (query.includes("__specwright_probe")) {
        return {
          errors: [
            {
              message: "Validation error of type FieldUndefined: Field '__specwright_probe' in type 'Test' is undefined",
              extensions: { classification: "ValidationError" },
            },
          ],
        };
      }
      return { data: { getTests: { total: 4, results: [] } } };
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await probeXrayConnection(deps);

    expect(outcome.ok).toBe(true);
    expect(outcome.stage).toBe("ok");
    const emitted = deps.lines.join("\n");
    expect(emitted).toContain("invalid-field error-shape probe");
    expect(emitted).toContain("FieldUndefined");
  });
});

const JIRA_NAME = "Jane Tester";

// Auth returns the JWT, /myself names the account (`identity` overrides it), the Jira project-search
// URL returns `jiraPage`, and every other /graphql POST is answered by `graphql`. Keeps the four
// transports of a full probe in one deterministic mock.
function jwtGraphqlAndJira(
  graphql: (query: string) => unknown,
  jira: { status: number; body: unknown },
  identity: { status: number; body: unknown } = { status: 200, body: { displayName: JIRA_NAME } }
): ReturnType<typeof vi.fn> {
  return vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith("/authenticate")) {
      return Promise.resolve(makeResponse(200, JSON.stringify(FAKE_JWT)));
    }
    if (url.includes("/rest/api/3/myself")) {
      return Promise.resolve(makeResponse(identity.status, JSON.stringify(identity.body)));
    }
    if (url.includes("/rest/api/3/project/search")) {
      const body = typeof jira.body === "string" ? jira.body : JSON.stringify(jira.body);
      return Promise.resolve(makeResponse(jira.status, body));
    }
    const parsed = JSON.parse(String(init?.body ?? "{}")) as { query?: string };
    return Promise.resolve(makeResponse(200, JSON.stringify(graphql(parsed.query ?? ""))));
  });
}

async function jiraSeededDeps(knownTestKeys: () => string[]): Promise<Awaited<ReturnType<typeof seededDeps>>> {
  const deps = await seededDeps(knownTestKeys);
  await deps.credentialStore.setJiraCredentials(SITE, JIRA_EMAIL, JIRA_TOKEN);
  return deps;
}

describe("probeXrayConnection: Jira project view", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("cross-checks probed projects against the Jira list and reports absent ones as not-found", async () => {
    const deps = await jiraSeededDeps(() => ["CALC-1", "MATH-1"]);
    const queries: string[] = [];
    const fetchMock = jwtGraphqlAndJira(
      (query) => {
        queries.push(query);
        return query.includes(String.raw`project = \"CALC\"`)
          ? { data: { getTests: { total: 5 } } }
          : { data: { getTests: { total: 0, results: [] } } };
      },
      { status: 200, body: { isLast: true, values: [{ key: "CALC", name: "Calculator" }] } }
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await probeXrayConnection(deps);

    expect(outcome.ok).toBe(true);
    expect(outcome.jiraProjects).toEqual([{ key: "CALC", name: "Calculator" }]);
    expect(outcome.jiraError).toBeUndefined();
    expect(outcome.projects).toEqual([
      { project: "CALC", totalTests: 5, existsOnSite: true },
      { project: "MATH", totalTests: 0, existsOnSite: false },
    ]);
    expect(outcome.message).toContain("project MATH: not found on this site");
    expect(outcome.message).toContain("1 Jira project(s) accessible");
    // No Xray probe is spent on the absent MATH project.
    expect(queries.some((query) => query.includes(String.raw`project = \"MATH\"`))).toBe(false);
  });

  it("uses honest can't-verify wording for a 0-total project when no Jira credentials are stored", async () => {
    const deps = await seededDeps(() => ["ZZZ-1"]);
    const fetchMock = jwtThenGraphql(() => ({ data: { getTests: { total: 0, results: [] } } }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await probeXrayConnection(deps);

    expect(outcome.projects).toEqual([{ project: "ZZZ", totalTests: 0 }]);
    expect(outcome.message).toContain("project may not exist, can't verify without Jira access");
    expect(outcome.jiraProjects).toBeUndefined();
  });

  it("names the authenticated Jira account in the verdict and the output", async () => {
    const deps = await jiraSeededDeps(() => ["CALC-1"]);
    const fetchMock = jwtGraphqlAndJira(
      () => ({ data: { getTests: { total: 1, results: [] } } }),
      { status: 200, body: { isLast: true, values: [{ key: "CALC", name: "Calculator" }] } }
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await probeXrayConnection(deps);

    expect(outcome.ok).toBe(true);
    expect(outcome.message).toContain(`Jira authenticated as ${JIRA_NAME}`);
    expect(deps.lines.join("\n")).toContain(`GET /rest/api/3/myself → 200; authenticated as ${JIRA_NAME}`);
  });

  it("reports the identity failure and never lists projects when /myself is refused", async () => {
    const deps = await jiraSeededDeps(() => ["CALC-1"]);
    const fetchMock = jwtGraphqlAndJira(
      () => ({ data: { getTests: { total: 1, results: [] } } }),
      { status: 200, body: { isLast: true, values: [{ key: "CALC", name: "Calculator" }] } },
      { status: 403, body: { errorMessages: ["Browse permission required"] } }
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await probeXrayConnection(deps);

    expect(outcome.ok).toBe(true);
    expect(outcome.jiraError).toBe("Jira identity check failed (HTTP 403): Browse permission required");
    expect(outcome.jiraProjects).toBeUndefined();
    expect(fetchMock.mock.calls.some((call: unknown[]) => String(call[0]).includes("project/search"))).toBe(false);
    expect(deps.lines.join("\n")).toContain("Browse permission required");
  });

  it("keeps ok true and records jiraError when the Jira project list fails", async () => {
    const deps = await jiraSeededDeps(() => ["CALC-1"]);
    const fetchMock = jwtGraphqlAndJira(
      () => ({ data: { getTests: { total: 3 } } }),
      { status: 401, body: { errorMessages: ["nope"] } }
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await probeXrayConnection(deps);

    expect(outcome.ok).toBe(true);
    expect(outcome.stage).toBe("ok");
    expect(outcome.jiraError).toContain("Jira authentication failed");
    expect(outcome.jiraProjects).toBeUndefined();
    // Falls back to tag-derived probing (existsOnSite left unset when no Jira list is available).
    expect(outcome.projects).toEqual([{ project: "CALC", totalTests: 3 }]);
  });

  it("lists Jira projects even when the workspace has no @TEST_ tags", async () => {
    const deps = await jiraSeededDeps(() => []);
    const fetchMock = jwtGraphqlAndJira(
      () => ({ data: { getTests: { total: 0 } } }),
      { status: 200, body: { isLast: true, values: [{ key: "CALC", name: "Calculator" }, { key: "MATH", name: "Mathematics" }] } }
    );
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await probeXrayConnection(deps);

    expect(outcome.ok).toBe(true);
    expect(outcome.jiraProjects).toHaveLength(2);
    expect(outcome.projects).toBeUndefined();
    expect(outcome.message).toContain("2 Jira project(s) accessible");
  });

  it("does not downgrade an absent project to not-found when the Jira list is truncated", async () => {
    const deps = await jiraSeededDeps(() => ["CALC-1"]);
    const jiraPage = JSON.stringify({
      isLast: false,
      nextPage: `https://${SITE}/rest/api/3/project/search?startAt=next`,
      values: Array.from({ length: 50 }, (_v, i) => ({ key: `P${i}`, name: `Project ${i}` })),
    });
    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith("/authenticate")) {
        return Promise.resolve(makeResponse(200, JSON.stringify(FAKE_JWT)));
      }
      if (url.includes("/rest/api/3/myself")) {
        return Promise.resolve(makeResponse(200, JSON.stringify({ displayName: JIRA_NAME })));
      }
      if (url.includes("/rest/api/3/project/search")) {
        return Promise.resolve(makeResponse(200, jiraPage));
      }
      return Promise.resolve(makeResponse(200, JSON.stringify({ data: { getTests: { total: 0, results: [] } } })));
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await probeXrayConnection(deps);

    expect(outcome.ok).toBe(true);
    expect(outcome.jiraTruncated).toBe(true);
    // CALC is absent from the (truncated) list, so it stays existsOnSite-unset rather than not-found.
    expect(outcome.projects).toEqual([{ project: "CALC", totalTests: 0 }]);
    expect(outcome.message).toContain("project may not exist, can't verify without Jira access");
    expect(outcome.message).not.toContain("project CALC: not found on this site");
    expect(outcome.message).toContain("(list truncated)");
  });

  it("never emits the Jira token or the basic-auth header while listing projects", async () => {
    const deps = await jiraSeededDeps(() => ["CALC-1"]);
    const fetchMock = jwtGraphqlAndJira(
      () => ({ data: { getTests: { total: 1, results: [] } } }),
      { status: 200, body: { isLast: true, values: [{ key: "CALC", name: "Calculator" }] } }
    );
    vi.stubGlobal("fetch", fetchMock);

    await probeXrayConnection(deps);

    const emitted = deps.lines.join("\n");
    const basic = Buffer.from(`${JIRA_EMAIL}:${JIRA_TOKEN}`).toString("base64");
    expect(emitted).not.toContain(JIRA_TOKEN);
    expect(emitted).not.toContain(basic);
    expect(emitted).not.toContain(FAKE_SECRET);
  });
});
