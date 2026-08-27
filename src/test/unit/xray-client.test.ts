import { describe, it, expect, vi } from "vitest";
import * as vscode from "vscode";
import { Logger, LogLevel } from "../../utils/logger";
import { FetchLike, XrayAbortError, XrayAuthError, XrayClient, XrayMutationError } from "../../xray/xray-client";
import { XrayCredentials } from "../../xray/xray-credential-store";
import {
  RemoteOutcomeUnknownError,
  WorkspaceTrust,
  WorkspaceTrustRevokedError,
} from "../../core/workspace-trust";

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
          folder: { name: "Smoke", path: "/Checkout/Smoke" },
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
    expect(record.repositoryFolder).toEqual({ name: "Smoke", path: "/Checkout/Smoke" });
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
    expect(queries[0]).toContain(String.raw`\"CALC-1\",`);
    expect(queries[0]).toContain(String.raw`\"CALC-100\")`);
    expect(queries[0]).not.toContain("CALC-101");
    expect(queries[1]).toContain(String.raw`\"CALC-101\",`);
    expect(queries[1]).toContain(String.raw`\"CALC-150\")`);
  });

  it("quotes each key so a reserved-word project part (IS) survives JQL parsing", async () => {
    const queries: string[] = [];
    const client = makeClient({
      fetchImpl: jwtThenGraphql((query) => {
        queries.push(query);
        return testsPage([]);
      }),
    });

    await client.fetchTestsByKeys(["IS-123"]);

    expect(queries[0]).toContain(String.raw`key in (\"IS-123\")`);
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
    expect(authCalls).toBe(2); // JWT2 reused; the stale token never clobbered the cache
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
    expect(outcome.pages[0]).toMatchObject({ query: 'project = "CALC"', start: 0, total: 150 });
  });

  it("reports each landed page with the records in hand and the total the remote gave", async () => {
    const client = makeClient({
      fetchImpl: jwtThenGraphql((query) => {
        const start = Number(/start: (\d+)/.exec(query)?.[1] ?? "0");
        return testsPage(Array.from({ length: Math.min(100, 150 - start) }, (_v, i) => `CALC-${start + i + 1}`), 150);
      }),
    });
    const pages: Array<[number, number | undefined]> = [];

    await client.fetchProjectCatalogue("CALC", undefined, (fetched, total) => pages.push([fetched, total]));

    // Cumulative, so the strip counts up rather than restarting each page.
    expect(pages).toEqual([[100, 150], [150, 150]]);
  });

  it("finishes the fetch when the progress sink throws, since reporting is best effort", async () => {
    const client = makeClient({
      fetchImpl: jwtThenGraphql((query) => {
        const start = Number(/start: (\d+)/.exec(query)?.[1] ?? "0");
        return testsPage(Array.from({ length: Math.min(100, 150 - start) }, (_v, i) => `CALC-${start + i + 1}`), 150);
      }),
    });

    const outcome = await client.fetchProjectCatalogue("CALC", undefined, () => {
      throw new Error("board closed");
    });

    expect(outcome.tests).toHaveLength(150);
    expect(outcome.complete).toBe(true);
    expect(outcome.errors).toEqual([]);
  });

  it("reports a page the remote gave no total for, so a countless scope still shows progress", async () => {
    const client = makeClient({
      fetchImpl: jwtThenGraphql(() => ({ data: { getTests: { results: [] } } })),
    });
    const pages: Array<[number, number | undefined]> = [];

    await client.fetchProjectCatalogue("CALC", undefined, (fetched, total) => pages.push([fetched, total]));

    expect(pages).toEqual([[0, undefined]]);
  });

  it("marks the scope incomplete when a page is empty before total is reached", async () => {
    const client = makeClient({
      fetchImpl: jwtThenGraphql((query) => {
        const start = Number(/start: (\d+)/.exec(query)?.[1] ?? "0");
        if (start === 0) {
          return testsPage(Array.from({ length: 100 }, (_v, i) => `CALC-${i + 1}`), 150);
        }
        return testsPage([], 150); // empty page while start < total, a short/anomalous fetch
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

    // Initial auth + exactly one refresh; an infinite-refresh regression makes these grow unbounded.
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
    expect(outcome.errors[0]).toContain('project = "CALC"');
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

  it("does not replay a JSON mutation after a 401", async () => {
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

    await expect(client.postJson("/import/execution", { tests: [] })).rejects.toBeInstanceOf(XrayAuthError);

    expect(authTokens).toEqual([JWT]);
    expect(usedBearers).toEqual([`Bearer ${JWT}`]);
    expect(posts).toBe(1);
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

  it("does not replay a multipart mutation after a 401", async () => {
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

    await expect(
      client.postMultipart("/import/execution/cucumber/multipart", { results: "[]", info: "{}" })
    ).rejects.toBeInstanceOf(XrayAuthError);

    expect(authTokens).toEqual([JWT]);
    expect(usedBearers).toEqual([`Bearer ${JWT}`]);
    expect(posts).toBe(1);
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
    // The secret is masked out of the echo, but the server's own wording survives verbatim.
    expect(emitted).toContain("[redacted]");
    expect(emitted).toContain('"error":"bad"');
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
  it("reports an unknown remote outcome when trust is revoked after the mutation starts", async () => {
    let mutationStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {mutationStarted = resolve;});
    const fetchImpl: FetchLike = (url, init) => {
      if (url.endsWith("/authenticate")) {
        return Promise.resolve(response(200, JSON.stringify(JWT)));
      }
      mutationStarted?.();
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    };
    const client = makeClient({ fetchImpl });
    const trust = new WorkspaceTrust(() => true);
    const pending = trust.run((signal) => client.createTest(
      { project: "CALC", summary: "S", gherkin: "Scenario: S" },
      signal
    ));

    await started;
    const disposal = trust.dispose();
    await expect(pending).rejects.toBeInstanceOf(RemoteOutcomeUnknownError);
    await disposal;
  });

  it("reports an unknown remote outcome when caller cancellation lands after dispatch", async () => {
    const controller = new AbortController();
    let writes = 0;
    const fetchImpl: FetchLike = (url) => {
      if (url.endsWith("/authenticate")) {
        return Promise.resolve(response(200, JSON.stringify(JWT)));
      }
      writes += 1;
      controller.abort();
      return Promise.reject(new Error("aborted"));
    };
    const client = makeClient({ fetchImpl });

    await expect(client.createTest(
      { project: "CALC", summary: "S", gherkin: "Scenario: S" },
      controller.signal
    )).rejects.toMatchObject({
      name: "RemoteOutcomeUnknownError",
      operationId: expect.any(String),
    });
    expect(writes).toBe(1);
  });

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

  it("does not locally quarantine the client after a reindex-like GraphQL mutation error", async () => {
    let mutations = 0;
    const client = makeClient({
      fetchImpl: jwtThenGraphql(() => {
        mutations += 1;
        return {
          errors: [{ message: "Project CALC may require administrator reindexing", extensions: { code: "BAD_REQUEST" } }],
          data: null,
        };
      }),
    });

    const create = (): Promise<unknown> =>
      client.createTest({ project: "CALC", summary: "S", gherkin: "Scenario: S" });

    await expect(create()).rejects.toBeInstanceOf(XrayMutationError);
    await expect(create()).rejects.toBeInstanceOf(XrayMutationError);
    expect(mutations).toBe(2);
  });
});

describe("XrayClient read cancellation", () => {
  it("keeps trust revocation classified as cancellation after a read starts", async () => {
    let readStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {readStarted = resolve;});
    const fetchImpl: FetchLike = (url, init) => {
      if (url.endsWith("/authenticate")) {
        return Promise.resolve(response(200, JSON.stringify(JWT)));
      }
      readStarted?.();
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    };
    const client = makeClient({ fetchImpl });
    const trust = new WorkspaceTrust(() => true);
    const pending = trust.run((signal) => client.fetchTestsByKeys(["CALC-1"], signal));

    await started;
    const disposal = trust.dispose();
    await expect(pending).rejects.toBeInstanceOf(WorkspaceTrustRevokedError);
    await disposal;
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

describe("XrayClient existing containers", () => {
  it("resolves a Test Set by a bounded exact-key type-specific read", async () => {
    let captured = "";
    const client = makeClient({
      fetchImpl: jwtThenGraphql((query) => {
        captured = query;
        return { data: { getTestSets: { results: [{ issueId: "5000", jira: { key: "calc-90" } }] } } };
      }),
    });

    await expect(client.resolveTestContainer("test-set", "CALC-90")).resolves.toEqual({
      kind: "test-set",
      key: "CALC-90",
      issueId: "5000",
    });
    expect(captured).toContain('getTestSets(jql: "key = \\"CALC-90\\"", limit: 1)');
    expect(captured).toContain('results { issueId jira(fields: ["key"]) }');
    expect(captured).not.toContain("getTestPlans");
  });

  it("returns undefined when the expected container type has no exact readable target", async () => {
    const client = makeClient({
      fetchImpl: jwtThenGraphql(() => ({
        data: { getTestPlans: { results: [{ issueId: "6000", jira: { key: "CALC-92" } }] } },
      })),
    });

    await expect(client.resolveTestContainer("test-plan", "CALC-91")).resolves.toBeUndefined();
  });

  it("returns undefined for a structurally valid empty lookup", async () => {
    const client = makeClient({
      fetchImpl: jwtThenGraphql(() => ({ data: { getTestSets: { results: [] } } })),
    });

    await expect(client.resolveTestContainer("test-set", "CALC-90")).resolves.toBeUndefined();
  });

  it("rejects a malformed HTTP-200 lookup envelope instead of treating it as missing", async () => {
    const client = makeClient({
      fetchImpl: jwtThenGraphql(() => ({ data: { getTestSets: {} } })),
    });

    await expect(client.resolveTestContainer("test-set", "CALC-90"))
      .rejects.toThrow("Xray returned a malformed Test Set lookup response.");
  });

  it("rejects an exact target row without a readable issue id instead of treating it as missing", async () => {
    const client = makeClient({
      fetchImpl: jwtThenGraphql(() => ({
        data: { getTestPlans: { results: [{ jira: { key: "CALC-91" } }] } },
      })),
    });

    await expect(client.resolveTestContainer("test-plan", "CALC-91"))
      .rejects.toThrow("Xray returned a malformed Test Plan lookup response.");
  });

  it("throws on a GraphQL errors envelope instead of misreporting the target as absent", async () => {
    const client = makeClient({
      fetchImpl: jwtThenGraphql(() => ({
        errors: [{ message: "Permission denied", extensions: { code: "FORBIDDEN" } }],
        data: null,
      })),
    });

    await expect(client.resolveTestContainer("test-set", "CALC-90")).rejects.toThrow("Permission denied");
  });

  it("throws on a non-OK read with a non-GraphQL body instead of misreporting the target as absent", async () => {
    const client = makeClient({
      fetchImpl: (url) => Promise.resolve(
        url.endsWith("/authenticate")
          ? response(200, JSON.stringify(JWT))
          : response(403, "forbidden")
      ),
    });

    await expect(client.resolveTestContainer("test-set", "CALC-90")).rejects.toThrow("Query failed (HTTP 403)");
  });

  it("sends one addTestsToTestSet mutation addressed by container and member issue ids", async () => {
    let captured = "";
    const client = makeClient({
      fetchImpl: jwtThenGraphql((query) => {
        captured = query;
        return { data: { addTestsToTestSet: { addedTests: ["1001"], warning: "1002 already exists" } } };
      }),
    });

    await expect(client.addTestsToContainer("test-set", "5000", ["1001", "1002"])).resolves.toEqual({
      addedTests: ["1001"],
      warning: "1002 already exists",
    });
    expect(captured).toContain('addTestsToTestSet(issueId: "5000", testIssueIds: ["1001", "1002"])');
    expect(captured).toContain("{ addedTests warning }");
  });

  it("keeps an unreadable addedTests field absent rather than returning an invented empty list", async () => {
    const client = makeClient({
      fetchImpl: jwtThenGraphql(() => ({ data: { addTestsToTestPlan: { warning: "inspect membership" } } })),
    });

    await expect(client.addTestsToContainer("test-plan", "6000", ["1001"])).resolves.toEqual({
      warning: "inspect membership",
    });
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

describe("XrayClient mutation replay safety", () => {
  const committedThenUnavailable = (): { fetchImpl: FetchLike; writes: () => number } => {
    let writes = 0;
    return {
      writes: () => writes,
      fetchImpl: (url) => {
        if (url.endsWith("/authenticate")) {return Promise.resolve(response(200, JSON.stringify(JWT)));}
        writes += 1;
        return Promise.resolve(response(503, "response lost after commit"));
      },
    };
  };

  it.each([
    ["create", (client: XrayClient) => client.createTest({ project: "CALC", summary: "S", gherkin: "Scenario: S" })],
    ["update", (client: XrayClient) => client.updateGherkinTestDefinition("123", "Scenario: S")],
    ["json import", (client: XrayClient) => client.postJson("/import/execution", { tests: [] })],
    ["multipart import", (client: XrayClient) => client.postMultipart("/import/execution/cucumber/multipart", { results: "[]", info: "{}" })],
  ])("does not replay %s after an ambiguous 503", async (_label, mutate) => {
    const remote = committedThenUnavailable();
    await expect(mutate(makeClient({ fetchImpl: remote.fetchImpl }))).rejects.toBeInstanceOf(RemoteOutcomeUnknownError);
    expect(remote.writes()).toBe(1);
  });
});
