import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type {
  FullConfig,
  FullProject,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  LIVE_REPORT_FILE_ENV,
  type LiveReporterRecord,
} from "../../core/live-reporter-protocol";
import SpecwrightLiveReporter from "../../test-providers/specwright-live-reporter";

function config(overrides: Partial<FullConfig> = {}): FullConfig {
  return {
    rootDir: "/repo/.features-gen",
    configFile: "/repo/playwright.config.ts",
    ...overrides,
  } as FullConfig;
}

function suite(tests: TestCase[]): Suite {
  return { allTests: () => tests } as Suite;
}

function testCase(overrides: Partial<TestCase> = {}): TestCase {
  const project = { name: "chromium" } as FullProject;
  return {
    id: "chromium-test",
    title: "logs in",
    titlePath: () => ["chromium", "login.feature.spec.ts", "Login", "logs in"],
    location: { file: "/repo/.features-gen/login.feature.spec.ts", line: 17, column: 1 },
    retries: 0,
    expectedStatus: "passed",
    parent: { project: () => project } as Suite,
    ...overrides,
  } as TestCase;
}

function testResult(overrides: Partial<TestResult> = {}): TestResult {
  return {
    status: "passed",
    duration: 42,
    retry: 0,
    ...overrides,
  } as TestResult;
}

describe("SpecwrightLiveReporter", () => {
  let tempDir: string;
  let reportFile: string;
  let previousReportFile: string | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "specwright-live-reporter-"));
    reportFile = path.join(tempDir, "events.jsonl");
    previousReportFile = process.env[LIVE_REPORT_FILE_ENV];
    process.env[LIVE_REPORT_FILE_ENV] = reportFile;
  });

  afterEach(() => {
    if (previousReportFile === undefined) {
      delete process.env[LIVE_REPORT_FILE_ENV];
    } else {
      process.env[LIVE_REPORT_FILE_ENV] = previousReportFile;
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function records(): LiveReporterRecord[] {
    return fs
      .readFileSync(reportFile, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as LiveReporterRecord);
  }

  it("writes run metadata followed by one terminal test result", () => {
    const test = testCase();
    const reporter = new SpecwrightLiveReporter();

    reporter.onBegin(config(), suite([test]));
    reporter.onTestEnd(test, testResult());

    expect(records()).toEqual([
      {
        kind: "run-begin",
        rootDir: "/repo/.features-gen",
        configFile: "/repo/playwright.config.ts",
        total: 1,
      },
      {
        kind: "test-end",
        file: "/repo/.features-gen/login.feature.spec.ts",
        line: 17,
        title: "logs in",
        titlePath: ["chromium", "login.feature.spec.ts", "Login", "logs in"],
        status: "passed",
        durationMs: 42,
        retry: 0,
        retries: 0,
        expectedStatus: "passed",
        projectName: "chromium",
        completed: 1,
        total: 1,
      },
    ]);
  });

  it("revises a failed attempt when its retry passes", () => {
    const test = testCase({ retries: 1 });
    const reporter = new SpecwrightLiveReporter();
    reporter.onBegin(config(), suite([test]));

    reporter.onTestEnd(test, testResult({ status: "failed", retry: 0 }));
    reporter.onTestEnd(test, testResult({ status: "passed", retry: 1, duration: 8 }));

    expect(records()).toHaveLength(3);
    expect(records()[1]).toMatchObject({
      kind: "test-end",
      status: "failed",
      retry: 0,
      completed: 1,
      total: 1,
    });
    expect(records()[2]).toMatchObject({
      kind: "test-end",
      status: "passed",
      retry: 1,
      completed: 1,
      total: 1,
    });
  });

  it("emits an exhausted retry with its error", () => {
    const test = testCase({ retries: 1 });
    const reporter = new SpecwrightLiveReporter();
    reporter.onBegin(config(), suite([test]));

    const error = {
      message: "expected dashboard",
      stack: "Error: expected dashboard\n    at login.steps.ts:4:2",
    };
    reporter.onTestEnd(test, testResult({ status: "failed", retry: 0, error }));
    reporter.onTestEnd(test, testResult({
      status: "failed",
      retry: 1,
      duration: 80,
      error,
    }));

    expect(records()).toHaveLength(3);
    expect(records().at(-1)).toMatchObject({
      kind: "test-end",
      status: "failed",
      errorMessage: "expected dashboard",
      errorStack: "Error: expected dashboard\n    at login.steps.ts:4:2",
      retry: 1,
      retries: 1,
      durationMs: 80,
    });
  });

  it("emits an interrupted attempt immediately even when retry budget remains", () => {
    const test = testCase({ retries: 2 });
    const reporter = new SpecwrightLiveReporter();
    reporter.onBegin(config(), suite([test]));

    reporter.onTestEnd(test, testResult({ status: "interrupted" }));

    expect(records()[1]).toMatchObject({
      kind: "test-end",
      status: "interrupted",
      completed: 1,
    });
  });

  it("publishes a failed attempt without predicting whether Playwright will retry it", () => {
    const test = testCase({ retries: 1 });
    const reporter = new SpecwrightLiveReporter();
    reporter.onBegin(config(), suite([test]));

    reporter.onTestEnd(test, testResult({ status: "failed" }));
    expect(records()[1]).toMatchObject({
      kind: "test-end",
      status: "failed",
      completed: 1,
    });
  });

  it("waits for every project before emitting one scenario result", () => {
    const chromium = testCase();
    const firefox = testCase({
      id: "firefox-test",
      parent: { project: () => ({ name: "firefox" } as FullProject) } as Suite,
    });
    const reporter = new SpecwrightLiveReporter();
    reporter.onBegin(config(), suite([chromium, firefox]));

    reporter.onTestEnd(chromium, testResult({ status: "passed" }));
    expect(records()).toHaveLength(1);

    reporter.onTestEnd(firefox, testResult({
      status: "failed",
      error: { message: "firefox failed" },
    }));
    expect(records()[1]).toMatchObject({
      kind: "test-end",
      status: "failed",
      errorMessage: "firefox failed",
      completed: 1,
      total: 1,
    });
  });

  it("aggregates projects by actual versus expected outcome", () => {
    const expectedFailure = testCase({ expectedStatus: "failed" });
    const unexpectedPass = testCase({
      id: "firefox-test",
      expectedStatus: "failed",
      retries: 1,
      parent: { project: () => ({ name: "firefox" } as FullProject) } as Suite,
    });
    const reporter = new SpecwrightLiveReporter();
    reporter.onBegin(config(), suite([expectedFailure, unexpectedPass]));

    reporter.onTestEnd(expectedFailure, testResult({ status: "failed" }));
    reporter.onTestEnd(unexpectedPass, testResult({ status: "passed" }));
    reporter.onTestEnd(unexpectedPass, testResult({ status: "passed", retry: 1 }));

    expect(records().at(-1)).toMatchObject({
      status: "passed",
      expectedStatus: "failed",
      projectName: "firefox",
      retry: 1,
      completed: 1,
    });
  });

  it("recomputes the project aggregate after a retry", () => {
    const chromium = testCase({ retries: 1 });
    const firefox = testCase({
      id: "firefox-test",
      parent: { project: () => ({ name: "firefox" } as FullProject) } as Suite,
    });
    const reporter = new SpecwrightLiveReporter();
    reporter.onBegin(config(), suite([chromium, firefox]));

    reporter.onTestEnd(chromium, testResult({ status: "failed" }));
    reporter.onTestEnd(firefox, testResult({ status: "passed" }));
    reporter.onTestEnd(chromium, testResult({ status: "passed", retry: 1 }));

    expect(records().slice(1).map((record) => ({
      kind: record.kind,
      status: record.kind === "test-end" ? record.status : undefined,
      completed: record.kind === "test-end" ? record.completed : undefined,
    }))).toEqual([
      { kind: "test-end", status: "failed", completed: 1 },
      { kind: "test-end", status: "passed", completed: 1 },
    ]);
  });

  it("groups named BDD project copies by their source feature location", () => {
    const projectConfig = config({
      rootDir: path.join(tempDir, ".features-gen"),
      configFile: path.join(tempDir, "playwright.config.ts"),
    });
    const chromiumPath = path.join(
      tempDir,
      ".features-gen",
      "chromium",
      "features",
      "login.feature.spec.ts"
    );
    const firefoxPath = path.join(
      tempDir,
      ".features-gen",
      "firefox",
      "features",
      "login.feature.spec.ts"
    );
    const writeSpec = (specPath: string, pwTestLine: number): void => {
      fs.mkdirSync(path.dirname(specPath), { recursive: true });
      fs.writeFileSync(specPath, [
        "// Generated from: features/login.feature",
        "const bddFileData = [ // bdd-data-start",
        `  {"pwTestLine":${pwTestLine},"pickleLine":4,"steps":[]},`,
        "]; // bdd-data-end",
      ].join("\n"));
    };
    writeSpec(chromiumPath, 17);
    writeSpec(firefoxPath, 29);
    const chromium = testCase({ location: { file: chromiumPath, line: 17, column: 1 } });
    const firefox = testCase({
      id: "firefox-test",
      location: { file: firefoxPath, line: 29, column: 1 },
      parent: { project: () => ({ name: "firefox" } as FullProject) } as Suite,
    });
    const reporter = new SpecwrightLiveReporter();

    reporter.onBegin(projectConfig, suite([chromium, firefox]));
    reporter.onTestEnd(chromium, testResult());
    reporter.onTestEnd(firefox, testResult());

    expect(records()[0]).toMatchObject({ kind: "run-begin", total: 1 });
    expect(records()).toHaveLength(2);
    expect(records()[1]).toMatchObject({ kind: "test-end", completed: 1, total: 1 });
  });

  it("keeps distinct source scenario lines as separate logical results", () => {
    const specPath = path.join(tempDir, ".features-gen", "login.feature.spec.ts");
    fs.mkdirSync(path.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, [
      "// Generated from: features/login.feature",
      "const bddFileData = [ // bdd-data-start",
      '  {"pwTestLine":17,"pickleLine":4,"steps":[]},',
      '  {"pwTestLine":29,"pickleLine":9,"steps":[]},',
      "]; // bdd-data-end",
    ].join("\n"));
    const first = testCase({ location: { file: specPath, line: 17, column: 1 } });
    const second = testCase({
      id: "second-test",
      location: { file: specPath, line: 29, column: 1 },
    });
    const reporter = new SpecwrightLiveReporter();

    reporter.onBegin(config({
      rootDir: path.dirname(specPath),
      configFile: path.join(tempDir, "playwright.config.ts"),
    }), suite([first, second]));

    expect(records()[0]).toMatchObject({ kind: "run-begin", total: 2 });
  });

  it("does not count a serial-suite peer again when Playwright reruns it", () => {
    const test = testCase({ retries: 1 });
    const reporter = new SpecwrightLiveReporter();
    reporter.onBegin(config(), suite([test]));

    reporter.onTestEnd(test, testResult({ status: "passed", retry: 0 }));
    reporter.onTestEnd(test, testResult({ status: "passed", retry: 1 }));

    expect(records()).toHaveLength(2);
    expect(records()[1]).toMatchObject({ completed: 1, total: 1 });
  });

  it("does nothing when no report file is configured", () => {
    delete process.env[LIVE_REPORT_FILE_ENV];
    const reporter = new SpecwrightLiveReporter();
    const test = testCase();

    expect(() => {
      reporter.onBegin(config(), suite([test]));
      reporter.onTestEnd(test, testResult());
    }).not.toThrow();
    expect(fs.existsSync(reportFile)).toBe(false);
  });

  it("swallows report-file write failures", () => {
    process.env[LIVE_REPORT_FILE_ENV] = path.join(tempDir, "missing", "events.jsonl");
    const reporter = new SpecwrightLiveReporter();
    const test = testCase();

    expect(() => {
      reporter.onBegin(config(), suite([test]));
      reporter.onTestEnd(test, testResult());
    }).not.toThrow();
  });
});
