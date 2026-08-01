import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { LiveReporterRecord, LiveTestEndRecord } from "../../core/live-reporter-protocol";
import { LIVE_REPORT_FILE_ENV } from "../../core/live-reporter-protocol";
import { openLiveRunSession, type LiveRunStatus } from "../../core/live-run-session";
import type { ScenarioResult } from "../../utils/playwright-json-parser";

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
      record({ status: "passed", title: "Revised title", retry: 1 }),
    ];
    const livePath = handle!.env[LIVE_REPORT_FILE_ENV]!;
    fs.appendFileSync(livePath, `${records.map((entry) => JSON.stringify(entry)).join("\n")}\n`);

    handle!.stream.finish();

    expect(statuses).toEqual([
      { passed: 0, failed: 0, completed: 0, total: 1 },
      { passed: 0, failed: 1, completed: 1, total: 1 },
      { passed: 1, failed: 0, completed: 1, total: 1 },
    ]);
    expect(results.map((result) => result.status)).toEqual(["failed", "passed"]);
    expect(errors).toEqual([]);
  });
});
