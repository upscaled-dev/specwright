import { describe, it, expect } from "vitest";
import * as vscode from "vscode";
import { Logger, LogLevel } from "../../utils/logger";
import {
  FetchLike,
  JiraAccessError,
  JiraProjectSearchResult,
  fetchJiraIdentity,
  searchJiraProjects,
} from "../../xray/jira-project-search";

const EMAIL = "me@example.com";
const TOKEN = "jira-api-token-must-never-be-logged";
const SITE = "acme.atlassian.net";
const SEARCH_PATH = "/rest/api/3/project/search";

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

function page(values: Array<{ key: string; name: string }>, extra: Record<string, unknown> = {}): unknown {
  return { startAt: 0, maxResults: 50, total: values.length, isLast: true, values, ...extra };
}

function run(
  fetchImpl: FetchLike,
  logger: Logger,
  over: { query?: string; signal?: AbortSignal } = {}
): Promise<JiraProjectSearchResult> {
  return searchJiraProjects({
    site: SITE,
    credentials: { email: EMAIL, token: TOKEN },
    logger,
    fetchImpl,
    sleep: () => Promise.resolve(),
    random: () => 0,
    ...over,
  });
}

describe("searchJiraProjects", () => {
  it("returns key/name pairs from a single final page and sends basic auth", async () => {
    const { logger } = capturingLogger();
    let authHeader: string | undefined;
    let requestedUrl = "";
    const fetchImpl: FetchLike = (url, init) => {
      requestedUrl = url;
      authHeader = (init.headers as Record<string, string>)["Authorization"];
      return Promise.resolve(response(200, page([
        { key: "CALC", name: "Calculator" },
        { key: "MATH", name: "Mathematics" },
      ])));
    };

    const { projects, truncated } = await run(fetchImpl, logger);

    expect(projects).toEqual([
      { key: "CALC", name: "Calculator" },
      { key: "MATH", name: "Mathematics" },
    ]);
    expect(truncated).toBe(false);
    expect(requestedUrl).toBe(`https://${SITE}${SEARCH_PATH}?startAt=0&maxResults=50`);
    const expected = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`;
    expect(authHeader).toBe(expected);
  });

  it("narrows the request with the endpoint's own query parameter, url-encoded", async () => {
    const { logger } = capturingLogger();
    let requestedUrl = "";
    const fetchImpl: FetchLike = (url) => {
      requestedUrl = url;
      return Promise.resolve(response(200, page([{ key: "CALC", name: "Calculator" }])));
    };

    await run(fetchImpl, logger, { query: "  my calc  " });

    expect(requestedUrl).toBe(`https://${SITE}${SEARCH_PATH}?startAt=0&maxResults=50&query=my%20calc`);
  });

  it("omits the query parameter entirely when no query is given", async () => {
    const { logger } = capturingLogger();
    let requestedUrl = "";
    const fetchImpl: FetchLike = (url) => {
      requestedUrl = url;
      return Promise.resolve(response(200, page([])));
    };

    await run(fetchImpl, logger, { query: "   " });

    expect(requestedUrl).not.toContain("query=");
  });

  it("threads the caller's abort signal into the fetch, so an abort cancels the request", async () => {
    const { logger } = capturingLogger();
    const controller = new AbortController();
    let aborted: boolean | undefined;
    const fetchImpl: FetchLike = (_url, init) => {
      const signal = init.signal as AbortSignal;
      controller.abort();
      aborted = signal.aborted;
      return Promise.resolve(response(200, page([{ key: "CALC", name: "Calculator" }])));
    };

    await run(fetchImpl, logger, { signal: controller.signal });

    expect(aborted).toBe(true);
  });

  it("follows nextPage until isLast and aggregates every page", async () => {
    const { logger } = capturingLogger();
    const urls: string[] = [];
    const fetchImpl: FetchLike = (url) => {
      urls.push(url);
      if (url.includes("startAt=0")) {
        return Promise.resolve(response(200, page(
          [{ key: "A", name: "Alpha" }],
          { isLast: false, nextPage: `https://${SITE}${SEARCH_PATH}?startAt=50&maxResults=50` }
        )));
      }
      return Promise.resolve(response(200, page([{ key: "B", name: "Beta" }])));
    };

    const { projects } = await run(fetchImpl, logger);

    expect(projects.map((p) => p.key)).toEqual(["A", "B"]);
    expect(urls).toHaveLength(2);
    expect(urls[1]).toContain("startAt=50");
  });

  it("stops at the 200-project hard cap even if the site keeps paging", async () => {
    const { logger } = capturingLogger();
    const fetchImpl: FetchLike = () =>
      Promise.resolve(response(200, page(
        Array.from({ length: 50 }, (_v, i) => ({ key: `P${i}`, name: `Project ${i}` })),
        { isLast: false, nextPage: `https://${SITE}${SEARCH_PATH}?startAt=99999&maxResults=50` }
      )));

    const { projects, truncated } = await run(fetchImpl, logger);

    expect(projects).toHaveLength(200);
    expect(truncated).toBe(true);
  });

  it("falls back to the key when a project name is missing", async () => {
    const { logger } = capturingLogger();
    const fetchImpl: FetchLike = () =>
      Promise.resolve(response(200, page([{ key: "SOLO" } as { key: string; name: string }])));

    const { projects } = await run(fetchImpl, logger);

    expect(projects).toEqual([{ key: "SOLO", name: "SOLO" }]);
  });

  it("throws a value-free JiraAccessError on 401 and logs the body with the token masked", async () => {
    const { logger, lines } = capturingLogger();
    const fetchImpl: FetchLike = () =>
      Promise.resolve(response(401, { errorMessages: [`token ${TOKEN} rejected`] }));

    await expect(run(fetchImpl, logger)).rejects.toBeInstanceOf(JiraAccessError);
    await expect(run(fetchImpl, logger)).rejects.toThrow("Jira authentication failed");

    const emitted = lines.join("\n");
    expect(emitted).toContain("response body:");
    expect(emitted).toContain("[redacted] rejected");
    expect(emitted).not.toContain(TOKEN);
  });

  it("masks the basic-auth header and the email out of a refused body", async () => {
    const { logger, lines } = capturingLogger();
    const basic = Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");
    const fetchImpl: FetchLike = () =>
      Promise.resolve(response(403, { errorMessages: [`Basic ${basic} for ${EMAIL} is not permitted`] }));

    await expect(run(fetchImpl, logger)).rejects.toThrow("Jira denied access");

    const emitted = lines.join("\n");
    expect(emitted).toContain("Basic [redacted] for [redacted] is not permitted");
    expect(emitted).not.toContain(basic);
    expect(emitted).not.toContain(EMAIL);
  });

  it("maps 403 and 404 to distinct value-free messages", async () => {
    const { logger } = capturingLogger();
    await expect(run(() => Promise.resolve(response(403, "denied")), logger)).rejects.toThrow(
      "Jira denied access"
    );
    await expect(run(() => Promise.resolve(response(404, "missing")), logger)).rejects.toThrow(
      "endpoint not found"
    );
  });

  it("retries a 500 then succeeds via backoff", async () => {
    const { logger } = capturingLogger();
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(response(500, "boom"));
      }
      return Promise.resolve(response(200, page([{ key: "CALC", name: "Calculator" }])));
    };

    const { projects } = await run(fetchImpl, logger);

    expect(calls).toBe(2);
    expect(projects).toEqual([{ key: "CALC", name: "Calculator" }]);
  });

  it("surfaces a network fault as an unreachable JiraAccessError after exhausting retries", async () => {
    const { logger } = capturingLogger();
    const fetchImpl: FetchLike = () => Promise.reject(new Error("ECONNRESET"));

    await expect(run(fetchImpl, logger)).rejects.toThrow("Could not reach Jira");
  });

  it("never logs the API token or the base64 basic-auth header on the happy path", async () => {
    const { logger, lines } = capturingLogger();
    const fetchImpl: FetchLike = () =>
      Promise.resolve(response(200, page([{ key: "CALC", name: "Calculator" }])));

    await run(fetchImpl, logger);

    const emitted = lines.join("\n");
    const basic = Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");
    expect(emitted).not.toContain(TOKEN);
    expect(emitted).not.toContain(basic);
    expect(emitted).not.toContain("Authorization");
    expect(emitted).toContain("GET /rest/api/3/project/search");
  });
});

describe("fetchJiraIdentity", () => {
  function identity(fetchImpl: FetchLike, logger: Logger): Promise<string> {
    return fetchJiraIdentity({ site: SITE, credentials: { email: EMAIL, token: TOKEN }, logger, fetchImpl });
  }

  it("returns the display name and sends basic auth to /myself", async () => {
    const { logger, lines } = capturingLogger();
    let requestedUrl = "";
    const fetchImpl: FetchLike = (url, init) => {
      requestedUrl = url;
      expect((init.headers as Record<string, string>)["Authorization"]).toContain("Basic ");
      return Promise.resolve(response(200, { displayName: "Jane Tester", accountId: "5b1" }));
    };

    await expect(identity(fetchImpl, logger)).resolves.toBe("Jane Tester");
    expect(requestedUrl).toBe(`https://${SITE}/rest/api/3/myself`);
    expect(lines.join("\n")).toContain("authenticated as Jane Tester");
  });

  it("falls back to the account email when the site names no display name", async () => {
    const { logger } = capturingLogger();
    const fetchImpl: FetchLike = () => Promise.resolve(response(200, { emailAddress: EMAIL }));

    await expect(identity(fetchImpl, logger)).resolves.toBe(EMAIL);
  });

  it("carries the status and the envelope's text on a refusal, with the credentials masked", async () => {
    const { logger, lines } = capturingLogger();
    const basic = Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");
    const fetchImpl: FetchLike = () =>
      Promise.resolve(
        response(403, { errorMessages: [`${EMAIL} with token ${TOKEN} (Basic ${basic}) lacks Browse`] })
      );

    await expect(identity(fetchImpl, logger)).rejects.toThrow(
      "Jira identity check failed (HTTP 403): [redacted] with token [redacted] (Basic [redacted]) lacks Browse"
    );
    const emitted = lines.join("\n");
    expect(emitted).toContain("GET /rest/api/3/myself → 403");
    expect(emitted).not.toContain(TOKEN);
    expect(emitted).not.toContain(basic);
    expect(emitted).not.toContain(EMAIL);
  });

  it("reports an unreachable site rather than a status", async () => {
    const { logger } = capturingLogger();
    const fetchImpl: FetchLike = () => Promise.reject(new Error("fetch failed", { cause: new Error("ECONNREFUSED") }));

    await expect(identity(fetchImpl, logger)).rejects.toThrow("Could not reach Jira");
  });
});
