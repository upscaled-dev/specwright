import * as path from "node:path";
import type { PublishRequest, RunArtifact, RunArtifactIteration, RunArtifactOutcome } from "../traceability/contracts";
import type { PublishableResult } from "../traceability/publish-core";
import type { EmbeddedEvidence } from "../traceability/evidence-resolution";
import { normalizePath, type ScenarioRef } from "../traceability/scenario-ref";
import { serverMessageOf } from "../utils/text";

// Resolves a publishable result's evidence to base64-embeddable blobs (empty when none applies for the
// active `xray.attachTo` mode). The Xray capability supplies it; `buildPayload` never touches disk.
export type EvidenceForResult = (result: PublishableResult) => readonly EmbeddedEvidence[];

const NO_EVIDENCE: EvidenceForResult = () => [];

const IMPORT_EXECUTION_PATH = "/import/execution";
const CUCUMBER_MULTIPART_PATH = "/import/execution/cucumber/multipart";

// Xray's Cucumber tag-matching convention is a fixed `@TEST_<key>` (Xray-defined, NOT the user's local
// tag prefix, §3.4), so it is hardcoded here rather than read from the KeyGrammar.
const XRAY_TEST_TAG_PREFIX = "@TEST_";
const MS_TO_NS = 1_000_000;
const GHERKIN_KEYWORDS = ["Given", "When", "Then", "And", "But", "*"] as const;

// The HTTP result of an import POST. Carries status/ok so a non-2xx reaches the importer with its body
// intact (the server message is never stripped at the transport). Structurally satisfied by XrayClient.
export interface ImportResponse {
  readonly status: number;
  readonly ok: boolean;
  readonly body: unknown;
}

// The transport seam the importers write through, structurally satisfied by XrayClient. Kept as a local
// interface so this module imports nothing from the vscode-chained client, staying extractable (P5).
export interface ImportTransport {
  postJson(path: string, body: unknown, signal?: AbortSignal): Promise<ImportResponse>;
  postMultipart(
    path: string,
    parts: { readonly results: string; readonly info: string },
    signal?: AbortSignal
  ): Promise<ImportResponse>;
}

// A non-2xx import response. `serverMessage` is resolved from the body's error envelope (see
// serverMessageOf); the wire-confirmed shape for this endpoint is the `{error}` string of §5, the
// other shapes are defensive breadth. 3b surfaces it in a toast, scrubbed and clipped.
export class XrayImportError extends Error {
  public readonly status: number;
  public readonly serverMessage?: string | undefined;
  constructor(status: number, detail?: string) {
    super(detail !== undefined ? `Import failed (HTTP ${status}): ${detail}` : `Import failed (HTTP ${status}).`);
    this.name = "XrayImportError";
    this.status = status;
    if (detail !== undefined) {
      this.serverMessage = detail;
    }
  }
}

// The import payload came out empty (every scenario dropped on the create path, or nothing publishable
// on append), so there is nothing to send. Thrown before any network call; the message is user-facing.
export class EmptyImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmptyImportError";
  }
}

// Allowlisted fields of the import response; id/key/self are wanted diagnostics (§9.3).
export interface ExecutionImportResponse {
  readonly id?: string | undefined;
  readonly key?: string | undefined;
  readonly self?: string | undefined;
}

// Resolves a scenario against CURRENT source at publish time (3b injects the real FeatureParser).
// `undefined` = the scenario changed/vanished since the run → the Cucumber importer drops it rather than
// emit a synthetic-step placeholder that could overwrite stored Xray gherkin (§10 live hazard).
export type StepResolution = { readonly featureName?: string | undefined; readonly steps: readonly string[] };
export type StepResolver = (ref: ScenarioRef) => StepResolution | undefined;

export interface ExecutionImporter<Input, Payload> {
  buildPayload(input: Input): Payload;
  import(transport: ImportTransport, payload: Payload, signal?: AbortSignal): Promise<ExecutionImportResponse>;
}

// Throws XrayImportError on a non-2xx (extracting the server message when the body carries one);
// otherwise returns the allowlisted {id, key, self} diagnostics, which 3b turns into the toast.
function handleImportResponse(response: ImportResponse): ExecutionImportResponse {
  if (!response.ok) {
    const message = serverMessageOf(response.body);
    throw message !== undefined ? new XrayImportError(response.status, message) : new XrayImportError(response.status);
  }
  return parseImportResponse(response.body);
}

function parseImportResponse(body: unknown): ExecutionImportResponse {
  const record = typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  const out: { id?: string; key?: string; self?: string } = {};
  const id = record["id"];
  if (typeof id === "string") {
    out.id = id;
  } else if (typeof id === "number") {
    out.id = String(id);
  }
  if (typeof record["key"] === "string") {
    out.key = record["key"];
  }
  if (typeof record["self"] === "string") {
    out.self = record["self"];
  }
  return out;
}

const XRAY_STATUS: Record<RunArtifactOutcome, string> = {
  passed: "PASSED",
  failed: "FAILED",
  "timed-out": "FAILED",
  interrupted: "ABORTED",
  skipped: "TODO",
};

// ---- Xray JSON importer (append mode) ----

export interface XrayJsonEvidence {
  readonly data: string;
  readonly filename: string;
  readonly contentType?: string | undefined;
}

export interface XrayJsonIteration {
  readonly name: string;
  readonly status: string;
  readonly parameters: readonly { readonly name: string; readonly value: string }[];
  readonly duration: string;
}

export interface XrayJsonTest {
  readonly testKey: string;
  readonly status: string;
  readonly comment?: string | undefined;
  readonly iterations?: readonly XrayJsonIteration[] | undefined;
  // 3c fills these; the field shape is pinned now.
  readonly evidence?: readonly XrayJsonEvidence[] | undefined;
}

// No `info` block: Xray writes its dates onto the execution issue's Xray date custom fields through a
// Jira issue update, so an issue type whose edit screen lacks those fields rejects the whole import
// ("Field 'customfield_XXXXX' cannot be set", seen live on a Sub-Test Execution). Append needs only the
// key and the tests.
export interface XrayJsonPayload {
  readonly testExecutionKey: string;
  readonly tests: readonly XrayJsonTest[];
}

export interface XrayJsonInput {
  readonly results: readonly PublishableResult[];
  readonly request: Extract<PublishRequest, { mode: "append" }>;
  readonly evidenceFor?: EvidenceForResult | undefined;
}

export function buildXrayJsonPayload(input: XrayJsonInput): XrayJsonPayload {
  const { results, request } = input;
  const evidenceFor = input.evidenceFor ?? NO_EVIDENCE;
  return {
    testExecutionKey: request.executionKey,
    tests: results.map((result) => toXrayJsonTest(result, evidenceFor(result))),
  };
}

function toXrayJsonTest(result: PublishableResult, evidence: readonly EmbeddedEvidence[]): XrayJsonTest {
  const test: {
    testKey: string;
    status: string;
    comment?: string;
    iterations?: XrayJsonIteration[];
    evidence?: readonly XrayJsonEvidence[];
  } = {
    testKey: result.testKey,
    status: XRAY_STATUS[result.outcome],
  };
  if (result.flaky) {
    test.comment = `passed on retry (${result.attempts} attempts)`;
  }
  // steps/examples/results/iterations are mutually exclusive per test (schema dependency): iterations
  // ONLY for outline results, a plain top-level status otherwise.
  if (result.iterations && result.iterations.length > 0) {
    test.iterations = result.iterations.map((iteration) => toXrayJsonIteration(iteration));
  }
  if (evidence.length > 0) {
    test.evidence = evidence.map((item) => ({ data: item.data, filename: item.filename, contentType: item.contentType }));
  }
  return test;
}

function toXrayJsonIteration(iteration: RunArtifactIteration): XrayJsonIteration {
  // playwright-xray, the reference reporter for this endpoint, always sends a non-empty `parameters` array
  // per iteration, so a synthetic `example` parameter rides along, carrying the row title: the artifact
  // records no column values, and a positional label would lie whenever only some rows ran.
  // IterationResult.duration is a string of nanoseconds; the artifact carries milliseconds.
  return {
    name: iteration.name,
    status: XRAY_STATUS[iteration.outcome],
    parameters: [{ name: "example", value: iteration.name }],
    duration: String(iteration.durationMs * MS_TO_NS),
  };
}

export class XrayJsonImporter implements ExecutionImporter<XrayJsonInput, XrayJsonPayload> {
  public buildPayload(input: XrayJsonInput): XrayJsonPayload {
    return buildXrayJsonPayload(input);
  }

  public async import(
    transport: ImportTransport,
    payload: XrayJsonPayload,
    signal?: AbortSignal
  ): Promise<ExecutionImportResponse> {
    if (payload.tests.length === 0) {
      throw new EmptyImportError("This run has no test results to add to the execution. Re-run the tests, then publish again.");
    }
    return handleImportResponse(await transport.postJson(IMPORT_EXECUTION_PATH, payload, signal));
  }
}

// ---- Cucumber multipart importer (create-new mode) ----

export interface CucumberTag {
  readonly name: string;
}

export interface CucumberStepResult {
  readonly status: string;
  readonly duration?: number | undefined;
}

// Cucumber's evidence shape (`data` = base64, `mime_type` = content type); Xray turns per-step
// embeddings into test-run evidence.
export interface CucumberEmbedding {
  readonly data: string;
  readonly mime_type: string;
}

export interface CucumberStep {
  readonly keyword: string;
  readonly name: string;
  readonly result: CucumberStepResult;
  readonly embeddings?: readonly CucumberEmbedding[] | undefined;
}

export interface CucumberElement {
  readonly keyword: string;
  readonly type: string;
  readonly name: string;
  readonly tags: readonly CucumberTag[];
  readonly steps: readonly CucumberStep[];
}

export interface CucumberFeature {
  readonly uri: string;
  readonly keyword: string;
  readonly name: string;
  readonly elements: readonly CucumberElement[];
}

export interface CucumberInfo {
  readonly fields: {
    readonly project: { readonly key: string };
    readonly summary: string;
    readonly issuetype: { readonly name: string };
  };
  readonly xrayFields: {
    readonly testPlanKey?: string | undefined;
    readonly environments?: readonly string[] | undefined;
  };
}

export interface CucumberMultipartPayload {
  readonly results: readonly CucumberFeature[];
  readonly info: CucumberInfo;
  // Publishable scenarios that no longer resolve in current source, surfaced to the dialog note.
  readonly droppedChangedCount: number;
}

export interface CucumberMultipartInput {
  readonly artifact: RunArtifact;
  readonly results: readonly PublishableResult[];
  readonly request: Extract<PublishRequest, { mode: "create-new" }>;
  readonly resolveSteps: StepResolver;
  // The captured `scenario.filePath` is absolute (the P2 ArtifactBuilder stores it un-relativized; see
  // run-artifact-store.ts); the publish flow supplies the owning workspace root PER feature so the
  // cucumber `uri` is workspace-relative even when a multi-root batch straddles folders. Undefined for
  // a given path → that path is forward-slashed but left as-is.
  readonly workspaceRootFor?: ((filePath: string) => string | undefined) | undefined;
  readonly evidenceFor?: EvidenceForResult | undefined;
  // The execution issue type name: the target project's own from createmeta when it resolved, else the
  // configured `xray.executionIssueType`.
  readonly issueTypeName: string;
}

interface FeatureDraft {
  uri: string;
  name: string;
  readonly elements: CucumberElement[];
}

export function buildCucumberMultipartPayload(input: CucumberMultipartInput): CucumberMultipartPayload {
  const { results, request, resolveSteps } = input;
  const workspaceRootFor = input.workspaceRootFor ?? (() => undefined);
  const evidenceFor = input.evidenceFor ?? NO_EVIDENCE;
  const drafts: FeatureDraft[] = [];
  const byUri = new Map<string, FeatureDraft>();
  let droppedChangedCount = 0;

  for (const result of results) {
    const resolution = resolveSteps(result.scenario);
    if (resolution === undefined) {
      droppedChangedCount += 1;
      continue;
    }
    const uri = featureUri(result.scenario.filePath, workspaceRootFor(result.scenario.filePath));
    let draft = byUri.get(uri);
    if (draft === undefined) {
      draft = { uri, name: resolution.featureName ?? "", elements: [] };
      byUri.set(uri, draft);
      drafts.push(draft);
    } else if (draft.name === "" && resolution.featureName !== undefined) {
      draft.name = resolution.featureName;
    }
    draft.elements.push(...toElements(result, resolution.steps, evidenceFor(result)));
  }

  return {
    results: drafts.map((draft) => ({ uri: draft.uri, keyword: "Feature", name: draft.name, elements: draft.elements })),
    info: buildCucumberInfo(request, input.issueTypeName),
    droppedChangedCount,
  };
}

function toElements(
  result: PublishableResult,
  steps: readonly string[],
  evidence: readonly EmbeddedEvidence[]
): CucumberElement[] {
  const tags: readonly CucumberTag[] = [{ name: `${XRAY_TEST_TAG_PREFIX}${result.testKey}` }];
  let elements: CucumberElement[];
  if (result.iterations && result.iterations.length > 0) {
    // Outline: one element per example row, iteration name suffixed, same tags.
    elements = result.iterations.map((iteration) => ({
      keyword: "Scenario",
      type: "scenario",
      name: `${result.scenario.name} (${iteration.name})`,
      tags,
      steps: toCucumberSteps(iteration.outcome, iteration.durationMs, steps),
    }));
  } else {
    elements = [
      {
        keyword: "Scenario",
        type: "scenario",
        name: result.scenario.name,
        tags,
        steps: toCucumberSteps(result.outcome, result.durationMs, steps),
      },
    ];
  }
  // The result's evidence rides the first element's failing step (or its first step); the artifact
  // carries scenario-level refs, not per-iteration ones, so a data-driven result attaches to one row.
  const first = elements[0];
  if (evidence.length > 0 && first !== undefined && first.steps.length > 0) {
    elements[0] = withEmbeddings(first, evidence);
  }
  return elements;
}

function withEmbeddings(element: CucumberElement, evidence: readonly EmbeddedEvidence[]): CucumberElement {
  const failing = element.steps.findIndex((step) => step.result.status === "failed");
  const target = failing >= 0 ? failing : 0;
  const embeddings = evidence.map((item) => ({ data: item.data, mime_type: item.contentType }));
  const steps = element.steps.map((step, index) => (index === target ? { ...step, embeddings } : step));
  return { ...element, steps };
}

function toCucumberSteps(outcome: RunArtifactOutcome, durationMs: number, steps: readonly string[]): CucumberStep[] {
  return steps.map((text, index) => {
    const { keyword, name } = splitStep(text);
    return { keyword, name, result: stepResult(outcome, durationMs, index) };
  });
}

function stepResult(outcome: RunArtifactOutcome, durationMs: number, index: number): CucumberStepResult {
  if (outcome === "passed") {
    // The artifact has no per-step timing: whole-scenario duration (ms→ns) on the first step, 0 on the rest.
    return { status: "passed", duration: index === 0 ? durationMs * MS_TO_NS : 0 };
  }
  if (outcome === "failed" || outcome === "timed-out") {
    // First step carries the failure, the rest are skipped; no error_message, the artifact carries none.
    return { status: index === 0 ? "failed" : "skipped" };
  }
  return { status: "skipped" };
}

function splitStep(text: string): { keyword: string; name: string } {
  const trimmed = text.trimStart();
  for (const keyword of GHERKIN_KEYWORDS) {
    if (trimmed === keyword || trimmed.startsWith(`${keyword} `)) {
      return { keyword: `${keyword} `, name: trimmed.slice(keyword.length).trimStart() };
    }
  }
  return { keyword: "", name: trimmed };
}

// Forward-slash the captured (absolute) feature path, and posix-relativize it against the workspace
// root when one is supplied, falling back to the normalized path if the file sits outside the root.
function featureUri(filePath: string, workspaceRoot: string | undefined): string {
  const normalized = normalizePath(filePath);
  if (workspaceRoot === undefined) {
    return normalized;
  }
  const rel = path.posix.relative(normalizePath(workspaceRoot), normalized);
  return rel !== "" && !rel.startsWith("..") ? rel : normalized;
}

function buildCucumberInfo(
  request: Extract<PublishRequest, { mode: "create-new" }>,
  issueTypeName: string
): CucumberInfo {
  const xrayFields: { testPlanKey?: string; environments?: readonly string[] } = {};
  if (request.testPlanKey !== undefined && request.testPlanKey !== "") {
    xrayFields.testPlanKey = request.testPlanKey;
  }
  if (request.environments !== undefined && request.environments.length > 0) {
    xrayFields.environments = request.environments;
  }
  // `fields` uses the Jira create-issue shape: the endpoint runs full create-issue validation and 400s
  // without issuetype ("issuetype: Specify an issue type", verified live 2026-07-25). It also 400s with
  // a name the target project does not accept ("issuetype: Specify a valid issue type", verified live
  // 2026-07-25). The name is site AND project configurable, so the publish flow resolves it upstream
  // and passes it here. `environments` (not `testEnvironments`) is the multipart xrayFields key (§5).
  return {
    fields: {
      project: { key: request.project },
      summary: request.summary,
      issuetype: { name: issueTypeName },
    },
    xrayFields,
  };
}

export class CucumberMultipartImporter
  implements ExecutionImporter<CucumberMultipartInput, CucumberMultipartPayload>
{
  public buildPayload(input: CucumberMultipartInput): CucumberMultipartPayload {
    return buildCucumberMultipartPayload(input);
  }

  public async import(
    transport: ImportTransport,
    payload: CucumberMultipartPayload,
    signal?: AbortSignal
  ): Promise<ExecutionImportResponse> {
    if (payload.results.length === 0) {
      throw new EmptyImportError(
        "None of the scenarios from this run match the current feature files, so there is nothing to publish. Re-run the tests, then publish again."
      );
    }
    const parts = { results: JSON.stringify(payload.results), info: JSON.stringify(payload.info) };
    return handleImportResponse(await transport.postMultipart(CUCUMBER_MULTIPART_PATH, parts, signal));
  }
}
