import * as fs from "node:fs";
import * as path from "node:path";
import type {
  FullConfig,
  Reporter,
  Suite,
  TestCase,
  TestResult,
} from "@playwright/test/reporter";
import { parseBddSourceData, type BddSourceData } from "../parsers/bdd-file-data-parser";
import { resolveTestStatus, type LogicalTestStatus } from "../core/test-result-status";
import {
  LIVE_REPORT_FILE_ENV,
  type LiveReporterRecord,
  type LiveRunBeginRecord,
  type LiveTestEndRecord,
} from "../core/live-reporter-protocol";

const STATUS_SEVERITY: Record<LogicalTestStatus, number> = {
  passed: 0,
  skipped: 1,
  failed: 2,
};

interface LiveScenarioGroup {
  readonly testIds: Set<string>;
  readonly latestByTestId: Map<string, LiveTestEndRecord>;
  emitted?: LiveTestEndRecord | undefined;
  counted: boolean;
}

function scenarioKey(test: TestCase, source: BddSourceData | undefined): string {
  const line = source?.lineNumbers.get(test.location.line);
  return source && line !== undefined
    ? `${source.featurePath}\0${line}`
    : `${test.location.file}\0${test.location.line}\0${test.title}`;
}

/**
 * Lightweight reporter used by extension-launched Playwright runs.
 *
 * Records go to a private JSONL side channel so test output and terminal reporters cannot
 * interleave with the machine-readable stream. Retry attempts revise the current logical
 * scenario aggregate, while the final JSON reporter remains authoritative after completion.
 */
export class SpecwrightLiveReporter implements Reporter {
  private readonly reportFile = process.env[LIVE_REPORT_FILE_ENV];
  private total = 0;
  private completed = 0;
  private writable = true;
  private readonly groupByTestId = new Map<string, LiveScenarioGroup>();
  private readonly sourceBySpecPath = new Map<string, BddSourceData | undefined>();

  public printsToStdio(): boolean {
    return false;
  }

  public onBegin(config: FullConfig, suite: Suite): void {
    this.groupByTestId.clear();
    this.sourceBySpecPath.clear();
    const groupsByKey = new Map<string, LiveScenarioGroup>();
    const projectDir = config.configFile ? path.dirname(config.configFile) : config.rootDir;
    for (const test of suite.allTests()) {
      const key = scenarioKey(test, this.sourceFor(test.location.file, projectDir));
      let group = groupsByKey.get(key);
      if (!group) {
        group = {
          testIds: new Set(),
          latestByTestId: new Map(),
          counted: false,
        };
        groupsByKey.set(key, group);
      }
      group.testIds.add(test.id);
      this.groupByTestId.set(test.id, group);
    }
    this.total = groupsByKey.size;
    this.completed = 0;
    const record: LiveRunBeginRecord = {
      kind: "run-begin",
      rootDir: config.rootDir,
      ...(config.configFile ? { configFile: config.configFile } : {}),
      total: this.total,
    };
    this.write(record);
  }

  public onTestEnd(test: TestCase, result: TestResult): void {
    const group = this.groupByTestId.get(test.id);
    if (!group) {return;}
    const errorMessage = result.error?.message ?? result.error?.value;
    const errorStack = result.error?.stack;
    const candidate: LiveTestEndRecord = {
      kind: "test-end",
      file: test.location.file,
      line: test.location.line,
      title: test.title,
      titlePath: test.titlePath(),
      status: result.status,
      durationMs: result.duration,
      ...(errorMessage !== undefined ? { errorMessage } : {}),
      ...(errorStack !== undefined ? { errorStack } : {}),
      retry: result.retry,
      retries: test.retries,
      expectedStatus: test.expectedStatus,
      projectName: test.parent.project()?.name ?? "",
      completed: 0,
      total: this.total,
    };
    group.latestByTestId.set(test.id, candidate);
    if (group.latestByTestId.size < group.testIds.size) {return;}

    const aggregate = [...group.latestByTestId.values()].reduce(worseResult);
    if (group.emitted && sameAggregate(group.emitted, aggregate)) {return;}
    group.emitted = aggregate;
    if (!group.counted) {
      group.counted = true;
      this.completed += 1;
    }
    this.write({ ...aggregate, completed: this.completed });
  }

  private sourceFor(specPath: string, projectDir: string): BddSourceData | undefined {
    if (!this.sourceBySpecPath.has(specPath)) {
      let source: BddSourceData | undefined;
      try {
        source = parseBddSourceData(fs.readFileSync(specPath, "utf8"), projectDir);
      } catch {
        source = undefined;
      }
      this.sourceBySpecPath.set(specPath, source);
    }
    return this.sourceBySpecPath.get(specPath);
  }

  private write(record: LiveReporterRecord): void {
    if (!this.reportFile || !this.writable) {return;}
    try {
      fs.appendFileSync(this.reportFile, `${JSON.stringify(record)}\n`, "utf8");
    } catch {
      // A live side channel must never change the Playwright run's result.
      this.writable = false;
    }
  }
}

function worseResult(current: LiveTestEndRecord, candidate: LiveTestEndRecord): LiveTestEndRecord {
  const severity = STATUS_SEVERITY[recordStatus(candidate)] - STATUS_SEVERITY[recordStatus(current)];
  if (severity > 0 || (severity === 0 && candidate.retry > current.retry)) {return candidate;}
  return current;
}

function recordStatus(record: LiveTestEndRecord): LogicalTestStatus {
  return resolveTestStatus(record.status, record.expectedStatus);
}

function sameAggregate(previous: LiveTestEndRecord, current: LiveTestEndRecord): boolean {
  const status = recordStatus(current);
  if (recordStatus(previous) !== status) {return false;}
  if (status !== "failed") {return true;}
  return previous.status === current.status &&
    previous.retry === current.retry &&
    previous.errorMessage === current.errorMessage &&
    previous.errorStack === current.errorStack;
}

export default SpecwrightLiveReporter;
