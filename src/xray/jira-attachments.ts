import { Logger } from "../utils/logger";
import { errMsg, maskValues, scrubJwtLike, serverText } from "../utils/text";
import { XrayJiraCredentials } from "./xray-credential-store";
import { contentTypeForFile, EVIDENCE_MAX_FILE_BYTES } from "../traceability/evidence-resolution";
import { describeShape } from "./xray-diagnostics";
import { FetchLike, JiraAccessError, jiraSecrets } from "./jira-project-search";
import { abortableSleep, RetryableError, XrayAbortError } from "./xray-client";
import { RemoteOutcomeUnknownError } from "../core/workspace-trust";
import { AttachmentSpool } from "../traceability/attachment-spool";
import type { PendingAttachment } from "../traceability/publish-ledger";
import { operationIdentity, RetryableRemoteError, retryAfterMilliseconds, runRemoteOperation } from "./remote-operation";

const REQUEST_TIMEOUT_MS = 60_000;

function basicAuthHeader(credentials: XrayJiraCredentials): string {
  const encoded = Buffer.from(`${credentials.email}:${credentials.token}`).toString("base64");
  return `Basic ${encoded}`;
}

function parseBody(bodyText: string): unknown {
  try {
    return JSON.parse(bodyText) as unknown;
  } catch {
    return bodyText;
  }
}

function stringifyShape(value: unknown): string {
  return JSON.stringify(describeShape(value), null, 2);
}

// ---- Attachment upload limits (`GET /rest/api/3/attachment/meta`) ----

// `enabled` gates the run-level section; `uploadLimit` (bytes) pre-checks file sizes in the dialog.
// The field names are flagged *(live, unverified)*; parse tolerantly and fall back to the evidence
// constant so an absent/renamed field never breaks the dialog.
export interface JiraAttachmentMeta {
  readonly enabled: boolean;
  readonly uploadLimit?: number | undefined;
}

export interface JiraAttachmentMetaDeps {
  site: string;
  credentials: XrayJiraCredentials;
  logger: Logger;
  fetchImpl?: FetchLike | undefined;
  signal?: AbortSignal | undefined;
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  random?: (() => number) | undefined;
}

function parseMeta(body: unknown): JiraAttachmentMeta {
  const record = body !== null && typeof body === "object" ? (body as Record<string, unknown>) : {};
  const enabled = record["enabled"];
  const uploadLimit = record["uploadLimit"];
  return {
    // Absent/renamed → assume enabled; only an explicit `false` disables the section.
    enabled: enabled !== false,
    ...(typeof uploadLimit === "number" && uploadLimit > 0 ? { uploadLimit } : {}),
  };
}

/**
 * Reads the site's attachment settings. On any failure the dialog degrades to the evidence constants,
 * so this never throws; a failed probe returns `{ enabled: true }` (no `uploadLimit`, fall back to
 * {@link EVIDENCE_MAX_FILE_BYTES}). A refused response is logged with its body verbatim, masked by
 * {@link jiraSecrets}, JWT-scrubbed and clipped at 300; a successful one is logged as shape/status only.
 */
export async function fetchJiraAttachmentMeta(deps: JiraAttachmentMetaDeps): Promise<JiraAttachmentMeta> {
  if (deps.signal?.aborted) {throw deps.signal.reason ?? new XrayAbortError();}
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const url = `https://${deps.site}/rest/api/3/attachment/meta`;
  try {
    const response = await runRemoteOperation(async () => {
      if (deps.signal?.aborted) {throw deps.signal.reason ?? new XrayAbortError();}
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      const onAbort = (): void => controller.abort();
      deps.signal?.addEventListener("abort", onAbort, { once: true });
      try {
        const fetched = await fetchImpl(url, {
          method: "GET",
          headers: { Accept: "application/json", Authorization: basicAuthHeader(deps.credentials) },
          signal: controller.signal,
        });
        const bodyText = await fetched.text();
        if (fetched.status === 429 || fetched.status >= 500) {
          throw new RetryableRemoteError(
            `HTTP ${fetched.status}`,
            retryAfterMilliseconds(fetched.headers?.get("retry-after") ?? null)
          );
        }
        return { fetched, bodyText };
      } catch (error) {
        if (deps.signal?.aborted) {throw deps.signal.reason ?? new XrayAbortError();}
        throw error instanceof RetryableRemoteError ? error : new RetryableRemoteError(scrubJwtLike(errMsg(error)));
      } finally {
        clearTimeout(timer);
        deps.signal?.removeEventListener("abort", onAbort);
      }
    }, {
      identity: operationIdentity("jira.attachment-meta.read"),
      logger: deps.logger,
      signal: deps.signal,
      sleep: deps.sleep ?? abortableSleep,
      random: deps.random ?? Math.random,
      abortError: () => deps.signal?.reason ?? new XrayAbortError(),
    });
    const { fetched, bodyText } = response;
    if (!fetched.ok) {
      deps.logger.warn(
        `GET /rest/api/3/attachment/meta → ${fetched.status}; using evidence-limit fallback; response body:\n${serverText(maskValues(bodyText, jiraSecrets(deps.credentials)))}`
      );
      return { enabled: true };
    }
    const body = parseBody(bodyText);
    deps.logger.info(`GET /rest/api/3/attachment/meta → ${fetched.status}; shape:\n${stringifyShape(body)}`);
    return parseMeta(body);
  } catch (error) {
    if (deps.signal?.aborted) {throw deps.signal.reason ?? new XrayAbortError();}
    deps.logger.warn(`Attachment meta probe failed: ${scrubJwtLike(maskValues(errMsg(error), jiraSecrets(deps.credentials)))}; using evidence-limit fallback`);
    return { enabled: true };
  }
}

// ---- Attachment upload (`POST /rest/api/3/issue/{key}/attachments`) ----

export interface JiraAttachmentUploadDeps {
  site: string;
  credentials: XrayJiraCredentials;
  // The execution issue key the attachments land on (the only key reliably held post-import).
  issueKey: string;
  // Sealed snapshots to upload. Mutable workspace paths never cross this boundary.
  files: readonly PendingAttachment[];
  logger: Logger;
  fetchImpl?: FetchLike | undefined;
  sleep?: ((ms: number, signal?: AbortSignal) => Promise<void>) | undefined;
  random?: (() => number) | undefined;
  signal?: AbortSignal | undefined;
  spool?: AttachmentSpool | undefined;
  operationId?: string | undefined;
}

// Per-file routing so a proven failure is recoverable; the failed snapshots become the ledger's
// `pendingAttachments`, replayed by the shared retry/resume routine. One file's failure never rolls
// back or re-imports; it also never taints the files that did upload.
//
// The three lists partition `files`. `cancelled` is what the caller's signal stopped: the file the abort
// landed on and every one after it. They are pending like a failure, but they are not a fault, so the
// caller can say cancelled instead of reporting an error nobody hit.
export interface JiraAttachmentUploadResult {
  readonly uploaded: readonly PendingAttachment[];
  readonly failed: readonly PendingAttachment[];
  readonly cancelled: readonly PendingAttachment[];
}

class JiraAttachmentUpload {
  private readonly fetchImpl: FetchLike;
  private readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  private readonly random: () => number;
  private readonly authHeader: string;
  private readonly url: string;

  constructor(private readonly deps: JiraAttachmentUploadDeps) {
    this.fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
    this.sleep = deps.sleep ?? abortableSleep;
    this.random = deps.random ?? Math.random;
    this.authHeader = basicAuthHeader(deps.credentials);
    this.url = `https://${deps.site}/rest/api/3/issue/${encodeURIComponent(deps.issueKey)}/attachments`;
  }

  public async run(): Promise<JiraAttachmentUploadResult> {
    const uploaded: PendingAttachment[] = [];
    const failed: PendingAttachment[] = [];
    const files = this.deps.files;
    for (const [index, file] of files.entries()) {
      // The file the abort landed on, and every file after it, is cancelled rather than failed.
      if (this.aborted()) {
        return { uploaded, failed, cancelled: files.slice(index) };
      }
      const ok = await this.uploadOne(file);
      if (!ok && this.aborted()) {
        return { uploaded, failed, cancelled: files.slice(index) };
      }
      (ok ? uploaded : failed).push(file);
    }
    return { uploaded, failed, cancelled: [] };
  }

  private aborted(): boolean {
    return this.deps.signal?.aborted ?? false;
  }

  private async uploadOne(file: PendingAttachment): Promise<boolean> {
    let content: Buffer;
    try {
      content = this.deps.spool?.read(file) ?? (() => {throw new Error("Attachment spool unavailable");})();
    } catch {
      this.deps.logger.warn("Attachment skipped: evidence snapshot unreadable");
      return false;
    }
    try {
      const status = await runRemoteOperation(() => this.postFile(file, content), {
        identity: operationIdentity("jira.attachment.upload", this.deps.operationId),
        logger: this.deps.logger,
        sleep: this.sleep,
        random: this.random,
        signal: this.deps.signal,
        abortError: () => new XrayAbortError(),
      });
      this.deps.logger.info(`POST /rest/api/3/issue/${this.deps.issueKey}/attachments → ${status}`);
      this.deps.spool?.discard([file]);
      return true;
    } catch (error) {
      if (error instanceof RemoteOutcomeUnknownError) {throw error;}
      this.deps.logger.warn("Attachment upload failed and remains pending", {
        outcome: error instanceof JiraAccessError ? "refused" : "transport",
      });
      return false;
    }
  }

  private async postFile(file: PendingAttachment, content: Buffer): Promise<number> {
    // A listener on an already-aborted signal never fires, so the state is read before it is subscribed
    // to; without this the fetch would go out after cancellation.
    if (this.aborted()) {
      throw new XrayAbortError();
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onAbort = (): void => controller.abort();
    this.deps.signal?.addEventListener("abort", onAbort, { once: true });
    const form = new FormData();
    const name = file.name;
    form.append("file", new Blob([content], { type: contentTypeForFile(name) }), name);
    let started = false;
    try {
      started = true;
      const response = await this.fetchImpl(this.url, {
        method: "POST",
        headers: { Authorization: this.authHeader, "X-Atlassian-Token": "no-check", Accept: "application/json" },
        body: form,
        signal: controller.signal,
      });
      await response.text();
      if (response.status === 429 || response.status >= 500) {
        throw new RetryableError(`HTTP ${response.status}`);
      }
      if (!response.ok) {
        throw new JiraAccessError(`Attachment upload failed (HTTP ${response.status}).`);
      }
      return response.status;
    } catch (error) {
      // An abort that lands mid-request reports as a cancel even when the fetch failed for a reason of
      // its own: the two are indistinguishable from here.
      if (started && this.aborted()) {
        throw new RetryableError("Request aborted after dispatch");
      }
      if (error instanceof RetryableError || error instanceof JiraAccessError) {
        throw error;
      }
      throw new RetryableError(scrubJwtLike(errMsg(error)));
    } finally {
      clearTimeout(timer);
      this.deps.signal?.removeEventListener("abort", onAbort);
    }
  }

}

/**
 * Uploads each file to the execution issue via `POST /rest/api/3/issue/{key}/attachments`
 * (`X-Atlassian-Token: no-check`, Jira basic auth, multipart `file`, original filenames). An ambiguous
 * transport result is never replayed. Returns `{ uploaded, failed, cancelled }` split per file; a single
 * failure is isolated so the caller can ledger the pending files and retry without re-importing. The
 * caller's `signal` is honoured before every request and during every backoff delay, so an abort starts
 * no further POST. The token and file bytes never reach the logger.
 */
export function uploadJiraAttachments(deps: JiraAttachmentUploadDeps): Promise<JiraAttachmentUploadResult> {
  return new JiraAttachmentUpload(deps).run();
}

// The upload-limit the dialog pre-checks against: the site's `uploadLimit` when known, else the
// conservative evidence file cap.
export function attachmentUploadLimit(meta: JiraAttachmentMeta): number {
  return meta.uploadLimit ?? EVIDENCE_MAX_FILE_BYTES;
}
