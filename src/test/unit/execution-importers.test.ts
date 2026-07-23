import { describe, it, expect } from "vitest";
import {
  CucumberMultipartImporter,
  EmptyImportError,
  XrayImportError,
  XrayJsonImporter,
  buildCucumberMultipartPayload,
  buildXrayJsonPayload,
  type ImportResponse,
  type ImportTransport,
  type StepResolver,
} from "../../xray/execution-importers";
import { publishableResults, type PublishableResult } from "../../traceability/publish-core";
import type {
  BatchSelection,
  PreflightDecision,
  RunArtifact,
  RunArtifactOutcome,
  RunArtifactResult,
} from "../../traceability/contracts";
import type { EmbeddedEvidence } from "../../traceability/evidence-resolution";
import type { ScenarioRef } from "../../traceability/scenario-ref";

const SHOT: EmbeddedEvidence = { filename: "shot.png", contentType: "image/png", data: "UE5H" };

const CREATED_AT = Date.UTC(2026, 6, 22, 12, 0, 0);

function ref(filePath: string, line: number, name: string, kind: ScenarioRef["kind"] = "scenario"): ScenarioRef {
  return { filePath, line, name, kind };
}

function pub(scenario: ScenarioRef, testKey: string, over: Partial<RunArtifactResult> = {}): PublishableResult {
  return { outcome: "passed", durationMs: 1000, attempts: 1, flaky: false, evidenceRefs: [], ...over, scenario, testKey };
}

function refArtifact(): RunArtifact {
  return {
    id: "run-1",
    createdAt: CREATED_AT,
    results: [],
    shards: [],
    selection: { kind: "all-mapped" },
    preflight: [],
    state: "complete",
  };
}

const CREATE_REQUEST = { mode: "create-new", project: "P", summary: "s" } as const;

// ---- Xray JSON (append) ----

describe("buildXrayJsonPayload", () => {
  it("produces a byte-stable append payload for a reference artifact (outline, flaky, iterations)", () => {
    const results: PublishableResult[] = [
      pub(ref("f", 1, "a"), "CALC-1", { outcome: "passed", durationMs: 1000 }),
      pub(ref("f", 2, "b"), "CALC-2", { outcome: "passed", durationMs: 2000, flaky: true, attempts: 3 }),
      pub(ref("f", 3, "c"), "CALC-3", { outcome: "failed", durationMs: 3000 }),
      pub(ref("f", 4, "d", "outline"), "CALC-4", {
        outcome: "passed",
        durationMs: 4000,
        iterations: [
          { name: "Example #1", outcome: "passed", durationMs: 1500, attempts: 1 },
          { name: "Example #2", outcome: "failed", durationMs: 2500, attempts: 1 },
        ],
      }),
    ];
    const payload = buildXrayJsonPayload({ artifact: refArtifact(), results, request: { mode: "append", executionKey: "XNP-100" } });

    expect(JSON.stringify(payload)).toBe(
      '{"testExecutionKey":"XNP-100","info":{"startDate":"2026-07-22T12:00:00.000Z","finishDate":"2026-07-22T12:00:10.000Z"},' +
        '"tests":[{"testKey":"CALC-1","status":"PASSED"},' +
        '{"testKey":"CALC-2","status":"PASSED","comment":"passed on retry (3 attempts)"},' +
        '{"testKey":"CALC-3","status":"FAILED"},' +
        '{"testKey":"CALC-4","status":"PASSED","iterations":[' +
        '{"name":"Example #1","status":"PASSED","duration":"1500"},' +
        '{"name":"Example #2","status":"FAILED","duration":"2500"}]}]}'
    );
  });

  const STATUS_CASES: ReadonlyArray<readonly [RunArtifactOutcome, string]> = [
    ["passed", "PASSED"],
    ["failed", "FAILED"],
    ["timed-out", "FAILED"],
    ["interrupted", "ABORTED"],
    ["skipped", "TODO"],
  ];
  it.each(STATUS_CASES)("maps run outcome %s to Xray status %s", (outcome, status) => {
    const payload = buildXrayJsonPayload({
      artifact: refArtifact(),
      results: [pub(ref("f", 1, "a"), "C-1", { outcome })],
      request: { mode: "append", executionKey: "X-1" },
    });
    expect(payload.tests[0]!.status).toBe(status);
  });

  it("adds the flaky retry comment only for flaky results", () => {
    const payload = buildXrayJsonPayload({
      artifact: refArtifact(),
      results: [pub(ref("f", 1, "a"), "C-1", { flaky: true, attempts: 3 }), pub(ref("f", 2, "b"), "C-2")],
      request: { mode: "append", executionKey: "X-1" },
    });
    expect(payload.tests[0]!.comment).toBe("passed on retry (3 attempts)");
    expect(payload.tests[1]!.comment).toBeUndefined();
  });

  it("emits iterations only for outline results and a plain status otherwise (mutually exclusive)", () => {
    const payload = buildXrayJsonPayload({
      artifact: refArtifact(),
      results: [
        pub(ref("f", 1, "plain"), "C-1"),
        pub(ref("f", 2, "outline", "outline"), "C-2", {
          iterations: [
            { name: "row1", outcome: "passed", durationMs: 100, attempts: 1 },
            { name: "row2", outcome: "failed", durationMs: 200, attempts: 1 },
          ],
        }),
      ],
      request: { mode: "append", executionKey: "X-1" },
    });
    expect(payload.tests[0]!.iterations).toBeUndefined();
    expect(payload.tests[1]!.iterations).toEqual([
      { name: "row1", status: "PASSED", duration: "100" },
      { name: "row2", status: "FAILED", duration: "200" },
    ]);
  });

  it("places testExecutionKey at the top level (not inside info or tests)", () => {
    const payload = buildXrayJsonPayload({
      artifact: refArtifact(),
      results: [pub(ref("f", 1, "a"), "C-1")],
      request: { mode: "append", executionKey: "XNP-1" },
    });
    expect(Object.keys(payload)).toEqual(["testExecutionKey", "info", "tests"]);
    expect(payload.testExecutionKey).toBe("XNP-1");
    expect(JSON.stringify(payload.info)).not.toContain("XNP-1");
  });

  it("derives finishDate as startDate plus the summed publishable durations", () => {
    const payload = buildXrayJsonPayload({
      artifact: refArtifact(),
      results: [pub(ref("f", 1, "a"), "C-1", { durationMs: 2500 }), pub(ref("f", 2, "b"), "C-2", { durationMs: 500 })],
      request: { mode: "append", executionKey: "X-1" },
    });
    expect(payload.info.startDate).toBe("2026-07-22T12:00:00.000Z");
    expect(payload.info.finishDate).toBe("2026-07-22T12:00:03.000Z");
  });
});

// ---- Cucumber multipart (create) ----

const CUCUMBER_RESULTS: PublishableResult[] = [
  pub(ref("features/calc.feature", 3, "Add two numbers"), "CALC-1", { outcome: "passed", durationMs: 1500 }),
  pub(ref("features/calc.feature", 8, "Subtract"), "CALC-2", { outcome: "failed", durationMs: 2000 }),
  pub(ref("features/math.feature", 3, "Divide", "outline"), "CALC-3", {
    outcome: "passed",
    durationMs: 3000,
    iterations: [
      { name: "1/1", outcome: "passed", durationMs: 1000, attempts: 1 },
      { name: "4/2", outcome: "skipped", durationMs: 0, attempts: 1 },
    ],
  }),
];

const CUCUMBER_RESOLVER: StepResolver = (scenario) => {
  switch (scenario.name) {
    case "Add two numbers":
      return { featureName: "Calculator", steps: ["Given the calculator is on", "When I add 2 and 3", "Then the result is 5"] };
    case "Subtract":
      return { featureName: "Calculator", steps: ["Given the calculator is on", "When I subtract 3 from 5", "Then the result is 2"] };
    case "Divide":
      return { featureName: "Math", steps: ["Given a dividend", "When I divide", "Then I get a quotient"] };
    default:
      return undefined;
  }
};

const EXPECTED_CUCUMBER_INFO = {
  fields: { project: { key: "CALC" }, summary: "Specwright run" },
  xrayFields: { testPlanKey: "CALC-100", environments: ["Chrome", "Windows"] },
};

const EXPECTED_CUCUMBER_RESULTS = [
  {
    uri: "features/calc.feature",
    keyword: "Feature",
    name: "Calculator",
    elements: [
      {
        keyword: "Scenario",
        type: "scenario",
        name: "Add two numbers",
        tags: [{ name: "@TEST_CALC-1" }],
        steps: [
          { keyword: "Given ", name: "the calculator is on", result: { status: "passed", duration: 1_500_000_000 } },
          { keyword: "When ", name: "I add 2 and 3", result: { status: "passed", duration: 0 } },
          { keyword: "Then ", name: "the result is 5", result: { status: "passed", duration: 0 } },
        ],
      },
      {
        keyword: "Scenario",
        type: "scenario",
        name: "Subtract",
        tags: [{ name: "@TEST_CALC-2" }],
        steps: [
          { keyword: "Given ", name: "the calculator is on", result: { status: "failed" } },
          { keyword: "When ", name: "I subtract 3 from 5", result: { status: "skipped" } },
          { keyword: "Then ", name: "the result is 2", result: { status: "skipped" } },
        ],
      },
    ],
  },
  {
    uri: "features/math.feature",
    keyword: "Feature",
    name: "Math",
    elements: [
      {
        keyword: "Scenario",
        type: "scenario",
        name: "Divide — 1/1",
        tags: [{ name: "@TEST_CALC-3" }],
        steps: [
          { keyword: "Given ", name: "a dividend", result: { status: "passed", duration: 1_000_000_000 } },
          { keyword: "When ", name: "I divide", result: { status: "passed", duration: 0 } },
          { keyword: "Then ", name: "I get a quotient", result: { status: "passed", duration: 0 } },
        ],
      },
      {
        keyword: "Scenario",
        type: "scenario",
        name: "Divide — 4/2",
        tags: [{ name: "@TEST_CALC-3" }],
        steps: [
          { keyword: "Given ", name: "a dividend", result: { status: "skipped" } },
          { keyword: "When ", name: "I divide", result: { status: "skipped" } },
          { keyword: "Then ", name: "I get a quotient", result: { status: "skipped" } },
        ],
      },
    ],
  },
];

describe("buildCucumberMultipartPayload", () => {
  it("produces byte-stable results + info for a reference artifact (grouping, tags, steps, outline)", () => {
    const payload = buildCucumberMultipartPayload({
      artifact: refArtifact(),
      results: CUCUMBER_RESULTS,
      request: { mode: "create-new", project: "CALC", summary: "Specwright run", testPlanKey: "CALC-100", environments: ["Chrome", "Windows"] },
      resolveSteps: CUCUMBER_RESOLVER,
    });

    expect(payload.results).toEqual(EXPECTED_CUCUMBER_RESULTS);
    expect(payload.info).toEqual(EXPECTED_CUCUMBER_INFO);
    expect(payload.droppedChangedCount).toBe(0);
    // Byte-order pin: the expected objects carry the intended key order, so serialized equality proves it.
    expect(JSON.stringify(payload.results)).toBe(JSON.stringify(EXPECTED_CUCUMBER_RESULTS));
    expect(JSON.stringify(payload.info)).toBe(JSON.stringify(EXPECTED_CUCUMBER_INFO));
  });

  it("groups scenarios into one feature per source file and forward-slashes the uri", () => {
    const payload = buildCucumberMultipartPayload({
      artifact: refArtifact(),
      results: [
        pub(ref("features\\calc.feature", 3, "A"), "C-1"),
        pub(ref("features\\calc.feature", 8, "B"), "C-2"),
        pub(ref("features/math.feature", 3, "C"), "C-3"),
      ],
      request: CREATE_REQUEST,
      resolveSteps: () => ({ steps: ["Given x"] }),
    });
    expect(payload.results.map((f) => f.uri)).toEqual(["features/calc.feature", "features/math.feature"]);
    expect(payload.results[0]!.elements.map((e) => e.name)).toEqual(["A", "B"]);
  });

  it("puts the whole-scenario duration (ms→ns) on the first passed step, 0 on the rest", () => {
    const payload = buildCucumberMultipartPayload({
      artifact: refArtifact(),
      results: [pub(ref("f", 1, "a"), "C-1", { outcome: "passed", durationMs: 1500 })],
      request: CREATE_REQUEST,
      resolveSteps: () => ({ steps: ["Given a", "When b", "Then c"] }),
    });
    const steps = payload.results[0]!.elements[0]!.steps;
    expect(steps.map((s) => s.result.status)).toEqual(["passed", "passed", "passed"]);
    expect(steps.map((s) => s.result.duration)).toEqual([1_500_000_000, 0, 0]);
  });

  it("maps a timed-out scenario like a failure (first step failed, rest skipped, no duration)", () => {
    const payload = buildCucumberMultipartPayload({
      artifact: refArtifact(),
      results: [pub(ref("f", 1, "a"), "C-1", { outcome: "timed-out", durationMs: 999 })],
      request: CREATE_REQUEST,
      resolveSteps: () => ({ steps: ["Given a", "When b", "Then c"] }),
    });
    const steps = payload.results[0]!.elements[0]!.steps;
    expect(steps.map((s) => s.result.status)).toEqual(["failed", "skipped", "skipped"]);
    expect(steps.every((s) => s.result.duration === undefined)).toBe(true);
  });

  it("maps an interrupted scenario to all steps skipped", () => {
    const payload = buildCucumberMultipartPayload({
      artifact: refArtifact(),
      results: [pub(ref("f", 1, "a"), "C-1", { outcome: "interrupted" })],
      request: CREATE_REQUEST,
      resolveSteps: () => ({ steps: ["Given a", "When b"] }),
    });
    expect(payload.results[0]!.elements[0]!.steps.map((s) => s.result.status)).toEqual(["skipped", "skipped"]);
  });

  it("splits the Gherkin keyword from the step name (And/But/* and unknown handled)", () => {
    const payload = buildCucumberMultipartPayload({
      artifact: refArtifact(),
      results: [pub(ref("f", 1, "a"), "C-1")],
      request: CREATE_REQUEST,
      resolveSteps: () => ({ steps: ["And also this", "But not that", "* a bullet", "no keyword here"] }),
    });
    expect(payload.results[0]!.elements[0]!.steps.map((s) => ({ keyword: s.keyword, name: s.name }))).toEqual([
      { keyword: "And ", name: "also this" },
      { keyword: "But ", name: "not that" },
      { keyword: "* ", name: "a bullet" },
      { keyword: "", name: "no keyword here" },
    ]);
  });

  it("emits one element per iteration for an outline, iteration name suffixed, same tags", () => {
    const payload = buildCucumberMultipartPayload({
      artifact: refArtifact(),
      results: [
        pub(ref("f", 1, "Divide", "outline"), "C-9", {
          iterations: [
            { name: "1/1", outcome: "passed", durationMs: 10, attempts: 1 },
            { name: "4/2", outcome: "failed", durationMs: 20, attempts: 1 },
          ],
        }),
      ],
      request: CREATE_REQUEST,
      resolveSteps: () => ({ steps: ["Given x"] }),
    });
    const elements = payload.results[0]!.elements;
    expect(elements.map((e) => e.name)).toEqual(["Divide — 1/1", "Divide — 4/2"]);
    expect(elements.every((e) => e.tags[0]!.name === "@TEST_C-9")).toBe(true);
    expect(elements[0]!.steps[0]!.result.status).toBe("passed");
    expect(elements[1]!.steps[0]!.result.status).toBe("failed");
  });

  it("drops a publishable scenario that no longer resolves in current source and counts it", () => {
    const payload = buildCucumberMultipartPayload({
      artifact: refArtifact(),
      results: [pub(ref("features/calc.feature", 3, "Add"), "CALC-1"), pub(ref("features/calc.feature", 8, "Removed"), "CALC-2")],
      request: CREATE_REQUEST,
      resolveSteps: (scenario) => (scenario.name === "Add" ? { featureName: "Calc", steps: ["Given x"] } : undefined),
    });
    expect(payload.droppedChangedCount).toBe(1);
    const tags = payload.results.flatMap((f) => f.elements.flatMap((e) => e.tags.map((t) => t.name)));
    expect(tags).toEqual(["@TEST_CALC-1"]);
  });

  it("builds info with project/summary fields and the 'environments' xrayFields key (not testEnvironments)", () => {
    const payload = buildCucumberMultipartPayload({
      artifact: refArtifact(),
      results: [pub(ref("f", 1, "a"), "C-1")],
      request: { mode: "create-new", project: "CALC", summary: "My run", testPlanKey: "CALC-9", environments: ["Chrome"] },
      resolveSteps: () => ({ steps: ["Given x"] }),
    });
    expect(payload.info).toEqual({
      fields: { project: { key: "CALC" }, summary: "My run" },
      xrayFields: { testPlanKey: "CALC-9", environments: ["Chrome"] },
    });
    expect(JSON.stringify(payload.info)).not.toContain("testEnvironments");
  });

  it("omits testPlanKey/environments from xrayFields when absent", () => {
    const payload = buildCucumberMultipartPayload({
      artifact: refArtifact(),
      results: [pub(ref("f", 1, "a"), "C-1")],
      request: CREATE_REQUEST,
      resolveSteps: () => ({ steps: ["Given x"] }),
    });
    expect(payload.info.xrayFields).toEqual({});
  });
});

// ---- Evidence embedding ----

describe("evidence embedding", () => {
  it("attaches Xray JSON evidence {data, filename, contentType} to the matching test only", () => {
    const withEvidence = pub(ref("f", 1, "a"), "C-1");
    const bare = pub(ref("f", 2, "b"), "C-2");
    const payload = buildXrayJsonPayload({
      artifact: refArtifact(),
      results: [withEvidence, bare],
      request: { mode: "append", executionKey: "X-1" },
      evidenceFor: (result) => (result === withEvidence ? [SHOT] : []),
    });
    expect(payload.tests[0]!.evidence).toEqual([{ data: "UE5H", filename: "shot.png", contentType: "image/png" }]);
    expect(payload.tests[1]!.evidence).toBeUndefined();
  });

  it("puts cucumber embeddings {data, mime_type} on the first failing step", () => {
    const failing = pub(ref("features/x.feature", 3, "Boom"), "C-1", { outcome: "failed" });
    const payload = buildCucumberMultipartPayload({
      artifact: refArtifact(),
      results: [failing],
      request: CREATE_REQUEST,
      resolveSteps: () => ({ steps: ["Given a", "When b", "Then c"] }),
      evidenceFor: () => [SHOT],
    });
    const steps = payload.results[0]!.elements[0]!.steps;
    expect(steps[0]!.embeddings).toEqual([{ data: "UE5H", mime_type: "image/png" }]);
    expect(steps[1]!.embeddings).toBeUndefined();
    expect(steps[2]!.embeddings).toBeUndefined();
  });

  it("falls back to the first step when a passing scenario carries evidence", () => {
    const passing = pub(ref("features/x.feature", 3, "Ok"), "C-1", { outcome: "passed" });
    const payload = buildCucumberMultipartPayload({
      artifact: refArtifact(),
      results: [passing],
      request: CREATE_REQUEST,
      resolveSteps: () => ({ steps: ["Given a", "When b"] }),
      evidenceFor: () => [SHOT],
    });
    const steps = payload.results[0]!.elements[0]!.steps;
    expect(steps[0]!.embeddings).toEqual([{ data: "UE5H", mime_type: "image/png" }]);
  });
});

// ---- Importer.import() over a fake transport ----

interface JsonCall {
  path: string;
  body: unknown;
}
interface MultipartCall {
  path: string;
  parts: { results: string; info: string };
}

const OK_BODY = { id: "10200", key: "XNP-24", self: "https://x/rest/api/2/issue/10200" };
const OK_RESPONSE: ImportResponse = { status: 200, ok: true, body: OK_BODY };

function recordingTransport(result: ImportResponse = OK_RESPONSE): {
  transport: ImportTransport;
  json: JsonCall[];
  multipart: MultipartCall[];
} {
  const json: JsonCall[] = [];
  const multipart: MultipartCall[] = [];
  const transport: ImportTransport = {
    postJson: (path, body) => {
      json.push({ path, body });
      return Promise.resolve(result);
    },
    postMultipart: (path, parts) => {
      multipart.push({ path, parts });
      return Promise.resolve(result);
    },
  };
  return { transport, json, multipart };
}

describe("CucumberMultipartImporter.import", () => {
  it("posts serialized results+info (only) to the cucumber multipart path and returns id/key/self", async () => {
    const rec = recordingTransport();
    const payload = buildCucumberMultipartPayload({
      artifact: refArtifact(),
      results: CUCUMBER_RESULTS,
      request: { mode: "create-new", project: "CALC", summary: "Specwright run" },
      resolveSteps: CUCUMBER_RESOLVER,
    });

    const outcome = await new CucumberMultipartImporter().import(rec.transport, payload);

    expect(rec.multipart).toHaveLength(1);
    expect(rec.json).toHaveLength(0);
    expect(rec.multipart[0]!.path).toBe("/import/execution/cucumber/multipart");
    expect(Object.keys(rec.multipart[0]!.parts)).toEqual(["results", "info"]);
    expect(JSON.parse(rec.multipart[0]!.parts.results)).toEqual(payload.results);
    expect(JSON.parse(rec.multipart[0]!.parts.info)).toEqual(payload.info);
    expect(outcome).toEqual({ id: "10200", key: "XNP-24", self: "https://x/rest/api/2/issue/10200" });
  });
});

describe("XrayJsonImporter.import", () => {
  it("posts the payload as JSON to /import/execution and returns id/key/self", async () => {
    const rec = recordingTransport();
    const payload = buildXrayJsonPayload({
      artifact: refArtifact(),
      results: [pub(ref("f", 1, "a"), "C-1")],
      request: { mode: "append", executionKey: "XNP-24" },
    });

    const outcome = await new XrayJsonImporter().import(rec.transport, payload);

    expect(rec.json).toHaveLength(1);
    expect(rec.multipart).toHaveLength(0);
    expect(rec.json[0]!.path).toBe("/import/execution");
    expect(rec.json[0]!.body).toBe(payload);
    expect(outcome).toEqual({ id: "10200", key: "XNP-24", self: "https://x/rest/api/2/issue/10200" });
  });
});

// ---- Cross-seam wiring: reconcile → importers ----

function ref2(filePath: string, line: number, name: string): ScenarioRef {
  return { filePath, line, name, kind: "scenario" };
}
function makeResult(scenario: ScenarioRef, over: Partial<RunArtifactResult> = {}): RunArtifactResult {
  return { outcome: "passed", durationMs: 1000, attempts: 1, flaky: false, evidenceRefs: [], ...over, scenario };
}
function artifactWith(results: RunArtifactResult[], preflight: PreflightDecision[]): RunArtifact {
  const selection: BatchSelection = { kind: "all-mapped" };
  return { id: "run-1", createdAt: CREATED_AT, results, shards: [], selection, preflight, state: "complete" };
}

describe("reconcile → importer wiring", () => {
  it("neither importer ever sees an excluded result (the pre-filtered set is the only input)", () => {
    const kept = ref2("features/calc.feature", 3, "Add");
    const excluded = ref2("features/calc.feature", 8, "Sub");
    const artifact = artifactWith(
      [makeResult(kept, { testKey: "CALC-1" }), makeResult(excluded, { testKey: "CALC-2" })],
      [{ scenario: excluded, testKey: "CALC-2", state: "duplicate-mapping", outcome: "exclude" }]
    );
    const reconciled = publishableResults(artifact);

    const cucumber = buildCucumberMultipartPayload({
      artifact,
      results: reconciled.publishable,
      request: CREATE_REQUEST,
      resolveSteps: () => ({ steps: ["Given x"] }),
    });
    const cucumberTags = cucumber.results.flatMap((f) => f.elements.flatMap((e) => e.tags.map((t) => t.name)));
    expect(cucumberTags).toContain("@TEST_CALC-1");
    expect(cucumberTags).not.toContain("@TEST_CALC-2");

    const xray = buildXrayJsonPayload({ artifact, results: reconciled.publishable, request: { mode: "append", executionKey: "X-1" } });
    expect(xray.tests.map((t) => t.testKey)).toEqual(["CALC-1"]);
  });
});

// ---- Import error seam ----

describe("import() error seam", () => {
  it("throws XrayImportError with status + server message on a non-2xx JSON body (Xray JSON)", async () => {
    const rec = recordingTransport({ status: 400, ok: false, body: { error: "No execution results were provided." } });
    const payload = buildXrayJsonPayload({
      artifact: refArtifact(),
      results: [pub(ref("f", 1, "a"), "C-1")],
      request: { mode: "append", executionKey: "X-1" },
    });

    const error = await new XrayJsonImporter().import(rec.transport, payload).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(XrayImportError);
    expect((error as XrayImportError).status).toBe(400);
    expect((error as XrayImportError).serverMessage).toBe("No execution results were provided.");
  });

  it("throws XrayImportError with status + server message on a non-2xx JSON body (Cucumber)", async () => {
    const rec = recordingTransport({ status: 400, ok: false, body: { error: "No execution results were provided." } });
    const payload = buildCucumberMultipartPayload({
      artifact: refArtifact(),
      results: [pub(ref("f", 1, "a"), "C-1")],
      request: CREATE_REQUEST,
      resolveSteps: () => ({ steps: ["Given x"] }),
    });

    const error = await new CucumberMultipartImporter().import(rec.transport, payload).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(XrayImportError);
    expect((error as XrayImportError).status).toBe(400);
    expect((error as XrayImportError).serverMessage).toBe("No execution results were provided.");
  });

  it("throws XrayImportError with status and no server message when the error body is not JSON", async () => {
    const rec = recordingTransport({ status: 500, ok: false, body: "Internal Server Error" });
    const payload = buildXrayJsonPayload({
      artifact: refArtifact(),
      results: [pub(ref("f", 1, "a"), "C-1")],
      request: { mode: "append", executionKey: "X-1" },
    });

    const error = await new XrayJsonImporter().import(rec.transport, payload).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(XrayImportError);
    expect((error as XrayImportError).status).toBe(500);
    expect((error as XrayImportError).serverMessage).toBeUndefined();
  });

  it("coerces a numeric import-response id to a string", async () => {
    const rec = recordingTransport({ status: 200, ok: true, body: { id: 10200, key: "XNP-24" } });
    const payload = buildXrayJsonPayload({
      artifact: refArtifact(),
      results: [pub(ref("f", 1, "a"), "C-1")],
      request: { mode: "append", executionKey: "X-1" },
    });

    const outcome = await new XrayJsonImporter().import(rec.transport, payload);
    expect(outcome.id).toBe("10200");
    expect(outcome.key).toBe("XNP-24");
  });
});

// ---- Empty-payload guard (fails fast before any network call) ----

describe("empty-payload guard", () => {
  it("throws EmptyImportError and posts nothing when every create scenario was dropped", async () => {
    const rec = recordingTransport();
    const payload = buildCucumberMultipartPayload({
      artifact: refArtifact(),
      results: [pub(ref("features/calc.feature", 3, "Gone"), "CALC-1")],
      request: CREATE_REQUEST,
      resolveSteps: () => undefined,
    });
    expect(payload.results).toHaveLength(0);

    const error = await new CucumberMultipartImporter().import(rec.transport, payload).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmptyImportError);
    expect((error as EmptyImportError).message).toContain("match the current feature files");
    expect(rec.multipart).toHaveLength(0);
  });

  it("throws EmptyImportError and posts nothing when the append payload has no tests", async () => {
    const rec = recordingTransport();
    const payload = buildXrayJsonPayload({ artifact: refArtifact(), results: [], request: { mode: "append", executionKey: "X-1" } });
    expect(payload.tests).toHaveLength(0);

    const error = await new XrayJsonImporter().import(rec.transport, payload).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EmptyImportError);
    expect(rec.json).toHaveLength(0);
  });
});

// ---- Cucumber uri relativization ----

describe("buildCucumberMultipartPayload uri", () => {
  it("posix-relativizes an absolute feature path against the provided workspaceRoot", () => {
    const payload = buildCucumberMultipartPayload({
      artifact: refArtifact(),
      results: [pub(ref("/home/me/proj/features/calc.feature", 3, "Add"), "C-1")],
      request: CREATE_REQUEST,
      resolveSteps: () => ({ steps: ["Given x"] }),
      workspaceRootFor: () => "/home/me/proj",
    });
    expect(payload.results[0]!.uri).toBe("features/calc.feature");
  });

  it("falls back to the normalized absolute path when the feature sits outside the workspaceRoot", () => {
    const payload = buildCucumberMultipartPayload({
      artifact: refArtifact(),
      results: [pub(ref("/elsewhere/features/x.feature", 3, "Add"), "C-1")],
      request: CREATE_REQUEST,
      resolveSteps: () => ({ steps: ["Given x"] }),
      workspaceRootFor: () => "/home/me/proj",
    });
    expect(payload.results[0]!.uri).toBe("/elsewhere/features/x.feature");
  });

  it("relativizes each feature against its own owning root in a multi-root batch", () => {
    const payload = buildCucumberMultipartPayload({
      artifact: refArtifact(),
      results: [
        pub(ref("/roots/a/features/calc.feature", 3, "Add"), "C-1"),
        pub(ref("/roots/b/features/math.feature", 3, "Div"), "C-2"),
      ],
      request: CREATE_REQUEST,
      resolveSteps: () => ({ steps: ["Given x"] }),
      workspaceRootFor: (filePath) => (filePath.startsWith("/roots/a/") ? "/roots/a" : "/roots/b"),
    });
    expect(payload.results.map((f) => f.uri)).toEqual(["features/calc.feature", "features/math.feature"]);
  });

  it("forward-slashes but does not relativize when no workspaceRoot is supplied", () => {
    const payload = buildCucumberMultipartPayload({
      artifact: refArtifact(),
      results: [pub(ref("C:\\repo\\features\\calc.feature", 3, "Add"), "C-1")],
      request: CREATE_REQUEST,
      resolveSteps: () => ({ steps: ["Given x"] }),
    });
    expect(payload.results[0]!.uri).toBe("C:/repo/features/calc.feature");
  });
});
