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

  it("tails completed records and maps a generated outline row back to its feature line", async () => {
    watch();
    fs.appendFileSync(reportPath, `${JSON.stringify(beginRecord())}\n`);
    const record = JSON.stringify(testEndRecord());
    fs.appendFileSync(reportPath, record.slice(0, 30));

    await new Promise((resolve) => setTimeout(resolve, 20));
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
});
