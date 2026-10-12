import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { LiveRunStream } from "../../core/live-run-stream";
import type {
  LiveRunBeginRecord,
  LiveTestEndRecord,
} from "../../core/live-reporter-protocol";
import type { ScenarioResult } from "../../utils/playwright-json-parser";

describe("LiveRunStream", () => {
  let root: string;
  let reportPath: string;
  let specPath: string;
  let stream: LiveRunStream | undefined;
  let began: LiveRunBeginRecord[];
  let ended: Array<{ result: ScenarioResult; record: LiveTestEndRecord }>;
  let malformed: string[];

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "live-run-stream-"));
    reportPath = path.join(root, "events.jsonl");
    specPath = path.join(root, ".features-gen", "features", "math.feature.spec.js");
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, [
      "// Generated from: features/math.feature",
      "const bddFileData = [ // bdd-data-start",
      '  {"pwTestLine":18,"pickleLine":12,"steps":[]},',
      "]; // bdd-data-end",
    ].join("\n"));
    fs.writeFileSync(reportPath, "");
    began = [];
    ended = [];
    malformed = [];
  });

  afterEach(() => {
    stream?.finish();
    fs.rmSync(root, { recursive: true, force: true });
  });

  function beginRecord(): LiveRunBeginRecord {
    return {
      kind: "run-begin",
      rootDir: path.dirname(specPath),
      configFile: path.join(root, "playwright.config.ts"),
      total: 1,
    };
  }

  function testEndRecord(overrides: Partial<LiveTestEndRecord> = {}): LiveTestEndRecord {
    return {
      kind: "test-end",
      file: specPath,
      line: 18,
      title: "Example #1",
      titlePath: ["chromium", "math.feature.spec.js", "Math", "Example #1"],
      status: "passed",
      durationMs: 7,
      retry: 0,
      retries: 2,
      expectedStatus: "passed",
      projectName: "chromium",
      completed: 1,
      total: 1,
      ...overrides,
    };
  }

  function watch(): void {
    stream = LiveRunStream.watch(reportPath, {
      onBegin: (record) => began.push(record),
      onTestEnd: (result, record) => ended.push({ result, record }),
      onMalformedLine: (line) => malformed.push(line),
    });
  }

  it("isolates malformed lifecycle records and failing optional progress consumers", () => {
    const progress = vi.fn(() => {throw new Error("closed");});
    const finished = vi.fn();
    const errors = vi.fn();
    fs.writeFileSync(reportPath, [
      JSON.stringify({ kind: "run-progress", retrying: -1 }),
      JSON.stringify({ kind: "run-progress", retrying: 0.5 }),
      JSON.stringify({ kind: "run-progress", retrying: 1, retry: { title: "row", attempt: 0, projectName: "" } }),
      JSON.stringify({ kind: "run-progress", retrying: 1, retry: { title: "row", attempt: 2, projectName: "" } }),
      JSON.stringify(testEndRecord()),
      JSON.stringify({ kind: "run-end" }),
    ].join("\n"));
    stream = LiveRunStream.watch(reportPath, {
      onBegin: () => undefined,
      onTestEnd: (result, record) => ended.push({ result, record }),
      onProgress: progress, onEnd: finished, onError: errors,
      onMalformedLine: (line) => malformed.push(line),
    });
    stream.finish();
    expect(malformed).toHaveLength(3);
    expect(progress).toHaveBeenCalledOnce();
    expect(errors).toHaveBeenCalledOnce();
    expect(ended).toHaveLength(1);
    expect(finished).toHaveBeenCalledOnce();
  });

  it("tails completed records and maps a generated outline row back to its feature line", async () => {
    watch();
    fs.appendFileSync(reportPath, `${JSON.stringify(beginRecord())}\n`);
    const record = JSON.stringify(testEndRecord());
    fs.appendFileSync(reportPath, record.slice(0, 30));

    await vi.waitFor(() => expect(began).toHaveLength(1));
    expect(ended).toEqual([]);

    fs.appendFileSync(reportPath, `${record.slice(30)}\n`);
    await vi.waitFor(() => expect(ended).toHaveLength(1));

    expect(began).toEqual([beginRecord()]);
    expect(ended[0]?.result).toMatchObject({
      featurePath: path.join(root, "features", "math.feature"),
      lineNumber: 12,
      scenarioName: "Example #1",
      status: "passed",
      durationMs: 7,
    });
    expect(malformed).toEqual([]);
  });

  it("isolates a malformed line and continues with the next record", async () => {
    watch();
    fs.appendFileSync(
      reportPath,
      `${JSON.stringify(beginRecord())}\n{not json}\n${JSON.stringify(testEndRecord())}\n`
    );

    await vi.waitFor(() => expect(ended).toHaveLength(1));
    expect(malformed).toEqual(["{not json}"]);
  });

  it("drains a final record without a newline and leaves cleanup to its owner", () => {
    watch();
    fs.appendFileSync(reportPath, `${JSON.stringify(beginRecord())}\n${JSON.stringify(testEndRecord())}`);

    stream!.finish();

    expect(ended).toHaveLength(1);
    expect(fs.existsSync(reportPath)).toBe(true);
  });

  it("falls back to the generated spec path when source metadata cannot be resolved", () => {
    watch();
    fs.appendFileSync(reportPath, `${JSON.stringify(beginRecord())}\n`);
    const record = testEndRecord({ file: path.join(root, "missing.spec.js") });
    fs.appendFileSync(reportPath, JSON.stringify(record));

    stream!.finish();

    expect(ended[0]?.result).toMatchObject({
      featurePath: record.file,
      scenarioName: "Example #1",
      status: "passed",
    });
    expect(ended[0]?.result.lineNumber).toBeUndefined();
  });

  it("collapses terminal Playwright statuses and carries retry detail", () => {
    watch();
    fs.appendFileSync(reportPath, `${JSON.stringify(beginRecord())}\n`);
    fs.appendFileSync(reportPath, JSON.stringify(testEndRecord({
      status: "timedOut",
      errorMessage: "too slow",
      errorStack: "TimeoutError: too slow\n    at math.steps.ts:2:1",
      retry: 2,
      completed: 1,
    })));

    stream!.finish();

    expect(ended[0]?.result).toMatchObject({
      status: "failed",
      outcome: "timed-out",
      errorMessage: "too slow",
      errorStack: "TimeoutError: too slow\n    at math.steps.ts:2:1",
      attempts: 3,
    });
  });

  it("resolves actual results against their expected status", () => {
    watch();
    fs.appendFileSync(reportPath, `${JSON.stringify(beginRecord())}\n`);
    fs.appendFileSync(reportPath, [
      testEndRecord({ status: "failed", expectedStatus: "failed" }),
      testEndRecord({
        status: "passed",
        expectedStatus: "failed",
        retry: 1,
        title: "Unexpected pass",
      }),
    ].map((record) => JSON.stringify(record)).join("\n"));

    stream!.finish();

    expect(ended.map(({ result }) => result.status)).toEqual(["passed", "failed"]);
    expect(ended[1]?.result.flaky).toBeUndefined();
  });

  it("does not let a consumer callback failure stop later records", () => {
    let calls = 0;
    const errors: Error[] = [];
    stream = LiveRunStream.watch(reportPath, {
      onBegin: () => { throw new Error("consumer failed"); },
      onTestEnd: () => { calls += 1; },
      onError: (error) => errors.push(error),
    });
    fs.appendFileSync(
      reportPath,
      `${JSON.stringify(beginRecord())}\n${JSON.stringify(testEndRecord())}`
    );

    stream.finish();

    expect(calls).toBe(1);
    expect(errors.map((error) => error.message)).toEqual(["consumer failed"]);
  });

  it("restarts cleanly when an external writer truncates the report", () => {
    fs.writeFileSync(reportPath, `${JSON.stringify(beginRecord())}\n${JSON.stringify(testEndRecord({ title: "A long initial title" }))}\n`);
    watch();
    expect(ended).toHaveLength(1);
    fs.writeFileSync(reportPath, JSON.stringify(testEndRecord({ title: "New" })));
    stream!.finish();
    expect(ended.map(item => item.result.scenarioName)).toEqual(["A long initial title", "New"]);
  });

  it("ignores blank lines and malformed values while preserving interruption and skip outcomes", () => {
    fs.writeFileSync(reportPath, ["", "   ", "null", "3", JSON.stringify({ kind: "unknown" }),
      JSON.stringify(testEndRecord({ status: "interrupted" })),
      JSON.stringify(testEndRecord({ status: "skipped" })),
      JSON.stringify({ ...testEndRecord(), status: "invalid" }),
    ].join("\n"));
    watch();
    stream!.finish();
    expect(malformed).toHaveLength(4);
    expect(ended.map(item => item.result.status)).toEqual(["failed", "skipped"]);
    expect(ended[0]!.result.outcome).toBe("interrupted");
  });

  it.each([true, false])("resolves relative generated paths with a begin record: %s", includeBegin => {
    const file = includeBegin ? path.basename(specPath) : path.relative(process.cwd(), specPath);
    fs.writeFileSync(reportPath, [
      ...(includeBegin ? [JSON.stringify(beginRecord())] : []),
      JSON.stringify(testEndRecord({ file, line: 999 })),
    ].join("\n"));
    watch();
    stream!.finish();
    expect(ended[0]!.result.featurePath).toBe(includeBegin ? path.join(root, "features", "math.feature") : path.resolve("features/math.feature"));
    expect(ended[0]!.result.lineNumber).toBeUndefined();
  });

  it("normalizes a non-Error consumer failure without losing the next result", () => {
    const errors: Error[] = [];
    stream = LiveRunStream.watch(reportPath, {
      onBegin: () => { throw "closed consumer"; },
      onTestEnd: (result, record) => ended.push({ result, record }),
      onError: error => errors.push(error),
    });
    fs.appendFileSync(reportPath, `${JSON.stringify(beginRecord())}\n${JSON.stringify(testEndRecord())}`);
    stream.finish();
    expect(errors.map(error => error.message)).toEqual(["closed consumer"]);
    expect(ended).toHaveLength(1);
  });
});
