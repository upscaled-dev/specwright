import { describe, it, expect, vi } from "vitest";
import * as vscode from "vscode";
import { Logger, LogLevel } from "../../utils/logger";
import { FetchLike } from "../../xray/jira-project-search";
import {
  attachmentUploadLimit,
  fetchJiraAttachmentMeta,
  uploadJiraAttachments,
} from "../../xray/jira-attachments";
import { EVIDENCE_MAX_FILE_BYTES } from "../../traceability/evidence-resolution";
import { RemoteOutcomeUnknownError, WorkspaceTrust } from "../../core/workspace-trust";
import { AttachmentSpool, type AttachmentSnapshot } from "../../traceability/attachment-spool";

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

type TestUploadDeps = Omit<Partial<Parameters<typeof uploadJiraAttachments>[0]>, "files" | "spool"> & {
  readonly files?: readonly string[];
  readonly readSnapshot?: ((path: string) => Buffer) | undefined;
};

interface TestUploadResult {
  readonly uploaded: readonly string[];
  readonly failed: readonly string[];
  readonly cancelled: readonly string[];
}

const upload = async ({ files, readSnapshot, ...over }: TestUploadDeps): Promise<TestUploadResult> => {
  const paths = files ?? ["/ws/report.zip"];
  const snapshots = paths.map((file, index): AttachmentSnapshot => ({
    ref: `${index.toString(16).padStart(8, "0")}-0000-4000-8000-000000000000`,
    name: file.split(/[\\/]/).at(-1) ?? file,
    size: 5,
    sha256: "a".repeat(64),
    createdAt: 1,
  }));
  const pathsByRef = new Map(snapshots.map((snapshot, index) => [snapshot.ref, paths[index]!]));
  const spool = {
    read: (snapshot: AttachmentSnapshot): Buffer =>
      readSnapshot?.(pathsByRef.get(snapshot.ref)!) ?? Buffer.from("bytes"),
    discard: () => 1,
  } as unknown as AttachmentSpool;
  const result = await uploadJiraAttachments({
    site: SITE,
    credentials: { email: EMAIL, token: TOKEN },
    issueKey: "XNP-9",
    files: snapshots,
    logger: capturingLogger().logger,
    spool,
    sleep: () => Promise.resolve(),
    random: () => 0,
    ...over,
  });
  const toPaths = (items: readonly AttachmentSnapshot[]): string[] => items.map((item) => pathsByRef.get(item.ref)!);
  return { uploaded: toPaths(result.uploaded), failed: toPaths(result.failed), cancelled: toPaths(result.cancelled) };
};

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

    expect(result).toEqual({ uploaded: ["/ws/report.zip"], failed: [], cancelled: [] });
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

  it("emits a terminal audit record for a confirmed 4xx", async () => {
    const { logger, lines } = capturingLogger();
    const result = await upload({
      fetchImpl: () => Promise.resolve(response(413, "too large")),
      logger,
      operationId: "publish-413",
    });

    expect(result.failed).toEqual(["/ws/report.zip"]);
    const emitted = lines.join("\n");
    expect(emitted).toContain("Remote operation failed");
    expect(emitted).toContain("publish-413");
    expect(emitted).toContain("jira.attachment.upload");
    expect(emitted).toContain("non-idempotent-write");
    expect(emitted).toContain('"attempt": 1');
    expect(emitted).toContain('"outcomeCertainty": "failed"');
    expect(emitted).toContain("Attachment upload failed and remains pending");
    expect(emitted).not.toContain("/ws/report.zip");
    expect(emitted).not.toContain(TOKEN);
  });

  it("does not replay a 429 because the upload may already have committed", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      return Promise.resolve(calls === 1 ? response(429, "rate limited") : response(200, [{ id: "1" }]));
    };
    await expect(upload({ fetchImpl })).rejects.toBeInstanceOf(RemoteOutcomeUnknownError);
    expect(calls).toBe(1);
  });

  it("does not replay a 503 because the upload may already have committed", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      return Promise.resolve(response(503, "unavailable"));
    };
    await expect(upload({ fetchImpl })).rejects.toBeInstanceOf(RemoteOutcomeUnknownError);
    expect(calls).toBe(1);
  });

  it("does not replay after an in-flight upload times out", async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const fetchImpl: FetchLike = (_url, init) => {
        calls += 1;
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        });
      };

      const pending = upload({ fetchImpl });
      const rejected = expect(pending).rejects.toBeInstanceOf(RemoteOutcomeUnknownError);
      await vi.advanceTimersByTimeAsync(61_000);
      await rejected;
      expect(calls).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports outcome unknown after one network fault without replay", async () => {
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      return Promise.reject(new Error("ECONNRESET"));
    };
    await expect(upload({ fetchImpl })).rejects.toBeInstanceOf(RemoteOutcomeUnknownError);
    expect(calls).toBe(1);
  });

  it("fails a file whose bytes cannot be read, without calling fetch", async () => {
    let called = false;
    const { logger, lines } = capturingLogger();
    const fetchImpl: FetchLike = () => {
      called = true;
      return Promise.resolve(response(200, []));
    };
    const result = await upload({
      fetchImpl,
      logger,
      readSnapshot: () => {
        throw new Error(`ENOENT ${TOKEN} /private/customer/report.zip`);
      },
    });
    expect(result.failed).toEqual(["/ws/report.zip"]);
    expect(called).toBe(false);
    const emitted = lines.join("\n");
    expect(emitted).toContain("Attachment skipped: evidence snapshot unreadable");
    expect(emitted).not.toContain(TOKEN);
    expect(emitted).not.toContain("/private/customer/report.zip");
  });

  it("never logs the token", async () => {
    const { logger, lines } = capturingLogger();
    const fetchImpl: FetchLike = () => Promise.resolve(response(200, []));
    await upload({ fetchImpl, logger });
    expect(lines.join("\n")).not.toContain(TOKEN);
  });
});

describe("uploadJiraAttachments: cancellation", () => {
  const FILES = ["/ws/a.zip", "/ws/b.zip"];

  it("reports an unknown remote outcome when trust is revoked after an upload starts", async () => {
    let requestStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {requestStarted = resolve;});
    const fetchImpl: FetchLike = (_url, init) => {
      requestStarted?.();
      return new Promise((_resolve, reject) => {
        init.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
      });
    };
    const trust = new WorkspaceTrust(() => true);
    const pending = trust.run((signal) => upload({ files: FILES, fetchImpl, signal }));

    await started;
    const disposal = trust.dispose();
    await expect(pending).rejects.toBeInstanceOf(RemoteOutcomeUnknownError);
    await disposal;
  });

  it("makes no request at all when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      return Promise.resolve(response(200, [{ id: "1" }]));
    };

    const result = await upload({ files: FILES, fetchImpl, signal: controller.signal });

    expect(calls).toBe(0);
    expect(result).toEqual({ uploaded: [], failed: [], cancelled: FILES });
  });

  it("marks the dispatched file outcome unknown on caller abort: no retry, no next upload", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      controller.abort();
      return Promise.reject(new Error("The operation was aborted"));
    };

    await expect(upload({
      files: FILES,
      fetchImpl,
      signal: controller.signal,
      operationId: "upload-aborted",
    })).rejects.toMatchObject({ operationId: "upload-aborted" });

    expect(calls).toBe(1);
  });

  it("stops mid-list: the uploaded file stands, the file the abort landed on and the rest are cancelled", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      if (calls === 2) {
        controller.abort();
        return Promise.reject(new Error("The operation was aborted"));
      }
      return Promise.resolve(response(200, [{ id: "1" }]));
    };

    await expect(upload({
      files: ["/ws/a.zip", "/ws/b.zip", "/ws/c.zip"],
      fetchImpl,
      signal: controller.signal,
      operationId: "upload-mid-list",
    })).rejects.toMatchObject({ operationId: "upload-mid-list" });

    expect(calls).toBe(2);
  });

  it("does not enter backoff for an ambiguous attachment response", async () => {
    const controller = new AbortController();
    let calls = 0;
    const fetchImpl: FetchLike = () => {
      calls += 1;
      return Promise.resolve(response(429, "rate limited"));
    };
    const sleepSignals: (AbortSignal | undefined)[] = [];
    const sleep = (_ms: number, signal?: AbortSignal): Promise<void> => {
      sleepSignals.push(signal);
      controller.abort();
      return Promise.resolve();
    };

    await expect(upload({ files: FILES, fetchImpl, sleep, signal: controller.signal }))
      .rejects.toBeInstanceOf(RemoteOutcomeUnknownError);
    expect(calls).toBe(1);
    expect(sleepSignals).toEqual([]);
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

  it("logs a refused probe's body with the credentials masked out", async () => {
    const { logger, lines } = capturingLogger();
    const basic = Buffer.from(`${EMAIL}:${TOKEN}`).toString("base64");
    const body = `Basic ${basic} for ${EMAIL} (token ${TOKEN}) cannot read attachment settings`;
    const fetchImpl: FetchLike = () => Promise.resolve(response(403, body));

    await fetchJiraAttachmentMeta({ ...deps(fetchImpl), logger });

    const emitted = lines.join("\n");
    expect(emitted).toContain("Basic [redacted] for [redacted] (token [redacted]) cannot read attachment settings");
    expect(emitted).not.toContain(TOKEN);
    expect(emitted).not.toContain(basic);
    expect(emitted).not.toContain(EMAIL);
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
