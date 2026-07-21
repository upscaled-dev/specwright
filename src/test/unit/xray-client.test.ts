import { describe, it, expect, vi } from "vitest";
import * as vscode from "vscode";
import { Logger, LogLevel } from "../../utils/logger";
import { FetchLike, XrayAbortError, XrayClient } from "../../xray/xray-client";
import { XrayCredentials } from "../../xray/xray-credential-store";

const JWT = `${"a".repeat(140)}.${"b".repeat(140)}.${"c".repeat(140)}`;
const JWT2 = `${"d".repeat(140)}.${"e".repeat(140)}.${"f".repeat(140)}`;
const SECRET = "client-secret-value-must-never-be-logged";

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

function response(status: number, body: string): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: (): Promise<string> => Promise.resolve(body),
  } as unknown as Response;
}

interface ClientOptions {
  fetchImpl: FetchLike;
  credentials?: () => Promise<XrayCredentials | undefined>;
  logger?: Logger;
}

function makeClient(options: ClientOptions): XrayClient {
  return new XrayClient({
    region: "global",
    logger: options.logger ?? Logger.create(undefined, LogLevel.ERROR),
    credentials: options.credentials ?? (() => Promise.resolve({ clientId: "id", clientSecret: SECRET })),
    fetchImpl: options.fetchImpl,
    sleep: () => Promise.resolve(),
    random: () => 0,
    now: () => 1_000,
  });
}

// Authenticate returns JWT; every /graphql POST is answered by `handler(query, headers)`.
function jwtThenGraphql(
  handler: (query: string, headers: Record<string, string>) => unknown
): FetchLike {
  return (url, init) => {
    if (url.endsWith("/authenticate")) {
      return Promise.resolve(response(200, JSON.stringify(JWT)));
    }
    const query = (JSON.parse(String(init.body ?? "{}")) as { query?: string }).query ?? "";
    const headers = (init.headers ?? {}) as Record<string, string>;
    return Promise.resolve(response(200, JSON.stringify(handler(query, headers))));
  };
}

function testsPage(keys: string[], total = keys.length): unknown {
  return {
    data: {
      getTests: {
        total,
        results: keys.map((key) => ({
          jira: { key, summary: `summary ${key}` },
          gherkin: `Scenario: ${key}\n  Given a step`,
          status: { name: "PASS", color: "#0f0", final: true },
          testType: { name: "Cucumber", kind: "Gherkin" },
          coverableIssues: { results: [{ jira: { key: `${key}-REQ` } }] },
        })),
      },
    },
  };
}

describe("XrayClient.fetchTestsByKeys", () => {
  it("authenticates once, sends a Bearer JWT, and maps the test records", async () => {
    const calls: string[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      calls.push(url);
      if (url.endsWith("/authenticate")) {
        return Promise.resolve(response(200, JSON.stringify(JWT)));
      }
      expect((init.headers as Record<string, string>)["Authorization"]).toBe(`Bearer ${JWT}`);
      return Promise.resolve(response(200, JSON.stringify(testsPage(["CALC-1"]))));
    };
    const client = makeClient({ fetchImpl });

    const outcome = await client.fetchTestsByKeys(["calc-1"]);

    expect(calls).toEqual([
      "https://xray.cloud.getxray.app/api/v2/authenticate",
      "https://xray.cloud.getxray.app/api/v2/graphql",
    ]);
    expect(outcome.complete).toBe(true);
    expect(outcome.tests).toHaveLength(1);
    const record = outcome.tests[0]!;
    expect(record.key).toBe("CALC-1");
    expect(record.summary).toBe("summary CALC-1");
    expect(record.status).toEqual({ category: "passed", providerValue: "PASS", color: "#0f0" });
    expect(record.gherkin).toContain("Given a step");
    expect(record.coverageKeys).toEqual(["CALC-1-REQ"]);
    expect(record.testType).toEqual({ name: "Cucumber", kind: "Gherkin" });
  });

  it("chunks more than 100 keys into separate flat key-in batches with limit 100", async () => {
    const queries: string[] = [];
    const client = makeClient({
      fetchImpl: jwtThenGraphql((query) => {
        queries.push(query);
        return testsPage([]);
      }),
    });

    const keys = Array.from({ length: 150 }, (_v, i) => `CALC-${i + 1}`);
    await client.fetchTestsByKeys(keys);

    expect(queries).toHaveLength(2);
    expect(queries[0]).toContain("limit: 100");
    expect(queries[0]).toContain("coverableIssues(limit: 20)");
    expect(queries[0]).toContain("CALC-1,");
    expect(queries[0]).toContain("CALC-100)");
    expect(queries[0]).not.toContain("CALC-101");
    expect(queries[1]).toContain("CALC-101,");
    expect(queries[1]).toContain("CALC-150)");
  });
});

describe("XrayClient auth invalidation", () => {
  it("re-authenticates on the next request after invalidateAuth drops the cached token", async () => {
    let authCalls = 0;
    const fetchImpl: FetchLike = (url) => {
      if (url.endsWith("/authenticate")) {
        authCalls += 1;
        return Promise.resolve(response(200, JSON.stringify(JWT)));
      }
      return Promise.resolve(response(200, JSON.stringify(testsPage([]))));
    };
    const client = makeClient({ fetchImpl });

    await client.fetchTestsByKeys(["CALC-1"]);
    expect(authCalls).toBe(1);
    // Reuse without invalidation keeps the same token.
    await client.fetchTestsByKeys(["CALC-2"]);
    expect(authCalls).toBe(1);

    client.invalidateAuth();
    await client.fetchTestsByKeys(["CALC-3"]);
    expect(authCalls).toBe(2);
  });
});

describe("XrayClient invalidateAuth during an in-flight authenticate", () => {
  it("disowns the stale token so it is neither installed nor reused, and re-auths with current creds", async () => {
    let authCalls = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const creds = [
      { clientId: "old", clientSecret: "old-secret" },
      { clientId: "new", clientSecret: "new-secret" },
    ];
    let credIndex = 0;
    const authBodies: string[] = [];
    const usedBearers: string[] = [];
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.endsWith("/authenticate")) {
        authCalls += 1;
        authBodies.push(String(init.body ?? ""));
        if (authCalls === 1) {
          await firstGate; // park the first authenticate until after invalidateAuth disowns it
          return response(200, JSON.stringify(JWT));
        }
        return response(200, JSON.stringify(JWT2));
      }
      usedBearers.push((init.headers as Record<string, string>)["Authorization"] ?? "");
      return response(200, JSON.stringify(testsPage([])));
    };
    const client = makeClient({ fetchImpl, credentials: () => Promise.resolve(creds[credIndex]) });

    // First fetch's authInFlight is set synchronously; invalidateAuth then disowns it while its
    // /authenticate is still parked at the gate.
    const first = client.fetchProjectCatalogue("CALC");
    client.invalidateAuth();
    credIndex = 1;

    const second = await client.fetchProjectCatalogue("MATH");
    expect(authCalls).toBe(2);
    expect(authBodies[1]).toContain("new");
    expect(usedBearers.at(-1)).toBe(`Bearer ${JWT2}`);
    expect(second.complete).toBe(true);

    // Release the stale first authenticate; its old JWT must neither install nor be reused.
    releaseFirst();
    await first;
    usedBearers.length = 0;
    await client.fetchProjectCatalogue("PHYS");
    expect(authCalls).toBe(2); // JWT2 reused — the stale token never clobbered the cache
    expect(usedBearers).toEqual([`Bearer ${JWT2}`]);
  });
});

describe("XrayClient auth single-flight", () => {
  it("shares one /authenticate round-trip across concurrent fetches", async () => {
    let authCalls = 0;
    const fetchImpl: FetchLike = (url) => {
      if (url.endsWith("/authenticate")) {
        authCalls += 1;
        return Promise.resolve(response(200, JSON.stringify(JWT)));
      }
      return Promise.resolve(response(200, JSON.stringify(testsPage([]))));
    };
    const client = makeClient({ fetchImpl });

    await Promise.all([
      client.fetchProjectCatalogue("CALC"),
      client.fetchTestsByKeys(["MATH-1"]),
      client.fetchProjectCatalogue("PHYS"),
    ]);

    expect(authCalls).toBe(1);
  });
});

describe("XrayClient pagination", () => {
  it("pages a project catalogue with start/total until every item is collected", async () => {
    const starts: number[] = [];
    const client = makeClient({
      fetchImpl: jwtThenGraphql((query) => {
        const start = Number(/start: (\d+)/.exec(query)?.[1] ?? "0");
        starts.push(start);
        const keys = Array.from({ length: Math.min(100, 150 - start) }, (_v, i) => `CALC-${start + i + 1}`);
        return testsPage(keys, 150);
      }),
    });

    const outcome = await client.fetchProjectCatalogue("CALC");

    expect(starts).toEqual([0, 100]);
    expect(outcome.tests).toHaveLength(150);
    expect(outcome.complete).toBe(true);
    expect(outcome.pages).toHaveLength(2);
    expect(outcome.pages[0]).toMatchObject({ query: "project = CALC", start: 0, total: 150 });
  });

  it("marks the scope incomplete when a page is empty before total is reached", async () => {
    const client = makeClient({
      fetchImpl: jwtThenGraphql((query) => {
        const start = Number(/start: (\d+)/.exec(query)?.[1] ?? "0");
        if (start === 0) {
          return testsPage(Array.from({ length: 100 }, (_v, i) => `CALC-${i + 1}`), 150);
        }
        return testsPage([], 150); // empty page while start < total — a short/anomalous fetch
      }),
    });

    const outcome = await client.fetchProjectCatalogue("CALC");

    expect(outcome.tests).toHaveLength(100);
    expect(outcome.complete).toBe(false);
    expect(outcome.errors.some((e) => e.includes("pagination incomplete"))).toBe(true);
  });

  it("stops at the item cap and marks incomplete when the server's total keeps growing", async () => {
    const client = makeClient({
      fetchImpl: jwtThenGraphql((query) => {
        const start = Number(/start: (\d+)/.exec(query)?.[1] ?? "0");
        const keys = Array.from({ length: 100 }, (_v, i) => `CALC-${start + i + 1}`);
        // Total always stays far ahead of what has been collected, so the scope is never "done".
        return testsPage(keys, start + 100_000);
      }),
    });

    const outcome = await client.fetchProjectCatalogue("CALC");

    expect(outcome.complete).toBe(false);
    expect(outcome.tests).toHaveLength(10_000);
    expect(outcome.errors.some((e) => e.includes("cap"))).toBe(true);
  });
});

describe("XrayClient auth refresh on 401", () => {
  it("re-authenticates once on a 401 and retries with the new token", async () => {
    let graphqlCalls = 0;
    const authTokens: string[] = [];
    const usedBearers: string[] = [];
    const fetchImpl: FetchLike = (url, init) => {
      if (url.endsWith("/authenticate")) {
        const token = authTokens.length === 0 ? JWT : JWT2;
        authTokens.push(token);
        return Promise.resolve(response(200, JSON.stringify(token)));
      }
      usedBearers.push((init.headers as Record<string, string>)["Authorization"] ?? "");
      graphqlCalls += 1;
      if (graphqlCalls === 1) {
        return Promise.resolve(response(401, "token expired"));
      }
      return Promise.resolve(response(200, JSON.stringify(testsPage(["CALC-1"]))));
    };
    const client = makeClient({ fetchImpl });

    const outcome = await client.fetchTestsByKeys(["CALC-1"]);

    expect(authTokens).toEqual([JWT, JWT2]);
    expect(usedBearers).toEqual([`Bearer ${JWT}`, `Bearer ${JWT2}`]);
    expect(outcome.tests).toHaveLength(1);
    expect(outcome.complete).toBe(true);
  });

  it("re-authenticates at most once on a persistent 401, then records an auth error", async () => {
    let authCalls = 0;
    let graphqlCalls = 0;
    const fetchImpl: FetchLike = (url) => {
      if (url.endsWith("/authenticate")) {
        authCalls += 1;
        return Promise.resolve(response(200, JSON.stringify(JWT)));
      }
      graphqlCalls += 1;
      return Promise.resolve(response(401, "expired"));
    };
    const client = makeClient({ fetchImpl });

    const outcome = await client.fetchProjectCatalogue("CALC");

    // Initial auth + exactly one refresh — an infinite-refresh regression makes these grow unbounded.
    expect(authCalls).toBe(2);
    expect(graphqlCalls).toBe(2);
    expect(outcome.complete).toBe(false);
    expect(outcome.errors.some((e) => e.includes("Authentication failed"))).toBe(true);
  });
});

describe("XrayClient backoff", () => {
  it("retries transient 5xx responses and then succeeds", async () => {
    let graphqlCalls = 0;
    const fetchImpl: FetchLike = (url) => {
      if (url.endsWith("/authenticate")) {
        return Promise.resolve(response(200, JSON.stringify(JWT)));
      }
      graphqlCalls += 1;
      if (graphqlCalls < 3) {
        return Promise.resolve(response(503, "unavailable"));
      }
      return Promise.resolve(response(200, JSON.stringify(testsPage(["CALC-1"]))));
    };
    const client = makeClient({ fetchImpl });

    const outcome = await client.fetchTestsByKeys(["CALC-1"]);

    expect(graphqlCalls).toBe(3);
    expect(outcome.complete).toBe(true);
    expect(outcome.tests).toHaveLength(1);
  });

  it("gives up after the attempt cap and records a value-free error without throwing", async () => {
    let graphqlCalls = 0;
    const fetchImpl: FetchLike = (url) => {
      if (url.endsWith("/authenticate")) {
        return Promise.resolve(response(200, JSON.stringify(JWT)));
      }
      graphqlCalls += 1;
      return Promise.resolve(response(500, "boom"));
    };
    const client = makeClient({ fetchImpl });

    const outcome = await client.fetchProjectCatalogue("CALC");

    expect(graphqlCalls).toBe(4);
    expect(outcome.complete).toBe(false);
    expect(outcome.tests).toEqual([]);
    expect(outcome.errors[0]).toContain("project = CALC");
  });

  it("retries a rate-limited 429 without depending on any rate-limit header", async () => {
    let graphqlCalls = 0;
    const fetchImpl: FetchLike = (url) => {
      if (url.endsWith("/authenticate")) {
        return Promise.resolve(response(200, JSON.stringify(JWT)));
      }
      graphqlCalls += 1;
      return graphqlCalls === 1
        ? Promise.resolve(response(429, "slow down"))
        : Promise.resolve(response(200, JSON.stringify(testsPage(["CALC-1"]))));
    };
    const client = makeClient({ fetchImpl });

    const outcome = await client.fetchTestsByKeys(["CALC-1"]);
    expect(graphqlCalls).toBe(2);
    expect(outcome.tests).toHaveLength(1);
  });
});

describe("XrayClient abort", () => {
  it("throws XrayAbortError and makes no request when the signal is already aborted", async () => {
    const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve(response(200, "{}")));
    const client = makeClient({ fetchImpl });
    const controller = new AbortController();
    controller.abort();

    await expect(client.fetchTestsByKeys(["CALC-1"], controller.signal)).rejects.toBeInstanceOf(XrayAbortError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("XrayClient redaction", () => {
  it("never emits the JWT or the client secret on the happy path", async () => {
    const { logger, lines } = capturingLogger();
    const client = makeClient({ fetchImpl: jwtThenGraphql(() => testsPage(["CALC-1"])), logger });

    await client.fetchTestsByKeys(["CALC-1"]);

    const emitted = lines.join("\n");
    expect(emitted).not.toContain(JWT);
    expect(emitted).not.toContain(JWT.slice(0, 24));
    expect(emitted).not.toContain(SECRET);
    expect(emitted).toContain("JWT received");
  });

  it("keeps an echoed client secret out of the logs when authentication fails", async () => {
    const { logger, lines } = capturingLogger();
    const echoBody = JSON.stringify({ error: "bad", request: { client_secret: SECRET } });
    const client = makeClient({ fetchImpl: () => Promise.resolve(response(400, echoBody)), logger });

    const outcome = await client.fetchTestsByKeys(["CALC-1"]);

    const emitted = lines.join("\n");
    expect(emitted).not.toContain(SECRET);
    expect(emitted).toContain(`string(${SECRET.length})`);
    expect(outcome.complete).toBe(false);
    expect(outcome.errors.some((e) => e.includes("Authentication failed"))).toBe(true);
  });

  it("scrubs a jwt-like token that shows up in a GraphQL error message", async () => {
    const { logger, lines } = capturingLogger();
    const client = makeClient({
      fetchImpl: jwtThenGraphql(() => ({
        errors: [{ message: `denied for token ${JWT}`, extensions: { code: "FORBIDDEN" } }],
        data: null,
      })),
      logger,
    });

    const outcome = await client.fetchProjectCatalogue("CALC");

    const emitted = lines.join("\n");
    expect(emitted).not.toContain(JWT);
    expect(emitted).toContain("[jwt-like-token]");
    expect(emitted).toContain("FORBIDDEN");
    expect(outcome.complete).toBe(false);
    expect(outcome.errors.length).toBeGreaterThan(0);
  });
});
