import { WEBVIEW_PROTOCOL_VERSION } from "./protocol";
export { WEBVIEW_PROTOCOL_VERSION } from "./protocol";

export type SetupRegion = "global" | "us" | "eu" | "au";
export type SetupConnectionState = "connected" | "disconnected" | "checking";
export const XRAY_SETUP_MASK = "••••••••";

export interface SetupValidationErrors {
  readonly site?: string | undefined;
  readonly region?: string | undefined;
  readonly clientId?: string | undefined;
  readonly clientSecret?: string | undefined;
  readonly jiraEmail?: string | undefined;
  readonly jiraToken?: string | undefined;
}

export type SetupClientMessage =
  | { readonly type: "ready"; readonly previousDocument?: string | undefined }
  | {
      readonly type: "save";
      readonly site: string;
      readonly region: string;
      readonly clientId: string;
      readonly clientSecret: string;
      readonly jiraEmail: string;
      readonly jiraToken: string;
      readonly test: boolean;
    };

export interface SetupJiraProject {
  readonly key: string;
  readonly name: string;
}

export interface SetupProjectSummary {
  readonly project: string;
  readonly totalTests: number;
  readonly existsOnSite?: boolean | undefined;
}

export type SetupHostMessage =
  | { readonly type: "busy"; readonly busy: boolean; readonly testing: boolean }
  | {
      readonly type: "form-state";
      readonly site: string;
      readonly region: SetupRegion;
      readonly credentials: boolean;
      readonly jira: boolean;
    }
  | { readonly type: "validation"; readonly errors: SetupValidationErrors }
  | { readonly type: "saved"; readonly site: string; readonly region: SetupRegion; readonly jira: boolean }
  | { readonly type: "test-result"; readonly ok: boolean; readonly message: string }
  | { readonly type: "error"; readonly message: string }
  | { readonly type: "conn-state"; readonly state: SetupConnectionState; readonly label: string }
  | {
      readonly type: "project-view";
      readonly hasJira: boolean;
      readonly jiraProjects: readonly SetupJiraProject[];
      readonly jiraTruncated: boolean;
      readonly probed: readonly SetupProjectSummary[];
      readonly jiraError?: string | undefined;
    };

export interface SetupEnvelope<T> {
  readonly version: typeof WEBVIEW_PROTOCOL_VERSION;
  readonly session: string;
  readonly document: string;
  readonly revision: number;
  readonly surface: "setup";
  readonly body: T;
}

const SESSION_LIMIT = 128;
const TEXT_LIMIT = 512;
const SECRET_LIMIT = 8_192;
const JIRA_PROJECT_LIMIT = 200;
const PROBED_PROJECT_LIMIT = 3;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && actual.every((key) => keys.includes(key));
}

function exactOrOptional(value: Record<string, unknown>, required: readonly string[], optional: readonly string[]): boolean {
  return required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

function text(value: unknown, limit = TEXT_LIMIT): value is string {
  return typeof value === "string" && value.length <= limit;
}

function region(value: unknown): value is SetupRegion {
  return typeof value === "string" && ["global", "us", "eu", "au"].includes(value);
}

export function isSetupDocument(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value);
}

function envelope(value: unknown): value is Record<string, unknown> & { body: Record<string, unknown> } {
  return record(value) && exact(value, ["version", "session", "document", "revision", "surface", "body"]) &&
    value["version"] === WEBVIEW_PROTOCOL_VERSION && text(value["session"], SESSION_LIMIT) && value["session"].length > 0 &&
    isSetupDocument(value["document"]) &&
    Number.isSafeInteger(value["revision"]) && (value["revision"] as number) >= 0 &&
    value["surface"] === "setup" && record(value["body"]);
}

function validClientBody(body: Record<string, unknown>): boolean {
  if (body["type"] === "ready") {
    return exactOrOptional(body, ["type"], ["previousDocument"]) &&
      (body["previousDocument"] === undefined ||
        isSetupDocument(body["previousDocument"]));
  }
  return body["type"] === "save" &&
    exact(body, ["type", "site", "region", "clientId", "clientSecret", "jiraEmail", "jiraToken", "test"]) &&
    text(body["site"]) && region(body["region"]) && text(body["clientId"], SECRET_LIMIT) &&
    text(body["clientSecret"], SECRET_LIMIT) && text(body["jiraEmail"]) &&
    text(body["jiraToken"], SECRET_LIMIT) && typeof body["test"] === "boolean";
}

export function parseSetupClientEnvelope(value: unknown): SetupEnvelope<SetupClientMessage> | undefined {
  return envelope(value) && validClientBody(value.body)
    ? value as unknown as SetupEnvelope<SetupClientMessage>
    : undefined;
}

function validErrors(value: unknown): boolean {
  if (!record(value)) {return false;}
  const keys = ["site", "region", "clientId", "clientSecret", "jiraEmail", "jiraToken"];
  return Object.keys(value).every((key) => keys.includes(key)) &&
    Object.values(value).every((message) => text(message));
}

function validJiraProject(value: unknown): boolean {
  return record(value) && exact(value, ["key", "name"]) && text(value["key"]) && text(value["name"]);
}

function validProjectSummary(value: unknown): boolean {
  return record(value) && exactOrOptional(value, ["project", "totalTests"], ["existsOnSite"]) &&
    text(value["project"]) && Number.isSafeInteger(value["totalTests"]) && (value["totalTests"] as number) >= 0 &&
    (value["existsOnSite"] === undefined || typeof value["existsOnSite"] === "boolean");
}

function boundedArray(value: unknown, limit: number, valid: (item: unknown) => boolean): boolean {
  if (!Array.isArray(value) || value.length > limit) {return false;}
  for (let index = 0; index < value.length; index += 1) {
    if (!Object.hasOwn(value, index) || !valid(value[index])) {return false;}
  }
  return true;
}

function validHostBody(body: Record<string, unknown>): boolean {
  if (body["type"] === "busy") {
    return exact(body, ["type", "busy", "testing"]) &&
      typeof body["busy"] === "boolean" && typeof body["testing"] === "boolean";
  }
  if (body["type"] === "validation") {
    return exact(body, ["type", "errors"]) && validErrors(body["errors"]);
  }
  if (body["type"] === "form-state") {
    return exact(body, ["type", "site", "region", "credentials", "jira"]) &&
      text(body["site"]) && region(body["region"]) &&
      typeof body["credentials"] === "boolean" && typeof body["jira"] === "boolean";
  }
  if (body["type"] === "saved") {
    return exact(body, ["type", "site", "region", "jira"]) &&
      text(body["site"]) && region(body["region"]) && typeof body["jira"] === "boolean";
  }
  if (body["type"] === "test-result") {
    return exact(body, ["type", "ok", "message"]) && typeof body["ok"] === "boolean" && text(body["message"]);
  }
  if (body["type"] === "error") {
    return exact(body, ["type", "message"]) && text(body["message"]);
  }
  if (body["type"] === "conn-state") {
    return exact(body, ["type", "state", "label"]) &&
      typeof body["state"] === "string" && ["connected", "disconnected", "checking"].includes(body["state"]) &&
      text(body["label"]);
  }
  return body["type"] === "project-view" &&
    exactOrOptional(body, ["type", "hasJira", "jiraProjects", "jiraTruncated", "probed"], ["jiraError"]) &&
    typeof body["hasJira"] === "boolean" && typeof body["jiraTruncated"] === "boolean" &&
    boundedArray(body["jiraProjects"], JIRA_PROJECT_LIMIT, validJiraProject) &&
    boundedArray(body["probed"], PROBED_PROJECT_LIMIT, validProjectSummary) &&
    (body["jiraError"] === undefined || text(body["jiraError"]));
}

export function isSetupHostEnvelope(
  value: unknown,
  session: string,
  document: string,
  revision: number
): value is SetupEnvelope<SetupHostMessage> {
  return envelope(value) && value["session"] === session && value["document"] === document &&
    (value["revision"] as number) > revision &&
    validHostBody(value.body);
}
