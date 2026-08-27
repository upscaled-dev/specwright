export const TRACEABILITY_VIEW_PROTOCOL_VERSION = 2 as const;
export const TRACEABILITY_CHUNK_ROWS = 256;
export const TRACEABILITY_CHUNK_BYTES = 512 * 1024;
export const TRACEABILITY_DISPLAY_TEXT_LIMIT = 1_024;
export const TRACEABILITY_PREVIEW_MEMBER_LIMIT = 128;
export const TRACEABILITY_SELECTION_LIMIT = 128;

const SESSION_LIMIT = 128;
const ID_LIMIT = 512;
const ACTION_LIMIT = 64;

export function boundedTraceabilityText(value: string): string {
  return value.slice(0, TRACEABILITY_DISPLAY_TEXT_LIMIT);
}

export interface TraceabilityWireRow {
  readonly id: string;
  readonly parentId?: string;
  readonly label: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly icon: string;
  readonly tone?: "success" | "error" | "skipped" | "pending" | "unknown" | "warning" | "info" | "muted";
  readonly expandable: boolean;
  readonly actions: readonly { readonly id: string; readonly label: string; readonly icon: string }[];
  readonly defaultAction?: string;
  readonly view?: "workspace" | "repository" | "test-sets";
}

export interface TraceabilityRunPreview {
  readonly previewId: string;
  readonly title: string;
  readonly remoteMembers: number;
  readonly runnable: number;
  readonly remoteOnly: number;
  readonly members: readonly { readonly label: string; readonly mapped: boolean }[];
  readonly displayTruncated: boolean;
}

export type TraceabilityClientBody =
  | { readonly type: "ready" }
  | { readonly type: "action"; readonly generation: number; readonly id: string; readonly action: string; readonly selection: readonly string[] }
  | { readonly type: "confirm-preview"; readonly generation: number; readonly previewId: string }
  | { readonly type: "cancel-preview"; readonly generation: number; readonly previewId: string }
  | { readonly type: "focused"; readonly generation: number };

export type TraceabilityViewState = "ready" | "disconnected" | "empty" | "untrusted";

export type TraceabilityHostBody =
  | { readonly type: "begin"; readonly generation: number; readonly state: TraceabilityViewState; readonly total: number }
  | { readonly type: "chunk"; readonly generation: number; readonly offset: number; readonly rows: readonly TraceabilityWireRow[] }
  | { readonly type: "end"; readonly generation: number }
  | { readonly type: "focus-filter"; readonly generation: number }
  | { readonly type: "preview"; readonly generation: number; readonly preview: TraceabilityRunPreview };

export interface TraceabilityEnvelope<T> {
  readonly version: typeof TRACEABILITY_VIEW_PROTOCOL_VERSION;
  readonly session: string;
  readonly revision: number;
  readonly surface: "traceability";
  readonly body: T;
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown, limit = ID_LIMIT): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= limit;
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function envelope(value: unknown): value is TraceabilityEnvelope<Record<string, unknown>> {
  return object(value)
    && exact(value, ["version", "session", "revision", "surface", "body"])
    && value["version"] === TRACEABILITY_VIEW_PROTOCOL_VERSION
    && text(value["session"], SESSION_LIMIT)
    && Number.isSafeInteger(value["revision"])
    && (value["revision"] as number) >= 0
    && value["surface"] === "traceability"
    && object(value["body"]);
}

function withinMessageLimit(value: unknown): boolean {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).length <= TRACEABILITY_CHUNK_BYTES;
  } catch {
    return false;
  }
}

export function parseTraceabilityClientEnvelope(value: unknown): TraceabilityEnvelope<TraceabilityClientBody> | undefined {
  if (!envelope(value) || !withinMessageLimit(value)) {
    return undefined;
  }
  const body = value.body;
  if (body["type"] === "ready" && exact(body, ["type"])) {
    return value as unknown as TraceabilityEnvelope<TraceabilityClientBody>;
  }
  if (body["type"] === "focused" && exact(body, ["type", "generation"]) && number(body["generation"])) {
    return value as unknown as TraceabilityEnvelope<TraceabilityClientBody>;
  }
  if ((body["type"] === "confirm-preview" || body["type"] === "cancel-preview")
    && exact(body, ["type", "generation", "previewId"])
    && number(body["generation"])
    && text(body["previewId"])) {
    return value as unknown as TraceabilityEnvelope<TraceabilityClientBody>;
  }
  if (body["type"] !== "action"
    || !exact(body, ["type", "generation", "id", "action", "selection"])
    || !number(body["generation"])
    || !text(body["id"])
    || !text(body["action"], ACTION_LIMIT)
    || !Array.isArray(body["selection"])
    || body["selection"].length > TRACEABILITY_SELECTION_LIMIT
    || !body["selection"].every((id) => text(id))) {
    return undefined;
  }
  return value as unknown as TraceabilityEnvelope<TraceabilityClientBody>;
}

function number(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function action(value: unknown): boolean {
  return object(value) && exact(value, ["id", "label", "icon"])
    && text(value["id"], ACTION_LIMIT)
    && text(value["label"], 512)
    && icon(value["icon"]);
}

function icon(value: unknown): value is string {
  return text(value, 64) && /^[a-z0-9-]+$/u.test(value);
}

function row(value: unknown): boolean {
  if (!object(value)) {
    return false;
  }
  const keys = Object.keys(value);
  const allowed = ["id", "parentId", "label", "description", "tooltip", "icon", "tone", "expandable", "actions", "defaultAction", "view"];
  if (!keys.every((key) => allowed.includes(key)) || !["id", "label", "icon", "expandable", "actions"].every((key) => Object.hasOwn(value, key))) {
    return false;
  }
  const actions = value["actions"];
  const defaultAction = value["defaultAction"];
  return text(value["id"])
    && text(value["label"], TRACEABILITY_DISPLAY_TEXT_LIMIT)
    && icon(value["icon"])
    && typeof value["expandable"] === "boolean"
    && Array.isArray(actions)
    && actions.length <= 8
    && actions.every(action)
    && (value["parentId"] === undefined || text(value["parentId"]))
    && (value["description"] === undefined || text(value["description"], TRACEABILITY_DISPLAY_TEXT_LIMIT))
    && (value["tooltip"] === undefined || text(value["tooltip"], TRACEABILITY_DISPLAY_TEXT_LIMIT))
    && (value["tone"] === undefined || ["success", "error", "skipped", "pending", "unknown", "warning", "info", "muted"].includes(value["tone"] as string))
    && (value["view"] === undefined || ["workspace", "repository", "test-sets"].includes(value["view"] as string))
    && (defaultAction === undefined
      || text(defaultAction, ACTION_LIMIT)
        && actions.some((candidate) => object(candidate) && candidate["id"] === defaultAction));
}

function previewMember(value: unknown): boolean {
  return object(value) && exact(value, ["label", "mapped"])
    && text(value["label"], TRACEABILITY_DISPLAY_TEXT_LIMIT)
    && typeof value["mapped"] === "boolean";
}

function preview(value: unknown): boolean {
  if (!object(value) || !exact(value, ["previewId", "title", "remoteMembers", "runnable", "remoteOnly", "members", "displayTruncated"])) {return false;}
  return text(value["previewId"])
    && text(value["title"], TRACEABILITY_DISPLAY_TEXT_LIMIT)
    && number(value["remoteMembers"])
    && number(value["runnable"])
    && number(value["remoteOnly"])
    && Array.isArray(value["members"])
    && value["members"].length <= TRACEABILITY_PREVIEW_MEMBER_LIMIT
    && value["members"].every(previewMember)
    && typeof value["displayTruncated"] === "boolean";
}

export function parseTraceabilityHostEnvelope(value: unknown, session: string, revision: number): TraceabilityEnvelope<TraceabilityHostBody> | undefined {
  if (!envelope(value) || !withinMessageLimit(value) || value.session !== session || value.revision !== revision + 1) {
    return undefined;
  }
  const body = value.body;
  const valid = body["type"] === "begin"
    ? exact(body, ["type", "generation", "state", "total"])
      && number(body["generation"])
      && number(body["total"])
      && ["ready", "disconnected", "empty", "untrusted"].includes(body["state"] as string)
    : body["type"] === "chunk"
      ? exact(body, ["type", "generation", "offset", "rows"])
        && number(body["generation"])
        && number(body["offset"])
        && Array.isArray(body["rows"])
        && body["rows"].length <= TRACEABILITY_CHUNK_ROWS
        && body["rows"].every(row)
      : (body["type"] === "end" || body["type"] === "focus-filter")
        ? exact(body, ["type", "generation"])
          && number(body["generation"])
        : body["type"] === "preview"
          && exact(body, ["type", "generation", "preview"])
          && number(body["generation"])
          && preview(body["preview"]);
  return valid ? value as unknown as TraceabilityEnvelope<TraceabilityHostBody> : undefined;
}
