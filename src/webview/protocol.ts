export const WEBVIEW_PROTOCOL_VERSION = 1 as const;

export type SurfaceName = "board" | "publish" | "link";
export type ShellTab = "mapping" | "matrix" | "executions" | "publish" | "link";

export interface WebviewEnvelope<T> {
  readonly version: typeof WEBVIEW_PROTOCOL_VERSION;
  readonly session: string;
  readonly revision: number;
  readonly surface: SurfaceName | "shell";
  readonly body: T;
}

export type ShellClientMessage = { type: "ready" } | { type: "tab"; tab: ShellTab };

export type BoardClientMessage =
  | { type: "search"; value: string }
  | { type: "columnSearch"; section: "untraced" | "available" | "mapped"; value: string }
  | { type: "page"; section: "untraced" | "available" | "mapped"; step: "prev" | "next" }
  | { type: "pageSize"; size: number }
  | { type: "drop"; scenario: string; key: string }
  | { type: "unlink"; scenario: string; key: string }
  | { type: "pushText"; scenario: string; key: string }
  | { type: "open"; key: string }
  | { type: "scope"; project: string }
  | { type: "select"; target: "scenario" | "test"; id: string; on: boolean }
  | { type: "select-scope"; section: "available" | "mapped"; on: boolean }
  | { type: "sync" }
  | { type: "bulkCreate" }
  | { type: "createTestSet" }
  | { type: "addToTestSet" }
  | { type: "createTestPlan" }
  | { type: "addToTestPlan" }
  | { type: "createTestExecution" };

export type LinkClientMessage =
  | { type: "search"; value: string }
  | { type: "confirm"; id: string }
  | { type: "openLinked" | "unlink"; key: string }
  | { type: "cancel" };

export type PublishClientMessage =
  | { type: "search"; token: number; kind: "execution" | "test-plan" | "project"; query: string }
  | { type: "browse" | "cancel" }
  | { type: "selectRun"; runId: string }
  | { type: "attachPending"; runId: string }
  | { type: "confirm"; runId: string; request: PublishRequest; attachments: string[] };

export type PublishRequest =
  | { readonly mode: "append"; readonly executionKey: string }
  | { readonly mode: "create-new"; readonly project: string; readonly summary: string; readonly testPlanKey?: string | undefined; readonly environments?: readonly string[] | undefined };

export type ClientMessage = ShellClientMessage | BoardClientMessage | LinkClientMessage | PublishClientMessage;

export interface LinkPickerRow {
  readonly id: string;
  readonly key: string;
  readonly summary?: string | undefined;
  readonly kind: "test" | "create" | "hint";
}

export interface LinkedRow {
  readonly key: string;
  readonly summary?: string | undefined;
  readonly remoteMissing?: boolean | undefined;
}

export interface SelectableScenarioCard {
  readonly name: string;
  readonly location: string;
  readonly dropId: string;
  readonly pills: readonly string[];
  readonly reqKeys: readonly string[];
  readonly selected: boolean;
}

export interface BoardTestLink {
  readonly name: string;
  readonly location: string;
  readonly unlinkId: string;
}

export interface SelectableTestCard {
  readonly key: string;
  readonly summary?: string | undefined;
  readonly project?: string | undefined;
  readonly pills: readonly string[];
  readonly links: readonly BoardTestLink[];
  readonly selected: boolean;
}

export type SectionSelection = "none" | "some" | "all";

export interface BoardSectionMeta {
  readonly total: number;
  readonly filtered: number;
  readonly page: number;
  readonly pageSize: number;
  readonly pageCount: number;
  readonly query: string;
  readonly filtering: boolean;
  readonly selection: SectionSelection;
}

export interface MatrixRow {
  readonly requirement: string;
  readonly test: string;
  readonly scenario: string;
  readonly tag: string;
  readonly result: string;
  readonly file: string;
  readonly projects: readonly string[];
}

export interface MatrixGroup {
  readonly file: string;
  readonly count: number;
  readonly rows: readonly MatrixRow[];
}

export interface ExecutionActivityRow {
  readonly action: string;
  readonly resultsImported: string;
  readonly passRate: string;
  readonly publishedAt: string;
}

export interface ExecutionGroup {
  readonly kind: "group";
  readonly key: string;
  readonly keyLabel: string;
  readonly summary: string;
  readonly latestPublishedAt: string;
  readonly activityCount: number;
  readonly activities: readonly ExecutionActivityRow[];
}

export interface UnknownExecutionRow extends ExecutionActivityRow {
  readonly kind: "unknown";
  readonly key: "";
  readonly keyLabel: string;
  readonly summary: string;
  readonly activityCount: 1;
}

export type ExecutionRow = ExecutionGroup | UnknownExecutionRow;

export interface BoardVerb {
  readonly label: string;
  readonly enabled: boolean;
  readonly hint: string;
}

export interface BoardRenderMessage {
  readonly type: "render";
  readonly scenarios: readonly SelectableScenarioCard[];
  readonly available: readonly SelectableTestCard[];
  readonly mapped: readonly SelectableTestCard[];
  readonly sections: Record<"untraced" | "available" | "mapped", BoardSectionMeta>;
  readonly pageSize: number;
  readonly matrix: readonly MatrixGroup[];
  readonly executions: readonly ExecutionRow[];
  readonly availableEmptyText: string;
  readonly filtering: boolean;
  readonly projects: readonly string[];
  readonly project: string;
  readonly scoped: boolean;
  readonly createVerb: BoardVerb;
  readonly syncVerb: BoardVerb;
  readonly untracedHelper: string;
  readonly testSetVerb: BoardVerb;
  readonly addToTestSetVerb: BoardVerb;
  readonly testPlanVerb: BoardVerb;
  readonly addToTestPlanVerb: BoardVerb;
  readonly mappingHelper: string;
  readonly executionVerb: BoardVerb;
}

export type BoardHostMessage = BoardRenderMessage | { type: "syncProgress"; text: string };
export type LinkHostMessage =
  | { type: "reset"; title: string; searchPlaceholder: string }
  | { type: "rows"; rows: readonly LinkPickerRow[] }
  | { type: "linked"; rows: readonly LinkedRow[] }
  | { type: "busy"; busy: boolean };

export interface PublishTarget { readonly key: string; readonly label: string }
export interface AttachmentSuggestion { readonly path: string; readonly name: string; readonly size: number }
export interface PublishAttachmentsModel {
  readonly available: boolean;
  readonly reason?: string | undefined;
  readonly suggestions: readonly AttachmentSuggestion[];
  readonly uploadLimitBytes: number;
  readonly evidenceStream: "evidence" | "issue" | "both";
}
export interface PublishRunOption {
  readonly id: string;
  readonly label: string;
  readonly subtitle: string;
  readonly project: { readonly value: string; readonly fromDerivation: boolean; readonly fromScope?: boolean | undefined };
  readonly defaultSummary: string;
  readonly prefillPlanKey?: string | undefined;
  readonly republish?: { readonly target: string; readonly publishedAt: number; readonly mode?: "create-new" | "append" | undefined; readonly outcomeUnknown?: boolean | undefined; readonly operationId?: string | undefined } | undefined;
  readonly pendingAttachments?: { readonly target: string; readonly count: number } | undefined;
}
export interface PublishDialogModel {
  readonly title: string;
  readonly runs: readonly PublishRunOption[];
  readonly selectedRunId: string;
  readonly jiraSearchAvailable: boolean;
  readonly knownProjectKeys: readonly string[];
  readonly attachments: PublishAttachmentsModel;
}
export type PublishHostMessage =
  | { type: "model"; model: PublishDialogModel }
  | { type: "retry" | "runs"; runs: readonly PublishRunOption[]; selectedRunId: string }
  | { type: "settled" }
  | { type: "search-result"; token: number; kind: "execution" | "test-plan" | "project"; items: readonly PublishTarget[]; error?: string | undefined }
  | { type: "browse-result"; items: readonly AttachmentSuggestion[] }
  | { type: "attachment-error"; text: string }
  | { type: "publish-busy"; busy: boolean }
  | { type: "pending-busy"; runId: string; busy: boolean }
  | { type: "pending-result"; runId: string; remaining: number };
export type ShellHostMessage = { type: "activate"; tab: ShellTab } | { type: "linkTab"; visible: boolean; title?: string | undefined };
export interface HostMessageBySurface {
  readonly shell: ShellHostMessage;
  readonly board: BoardHostMessage;
  readonly link: LinkHostMessage;
  readonly publish: PublishHostMessage;
}
export interface ClientMessageBySurface {
  readonly shell: ShellClientMessage;
  readonly board: BoardClientMessage;
  readonly link: LinkClientMessage;
  readonly publish: PublishClientMessage;
}
export type HostMessage = HostMessageBySurface[keyof HostMessageBySurface];

const STRING_LIMIT = 512;
const PATH_LIMIT = 2_048;
export const WEBVIEW_ATTACHMENT_LIMIT = 64;
const ATTACHMENT_TRANSPORT_LIMIT = 128;
const SESSION_LIMIT = 128;
const HOST_PROJECTION_LIMIT = 50_000;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function text(value: unknown, limit = STRING_LIMIT): value is string {
  return typeof value === "string" && value.length <= limit;
}

function oneOf<T extends string>(value: unknown, values: readonly T[]): value is T {
  return typeof value === "string" && values.includes(value as T);
}

function noArgs(body: Record<string, unknown>, types: readonly string[]): boolean {
  return exact(body, ["type"]) && oneOf(body["type"], types);
}

function validPublishRequest(value: unknown): value is PublishRequest {
  if (!record(value) || !oneOf(value["mode"], ["create-new", "append"] as const)) {return false;}
  if (value["mode"] === "append") {
    return exact(value, ["mode", "executionKey"]) && text(value["executionKey"]);
  }
  const allowed = ["mode", "summary", "project", "testPlanKey", "environments"];
  return Object.keys(value).every((key) => allowed.includes(key)) &&
    text(value["summary"]) && text(value["project"]) &&
    (value["testPlanKey"] === undefined || text(value["testPlanKey"])) &&
    (value["environments"] === undefined || (Array.isArray(value["environments"]) &&
      value["environments"].length <= 32 && value["environments"].every((item) => text(item))));
}

export function parseClientEnvelope(value: unknown): WebviewEnvelope<ClientMessage> | undefined {
  if (!record(value) || !exact(value, ["version", "session", "revision", "surface", "body"]) ||
      value["version"] !== WEBVIEW_PROTOCOL_VERSION || !text(value["session"], SESSION_LIMIT) ||
      !Number.isSafeInteger(value["revision"]) || (value["revision"] as number) < 0 ||
      !oneOf(value["surface"], ["shell", "board", "link", "publish"] as const) || !record(value["body"])) {
    return undefined;
  }
  const body = value["body"];
  const valid = value["surface"] === "shell" ? validShell(body)
    : value["surface"] === "board" ? validBoard(body)
      : value["surface"] === "link" ? validLink(body) : validPublish(body);
  return valid ? value as unknown as WebviewEnvelope<ClientMessage> : undefined;
}

function validShell(body: Record<string, unknown>): boolean {
  return noArgs(body, ["ready"]) ||
    (body["type"] === "tab" && exact(body, ["type", "tab"]) &&
      oneOf(body["tab"], ["mapping", "matrix", "executions", "publish", "link"] as const));
}

function validBoard(body: Record<string, unknown>): boolean {
  const section = ["untraced", "available", "mapped"] as const;
  if (noArgs(body, ["sync", "bulkCreate", "createTestSet", "addToTestSet", "createTestPlan", "addToTestPlan", "createTestExecution"])) {return true;}
  if (body["type"] === "search") {return exact(body, ["type", "value"]) && text(body["value"]);}
  if (body["type"] === "columnSearch") {return exact(body, ["type", "section", "value"]) && oneOf(body["section"], section) && text(body["value"]);}
  if (body["type"] === "page") {return exact(body, ["type", "section", "step"]) && oneOf(body["section"], section) && oneOf(body["step"], ["prev", "next"] as const);}
  if (body["type"] === "pageSize") {return exact(body, ["type", "size"]) && Number.isSafeInteger(body["size"]) && (body["size"] as number) >= 1 && (body["size"] as number) <= 100;}
  if (oneOf(body["type"], ["drop", "unlink", "pushText"] as const)) {return exact(body, ["type", "scenario", "key"]) && text(body["scenario"]) && text(body["key"]);}
  if (body["type"] === "open") {return exact(body, ["type", "key"]) && text(body["key"]);}
  if (body["type"] === "scope") {return exact(body, ["type", "project"]) && text(body["project"]);}
  if (body["type"] === "select") {
    return exact(body, ["type", "target", "id", "on"]) && oneOf(body["target"], ["scenario", "test"] as const) &&
      text(body["id"]) && typeof body["on"] === "boolean";
  }
  return body["type"] === "select-scope" && exact(body, ["type", "section", "on"]) &&
    oneOf(body["section"], ["available", "mapped"] as const) && typeof body["on"] === "boolean";
}

function validLink(body: Record<string, unknown>): boolean {
  if (noArgs(body, ["cancel"])) {return true;}
  if (body["type"] === "search") {return exact(body, ["type", "value"]) && text(body["value"]);}
  if (body["type"] === "confirm") {return exact(body, ["type", "id"]) && text(body["id"]);}
  return oneOf(body["type"], ["openLinked", "unlink"] as const) && exact(body, ["type", "key"]) && text(body["key"]);
}

function validPublish(body: Record<string, unknown>): boolean {
  if (noArgs(body, ["browse", "cancel"])) {return true;}
  if (body["type"] === "selectRun") {return exact(body, ["type", "runId"]) && text(body["runId"]);}
  if (body["type"] === "attachPending") {return exact(body, ["type", "runId"]) && text(body["runId"]);}
  if (body["type"] === "search") {
    return exact(body, ["type", "token", "kind", "query"]) && Number.isSafeInteger(body["token"]) &&
      (body["token"] as number) >= 0 && oneOf(body["kind"], ["execution", "test-plan", "project"] as const) && text(body["query"]);
  }
  return body["type"] === "confirm" && exact(body, ["type", "runId", "request", "attachments"]) &&
    text(body["runId"]) && validPublishRequest(body["request"]) && Array.isArray(body["attachments"]) &&
    body["attachments"].length <= ATTACHMENT_TRANSPORT_LIMIT && body["attachments"].every((item) => text(item, PATH_LIMIT));
}

function number(value: unknown, minimum = 0): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= minimum;
}

function stringArray(value: unknown, limit = 256): value is readonly string[] {
  return Array.isArray(value) && value.length <= limit && value.every((item) => text(item, PATH_LIMIT));
}

function optionalText(value: Record<string, unknown>, key: string): boolean {
  return value[key] === undefined || text(value[key], PATH_LIMIT);
}

function exactOrOptional(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function objectArray(value: unknown, valid: (item: Record<string, unknown>) => boolean, limit = 256): boolean {
  return Array.isArray(value) && value.length <= limit && value.every((item) => record(item) && valid(item));
}

interface ProjectionBudget { remaining: number }

function consumeProjection(budget: ProjectionBudget, count: number): boolean {
  if (count > budget.remaining) {return false;}
  budget.remaining -= count;
  return true;
}

function projectedArray(
  value: unknown,
  valid: (item: Record<string, unknown>, budget: ProjectionBudget) => boolean,
  budget: ProjectionBudget
): boolean {
  if (!Array.isArray(value) || !consumeProjection(budget, value.length)) {return false;}
  return value.every((item) => record(item) && valid(item, budget));
}

function projectedStrings(value: unknown, limit: number, budget: ProjectionBudget): boolean {
  return Array.isArray(value) && value.length <= limit && consumeProjection(budget, value.length) &&
    value.every((item) => text(item, PATH_LIMIT));
}

function validLinkPickerRow(value: Record<string, unknown>): boolean {
  return exactOrOptional(value, ["id", "key", "kind"], ["summary"]) && text(value["id"]) && text(value["key"]) &&
    oneOf(value["kind"], ["test", "create", "hint"] as const) && optionalText(value, "summary");
}

function validLinkedRow(value: Record<string, unknown>): boolean {
  return exactOrOptional(value, ["key"], ["summary", "remoteMissing"]) && text(value["key"]) && optionalText(value, "summary") &&
    (value["remoteMissing"] === undefined || typeof value["remoteMissing"] === "boolean");
}

function validScenarioCard(value: Record<string, unknown>, budget: ProjectionBudget): boolean {
  return exact(value, ["name", "location", "dropId", "pills", "reqKeys", "selected"]) &&
    text(value["name"]) && text(value["location"], PATH_LIMIT) && text(value["dropId"], PATH_LIMIT) &&
    projectedStrings(value["pills"], 64, budget) && projectedStrings(value["reqKeys"], 64, budget) &&
    typeof value["selected"] === "boolean";
}

function validBoardLink(value: Record<string, unknown>): boolean {
  return exact(value, ["name", "location", "unlinkId"]) && text(value["name"]) &&
    text(value["location"], PATH_LIMIT) && text(value["unlinkId"], PATH_LIMIT);
}

function validTestCard(value: Record<string, unknown>, budget: ProjectionBudget): boolean {
  return exactOrOptional(value, ["key", "pills", "links", "selected"], ["summary", "project"]) && text(value["key"]) &&
    optionalText(value, "summary") && optionalText(value, "project") && projectedStrings(value["pills"], 64, budget) &&
    projectedArray(value["links"], (item) => validBoardLink(item), budget) &&
    typeof value["selected"] === "boolean";
}

function validSection(value: unknown): boolean {
  return record(value) && exact(value, ["total", "filtered", "page", "pageSize", "pageCount", "query", "filtering", "selection"]) &&
    number(value["total"]) && number(value["filtered"]) && number(value["page"]) && number(value["pageSize"], 1) &&
    number(value["pageCount"]) && text(value["query"]) && typeof value["filtering"] === "boolean" &&
    oneOf(value["selection"], ["none", "some", "all"] as const);
}

function validMatrixRow(value: Record<string, unknown>, budget: ProjectionBudget): boolean {
  return exact(value, ["requirement", "test", "scenario", "tag", "result", "file", "projects"]) &&
    ["requirement", "test", "scenario", "tag", "result"].every((key) => text(value[key])) &&
    text(value["file"], PATH_LIMIT) && projectedStrings(value["projects"], 64, budget);
}

function validMatrixGroup(value: Record<string, unknown>, budget: ProjectionBudget): boolean {
  return exact(value, ["file", "count", "rows"]) && text(value["file"], PATH_LIMIT) && number(value["count"]) &&
    projectedArray(value["rows"], validMatrixRow, budget);
}

function validActivity(value: Record<string, unknown>): boolean {
  return exact(value, ["action", "resultsImported", "passRate", "publishedAt"]) &&
    ["action", "resultsImported", "passRate", "publishedAt"].every((key) => text(value[key]));
}

function validExecution(value: Record<string, unknown>, budget: ProjectionBudget): boolean {
  if (value["kind"] === "group") {
    return exact(value, ["kind", "key", "keyLabel", "summary", "latestPublishedAt", "activityCount", "activities"]) &&
      ["key", "keyLabel", "summary", "latestPublishedAt"].every((key) => text(value[key])) && number(value["activityCount"]) &&
      projectedArray(value["activities"], (item) => validActivity(item), budget);
  }
  return value["kind"] === "unknown" && exact(value, ["kind", "key", "keyLabel", "summary", "activityCount", "action", "resultsImported", "passRate", "publishedAt"]) &&
    value["key"] === "" && value["activityCount"] === 1 && ["keyLabel", "summary", "action", "resultsImported", "passRate", "publishedAt"].every((key) => text(value[key]));
}

function validVerb(value: unknown): boolean {
  return record(value) && exact(value, ["label", "enabled", "hint"]) && text(value["label"]) &&
    typeof value["enabled"] === "boolean" && text(value["hint"]);
}

function validAttachment(value: Record<string, unknown>): boolean {
  return exact(value, ["path", "name", "size"]) && text(value["path"], PATH_LIMIT) && text(value["name"]) && number(value["size"]);
}

function validTarget(value: Record<string, unknown>): boolean {
  return exact(value, ["key", "label"]) && text(value["key"]) && text(value["label"]);
}

function validRun(value: Record<string, unknown>): boolean {
  if (!exactOrOptional(value, ["id", "label", "subtitle", "project", "defaultSummary"], ["prefillPlanKey", "republish", "pendingAttachments"]) ||
      !["id", "label", "subtitle", "defaultSummary"].every((key) => text(value[key])) || !optionalText(value, "prefillPlanKey") || !record(value["project"])) {return false;}
  const project = value["project"];
  if (!exactOrOptional(project, ["value", "fromDerivation"], ["fromScope"]) || !text(project["value"]) ||
      typeof project["fromDerivation"] !== "boolean" || (project["fromScope"] !== undefined && typeof project["fromScope"] !== "boolean")) {return false;}
  if (value["republish"] !== undefined) {
    if (!record(value["republish"])) {return false;}
    const notice = value["republish"];
    if (!exactOrOptional(notice, ["target", "publishedAt"], ["mode", "outcomeUnknown", "operationId"]) || !text(notice["target"]) ||
        !number(notice["publishedAt"]) || (notice["mode"] !== undefined && !oneOf(notice["mode"], ["create-new", "append"] as const)) ||
        (notice["outcomeUnknown"] !== undefined && typeof notice["outcomeUnknown"] !== "boolean") || !optionalText(notice, "operationId")) {return false;}
  }
  if (value["pendingAttachments"] !== undefined) {
    if (!record(value["pendingAttachments"])) {return false;}
    const pending = value["pendingAttachments"];
    if (!exact(pending, ["target", "count"]) || !text(pending["target"]) || !number(pending["count"])) {return false;}
  }
  return true;
}

function validAttachments(value: unknown): boolean {
  return record(value) && exactOrOptional(value, ["available", "suggestions", "uploadLimitBytes", "evidenceStream"], ["reason"]) &&
    typeof value["available"] === "boolean" && objectArray(value["suggestions"], validAttachment, WEBVIEW_ATTACHMENT_LIMIT) && number(value["uploadLimitBytes"]) &&
    oneOf(value["evidenceStream"], ["evidence", "issue", "both"] as const) && optionalText(value, "reason");
}

function validModel(value: unknown): boolean {
  return record(value) && exact(value, ["title", "runs", "selectedRunId", "jiraSearchAvailable", "knownProjectKeys", "attachments"]) &&
    text(value["title"]) && objectArray(value["runs"], validRun) && text(value["selectedRunId"]) &&
    typeof value["jiraSearchAvailable"] === "boolean" && stringArray(value["knownProjectKeys"], 128) && validAttachments(value["attachments"]);
}

function validHostBody(surface: SurfaceName | "shell", body: Record<string, unknown>): boolean {
  if (!text(body["type"], 64)) {return false;}
  if (surface === "shell") {
    if (body["type"] === "activate") {return exact(body, ["type", "tab"]) && oneOf(body["tab"], ["mapping", "matrix", "executions", "publish", "link"] as const);}
    return body["type"] === "linkTab" && Object.keys(body).every((key) => ["type", "visible", "title"].includes(key)) &&
      typeof body["visible"] === "boolean" && (body["title"] === undefined || text(body["title"]));
  }
  if (surface === "link") {
    if (body["type"] === "reset") {return exact(body, ["type", "title", "searchPlaceholder"]) && text(body["title"]) && text(body["searchPlaceholder"]);}
    if (body["type"] === "busy") {return exact(body, ["type", "busy"]) && typeof body["busy"] === "boolean";}
    if (body["type"] === "rows") {return exact(body, ["type", "rows"]) && objectArray(body["rows"], validLinkPickerRow);}
    return body["type"] === "linked" && exact(body, ["type", "rows"]) && objectArray(body["rows"], validLinkedRow);
  }
  if (surface === "board") {
    if (body["type"] === "syncProgress") {return exact(body, ["type", "text"]) && text(body["text"]);}
    const keys = ["type", "scenarios", "available", "mapped", "sections", "pageSize", "matrix", "executions", "availableEmptyText", "filtering", "projects", "project", "scoped", "createVerb", "syncVerb", "untracedHelper", "testSetVerb", "addToTestSetVerb", "testPlanVerb", "addToTestPlanVerb", "mappingHelper", "executionVerb"];
    const budget: ProjectionBudget = { remaining: HOST_PROJECTION_LIMIT };
    return body["type"] === "render" && exact(body, keys) && projectedArray(body["scenarios"], validScenarioCard, budget) &&
      projectedArray(body["available"], validTestCard, budget) && projectedArray(body["mapped"], validTestCard, budget) && projectedArray(body["matrix"], validMatrixGroup, budget) &&
      projectedArray(body["executions"], validExecution, budget) && record(body["sections"]) && exact(body["sections"], ["untraced", "available", "mapped"]) &&
      validSection(body["sections"]["untraced"]) && validSection(body["sections"]["available"]) && validSection(body["sections"]["mapped"]) && Number.isSafeInteger(body["pageSize"]) &&
      projectedStrings(body["projects"], 128, budget) &&
      text(body["project"]) && text(body["availableEmptyText"]) &&
      typeof body["filtering"] === "boolean" && typeof body["scoped"] === "boolean" &&
      ["createVerb", "syncVerb", "testSetVerb", "addToTestSetVerb", "testPlanVerb", "addToTestPlanVerb", "executionVerb"].every((key) => validVerb(body[key])) &&
      ["untracedHelper", "mappingHelper"].every((key) => text(body[key]));
  }
  if (body["type"] === "settled") {return exact(body, ["type"]);}
  if (body["type"] === "model") {return exact(body, ["type", "model"]) && validModel(body["model"]);}
  if (oneOf(body["type"], ["retry", "runs"] as const)) {
    return exact(body, ["type", "runs", "selectedRunId"]) && objectArray(body["runs"], validRun) && text(body["selectedRunId"]);
  }
  if (body["type"] === "search-result") {
    return Object.keys(body).every((key) => ["type", "token", "kind", "items", "error"].includes(key)) &&
      Number.isSafeInteger(body["token"]) && oneOf(body["kind"], ["execution", "test-plan", "project"] as const) &&
      objectArray(body["items"], validTarget) && (body["error"] === undefined || text(body["error"]));
  }
  if (body["type"] === "browse-result") {return exact(body, ["type", "items"]) && objectArray(body["items"], validAttachment, WEBVIEW_ATTACHMENT_LIMIT);}
  if (body["type"] === "attachment-error") {return exact(body, ["type", "text"]) && text(body["text"]);}
  if (body["type"] === "publish-busy") {return exact(body, ["type", "busy"]) && typeof body["busy"] === "boolean";}
  if (body["type"] === "pending-busy") {
    return exact(body, ["type", "runId", "busy"]) && text(body["runId"]) && typeof body["busy"] === "boolean";
  }
  return body["type"] === "pending-result" && exact(body, ["type", "runId", "remaining"]) &&
    text(body["runId"]) && Number.isSafeInteger(body["remaining"]) && (body["remaining"] as number) >= 0;
}

export function isHostEnvelope(value: unknown, session: string, revision: number): value is WebviewEnvelope<HostMessage> {
  if (!record(value) || !exact(value, ["version", "session", "revision", "surface", "body"]) ||
      value["version"] !== WEBVIEW_PROTOCOL_VERSION || value["session"] !== session ||
      !Number.isSafeInteger(value["revision"]) || (value["revision"] as number) <= revision ||
      !oneOf(value["surface"], ["shell", "board", "link", "publish"] as const) || !record(value["body"]) || !text(value["body"]["type"], 64)) {
    return false;
  }
  return validHostBody(value["surface"], value["body"]);
}
