import * as fs from "node:fs";
import { Logger } from "../utils/logger";
import { errMsg, maskValues, scrubJwtLike, serverText } from "../utils/text";
import { XrayJiraCredentials } from "./xray-credential-store";
import { contentTypeForFile, EVIDENCE_MAX_FILE_BYTES } from "../traceability/evidence-resolution";
import { describeShape } from "./xray-diagnostics";
import { FetchLike, JiraAccessError, jiraSecrets } from "./jira-project-search";

const REQUEST_TIMEOUT_MS = 60_000;
const MAX_ATTEMPTS = 4;
const BACKOFF_BASE_MS = 300;
const BACKOFF_CAP_MS = 8_000;

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

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function baseName(filePath: string): string {
  const parts = filePath.split(/[\\/]/);
  return parts[parts.length - 1] ?? filePath;
}

class RetryableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RetryableError";
  }
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
  const fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
  const url = `https://${deps.site}/rest/api/3/attachment/meta`;
  try {
    const response = await fetchImpl(url, {
      method: "GET",
      headers: { Accept: "application/json", Authorization: basicAuthHeader(deps.credentials) },
      ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
    });
    const bodyText = await response.text();
    if (!response.ok) {
      deps.logger.warn(
        `GET /rest/api/3/attachment/meta → ${response.status}; using evidence-limit fallback; response body:\n${serverText(maskValues(bodyText, jiraSecrets(deps.credentials)))}`
      );
      return { enabled: true };
    }
    const body = parseBody(bodyText);
    deps.logger.info(`GET /rest/api/3/attachment/meta → ${response.status}; shape:\n${stringifyShape(body)}`);
    return parseMeta(body);
  } catch (error) {
    deps.logger.warn(`Attachment meta probe failed: ${scrubJwtLike(errMsg(error))}; using evidence-limit fallback`);
    return { enabled: true };
  }
}

// ---- Attachment upload (`POST /rest/api/3/issue/{key}/attachments`) ----

export interface JiraAttachmentUploadDeps {
  site: string;
  credentials: XrayJiraCredentials;
  // The execution issue key the attachments land on (the only key reliably held post-import).
  issueKey: string;
  // Absolute file paths to upload: run-level picks plus any `issue`-routed per-result evidence.
  files: readonly string[];
  logger: Logger;
  fetchImpl?: FetchLike | undefined;
  readFile?: ((path: string) => Buffer) | undefined;
  sleep?: ((ms: number) => Promise<void>) | undefined;
  random?: (() => number) | undefined;
  signal?: AbortSignal | undefined;
}

// Per-file routing so a partial failure is recoverable; the failed paths become the ledger's
// `pendingAttachments`, replayed by the shared retry/resume routine. One file's failure never rolls
// back or re-imports; it also never taints the files that did upload.
export interface JiraAttachmentUploadResult {
  readonly uploaded: readonly string[];
  readonly failed: readonly string[];
}

class JiraAttachmentUpload {
  private readonly fetchImpl: FetchLike;
  private readonly readFile: (path: string) => Buffer;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly random: () => number;
  private readonly authHeader: string;
  private readonly url: string;

  constructor(private readonly deps: JiraAttachmentUploadDeps) {
    this.fetchImpl = deps.fetchImpl ?? ((url, init) => fetch(url, init));
    this.readFile = deps.readFile ?? ((path) => fs.readFileSync(path));
    this.sleep = deps.sleep ?? defaultSleep;
    this.random = deps.random ?? Math.random;
    this.authHeader = basicAuthHeader(deps.credentials);
    this.url = `https://${deps.site}/rest/api/3/issue/${encodeURIComponent(deps.issueKey)}/attachments`;
  }

  public async run(): Promise<JiraAttachmentUploadResult> {
    const uploaded: string[] = [];
    const failed: string[] = [];
    for (const file of this.deps.files) {
      const ok = await this.uploadOne(file);
      (ok ? uploaded : failed).push(file);
    }
    return { uploaded, failed };
  }

  private async uploadOne(file: string): Promise<boolean> {
    let content: Buffer;
    try {
      content = this.readFile(file);
    } catch (error) {
      this.deps.logger.warn(`Attachment skipped, unreadable: ${scrubJwtLike(errMsg(error))}`);
      return false;
    }
    try {
      const status = await this.withBackoff(() => this.postFile(file, content));
      this.deps.logger.info(`POST /rest/api/3/issue/${this.deps.issueKey}/attachments → ${status}`);
      return true;
    } catch {
      return false;
    }
  }

  private async postFile(file: string, content: Buffer): Promise<number> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    const onAbort = (): void => controller.abort();
    this.deps.signal?.addEventListener("abort", onAbort);
    const form = new FormData();
    form.append("file", new Blob([content], { type: contentTypeForFile(file) }), baseName(file));
    try {
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
      if (error instanceof RetryableError || error instanceof JiraAccessError) {
        throw error;
      }
      throw new RetryableError(scrubJwtLike(errMsg(error)));
    } finally {
      clearTimeout(timer);
      this.deps.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async withBackoff(run: () => Promise<number>): Promise<number> {
    let attempt = 0;
    for (;;) {
      try {
        return await run();
      } catch (error) {
        if (error instanceof JiraAccessError) {
          throw error;
        }
        attempt += 1;
        if (!(error instanceof RetryableError) || attempt >= MAX_ATTEMPTS) {
          throw error;
        }
        await this.sleep(this.backoffDelay(attempt));
      }
    }
  }

  private backoffDelay(attempt: number): number {
    const base = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
    return base + Math.floor(this.random() * BACKOFF_BASE_MS);
  }
}

/**
 * Uploads each file to the execution issue via `POST /rest/api/3/issue/{key}/attachments`
 * (`X-Atlassian-Token: no-check`, Jira basic auth, multipart `file`, original filenames), retrying
 * transient faults with backoff. Returns `{ uploaded, failed }` split per file; a single failure is
 * isolated so the caller can ledger the pending files and retry without re-importing. The token and
 * file bytes never reach the logger.
 */
export function uploadJiraAttachments(deps: JiraAttachmentUploadDeps): Promise<JiraAttachmentUploadResult> {
  return new JiraAttachmentUpload(deps).run();
}

// The upload-limit the dialog pre-checks against: the site's `uploadLimit` when known, else the
// conservative evidence file cap.
export function attachmentUploadLimit(meta: JiraAttachmentMeta): number {
  return meta.uploadLimit ?? EVIDENCE_MAX_FILE_BYTES;
}
