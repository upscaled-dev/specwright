import { describe, it, expect } from "vitest";
import * as vscode from "vscode";
import { Logger, LogLevel } from "../../utils/logger";
import { FetchLike, JiraAccessError } from "../../xray/jira-project-search";
import { JiraIssueKind, JiraIssueSearchResult, searchJiraIssues } from "../../xray/jira-issue-search";

const EMAIL = "me@example.com";
const TOKEN = "jira-api-token-must-never-be-logged";
const SITE = "acme.atlassian.net";
const SEARCH_URL = `https://${SITE}/rest/api/3/search/jql`;

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

function response(status: number, body: unknown): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    text: (): Promise<string> => Promise.resolve(typeof body === "string" ? body : JSON.stringify(body)),
  } as unknown as Response;
}

function page(issues: Array<{ key: string; summary: string }>, extra: Record<string, unknown> = {}): unknown {
  return { issues: issues.map((i) => ({ key: i.key, fields: { summary: i.summary } })), isLast: true, ...extra };
}

function run(
  fetchImpl: FetchLike,
  logger: Logger,
  kind: JiraIssueKind = "execution",
  query = "CALC"
): Promise<JiraIssueSearchResult> {
  return searchJiraIssues({
    site: SITE,
    credentials: { email: EMAIL, token: TOKEN },
    kind,
    query,
    logger,
    fetchImpl,
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
}

describe("searchJiraIssues", () => {
  it("returns key/summary pairs, POSTs the scoped JQL, and sends basic auth", async () => {
    const { logger } = capturingLogger();
    let authHeader: string | undefined;
    let requestedUrl = "";
    let body: { jql?: string } = {};
    const fetchImpl: FetchLike = (url, init) => {
      requestedUrl = url;
      authHeader = (init.headers as Record<string, string>)["Authorization"];
      body = JSON.parse(init.body as string) as { jql?: string };
      return Promise.resolve(response(200, page([
        { key: "XNP-1", summary: "Nightly" },
        { key: "XNP-2", summary: "Smoke" },
      ])));
    };

    const { issues, truncated } = await run(fetchImpl, logger);

    expect(issues).toEqual([
      { key: "XNP-1", summary: "Nightly" },
      { key: "XNP-2", summary: "Smoke" },
    ]);
    expect(truncated).toBe(false);
    expect(requestedUrl).toBe(SEARCH_URL);
    expect(body.jql).toBe('project = "CALC" AND issuetype = "Test Execution" ORDER BY created DESC');
    expect(authHeader).toBe(`Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`);
  });

  it("builds the Test Plan JQL for the test-plan kind and omits the scope on an empty query", async () => {
    const { logger } = capturingLogger();
    let jql = "";
    const fetchImpl: FetchLike = (_url, init) => {
      jql = (JSON.parse(init.body as string) as { jql: string }).jql;
      return Promise.resolve(response(200, page([])));
    };
    await run(fetchImpl, logger, "test-plan", "");
    expect(jql).toBe('issuetype = "Test Plan" ORDER BY created DESC');
  });

  it("falls back to the issue key when a summary is missing", async () => {
    const { logger } = capturingLogger();
    const fetchImpl: FetchLike = () =>
      Promise.resolve(response(200, { issues: [{ key: "XNP-3", fields: {} }], isLast: true }));
    const { issues } = await run(fetchImpl, logger);
    expect(issues).toEqual([{ key: "XNP-3", summary: "XNP-3" }]);
  });

  it("paginates via nextPageToken until isLast", async () => {
    const { logger } = capturingLogger();
    const tokens: Array<string | undefined> = [];
    let call = 0;
    const fetchImpl: FetchLike = (_url, init) => {
      tokens.push((JSON.parse(init.body as string) as { nextPageToken?: string }).nextPageToken);
      call += 1;
      if (call === 1) {
        return Promise.resolve(response(200, page([{ key: "XNP-1", summary: "A" }], { isLast: false, nextPageToken: "tok-2" })));
      }
      return Promise.resolve(response(200, page([{ key: "XNP-2", summary: "B" }])));
    };

    const { issues, truncated } = await run(fetchImpl, logger);

    expect(issues.map((i) => i.key)).toEqual(["XNP-1", "XNP-2"]);
    expect(tokens).toEqual([undefined, "tok-2"]);
    expect(truncated).toBe(false);
  });

  it("truncates at the 200-issue cap", async () => {
    const { logger } = capturingLogger();
    const fetchImpl: FetchLike = () =>
      Promise.resolve(
        response(200, {
          issues: Array.from({ length: 50 }, (_v, i) => ({ key: `XNP-${i}`, fields: { summary: "s" } })),
          isLast: false,
          nextPageToken: "more",
        })
      );
    const { issues, truncated } = await run(fetchImpl, logger);
    expect(issues).toHaveLength(200);
    expect(truncated).toBe(true);
  });

  it("throws a value-free JiraAccessError on a 400 and never logs the token", async () => {
    const { logger, lines } = capturingLogger();
    const fetchImpl: FetchLike = () => Promise.resolve(response(400, { errorMessages: ["bad JQL"] }));
    await expect(run(fetchImpl, logger)).rejects.toBeInstanceOf(JiraAccessError);
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});

// The retry/backoff seam. `run` injects a no-op `sleep`, so these exercise the branching without real
// timers or wall-clock delay — no fake-timer plumbing needed (mirrors the jira-project-search tests).
describe("searchJiraIssues retry/backoff", () => {
  // withBackoff caps at MAX_ATTEMPTS = 4 (module-local); the count is the contract these tests pin.
  const MAX_ATTEMPTS = 4;

  it("retries a 429 rate-limit and succeeds on the next attempt", async () => {
    const { logger } = capturingLogger();
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(response(429, { errorMessages: ["rate limited"] }));
      }
      return Promise.resolve(response(200, page([{ key: "XNP-1", summary: "Nightly" }])));
    };

    const { issues } = await run(fetchImpl, logger);

    expect(calls).toBe(2);
    expect(issues).toEqual([{ key: "XNP-1", summary: "Nightly" }]);
  });

  it("retries a 5xx server error and succeeds on the next attempt", async () => {
    const { logger } = capturingLogger();
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(response(503, "service unavailable"));
      }
      return Promise.resolve(response(200, page([{ key: "XNP-2", summary: "Smoke" }])));
    };

    const { issues } = await run(fetchImpl, logger);

    expect(calls).toBe(2);
    expect(issues).toEqual([{ key: "XNP-2", summary: "Smoke" }]);
  });

  it("surfaces a repeated network fault as an unreachable JiraAccessError after exhausting retries", async () => {
    const { logger } = capturingLogger();
    let calls = 0;
    const sleeps: number[] = [];
    const fetchImpl: FetchLike = () => {
      calls += 1;
      return Promise.reject(new Error("ECONNRESET"));
    };

    const promise = searchJiraIssues({
      site: SITE,
      credentials: { email: EMAIL, token: TOKEN },
      kind: "execution",
      query: "CALC",
      logger,
      fetchImpl,
      sleep: (ms: number) => { sleeps.push(ms); return Promise.resolve(); },
      random: () => 0,
    });

    await expect(promise).rejects.toBeInstanceOf(JiraAccessError);
    await expect(
      searchJiraIssues({
        site: SITE,
        credentials: { email: EMAIL, token: TOKEN },
        kind: "execution",
        query: "CALC",
        logger,
        fetchImpl,
        sleep: () => Promise.resolve(),
        random: () => 0,
      })
    ).rejects.toThrow("Could not reach Jira");
    // MAX_ATTEMPTS fetches, one per attempt; backoff slept between each of the first run's attempts.
    expect(calls).toBe(MAX_ATTEMPTS * 2);
    expect(sleeps).toHaveLength(MAX_ATTEMPTS - 1);
  });

  it("does not retry a non-retryable 400 — a single fetch, then a terminal JiraAccessError", async () => {
    const { logger } = capturingLogger();
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      return Promise.resolve(response(400, { errorMessages: ["bad JQL"] }));
    };

    await expect(run(fetchImpl, logger)).rejects.toBeInstanceOf(JiraAccessError);
    expect(calls).toBe(1);
  });
});
