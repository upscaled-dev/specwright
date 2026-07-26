import { describe, it, expect } from "vitest";
import * as vscode from "vscode";
import { Logger, LogLevel } from "../../utils/logger";
import { FetchLike } from "../../xray/jira-project-search";
import {
  attachmentUploadLimit,
  fetchJiraAttachmentMeta,
  uploadJiraAttachments,
} from "../../xray/jira-attachments";
import { EVIDENCE_MAX_FILE_BYTES } from "../../traceability/evidence-resolution";

const EMAIL = "me@example.com";
const TOKEN = "jira-api-token-must-never-be-logged";
const SITE = "acme.atlassian.net";

function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const channel = {
    name: "test",
    append: () => undefined,
    appendLine: (line: string): void => {
      lines.push(line);
    },
    replace: () => undefined,
    clear: () => undefined,
    show: () => undefined,
    hide: () => undefined,
    dispose: () => undefined,
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

const upload = (over: Partial<Parameters<typeof uploadJiraAttachments>[0]>): ReturnType<typeof uploadJiraAttachments> =>
  uploadJiraAttachments({
    site: SITE,
    credentials: { email: EMAIL, token: TOKEN },
    issueKey: "XNP-9",
    files: ["/ws/report.zip"],
    logger: capturingLogger().logger,
    readFile: () => Buffer.from("bytes"),
    sleep: () => Promise.resolve(),
    random: () => 0,
    ...over,
  });

describe("uploadJiraAttachments", () => {
  it("POSTs each file to the issue attachments endpoint with the no-check token + basic auth", async () => {
    let url = "";
    let headers: Record<string, string> = {};
    const fetchImpl: FetchLike = (u, init) => {
      url = u;
      headers = init.headers as Record<string, string>;
      return Promise.resolve(response(200, [{ id: "1" }]));
    };

    const result = await upload({ fetchImpl });

    expect(result).toEqual({ uploaded: ["/ws/report.zip"], failed: [] });
    expect(url).toBe(`https://${SITE}/rest/api/3/issue/XNP-9/attachments`);
    expect(headers["X-Atlassian-Token"]).toBe("no-check");
    expect(headers["Authorization"]).toBe(`Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64")}`);
  });

  it("isolates a per-file failure: the 4xx file fails, the others upload", async () => {
    const fetchImpl: FetchLike = (_u, init) => {
      const body = init.body as FormData;
      const file = body.get("file") as { name?: string } | null;
      return Promise.resolve(file?.name === "bad.zip" ? response(413, "too large") : response(200, [{ id: "1" }]));
    };

    const result = await upload({ files: ["/ws/ok.zip", "/ws/bad.zip", "/ws/ok2.zip"], fetchImpl });

    expect(result.uploaded).toEqual(["/ws/ok.zip", "/ws/ok2.zip"]);
    expect(result.failed).toEqual(["/ws/bad.zip"]);
  });

  it("retries a 429 and then succeeds", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      return Promise.resolve(calls === 1 ? response(429, "rate limited") : response(200, [{ id: "1" }]));
    };
    const result = await upload({ fetchImpl });
    expect(calls).toBe(2);
    expect(result.uploaded).toEqual(["/ws/report.zip"]);
  });

  it("marks a file failed after exhausting retries on a repeated network fault", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      return Promise.reject(new Error("ECONNRESET"));
    };
    const result = await upload({ fetchImpl });
    expect(result.failed).toEqual(["/ws/report.zip"]);
    // MAX_ATTEMPTS = 4 fetches for the one file.
    expect(calls).toBe(4);
  });

  it("fails a file whose bytes cannot be read, without calling fetch", async () => {
    let called = false;
    const fetchImpl: FetchLike = () => {
      called = true;
      return Promise.resolve(response(200, []));
    };
    const result = await upload({
      fetchImpl,
      readFile: () => {
        throw new Error("ENOENT");
      },
    });
    expect(result.failed).toEqual(["/ws/report.zip"]);
    expect(called).toBe(false);
  });

  it("never logs the token", async () => {
    const { logger, lines } = capturingLogger();
    const fetchImpl: FetchLike = () => Promise.resolve(response(200, []));
    await upload({ fetchImpl, logger });
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});

describe("fetchJiraAttachmentMeta", () => {
  const deps = (fetchImpl: FetchLike): Parameters<typeof fetchJiraAttachmentMeta>[0] => ({
    site: SITE,
    credentials: { email: EMAIL, token: TOKEN },
    logger: capturingLogger().logger,
    fetchImpl,
  });

  it("parses enabled + uploadLimit", async () => {
    const meta = await fetchJiraAttachmentMeta(deps(() => Promise.resolve(response(200, { enabled: true, uploadLimit: 10485760 }))));
    expect(meta).toEqual({ enabled: true, uploadLimit: 10485760 });
  });

  it("treats an absent enabled field as enabled and omits an absent uploadLimit", async () => {
    const meta = await fetchJiraAttachmentMeta(deps(() => Promise.resolve(response(200, {}))));
    expect(meta).toEqual({ enabled: true });
  });

  it("honors an explicit enabled:false", async () => {
    const meta = await fetchJiraAttachmentMeta(deps(() => Promise.resolve(response(200, { enabled: false }))));
    expect(meta.enabled).toBe(false);
  });

  it("degrades to enabled with no limit when the probe fails (never throws)", async () => {
    const meta = await fetchJiraAttachmentMeta(deps(() => Promise.resolve(response(403, "forbidden"))));
    expect(meta).toEqual({ enabled: true });
  });

  it("degrades on a thrown transport error too", async () => {
    const meta = await fetchJiraAttachmentMeta(deps(() => Promise.reject(new Error("offline"))));
    expect(meta).toEqual({ enabled: true });
  });
});

describe("attachmentUploadLimit", () => {
  it("uses the site limit when known", () => {
    expect(attachmentUploadLimit({ enabled: true, uploadLimit: 123 })).toBe(123);
  });

  it("falls back to the evidence file cap when the limit is unknown", () => {
    expect(attachmentUploadLimit({ enabled: true })).toBe(EVIDENCE_MAX_FILE_BYTES);
  });
});
