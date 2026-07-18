import { describe, it, expect, vi, afterEach } from "vitest";
import * as vscode from "vscode";
import { ExtensionConfig } from "../../core/extension-config";
import { Logger, LogLevel } from "../../utils/logger";
import { XrayCredentialStore } from "../../xray/xray-credential-store";
import {
  describeJwt,
  describeShape,
  graphqlErrorSummaries,
  parseKeyList,
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

describe("parseKeyList", () => {
  it("splits, trims, and accepts valid Jira keys", () => {
    const { keys, invalid } = parseKeyList(" CALC-1043 , calc-1051 ");
    expect(keys).toEqual(["CALC-1043", "calc-1051"]);
    expect(invalid).toEqual([]);
  });

  it("skips empty tokens from trailing/duplicate commas", () => {
    expect(parseKeyList("CALC-1, , ,CALC-2,").keys).toEqual(["CALC-1", "CALC-2"]);
  });

  it("collects malformed keys as invalid", () => {
    const { keys, invalid } = parseKeyList("CALC-1, BADKEY, 12-3");
    expect(keys).toEqual(["CALC-1"]);
    expect(invalid).toEqual(["BADKEY", "12-3"]);
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

function configWith(values: Record<string, unknown>): ExtensionConfig {
  const workspaceConfig = {
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      key in values ? (values[key] as T) : defaultValue,
    update: (): Promise<void> => Promise.resolve(),
    inspect: (key: string): { key: string } => ({ key }),
  } as unknown as vscode.WorkspaceConfiguration;
  return ExtensionConfig.create(workspaceConfig, false);
}

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

async function seededDeps(): Promise<{
  config: ExtensionConfig;
  credentialStore: XrayCredentialStore;
  logger: Logger;
  lines: string[];
}> {
  const { logger, lines } = capturingLogger();
  const config = configWith({ "xray.siteUrl": SITE });
  const credentialStore = mapCredentialStore();
  await credentialStore.setCredentials(SITE, "fake-client-id", FAKE_SECRET);
  return { config, credentialStore, logger, lines };
}

describe("runXrayConnectionTest — secret/JWT redaction invariant", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("never emits the raw JWT, its prefix, or the client secret on the happy path", async () => {
    const { config, credentialStore, logger, lines } = await seededDeps();

    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith("/authenticate")) {
        return Promise.resolve(makeResponse(200, JSON.stringify(FAKE_JWT)));
      }
      return Promise.resolve(
        makeResponse(
          200,
          JSON.stringify({ data: { getTests: { total: 1, results: [{ issueId: "10", jira: { key: "CALC-1" } }] } } }),
          { "X-RateLimit-Remaining": "99" }
        )
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("CALC-1");

    await runXrayConnectionTest({ config, credentialStore, logger });

    const emitted = lines.join("\n");
    expect(emitted).not.toContain(FAKE_JWT);
    expect(emitted).not.toContain(FAKE_JWT.slice(0, 20));
    expect(emitted).not.toContain(FAKE_SECRET);
    expect(emitted).not.toContain(FAKE_SECRET.slice(0, 12));
    expect(emitted).toContain("JWT received");
    expect(emitted).toContain("quote-wrapped (JSON string)");
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("keeps an echoed client secret out of the logs when authentication fails", async () => {
    const { config, credentialStore, logger, lines } = await seededDeps();

    const echoBody = JSON.stringify({
      error: "bad request",
      request: { client_id: "fake-client-id", client_secret: FAKE_SECRET },
    });
    vi.stubGlobal("fetch", vi.fn(() => Promise.resolve(makeResponse(400, echoBody))));
    const errorToast = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);

    await runXrayConnectionTest({ config, credentialStore, logger });

    const emitted = lines.join("\n");
    expect(emitted).not.toContain(FAKE_SECRET);
    expect(emitted).not.toContain(FAKE_SECRET.slice(0, 12));
    expect(emitted).toContain("response body shape");
    expect(emitted).toContain(`string(${FAKE_SECRET.length})`);
    expect(errorToast).toHaveBeenCalledWith(
      expect.stringContaining("authentication failed"),
      "Show Output"
    );
  });

  it("fails the probe and scrubs jwt-like strings when GraphQL returns 200 with errors", async () => {
    const { config, credentialStore, logger, lines } = await seededDeps();

    const fetchMock = vi.fn((url: string) => {
      if (url.endsWith("/authenticate")) {
        return Promise.resolve(makeResponse(200, JSON.stringify(FAKE_JWT)));
      }
      return Promise.resolve(
        makeResponse(
          200,
          JSON.stringify({
            errors: [{ message: `denied for token ${FAKE_JWT}`, extensions: { code: "FORBIDDEN" } }],
            data: null,
          })
        )
      );
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValue("CALC-1");
    const errorToast = vi.spyOn(vscode.window, "showErrorMessage").mockResolvedValue(undefined);

    await runXrayConnectionTest({ config, credentialStore, logger });

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
    const { config, credentialStore, logger, lines } = await seededDeps();

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

    const run = runXrayConnectionTest({ config, credentialStore, logger });
    await vi.advanceTimersByTimeAsync(31_000);
    await run;

    expect(lines.join("\n")).toContain("Authentication request error");
    expect(errorToast).toHaveBeenCalledWith(
      expect.stringContaining("authentication request failed"),
      "Show Output"
    );
  });
});
