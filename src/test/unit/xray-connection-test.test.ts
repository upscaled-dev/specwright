import { describe, it, expect, vi, afterEach } from "vitest";
import * as vscode from "vscode";
import { Logger, LogLevel } from "../../utils/logger";
import { XrayCredentialStore } from "../../xray/xray-credential-store";
import {
  describeJwt,
  describeShape,
  extractTotal,
  graphqlErrorSummaries,
  probeXrayConnection,
  rateLimitHeaders,
  runXrayConnectionTest,
  scrubJwtLike,
} from "../../xray/xray-connection-test";

describe("describeShape", () => {
  it("emits types and lengths, never values", () => {
    const input = { name: "secret-value", count: 3, ok: true, none: null };
    expect(describeShape(input)).toEqual({
      name: "string(12)",
      count: "number",
      ok: "boolean",
      none: "null",
    });
  });

  it("summarizes arrays by first-element skeleton plus count", () => {
    expect(describeShape([{ a: "x" }, { a: "yy" }, { a: "zzz" }])).toEqual([
      { a: "string(1)" },
      "… 3 items total",
    ]);
    expect(describeShape([42])).toEqual(["number"]);
    expect(describeShape([])).toEqual(["(empty)"]);
  });

  it("stops recursing past the depth cap", () => {
    const deep = { l0: { l1: { l2: { l3: { l4: { l5: { l6: "too deep" } } } } } } };
    const result = describeShape(deep);
    const dig = (value: unknown, keys: string[]): unknown =>
      keys.reduce<unknown>((acc, key) => (acc as Record<string, unknown>)[key], value);
    expect(dig(result, ["l0", "l1", "l2", "l3", "l4", "l5"])).toBe("…");
  });

  it("never reproduces a long secret-like string in its output", () => {
    const secret = "client-secret-0123456789-abcdefghij";
    const out = JSON.stringify(describeShape({ request: { client_secret: secret } }));
    expect(out).not.toContain(secret);
    expect(out).toContain(`string(${secret.length})`);
  });
});

describe("scrubJwtLike", () => {
  const jwt = `${"a".repeat(40)}.${"b".repeat(40)}.${"c".repeat(40)}`;

  it("masks a three-segment token embedded in a sentence", () => {
    const scrubbed = scrubJwtLike(`denied for token ${jwt} on resource`);
    expect(scrubbed).not.toContain(jwt);
    expect(scrubbed).toContain("[jwt-like-token]");
    expect(scrubbed).toContain("denied for token");
  });

  it("keeps hostnames and short dotted values intact", () => {
    expect(scrubJwtLike("see acme.atlassian.net and v1.2.3")).toBe(
      "see acme.atlassian.net and v1.2.3"
    );
  });
});

describe("graphqlErrorSummaries", () => {
  it("returns empty for non-objects and bodies without errors", () => {
    expect(graphqlErrorSummaries("plain text")).toEqual([]);
    expect(graphqlErrorSummaries(null)).toEqual([]);
    expect(graphqlErrorSummaries({ data: { ok: true } })).toEqual([]);
    expect(graphqlErrorSummaries({ errors: [] })).toEqual([]);
  });

  it("formats message and extensions.code, with a fallback for missing messages", () => {
    const summaries = graphqlErrorSummaries({
      errors: [{ message: "denied", extensions: { code: "FORBIDDEN" } }, {}],
    });
    expect(summaries[0]).toBe("errors[0] [FORBIDDEN]: denied");
    expect(summaries[1]).toBe("errors[1]: (no message)");
  });

  it("clips long messages and scrubs jwt-like tokens inside them", () => {
    const jwt = `${"a".repeat(40)}.${"b".repeat(40)}.${"c".repeat(40)}`;
    const summaries = graphqlErrorSummaries({
      errors: [{ message: `bad token ${jwt} ${"x".repeat(400)}` }],
    });
    expect(summaries[0]).not.toContain(jwt);
    expect(summaries[0]).toContain("[jwt-like-token]");
    expect((summaries[0] ?? "").length).toBeLessThanOrEqual("errors[0]: ".length + 160);
  });
});

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

describe("describeJwt", () => {
  it("reports length and segment count without emitting the token", () => {
    const jwt = `${"a".repeat(20)}.${"b".repeat(20)}.${"c".repeat(20)}`;
    const line = describeJwt(jwt);
    expect(line).not.toContain(jwt);
    expect(line).toContain(`length ${jwt.length}`);
    expect(line).toContain("three-segment shape: true");
  });

  it("flags a token without three segments", () => {
    expect(describeJwt("no-dots")).toContain("three-segment shape: false");
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
  return new XrayCredentialStore(storage);
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
const SITE = "acme.atlassian.net";

async function seededDeps(knownTestKeys: () => string[] = () => []): Promise<{
  site: string;
  credentialStore: XrayCredentialStore;
  logger: Logger;
  knownTestKeys: () => string[];
  lines: string[];
}> {
  const { logger, lines } = capturingLogger();
  const credentialStore = mapCredentialStore();
  await credentialStore.setCredentials(SITE, "fake-client-id", FAKE_SECRET);
  return { site: SITE, credentialStore, logger, knownTestKeys, lines };
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

describe("runXrayConnectionTest — secret/JWT redaction invariant", () => {
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
    // authenticate + two shape probes + one project-count probe (single CALC project).
    expect(fetchMock).toHaveBeenCalledTimes(4);
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
    expect(emitted).toContain("response body shape");
    expect(emitted).toContain(`string(${FAKE_SECRET.length})`);
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
      expect.stringContaining("GraphQL probe failed"),
      "Show Output"
    );
  });

  it("aborts a stalled body read via the 30s timeout instead of hanging", async () => {
    vi.useFakeTimers();
    const deps = await seededDeps(() => ["CALC-1"]);
    const { lines } = deps;

    // 200 headers arrive, then the body stream stalls: text() settles only when the request
    // signal aborts — exactly the case the timer must still cover.
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
    await vi.advanceTimersByTimeAsync(31_000);
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

    await runXrayConnectionTest({ site: SITE, credentialStore, logger, knownTestKeys: () => [] });

    expect(warn).toHaveBeenCalledWith(
      "Connect to Xray before running a connection test.",
      "Connect"
    );
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe("probeXrayConnection — structured outcome", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
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
      message: `Connected to ${SITE} — authentication OK`,
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(deps.lines.join("\n")).toContain("no @TEST_ tags found in workspace — skipped GraphQL probes");
  });

  it("groups keys by project and reports each project's total from a `project = X` probe", async () => {
    const deps = await seededDeps(() => ["CALC-1043", "CALC-1051", "MATH-2"]);
    const fetchMock = jwtThenGraphql((query) => {
      if (query.includes("project = CALC")) {
        return { data: { getTests: { total: 42 } } };
      }
      if (query.includes("project = MATH")) {
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
      `Connected to ${SITE} — project CALC: 42 Xray tests, project MATH: 7 Xray tests`
    );
    // authenticate + two shape probes + one probe per project.
    expect(fetchMock).toHaveBeenCalledTimes(5);
  });

  it("probes at most three projects", async () => {
    const deps = await seededDeps(() => ["A-1", "B-1", "C-1", "D-1"]);
    const fetchMock = jwtThenGraphql(() => ({ data: { getTests: { total: 1 } } }));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await probeXrayConnection(deps);

    expect(outcome.projects).toHaveLength(3);
    // authenticate + two shape probes + three project probes (D is dropped by the cap).
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("returns an auth-stage failure and runs no further requests when authentication fails", async () => {
    const deps = await seededDeps(() => ["CALC-1"]);
    const fetchMock = vi.fn(() => Promise.resolve(makeResponse(401, "nope")));
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await probeXrayConnection(deps);

    expect(outcome.ok).toBe(false);
    expect(outcome.stage).toBe("auth");
    expect(outcome.message).toBe("Authentication failed — check your client ID and secret.");
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
    // Only /authenticate — no shape or project probes.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("excludes a project whose probe returns 200-with-errors and notes the failure in the message", async () => {
    const deps = await seededDeps(() => ["CALC-1", "MATH-1"]);
    const fetchMock = jwtThenGraphql((query) => {
      if (query.includes("project = CALC")) {
        return { errors: [{ message: "boom" }], data: null };
      }
      if (query.includes("project = MATH")) {
        return { data: { getTests: { total: 5 } } };
      }
      return { data: { getTests: { total: 2, results: [] } } };
    });
    vi.stubGlobal("fetch", fetchMock);

    const outcome = await probeXrayConnection(deps);

    expect(outcome.ok).toBe(true);
    expect(outcome.projects).toEqual([{ project: "MATH", totalTests: 5 }]);
    expect(outcome.message).toBe(
      `Connected to ${SITE} — project MATH: 5 Xray tests — 1 project probe(s) failed, see output`
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
    expect(listed[0]).toBe("CALC-1");
    expect(listed[19]).toBe("CALC-20");
    expect(capturedJql).not.toContain("CALC-21");
  });
});
