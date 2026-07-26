import { describe, it, expect, vi } from "vitest";
import * as vscode from "vscode";
import { Logger, LogLevel } from "../../utils/logger";
import { FetchLike, XrayAbortError, XrayClient, XrayMutationError } from "../../xray/xray-client";
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
          issueId: `${key}-id`,
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
    expect(record.issueId).toBe("CALC-1-id");
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

describe("XrayClient.searchTests", () => {
  it("forwards a caller-built JQL through the getTests engine and maps the records", async () => {
    const queries: string[] = [];
    const client = makeClient({
      fetchImpl: jwtThenGraphql((query) => {
        queries.push(query);
        return testsPage(["CALC-7"]);
      }),
    });

    const outcome = await client.searchTests('project = CALC AND summary ~ "login*"');

    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("project = CALC AND summary ~");
    expect(queries[0]).toContain("limit: 100");
    expect(outcome.complete).toBe(true);
    expect(outcome.tests.map((t) => t.key)).toEqual(["CALC-7"]);
  });

  it("carries a test-plan JQL verbatim (the plan → test-keys lookup rides the same engine)", async () => {
    const queries: string[] = [];
    const client = makeClient({
      fetchImpl: jwtThenGraphql((query) => {
        queries.push(query);
        return testsPage(["CALC-1", "CALC-2"]);
      }),
    });

    const outcome = await client.searchTests('issue in testPlanTests("CALC-100")');

    expect(queries[0]).toContain("testPlanTests(");
    expect(outcome.tests.map((t) => t.key)).toEqual(["CALC-1", "CALC-2"]);
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

describe("XrayClient.postJson", () => {
  it("POSTs JSON to the given path with a Bearer JWT and returns the parsed body", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody = "";
    const fetchImpl: FetchLike = (url, init) => {
      if (url.endsWith("/authenticate")) {
        return Promise.resolve(response(200, JSON.stringify(JWT)));
      }
      capturedUrl = url;
      capturedHeaders = init.headers as Record<string, string>;
      capturedBody = String(init.body ?? "");
      return Promise.resolve(response(200, JSON.stringify({ id: "10200", key: "XNP-24", self: "https://x/10200" })));
    };
    const client = makeClient({ fetchImpl });

    const result = await client.postJson("/import/execution", { testExecutionKey: "XNP-24", tests: [] });

    expect(capturedUrl).toBe("https://xray.cloud.getxray.app/api/v2/import/execution");
    expect(capturedHeaders["Authorization"]).toBe(`Bearer ${JWT}`);
    expect(capturedHeaders["Content-Type"]).toBe("application/json");
    expect(JSON.parse(capturedBody)).toEqual({ testExecutionKey: "XNP-24", tests: [] });
    expect(result).toEqual({ status: 200, ok: true, body: { id: "10200", key: "XNP-24", self: "https://x/10200" } });
  });

  it("surfaces a non-2xx response as {status, ok:false, body} without throwing (400 is the importer's to validate)", async () => {
    const fetchImpl: FetchLike = (url) => {
      if (url.endsWith("/authenticate")) {
        return Promise.resolve(response(200, JSON.stringify(JWT)));
      }
      return Promise.resolve(response(400, JSON.stringify({ error: "No execution results were provided." })));
    };
    const client = makeClient({ fetchImpl });

    const result = await client.postJson("/import/execution", { tests: [] });

    expect(result).toEqual({ status: 400, ok: false, body: { error: "No execution results were provided." } });
  });

  it("refreshes the JWT exactly once on a 401 and retries with the new token", async () => {
    const authTokens: string[] = [];
    const usedBearers: string[] = [];
    let posts = 0;
    const fetchImpl: FetchLike = (url, init) => {
      if (url.endsWith("/authenticate")) {
        const token = authTokens.length === 0 ? JWT : JWT2;
        authTokens.push(token);
        return Promise.resolve(response(200, JSON.stringify(token)));
      }
      usedBearers.push((init.headers as Record<string, string>)["Authorization"] ?? "");
      posts += 1;
      return posts === 1
        ? Promise.resolve(response(401, "expired"))
        : Promise.resolve(response(200, JSON.stringify({ key: "XNP-24" })));
    };
    const client = makeClient({ fetchImpl });

    const result = await client.postJson("/import/execution", { tests: [] });

    expect(authTokens).toEqual([JWT, JWT2]);
    expect(usedBearers).toEqual([`Bearer ${JWT}`, `Bearer ${JWT2}`]);
    expect(result.body).toEqual({ key: "XNP-24" });
  });

  it("throws XrayAbortError and makes no request when the signal is already aborted", async () => {
    const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve(response(200, "{}")));
    const client = makeClient({ fetchImpl });
    const controller = new AbortController();
    controller.abort();

    await expect(client.postJson("/import/execution", {}, controller.signal)).rejects.toBeInstanceOf(XrayAbortError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("XrayClient.postMultipart", () => {
  it("POSTs two application/json file parts named results/info with a Bearer JWT and no hand-set Content-Type", async () => {
    let capturedUrl = "";
    let capturedHeaders: Record<string, string> = {};
    let capturedBody: unknown;
    const fetchImpl: FetchLike = (url, init) => {
      if (url.endsWith("/authenticate")) {
        return Promise.resolve(response(200, JSON.stringify(JWT)));
      }
      capturedUrl = url;
      capturedHeaders = init.headers as Record<string, string>;
      capturedBody = init.body;
      return Promise.resolve(response(200, JSON.stringify({ id: "10200", key: "XNP-24", self: "https://x/10200" })));
    };
    const client = makeClient({ fetchImpl });

    const result = await client.postMultipart("/import/execution/cucumber/multipart", {
      results: '[{"uri":"features/a.feature"}]',
      info: '{"fields":{"project":{"key":"CALC"}}}',
    });

    expect(capturedUrl).toBe("https://xray.cloud.getxray.app/api/v2/import/execution/cucumber/multipart");
    expect(capturedHeaders["Authorization"]).toBe(`Bearer ${JWT}`);
    expect(capturedHeaders["Content-Type"]).toBeUndefined();
    const form = capturedBody as FormData;
    expect([...form.keys()]).toEqual(["results", "info"]);
    const results = form.get("results");
    const info = form.get("info");
    expect(results).toBeInstanceOf(Blob);
    expect(info).toBeInstanceOf(Blob);
    expect((results as Blob).type).toBe("application/json");
    expect(await (results as Blob).text()).toBe('[{"uri":"features/a.feature"}]');
    expect(await (info as Blob).text()).toBe('{"fields":{"project":{"key":"CALC"}}}');
    expect(result).toEqual({ status: 200, ok: true, body: { id: "10200", key: "XNP-24", self: "https://x/10200" } });
  });

  it("refreshes the JWT once on a 401 and retries the multipart POST", async () => {
    const authTokens: string[] = [];
    const usedBearers: string[] = [];
    let posts = 0;
    const fetchImpl: FetchLike = (url, init) => {
      if (url.endsWith("/authenticate")) {
        const token = authTokens.length === 0 ? JWT : JWT2;
        authTokens.push(token);
        return Promise.resolve(response(200, JSON.stringify(token)));
      }
      usedBearers.push((init.headers as Record<string, string>)["Authorization"] ?? "");
      posts += 1;
      return posts === 1
        ? Promise.resolve(response(401, "expired"))
        : Promise.resolve(response(200, JSON.stringify({ key: "XNP-24" })));
    };
    const client = makeClient({ fetchImpl });

    const result = await client.postMultipart("/import/execution/cucumber/multipart", { results: "[]", info: "{}" });

    expect(authTokens).toEqual([JWT, JWT2]);
    expect(usedBearers).toEqual([`Bearer ${JWT}`, `Bearer ${JWT2}`]);
    expect(result.body).toEqual({ key: "XNP-24" });
  });

  it("throws XrayAbortError and makes no request when the signal is already aborted", async () => {
    const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve(response(200, "{}")));
    const client = makeClient({ fetchImpl });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.postMultipart("/import/execution/cucumber/multipart", { results: "[]", info: "{}" }, controller.signal)
    ).rejects.toBeInstanceOf(XrayAbortError);
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

describe("XrayClient.createTest", () => {
  it("sends a Cucumber createTest mutation with JSON-escaped gherkin/project/summary and reads key/issueId/warnings back inline", async () => {
    let captured = "";
    const client = makeClient({
      fetchImpl: jwtThenGraphql((query) => {
        captured = query;
        return { data: { createTest: { test: { issueId: "45678", jira: { key: "calc-9" } }, warnings: [] } } };
      }),
    });

    const created = await client.createTest({
      project: "CALC",
      summary: 'Login "flow"',
      gherkin: "Scenario: Login\n  Given a user",
    });

    expect(captured).toContain('testType: { name: "Cucumber" }');
    expect(captured).toContain('gherkin: "Scenario: Login\\n  Given a user"');
    expect(captured).toContain('project: { key: "CALC" }');
    expect(captured).toContain('summary: "Login \\"flow\\""');
    expect(captured).toContain('test { issueId jira(fields: ["key"]) } warnings');
    // The key is uppercased on the way back, mirroring the getTests parse.
    expect(created).toEqual({ key: "CALC-9", issueId: "45678", warnings: [] });
  });

  it("returns a keyless record (never throws) when the create response carries no readable key", async () => {
    const client = makeClient({
      fetchImpl: jwtThenGraphql(() => ({ data: { createTest: { test: { issueId: "99" }, warnings: [] } } })),
    });

    const created = await client.createTest({ project: "CALC", summary: "S", gherkin: "Scenario: S" });

    expect(created.key).toBeUndefined();
    expect(created.issueId).toBe("99");
    expect(created.warnings).toEqual([]);
  });

  it("surfaces non-empty createTest warnings and drops empty ones", async () => {
    const client = makeClient({
      fetchImpl: jwtThenGraphql(() => ({
        data: { createTest: { test: { issueId: "1", jira: { key: "CALC-1" } }, warnings: ["gherkin adjusted", ""] } },
      })),
    });

    const created = await client.createTest({ project: "CALC", summary: "S", gherkin: "Scenario: S" });

    expect(created).toEqual({ key: "CALC-1", issueId: "1", warnings: ["gherkin adjusted"] });
  });

  it("throws XrayMutationError on a GraphQL errors envelope (the create is treated as not having happened)", async () => {
    const client = makeClient({
      fetchImpl: jwtThenGraphql(() => ({
        errors: [{ message: "Project CALC does not exist", extensions: { code: "BAD_REQUEST" } }],
        data: null,
      })),
    });

    await expect(
      client.createTest({ project: "CALC", summary: "S", gherkin: "Scenario: S" })
    ).rejects.toBeInstanceOf(XrayMutationError);
  });
});

describe("XrayClient container creates", () => {
  it("sends createTestSet with the member issue ids and the same jira literal createTest builds", async () => {
    let captured = "";
    const client = makeClient({
      fetchImpl: jwtThenGraphql((query) => {
        captured = query;
        return { data: { createTestSet: { testSet: { issueId: "5000", jira: { key: "calc-90" } }, warnings: [] } } };
      }),
    });

    const created = await client.createTestSet("CALC", 'Regression "suite"', ["1001", "1002"]);

    expect(captured).toContain('createTestSet(testIssueIds: ["1001", "1002"]');
    expect(captured).toContain('jira: { fields: { project: { key: "CALC" }, summary: "Regression \\"suite\\"" } }');
    expect(captured).toContain('testSet { issueId jira(fields: ["key"]) } warnings');
    expect(created).toEqual({ key: "CALC-90", issueId: "5000", warnings: [] });
  });

  it("sends createTestPlan the same way, never a savedFilter (it excludes testIssueIds)", async () => {
    let captured = "";
    const client = makeClient({
      fetchImpl: jwtThenGraphql((query) => {
        captured = query;
        return { data: { createTestPlan: { testPlan: { issueId: "6000", jira: { key: "CALC-91" } }, warnings: [] } } };
      }),
    });

    const created = await client.createTestPlan("CALC", "Release 4", ["1001"]);

    expect(captured).toContain('createTestPlan(testIssueIds: ["1001"]');
    expect(captured).toContain('testPlan { issueId jira(fields: ["key"]) } warnings');
    expect(captured).not.toContain("savedFilter");
    expect(created).toEqual({ key: "CALC-91", issueId: "6000", warnings: [] });
  });

  // `tests(...)` is a connection needing its own limit, so the created container is never asked for its
  // members: the caller already knows what it sent.
  it("never selects the members back off the created container", async () => {
    let captured = "";
    const client = makeClient({
      fetchImpl: jwtThenGraphql((query) => {
        captured = query;
        return { data: { createTestSet: { testSet: { issueId: "5000" }, warnings: [] } } };
      }),
    });

    await client.createTestSet("CALC", "Regression", ["1001"]);

    expect(captured).not.toContain("tests(");
  });

  it("returns a keyless record (never throws) when the container response carries no readable key", async () => {
    const client = makeClient({
      fetchImpl: jwtThenGraphql(() => ({ data: { createTestPlan: { testPlan: { issueId: "6000" }, warnings: [] } } })),
    });

    const created = await client.createTestPlan("CALC", "Release 4", ["1001"]);

    expect(created).toEqual({ issueId: "6000", warnings: [] });
  });

  it("surfaces non-empty container warnings and drops empty ones", async () => {
    const client = makeClient({
      fetchImpl: jwtThenGraphql(() => ({
        data: { createTestSet: { testSet: { jira: { key: "CALC-90" } }, warnings: ["1002 is not a test", ""] } },
      })),
    });

    const created = await client.createTestSet("CALC", "Regression", ["1001", "1002"]);

    expect(created).toEqual({ key: "CALC-90", warnings: ["1002 is not a test"] });
  });

  it("throws XrayMutationError on a GraphQL errors envelope (the container is treated as not created)", async () => {
    const client = makeClient({
      fetchImpl: jwtThenGraphql(() => ({
        errors: [{ message: "Project CALC does not exist", extensions: { code: "BAD_REQUEST" } }],
        data: null,
      })),
    });

    await expect(client.createTestSet("CALC", "Regression", ["1001"])).rejects.toBeInstanceOf(XrayMutationError);
  });

  it("sends createTestExecution with no members and no environments at all", async () => {
    let captured = "";
    const client = makeClient({
      fetchImpl: jwtThenGraphql((query) => {
        captured = query;
        return {
          data: { createTestExecution: { testExecution: { issueId: "7000", jira: { key: "xnp-7" } }, warnings: [] } },
        };
      }),
    });

    const created = await client.createTestExecution("XNP", "XNP Test Execution (2026-07-26)");

    expect(captured).toContain(
      'createTestExecution(jira: { fields: { project: { key: "XNP" }, summary: "XNP Test Execution (2026-07-26)" } })'
    );
    expect(captured).toContain('testExecution { issueId jira(fields: ["key"]) } warnings');
    expect(captured).not.toContain("testIssueIds");
    expect(captured).not.toContain("testEnvironments");
    expect(captured).not.toContain("createdTestEnvironments");
    expect(captured).not.toContain("tests(");
    expect(created).toEqual({ key: "XNP-7", issueId: "7000", warnings: [] });
  });

  it("returns a keyless execution record rather than throwing, so the caller can report it honestly", async () => {
    const client = makeClient({
      fetchImpl: jwtThenGraphql(() => ({
        data: { createTestExecution: { testExecution: { issueId: "7000" }, warnings: ["summary was trimmed"] } },
      })),
    });

    const created = await client.createTestExecution("XNP", "Nightly");

    expect(created).toEqual({ issueId: "7000", warnings: ["summary was trimmed"] });
  });

  it("threads the abort signal through, so a cancelled create never reaches the network", async () => {
    const fetchImpl = vi.fn<FetchLike>(() => Promise.resolve(response(200, "{}")));
    const client = makeClient({ fetchImpl });
    const controller = new AbortController();
    controller.abort();

    await expect(
      client.createTestPlan("CALC", "Release 4", ["1001"], controller.signal)
    ).rejects.toBeInstanceOf(XrayAbortError);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("XrayClient.updateGherkinTestDefinition", () => {
  it("addresses the mutation by issue id with JSON-escaped gherkin, omits versionId, and returns the read-back text", async () => {
    let captured = "";
    const client = makeClient({
      fetchImpl: jwtThenGraphql((query) => {
        captured = query;
        return { data: { updateGherkinTestDefinition: { issueId: "45678", gherkin: "Scenario: Login\n  Given a user" } } };
      }),
    });

    const readBack = await client.updateGherkinTestDefinition("45678", "Scenario: Login\n  Given a user");

    expect(captured).toContain('updateGherkinTestDefinition(issueId: "45678"');
    expect(captured).toContain('gherkin: "Scenario: Login\\n  Given a user"');
    expect(captured).toContain("{ issueId gherkin }");
    expect(captured).not.toContain("versionId");
    expect(readBack).toBe("Scenario: Login\n  Given a user");
  });

  it("returns undefined when the response carries no readable text, so the caller reports it unverified", async () => {
    const client = makeClient({
      fetchImpl: jwtThenGraphql(() => ({ data: { updateGherkinTestDefinition: null } })),
    });

    await expect(client.updateGherkinTestDefinition("45678", "Scenario: S")).resolves.toBeUndefined();
  });

  it("throws XrayMutationError on a GraphQL errors envelope (the update is treated as not having happened)", async () => {
    const client = makeClient({
      fetchImpl: jwtThenGraphql(() => ({
        errors: [{ message: "Issue does not exist", extensions: { code: "BAD_REQUEST" } }],
        data: null,
      })),
    });

    await expect(client.updateGherkinTestDefinition("45678", "Scenario: S")).rejects.toBeInstanceOf(XrayMutationError);
  });
});
