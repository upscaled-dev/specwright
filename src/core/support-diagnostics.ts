import * as vscode from "vscode";
import { isRemoteOperationName } from "./remote-operation-name";
import { truncate } from "../utils/text";

export type SupportLevel = "debug" | "info" | "warn" | "error" | "unknown";

export interface SupportRecord { readonly level: SupportLevel; readonly message: string; readonly data?: unknown; }
export interface SupportSnapshotInput { readonly extensionVersion: string; readonly configuration: unknown; }

const MAX_RECORDS = 100;
const MAX_RECORD_BYTES = 48 * 1024;
const MAX_SNAPSHOT_BYTES = 64 * 1024;
const MAX_DEPTH = 6;
const MAX_ENTRIES = 40;
const MAX_STRING = 512;
const SENSITIVE_KEY = /token|secret|password|credential|auth|cookie|api[-_ ]?key|client[-_ ]?secret|request|response|body|payload|header|env/i;
const UNSAFE_DETAIL = /\b(?:request|response|body|payload|headers?|cookies?|environment)\b/i;
const AUTH = /\b(?:Bearer|Basic)\s+[A-Za-z0-9+/_=.-]+/gi;
const JWT = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g;
const URL = /\b(?:https?|wss?):\/\/[^\s"']+/gi;
const EMAIL = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
const PATH = /(?:file:\/\/[^\r\n]+|\\\\[^\r\n]+|[A-Za-z]:\\[^\r\n]+|\/[^\r\n]+)/g;
const DETAIL_KEY = /^(?:message|detail)$/i;
const ERROR_KEY = /^error$/i;
const OPERATIONAL_DETAIL = /^(?:started|completed|cancelled|failed|running|queued|retrying|resolved|discovered|refreshed)\b/i;
const OPERATIONAL_DATA_KEYS = new Set([
  "artifactId", "attempt", "backoffMs", "cancelled", "captureState", "durationMs", "engine",
  "initiatedBy", "mode", "operation", "operationClass", "operationId", "outcome", "outcomeCertainty",
  "schemaProfile", "state", "message", "detail",
]);
const NUMERIC_DATA_KEYS = new Set(["attempt", "backoffMs", "durationMs"]);
const STRING_DATA_KEYS = new Set([...OPERATIONAL_DATA_KEYS].filter((key) => !NUMERIC_DATA_KEYS.has(key) && key !== "cancelled"));

function text(value: string): string {
  return truncate(value.replace(AUTH, "[redacted-auth]").replace(JWT, "[redacted-jwt]").replace(URL, "[redacted-url]").replace(EMAIL, "[redacted-email]").replace(PATH, "[redacted-path]"), MAX_STRING);
}
function eventCategory(message: string): string {
  return message === "Legacy execution lifecycle" ? "execution-lifecycle" : "operational-event";
}
function levelCategory(value: string): SupportLevel {
  return value === "debug" || value === "info" || value === "warn" || value === "error" ? value : "unknown";
}
function isSensitiveKey(value: string): boolean { return SENSITIVE_KEY.test(value) || ERROR_KEY.test(value); }
function dataKey(value: string): string { return !OPERATIONAL_DATA_KEYS.has(value) || isSensitiveKey(value) ? "[redacted-key]" : value; }
function schemaKey(value: string): string { return value.length <= MAX_STRING && /^playwrightBddRunner\.[A-Za-z][A-Za-z0-9.]*$/u.test(value) ? value : "[redacted-key]"; }
interface Projection { remaining: number; readonly seen: WeakSet<object>; }

function detailCategory(value: unknown): string | undefined {
  if (typeof value !== "string" || UNSAFE_DETAIL.test(value)) { return undefined; }
  return OPERATIONAL_DETAIL.exec(value)?.[0].toLowerCase();
}

function safeString(field: string | undefined, value: string): string {
  const detail = field && DETAIL_KEY.test(field) ? detailCategory(value) : undefined;
  if (detail !== undefined) { return detail; }
  if (field === "mode" && /^(?:run|debug)$/u.test(value)) { return value; }
  if (field === "engine" && /^(?:legacy-direct|core-client)$/u.test(value)) { return value; }
  if (field === "schemaProfile" && /^(?:unknown|legacy-v1|client-v1)$/u.test(value)) { return value; }
  if (field === "initiatedBy" && /^(?:test-explorer|code-lens|editor|explorer|palette|traceability-tree|coverage-board|unknown)$/u.test(value)) { return value; }
  if (field === "state" && /^(?:complete|partial|cancelled|prepare-rejected|batch-rejected|sink-rejected|unexpected-rejection)$/u.test(value)) { return value; }
  if (field === "outcomeCertainty" && /^(?:confirmed|failed|unknown)$/u.test(value)) { return value; }
  if (field === "captureState" && /^(?:captured|missing)$/u.test(value)) { return value; }
  if (field === "operationClass" && /^(?:read|idempotent-write|non-idempotent-write)$/u.test(value)) { return value; }
  if (field === "outcome" && /^(?:refused|transport)$/u.test(value)) { return value; }
  if (field === "operation" && isRemoteOperationName(value)) { return value; }
  if (field === "operationId" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(value)) { return value; }
  if (field === "artifactId" && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu.test(value)) { return value; }
  return "[redacted]";
}

function schemaString(field: "type" | "scope", value: string): string {
  if (field === "type" && /^(?:string|number|boolean|array|object)$/u.test(value)) { return value; }
  if (field === "scope" && /^(?:window|resource|language-overridable)$/u.test(value)) { return value; }
  return "[redacted]";
}

function isPlainObject(value: object): boolean {
  try {
    const prototype = Object.getPrototypeOf(value);
    return Array.isArray(value) || prototype === Object.prototype || prototype === null;
  } catch { return false; }
}

function project(value: unknown, depth: number, state: Projection, field?: string): unknown {
  if (field && STRING_DATA_KEYS.has(field)) { return typeof value === "string" ? safeString(field, value) : "[redacted]"; }
  if (field && NUMERIC_DATA_KEYS.has(field)) { return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : "[redacted]"; }
  if (field === "cancelled") { return typeof value === "boolean" ? value : "[redacted]"; }
  if (typeof value === "string") { return safeString(field, value); }
  if (typeof value === "number" || typeof value === "boolean") { return "[redacted]"; }
  if (typeof value === "bigint") { return "[bigint]"; }
  if (typeof value === "symbol" || typeof value === "function") { return `[${typeof value}]`; }
  if (value === null || typeof value !== "object") { return value; }
  if (depth >= MAX_DEPTH) { return "[depth-truncated]"; }
  if (state.seen.has(value)) { return "[Circular]"; }
  state.seen.add(value);
  if (value instanceof Error) { return "[redacted-error]"; }
  if (value instanceof Uint8Array) { return `[binary:${value.byteLength}]`; }
  if (!isPlainObject(value)) { return "[non-plain-object]"; }
  const out: Record<string, unknown> = {};
  try {
    for (const raw in value) {
      if (state.remaining <= 0) { out["[truncated]"] = "[entry-budget]"; break; }
      state.remaining -= 1;
      if (!Object.prototype.hasOwnProperty.call(value, raw)) { continue; }
      const safe = dataKey(raw);
      if (safe === "[redacted-key]") { out[safe] = "[redacted]"; continue; }
      let nested: unknown;
      try { nested = (value as Record<string, unknown>)[raw]; } catch { out[safe] = "[unreadable]"; continue; }
      if ((isSensitiveKey(raw) || DETAIL_KEY.test(raw)) && !(DETAIL_KEY.test(raw) && detailCategory(nested) !== undefined)) {
        out[safe] = "[redacted]";
        continue;
      }
      try { out[safe] = project(nested, depth + 1, state, raw); } catch { out[safe] = "[unreadable]"; }
    }
  } catch { return "[unreadable]"; }
  return out;
}

interface SchemaShape {
  readonly entries: Array<Record<string, string>>;
  readonly knownSkippedNodes: number;
  readonly truncated: boolean;
}

function schemaShape(configuration: unknown): SchemaShape {
  const entries: Array<Record<string, string>> = [];
  let knownSkippedNodes = 0;
  let truncated = false;
  let groups: unknown[];
  try { groups = Array.isArray(configuration) ? configuration : [configuration]; } catch { return { entries, knownSkippedNodes: 1, truncated: true }; }
  let remaining = MAX_ENTRIES;
  try {
    for (const groupIndex in groups) {
      if (remaining <= 0) {
        truncated = true;
        try { if (Object.prototype.hasOwnProperty.call(groups, groupIndex)) { knownSkippedNodes += 1; } } catch { /* the candidate is not proven own */ }
        break;
      }
      remaining -= 1;
      if (!Object.prototype.hasOwnProperty.call(groups, groupIndex)) { continue; }
      let group: unknown;
      try { group = groups[groupIndex as unknown as number]; } catch { knownSkippedNodes += 1; truncated = true; continue; }
      if (group !== null && typeof group === "object" && !isPlainObject(group)) { knownSkippedNodes += 1; truncated = true; continue; }
      let properties: unknown;
      try { properties = group && typeof group === "object" ? (group as { properties?: unknown }).properties : undefined; } catch { knownSkippedNodes += 1; truncated = true; continue; }
      if (!properties || typeof properties !== "object") { continue; }
      if (!isPlainObject(properties)) { knownSkippedNodes += 1; truncated = true; continue; }
      try {
        for (const raw in properties) {
          if (remaining <= 0) {
            truncated = true;
            try { if (Object.prototype.hasOwnProperty.call(properties, raw)) { knownSkippedNodes += 1; } } catch { /* the candidate is not proven own */ }
            break;
          }
          remaining -= 1;
          if (!Object.prototype.hasOwnProperty.call(properties, raw)) { continue; }
          let value: { type?: unknown; scope?: unknown } = {};
          try { value = (properties as Record<string, { type?: unknown; scope?: unknown }>)[raw] ?? {}; } catch { knownSkippedNodes += 1; truncated = true; continue; }
          entries.push({ key: schemaKey(raw), ...(typeof value.type === "string" ? { type: schemaString("type", value.type) } : {}), ...(typeof value.scope === "string" ? { scope: schemaString("scope", value.scope) } : {}) });
        }
      } catch { knownSkippedNodes += 1; truncated = true; }
    }
  } catch { knownSkippedNodes += 1; truncated = true; }
  return { entries, knownSkippedNodes, truncated };
}

function renderWithByteCount<T extends { truncation: { snapshotBytes: number } }>(value: T): string {
  let json = JSON.stringify(value, null, 2);
  for (let pass = 0; pass < 16; pass++) {
    const snapshotBytes = Buffer.byteLength(json);
    if (value.truncation.snapshotBytes === snapshotBytes) { return json; }
    value.truncation.snapshotBytes = snapshotBytes;
    json = JSON.stringify(value, null, 2);
  }
  return json;
}

export class SupportDiagnostics implements vscode.Disposable {
  private records: SupportRecord[] = [];
  private bytes = 0;
  private dropped = 0;
  public record(level: string, message: string, data?: unknown): void {
    try {
      const unsafe = UNSAFE_DETAIL.test(message);
      const item: SupportRecord = { level: levelCategory(level), message: eventCategory(message), ...(data === undefined ? {} : { data: unsafe ? "[redacted-detail]" : project(data, 0, { remaining: MAX_ENTRIES, seen: new WeakSet() }) }) };
      const size = Buffer.byteLength(JSON.stringify(item));
      if (size > MAX_RECORD_BYTES) { this.dropped += 1; return; }
      while (this.records.length >= MAX_RECORDS || this.bytes + size > MAX_RECORD_BYTES) {
        const removed = this.records.shift();
        if (!removed) { break; }
        this.bytes -= Buffer.byteLength(JSON.stringify(removed)); this.dropped += 1;
      }
      this.records.push(item); this.bytes += size;
    } catch { this.dropped += 1; }
  }
  public snapshot(input: SupportSnapshotInput): string {
    let schema: ReturnType<typeof schemaShape>;
    try { schema = schemaShape(input.configuration); } catch { schema = { entries: [], knownSkippedNodes: 1, truncated: true }; }
    const base = { extensionVersion: text(input.extensionVersion), vscodeVersion: text(String(vscode.version ?? "unknown")), nodeVersion: text(process.version), platform: text(process.platform), arch: text(process.arch), workspaceFolderCount: vscode.workspace.workspaceFolders?.length ?? 0, configurationSchema: schema.entries, logs: this.records, truncation: { droppedRecords: this.dropped, schemaTruncated: schema.truncated, knownSkippedSchemaNodes: schema.knownSkippedNodes, retainedRecordBytes: this.bytes, snapshotBytes: 0 } };
    let json = renderWithByteCount(base);
    while (Buffer.byteLength(json) > MAX_SNAPSHOT_BYTES && base.logs.length > 0) { base.logs = base.logs.slice(1); base.truncation.droppedRecords += 1; json = JSON.stringify(base, null, 2); }
    while (Buffer.byteLength(json) > MAX_SNAPSHOT_BYTES && base.configurationSchema.length > 0) { base.configurationSchema = base.configurationSchema.slice(0, -1); base.truncation.schemaTruncated = true; base.truncation.knownSkippedSchemaNodes += 1; json = JSON.stringify(base, null, 2); }
    json = renderWithByteCount(base);
    if (Buffer.byteLength(json) <= MAX_SNAPSHOT_BYTES) { return json; }
    return renderWithByteCount({ truncation: { droppedRecords: base.truncation.droppedRecords + base.logs.length, schemaTruncated: base.truncation.schemaTruncated || base.configurationSchema.length > 0, knownSkippedSchemaNodes: base.truncation.knownSkippedSchemaNodes + base.configurationSchema.length, snapshotBytes: 0 } });
  }
  public retainedRecords(): readonly SupportRecord[] { return this.records; }
  public dispose(): void { this.records = []; this.bytes = 0; this.dropped = 0; }
}
