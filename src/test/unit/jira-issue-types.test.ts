import { describe, it, expect, vi } from "vitest";
import * as vscode from "vscode";
import { Logger, LogLevel } from "../../utils/logger";
import { FetchLike } from "../../xray/jira-project-search";
import { IssueTypeResolution, resolveExecutionIssueType } from "../../xray/jira-issue-types";

const EMAIL = "me@example.com";
const TOKEN = "jira-api-token-must-never-be-logged";
const SITE = "acme.atlassian.net";

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

function meta(issueTypes: unknown[]): unknown {
  return { maxResults: 200, startAt: 0, total: issueTypes.length, issueTypes };
}

// A DOMException-shaped abort as a real fetch surfaces when its AbortSignal fires.
function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}

function resolve(
  fetchImpl: FetchLike,
  logger: Logger,
  projectKey = "SCRATCH",
  executionIssueType = "Test Execution"
): Promise<IssueTypeResolution> {
  return resolveExecutionIssueType({
    site: SITE,
    credentials: { email: EMAIL, token: TOKEN },
    projectKey,
    executionIssueType,
    logger,
    fetchImpl,
    sleep: () => Promise.resolve(),
    random: () => 0,
  });
}

describe("resolveExecutionIssueType", () => {
  it("resolves the matching type by name, GETs createmeta issuetypes, and sends basic auth", async () => {
    const { logger } = capturingLogger();
    let requestedUrl = "";
    let method: string | undefined;
    let authHeader: string | undefined;
    const fetchImpl: FetchLike = (url, init) => {
      requestedUrl = url;
      method = init.method;
      authHeader = (init.headers as Record<string, string>)["Authorization"];
      return Promise.resolve(response(200, meta([
        { id: "1", name: "Bug", subtask: false },
        { id: "2", name: "Test Execution", subtask: false },
      ])));
    };

    const result = await resolve(fetchImpl, logger);

    expect(result).toEqual({ kind: "resolved", name: "Test Execution" });
    expect(requestedUrl).toBe(`https://${SITE}/rest/api/3/issue/createmeta/SCRATCH/issuetypes?maxResults=200`);
    expect(method).toBe("GET");
    expect(authHeader).toBe(`Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`);
  });

  it("matches case-insensitively and returns the project's verbatim casing", async () => {
    const { logger } = capturingLogger();
    const fetchImpl: FetchLike = () =>
      Promise.resolve(response(200, meta([{ id: "9", name: "TEST EXECUTION", subtask: false }])));
    const result = await resolve(fetchImpl, logger);
    expect(result).toEqual({ kind: "resolved", name: "TEST EXECUTION" });
  });

  it("matches the configured work type name when the project maps its own", async () => {
    const { logger } = capturingLogger();
    const fetchImpl: FetchLike = () =>
      Promise.resolve(response(200, meta([
        { id: "1", name: "Test Execution", subtask: false },
        { id: "2", name: "Sub-Test Execution", subtask: false },
      ])));
    const result = await resolve(fetchImpl, logger, "APEX", "Sub-Test Execution");
    expect(result).toEqual({ kind: "resolved", name: "Sub-Test Execution" });
  });

  it("reports the configured name as a subtask type when the project maps it subtask-level", async () => {
    const { logger } = capturingLogger();
    const fetchImpl: FetchLike = () =>
      Promise.resolve(response(200, meta([
        { id: "1", name: "Sub-Test Execution", subtask: true },
        { id: "2", name: "Test Execution", subtask: false },
      ])));
    const result = await resolve(fetchImpl, logger, "APEX", "Sub-Test Execution");
    expect(result).toEqual({
      kind: "unavailable",
      availableNames: ["Test Execution"],
      subtaskNames: ["Sub-Test Execution"],
      subtaskMatch: "Sub-Test Execution",
      teamManaged: false,
    });
  });

  it("reports a localized subtask entry as the match when only its untranslatedName carries the target", async () => {
    const { logger } = capturingLogger();
    const fetchImpl: FetchLike = () =>
      Promise.resolve(response(200, meta([
        { id: "1", name: "Ausführung", untranslatedName: "Test Execution", subtask: true },
        { id: "2", name: "Story", subtask: false },
      ])));
    const result = await resolve(fetchImpl, logger);
    expect(result).toEqual({
      kind: "unavailable",
      availableNames: ["Story"],
      subtaskNames: ["Ausführung"],
      subtaskMatch: "Ausführung",
      teamManaged: false,
    });
  });

  it("matches on untranslatedName when the display name is localized", async () => {
    const { logger } = capturingLogger();
    const fetchImpl: FetchLike = () =>
      Promise.resolve(response(200, meta([{ id: "3", name: "Ausführung", untranslatedName: "Test Execution", subtask: false }])));
    const result = await resolve(fetchImpl, logger);
    expect(result).toEqual({ kind: "resolved", name: "Ausführung" });
  });

  it("never matches a subtask entry carrying the execution name, but reports it as a subtask type", async () => {
    const { logger } = capturingLogger();
    const fetchImpl: FetchLike = () =>
      Promise.resolve(response(200, meta([
        { id: "4", name: "Test Execution", subtask: true },
        { id: "5", name: "Story", subtask: false },
      ])));
    const result = await resolve(fetchImpl, logger);
    expect(result).toEqual({
      kind: "unavailable",
      availableNames: ["Story"],
      subtaskNames: ["Test Execution"],
      subtaskMatch: "Test Execution",
      teamManaged: false,
    });
  });

  it("returns unavailable with the non-subtask names when nothing matches", async () => {
    const { logger } = capturingLogger();
    const fetchImpl: FetchLike = () =>
      Promise.resolve(response(200, meta([
        { id: "1", name: "Bug", subtask: false },
        { id: "2", name: "Story", subtask: false },
        { id: "3", name: "Sub-task", subtask: true },
        { id: "4", name: "Task", subtask: false },
      ])));
    const result = await resolve(fetchImpl, logger);
    expect(result).toEqual({
      kind: "unavailable",
      availableNames: ["Bug", "Story", "Task"],
      subtaskNames: ["Sub-task"],
      teamManaged: false,
    });
  });

  it("carries every subtask name in listing order", async () => {
    const { logger } = capturingLogger();
    const fetchImpl: FetchLike = () =>
      Promise.resolve(response(200, meta([
        { id: "1", name: "Sub-task", subtask: true },
        { id: "2", name: "Bug", subtask: false },
        { id: "3", name: "Test Execution", subtask: true },
      ])));
    const result = await resolve(fetchImpl, logger);
    expect(result).toEqual({
      kind: "unavailable",
      availableNames: ["Bug"],
      subtaskNames: ["Sub-task", "Test Execution"],
      subtaskMatch: "Test Execution",
      teamManaged: false,
    });
  });

  it("returns unavailable with an empty list when the project exposes no issue types", async () => {
    const { logger } = capturingLogger();
    const fetchImpl: FetchLike = () => Promise.resolve(response(200, meta([])));
    const result = await resolve(fetchImpl, logger);
    expect(result).toEqual({ kind: "unavailable", availableNames: [], subtaskNames: [], teamManaged: false });
  });

  it("flags team-managed when any entry carries a PROJECT scope", async () => {
    const { logger } = capturingLogger();
    const fetchImpl: FetchLike = () =>
      Promise.resolve(response(200, meta([
        { id: "1", name: "Bug", subtask: false },
        { id: "2", name: "Story", subtask: false, scope: { type: "PROJECT", project: { id: "10000" } } },
      ])));
    const result = await resolve(fetchImpl, logger);
    expect(result).toEqual({
      kind: "unavailable",
      availableNames: ["Bug", "Story"],
      subtaskNames: [],
      teamManaged: true,
    });
  });

  it("flags team-managed even when only a subtask entry carries the PROJECT scope", async () => {
    const { logger } = capturingLogger();
    const fetchImpl: FetchLike = () =>
      Promise.resolve(response(200, meta([
        { id: "1", name: "Bug", subtask: false },
        { id: "2", name: "Sub-task", subtask: true, scope: { type: "PROJECT", project: { id: "10000" } } },
      ])));
    const result = await resolve(fetchImpl, logger);
    expect(result).toEqual({
      kind: "unavailable",
      availableNames: ["Bug"],
      subtaskNames: ["Sub-task"],
      teamManaged: true,
    });
  });

  it("does not flag team-managed for a TEMPLATE scope or a missing scope", async () => {
    const { logger } = capturingLogger();
    const fetchImpl: FetchLike = () =>
      Promise.resolve(response(200, meta([
        { id: "1", name: "Bug", subtask: false, scope: { type: "TEMPLATE" } },
        { id: "2", name: "Story", subtask: false },
      ])));
    const result = await resolve(fetchImpl, logger);
    expect(result).toEqual({
      kind: "unavailable",
      availableNames: ["Bug", "Story"],
      subtaskNames: [],
      teamManaged: false,
    });
  });

  it("url-encodes a project key with reserved characters", async () => {
    const { logger } = capturingLogger();
    let requestedUrl = "";
    const fetchImpl: FetchLike = (url) => {
      requestedUrl = url;
      return Promise.resolve(response(200, meta([])));
    };
    await resolve(fetchImpl, logger, "a/b c");
    expect(requestedUrl).toBe(`https://${SITE}/rest/api/3/issue/createmeta/a%2Fb%20c/issuetypes?maxResults=200`);
  });

  it("returns unknown on a 403 and logs the status/shape without the token", async () => {
    const { logger, lines } = capturingLogger();
    const fetchImpl: FetchLike = () => Promise.resolve(response(403, { errorMessages: ["forbidden"], token: TOKEN }));
    const result = await resolve(fetchImpl, logger);
    expect(result).toEqual({ kind: "unknown" });
    const log = lines.join("\n");
    expect(log).toContain("HTTP 403");
    expect(log).not.toContain(TOKEN);
    expect(log).not.toContain("forbidden");
  });

  it("returns unknown on a 404", async () => {
    const { logger } = capturingLogger();
    const fetchImpl: FetchLike = () => Promise.resolve(response(404, { errorMessages: ["no project"] }));
    expect(await resolve(fetchImpl, logger)).toEqual({ kind: "unknown" });
  });

  it("returns unknown on an unparseable 2xx body", async () => {
    const { logger } = capturingLogger();
    const fetchImpl: FetchLike = () => Promise.resolve(response(200, "<html>not json</html>"));
    expect(await resolve(fetchImpl, logger)).toEqual({ kind: "unknown" });
  });

  it("retries a 429 rate-limit and resolves on the next attempt", async () => {
    const { logger } = capturingLogger();
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      if (calls === 1) {
        return Promise.resolve(response(429, { errorMessages: ["rate limited"] }));
      }
      return Promise.resolve(response(200, meta([{ id: "1", name: "Test Execution", subtask: false }])));
    };
    const result = await resolve(fetchImpl, logger);
    expect(calls).toBe(2);
    expect(result).toEqual({ kind: "resolved", name: "Test Execution" });
  });

  it("returns unknown after a repeated network fault exhausts the retries", async () => {
    const { logger } = capturingLogger();
    let calls = 0;
    const sleeps: number[] = [];
    const fetchImpl: FetchLike = () => {
      calls += 1;
      return Promise.reject(new Error("ECONNRESET"));
    };
    const result = await resolveExecutionIssueType({
      site: SITE,
      credentials: { email: EMAIL, token: TOKEN },
      projectKey: "SCRATCH",
      executionIssueType: "Test Execution",
      logger,
      fetchImpl,
      sleep: (ms: number) => { sleeps.push(ms); return Promise.resolve(); },
      random: () => 0,
    });
    expect(result).toEqual({ kind: "unknown" });
    expect(calls).toBe(4);
    expect(sleeps).toHaveLength(3);
  });

  it("resolves to unknown when an external signal aborts a fetch in flight, exhausting retries", async () => {
    const { logger } = capturingLogger();
    const external = new AbortController();
    let calls = 0;
    const sleeps: number[] = [];
    // An abort is not short-circuited: it surfaces as an AbortError, is wrapped as retryable, and
    // exhausts every attempt via the injected sleep. The first attempt aborts mid-flight; later
    // attempts see the already-aborted signal and reject at once, so the loop drains without hanging.
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => {
        calls += 1;
        const fail = (): void => reject(abortError());
        if (external.signal.aborted) {
          fail();
          return;
        }
        init.signal?.addEventListener("abort", fail);
        external.abort();
      });

    const result = await resolveExecutionIssueType({
      site: SITE,
      credentials: { email: EMAIL, token: TOKEN },
      projectKey: "SCRATCH",
      executionIssueType: "Test Execution",
      logger,
      fetchImpl,
      sleep: (ms: number) => { sleeps.push(ms); return Promise.resolve(); },
      random: () => 0,
      signal: external.signal,
    });

    expect(result).toEqual({ kind: "unknown" });
    expect(calls).toBe(4);
    expect(sleeps).toHaveLength(3);
  });

  it("defensively skips null, non-object, subtask, and empty-name entries and still resolves", async () => {
    const { logger } = capturingLogger();
    const fetchImpl: FetchLike = () =>
      Promise.resolve(response(200, {
        issueTypes: [
          null,
          5,
          { subtask: true, name: "Subtask Thing" },
          { name: "" },
          { name: "Test Execution", id: "10009" },
        ],
      }));
    const result = await resolve(fetchImpl, logger);
    expect(result).toEqual({ kind: "resolved", name: "Test Execution" });
  });

  it("resolves to unknown when a hung request trips the 30s request timeout", async () => {
    vi.useFakeTimers();
    try {
      const { logger } = capturingLogger();
      let calls = 0;
      // The request never settles on its own; only the internal 30s timeout AbortSignal ends it.
      const fetchImpl: FetchLike = (_url, init) =>
        new Promise((_resolve, reject) => {
          calls += 1;
          init.signal?.addEventListener("abort", () => reject(abortError()));
        });

      const pending = resolveExecutionIssueType({
        site: SITE,
        credentials: { email: EMAIL, token: TOKEN },
        projectKey: "SCRATCH",
        executionIssueType: "Test Execution",
        logger,
        fetchImpl,
        sleep: () => Promise.resolve(),
        random: () => 0,
      });

      await vi.runAllTimersAsync();
      const result = await pending;

      expect(result).toEqual({ kind: "unknown" });
      expect(calls).toBe(4);
    } finally {
      vi.useRealTimers();
    }
  });
});
