import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LiveReporterRecord, LiveTestEndRecord } from "../../core/live-reporter-protocol";
import { LIVE_REPORT_FILE_ENV } from "../../core/live-reporter-protocol";
import { DetailBudget } from "../../core/execution-limits";
import { openLiveRunSession, type LiveRunHandle, type LiveRunStatus } from "../../core/live-run-session";
import type { ScenarioResult } from "../../utils/playwright-json-parser";
import type { RunProgress } from "../../core/run-progress";
import type { FullConfig, Suite, TestCase, TestResult } from "@playwright/test/reporter";
import SpecwrightLiveReporter from "../../test-providers/specwright-live-reporter";

describe("openLiveRunSession", () => {
  let root: string;
  let specPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "live-run-session-"));
    specPath = path.join(root, ".features-gen", "sample.feature.spec.js");
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, [
      "// Generated from: features/sample.feature",
      "const bddFileData = [ // bdd-data-start",
      '  {"pwTestLine":7,"pickleLine":4,"steps":[]},',
      "]; // bdd-data-end",
    ].join("\n"));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("carries real reporter retry and end boundaries while optional stage consumers throw", async () => {
    const stages: RunProgress[] = [];
    const results: ScenarioResult[] = [];
    const errors: Error[] = [];
    const handle = openLiveRunSession({
      liveReportPath: path.join(root, "live.jsonl"), reporterPath: "/extension/reporter.js",
      progress: {
        onProgress: (progress) => {stages.push(progress); throw new Error("closed progress UI");},
        onTestEnd: (result) => results.push(result),
      },
      onError: (error) => errors.push(error),
    });
    expect(handle).toBeDefined();
    const previous = process.env[LIVE_REPORT_FILE_ENV];
    process.env[LIVE_REPORT_FILE_ENV] = handle!.env[LIVE_REPORT_FILE_ENV];
    try {
      const reporter = new SpecwrightLiveReporter();
      const test = {
        id: "row", title: "First title", titlePath: () => ["Sample", "First title"],
        location: { file: specPath, line: 7, column: 1 }, retries: 1, expectedStatus: "passed",
        parent: { project: () => ({ name: "chromium" }) },
      } as unknown as TestCase;
      reporter.onBegin({ rootDir: root, configFile: path.join(root, "playwright.config.ts") } as FullConfig,
        { allTests: () => [test] } as Suite);
      reporter.onTestEnd(test, { status: "failed", retry: 0, duration: 1 } as TestResult);
      reporter.onTestBegin(test, { status: "passed", retry: 1, duration: 0 } as TestResult);
      await vi.waitFor(() => expect(stages.at(-1)).toMatchObject({ phase: "running", completed: 1, total: 1, retrying: 1 }));
      reporter.onTestEnd(test, { status: "passed", retry: 1, duration: 2 } as TestResult);
      await vi.waitFor(() => expect(results.at(-1)?.status).toBe("passed"));
      expect(stages.some((stage) => stage.phase === "finishing")).toBe(false);
      reporter.onEnd();
      await vi.waitFor(() => expect(stages.at(-1)).toEqual({ phase: "finishing" }));
      expect(handle!.recoverResults([])).toMatchObject([{ status: "passed", attempts: 2 }]);
      expect(errors).toEqual([]);
    } finally {
      if (previous === undefined) {delete process.env[LIVE_REPORT_FILE_ENV];}
      else {process.env[LIVE_REPORT_FILE_ENV] = previous;}
      handle!.stream.finish();
    }
  });

  it("keeps a zero-case invocation running so exact-target regeneration cannot falsely finish", async () => {
    const stages: RunProgress[] = [];
    const handle = openLiveRunSession({
      liveReportPath: path.join(root, "live.jsonl"), reporterPath: "/extension/reporter.js",
      progress: { onProgress: (stage) => stages.push(stage) }, onError: () => undefined,
    });
    expect(handle).toBeDefined();
    try {
      const file = handle!.env[LIVE_REPORT_FILE_ENV]!;
      fs.appendFileSync(file, [
        JSON.stringify({ kind: "run-begin", rootDir: root, total: 0 }),
        JSON.stringify({ kind: "run-end" }),
      ].join("\n") + "\n");
      await vi.waitFor(() => expect(stages).toHaveLength(1));
      expect(stages).toEqual([{ phase: "running", completed: 0, total: 0, retrying: 0 }]);
      fs.appendFileSync(file, [
        JSON.stringify({ kind: "run-begin", rootDir: root, total: 1 }),
        JSON.stringify({ kind: "run-end" }),
      ].join("\n") + "\n");
      await vi.waitFor(() => expect(stages.at(-1)).toEqual({ phase: "finishing" }));
      expect(stages.filter((stage) => stage.phase === "finishing")).toHaveLength(1);
    } finally {handle!.stream.finish();}
  });

  it("replaces failed counters when the same logical scenario retry passes", () => {
    const statuses: LiveRunStatus[] = [];
    const results: ScenarioResult[] = [];
    const errors: Error[] = [];
    const handle = openLiveRunSession({
      liveReportPath: path.join(root, "live.jsonl"),
      reporterPath: "/extension/specwright-live-reporter.js",
      progress: { onTestEnd: (result) => results.push(result) },
      onStatus: (status) => statuses.push(status),
      onError: (error) => errors.push(error),
    });
    expect(handle).toBeDefined();

    const record = (overrides: Partial<LiveTestEndRecord>): LiveTestEndRecord => ({
      kind: "test-end",
      file: specPath,
      line: 7,
      title: "First title",
      titlePath: ["chromium", "sample.feature.spec.js", "Sample", "First title"],
      status: "failed",
      durationMs: 4,
      retry: 0,
      retries: 1,
      expectedStatus: "passed",
      projectName: "chromium",
      completed: 1,
      total: 1,
      ...overrides,
    });
    const records: LiveReporterRecord[] = [
      {
        kind: "run-begin",
        rootDir: path.dirname(specPath),
        configFile: path.join(root, "playwright.config.ts"),
        total: 1,
      },
      record({}),
      record({ status: "passed", retry: 1 }),
      record({
        status: "failed",
        retry: 0,
        projectName: "firefox",
        titlePath: ["firefox", "sample.feature.spec.js", "Sample", "First title"],
      }),
    ];
    const livePath = handle!.env[LIVE_REPORT_FILE_ENV]!;
    fs.appendFileSync(livePath, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    handle!.stream.finish();

    expect(statuses).toEqual([
      { passed: 0, failed: 0, completed: 0, total: 1 },
      { passed: 0, failed: 1, completed: 1, total: 1 },
      { passed: 1, failed: 0, completed: 1, total: 1 },
      { passed: 0, failed: 1, completed: 1, total: 1 },
    ]);
    expect(results.map((result) => result.status)).toEqual(["failed", "passed", "failed"]);
    expect(handle!.recoverResults([])).toEqual([results[1], results[2]]);
    const chromiumFinal = {
      ...results[1]!,
      featurePath: results[1]!.featurePath.replaceAll("/", "\\"),
    };
    expect(handle!.recoverResults([chromiumFinal])).toEqual([results[2], chromiumFinal]);
    const finalResults = [chromiumFinal, { ...results[2]!, status: "passed" as const }];
    expect(handle!.recoverResults(finalResults)).toEqual(finalResults);
    expect(errors).toEqual([]);
  });

  it("folds a few hundred cases with work linear in the case count", () => {
    // Retention serializes the landing case and its compact twin, nothing else. Re-serializing or
    // re-walking what is already retained would square this count.
    const stringify = vi.spyOn(JSON, "stringify");
    const statuses: LiveRunStatus[] = [];
    const handle = openLiveRunSession({
      liveReportPath: path.join(root, "live.jsonl"),
      reporterPath: "/extension/specwright-live-reporter.js",
      progress: {},
      onStatus: (status) => statuses.push(status),
      onError: () => {},
    });
    const cases = 300;
    const records: LiveReporterRecord[] = [
      {
        kind: "run-begin",
        rootDir: path.dirname(specPath),
        configFile: path.join(root, "playwright.config.ts"),
        total: cases,
      },
      ...Array.from({ length: cases }, (_, index): LiveTestEndRecord => ({
        kind: "test-end",
        file: specPath,
        line: 7,
        title: `Scenario ${index}`,
        titlePath: ["chromium", "sample.feature.spec.js", "Sample", `Scenario ${index}`],
        status: index % 10 === 0 ? "failed" : "passed",
        durationMs: 1,
        retry: 0,
        retries: 0,
        expectedStatus: "passed",
        projectName: "chromium",
        completed: index + 1,
        total: cases,
      })),
    ];
    const payload = `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`;
    const baseline = stringify.mock.calls.length;
    fs.appendFileSync(handle!.env[LIVE_REPORT_FILE_ENV]!, payload);

    handle!.stream.finish();

    expect(statuses.at(-1)).toEqual({ passed: 270, failed: 30, completed: cases, total: cases });
    expect(stringify.mock.calls.length - baseline).toBeLessThanOrEqual(3 * cases);
    stringify.mockRestore();
  });

  it("retains every case while dropping the bulky payload past the per-run budget", () => {
    const errors: Error[] = [];
    const handle = openLiveRunSession({
      liveReportPath: path.join(root, "live.jsonl"),
      reporterPath: "/extension/specwright-live-reporter.js",
      progress: {},
      onStatus: () => {},
      onError: (error) => errors.push(error),
    });
    const cases = 200;
    const stack = "at step (/ws/steps.ts:1:1)\n".repeat(2000);
    const records: LiveReporterRecord[] = [
      {
        kind: "run-begin",
        rootDir: path.dirname(specPath),
        configFile: path.join(root, "playwright.config.ts"),
        total: cases,
      },
      ...Array.from({ length: cases }, (_, index): LiveTestEndRecord => ({
        kind: "test-end",
        file: specPath,
        line: 7,
        title: `Scenario ${index}`,
        titlePath: ["chromium", "sample.feature.spec.js", "Sample", `Scenario ${index}`],
        status: "failed",
        durationMs: 4,
        retry: 0,
        retries: 0,
        expectedStatus: "passed",
        projectName: "chromium",
        errorMessage: "expected true",
        errorStack: stack,
        completed: index + 1,
        total: cases,
      })),
    ];
    fs.appendFileSync(
      handle!.env[LIVE_REPORT_FILE_ENV]!,
      `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`
    );
    handle!.stream.finish();

    const recovered = handle!.recoverResults([]);
    expect(recovered).toHaveLength(cases);
    expect(recovered.every((result) => result.status === "failed")).toBe(true);
    expect(recovered.every((result) => result.errorMessage?.startsWith("expected true"))).toBe(true);
    expect(recovered.filter((result) => result.errorStack !== undefined).length)
      .toBeLessThan(cases);
    expect(errors).toEqual([]);
  });

  it("spends one detail budget across every session a run opens", () => {
    // Sized so the first case fits and a second copy cannot: with a budget per session instead of
    // per run, the second invocation would retain its stack too.
    const stack = "at step (/ws/steps.ts:1:1)\n".repeat(150);
    const budget = new DetailBudget(6000);
    const errors: Error[] = [];
    const openSession = (name: string): LiveRunHandle => {
      const handle = openLiveRunSession({
        liveReportPath: path.join(root, `${name}.jsonl`),
        reporterPath: "/extension/specwright-live-reporter.js",
        progress: {},
        detailBudget: budget,
        onStatus: () => {},
        onError: (error) => errors.push(error),
      });
      expect(handle).toBeDefined();
      return handle!;
    };
    const report = (handle: LiveRunHandle, title: string): void => {
      const records: LiveReporterRecord[] = [
        {
          kind: "run-begin",
          rootDir: path.dirname(specPath),
          configFile: path.join(root, "playwright.config.ts"),
          total: 1,
        },
        {
          kind: "test-end",
          file: specPath,
          line: 7,
          title,
          titlePath: ["chromium", "sample.feature.spec.js", "Sample", title],
          status: "failed",
          durationMs: 4,
          retry: 0,
          retries: 0,
          expectedStatus: "passed",
          projectName: "chromium",
          errorMessage: "expected true",
          errorStack: stack,
          completed: 1,
          total: 1,
        },
      ];
      fs.appendFileSync(
        handle.env[LIVE_REPORT_FILE_ENV]!,
        `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`
      );
      handle.stream.finish();
    };
    const first = openSession("first");
    const second = openSession("second");

    report(first, "First case");
    report(second, "Second case");

    expect(first.recoverResults([])[0]?.errorStack).toBe(stack);
    expect(second.recoverResults([])[0]).toMatchObject({
      scenarioName: "Second case",
      status: "failed",
      errorMessage: "expected true",
    });
    expect(second.recoverResults([])[0]?.errorStack).toBeUndefined();
    expect(errors).toEqual([]);
  });
});
