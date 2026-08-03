import * as fs from "node:fs";
import { LIVE_REPORT_FILE_ENV } from "./live-reporter-protocol";
import { LiveRunStream } from "./live-run-stream";
import type { RunProgressObserver } from "./run-progress";
import { DetailBudget } from "./execution-limits";
import { refIdentity, scenarioRefFromResult } from "../traceability/scenario-ref";
import { truncate } from "../utils/text";
import type { ScenarioResult, ScenarioStatus } from "../utils/playwright-json-parser";

export interface LiveRunHandle {
  readonly stream: LiveRunStream;
  readonly env: NodeJS.ProcessEnv;
  recoverResults(finalResults: readonly ScenarioResult[]): ScenarioResult[];
}

export interface LiveRunStatus {
  readonly passed: number;
  readonly failed: number;
  readonly completed: number;
  readonly total: number;
}

interface LiveRunSessionOptions {
  readonly liveReportPath: string;
  readonly reporterPath: string;
  readonly progress: RunProgressObserver;
  readonly signal?: AbortSignal | undefined;
  // Shared by every invocation of one run; absent means this session is the whole run.
  readonly detailBudget?: DetailBudget | undefined;
  readonly onStatus?: ((status: LiveRunStatus) => void) | undefined;
  readonly onError: (error: Error) => void;
}

interface ScenarioStatusState {
  readonly byProject: Map<string, ScenarioStatus>;
  readonly counts: Record<ScenarioStatus, number>;
  status: ScenarioStatus;
}

interface RetainedResult {
  readonly result: ScenarioResult;
  readonly detailBytes: number;
}

const BRIEF_ERROR_CHARS = 1024;

function resolvedStatus(counts: Readonly<Record<ScenarioStatus, number>>): ScenarioStatus {
  if (counts.failed > 0) {return "failed";}
  if (counts.skipped > 0) {return "skipped";}
  return "passed";
}

function scenarioKey(result: ScenarioResult): string {
  return refIdentity(scenarioRefFromResult(result));
}

function executionKey(result: ScenarioResult): string {
  return `${scenarioKey(result)}\0${result.projectName ?? ""}`;
}

// What a case is worth once its bulky evidence is dropped: who ran, how it ended, how long it took,
// and enough error text to read in a summary.
function compactResult(result: ScenarioResult): ScenarioResult {
  const compact: ScenarioResult = { ...result };
  delete compact.steps;
  delete compact.attachmentPaths;
  delete compact.errorStack;
  if (compact.errorMessage !== undefined) {
    compact.errorMessage = truncate(compact.errorMessage, BRIEF_ERROR_CHARS);
  }
  return compact;
}

/** Create one extension-owned reporter side channel. Failure leaves the test run usable. */
export function openLiveRunSession(options: LiveRunSessionOptions): LiveRunHandle | undefined {
  try {
    fs.writeFileSync(options.liveReportPath, "", "utf8");
    let passed = 0;
    let failed = 0;
    const budget = options.detailBudget ?? new DetailBudget();
    const resultByExecution = new Map<string, RetainedResult>();
    const statusByScenario = new Map<string, ScenarioStatusState>();
    const adjustRunCount = (status: ScenarioStatus, by: 1 | -1): void => {
      if (status === "passed") {passed += by;}
      else if (status === "failed") {failed += by;}
    };
    const updateStatus = (result: ScenarioResult): void => {
      const logical = scenarioKey(result);
      const project = result.projectName ?? "";
      const state = statusByScenario.get(logical);
      if (state === undefined) {
        const counts: Record<ScenarioStatus, number> = { passed: 0, failed: 0, skipped: 0 };
        counts[result.status] = 1;
        statusByScenario.set(logical, {
          byProject: new Map([[project, result.status]]),
          counts,
          status: result.status,
        });
        adjustRunCount(result.status, 1);
        return;
      }
      adjustRunCount(state.status, -1);
      const previous = state.byProject.get(project);
      if (previous !== undefined) {state.counts[previous] -= 1;}
      state.byProject.set(project, result.status);
      state.counts[result.status] += 1;
      state.status = resolvedStatus(state.counts);
      adjustRunCount(state.status, 1);
    };
    const retain = (result: ScenarioResult): void => {
      const key = executionKey(result);
      const previous = resultByExecution.get(key);
      if (previous !== undefined) {
        budget.release(
          previous.detailBytes,
          previous.detailBytes > 0 ? previous.result : undefined
        );
      }
      const compact = compactResult(result);
      const bytes =
        Buffer.byteLength(JSON.stringify(result)) - Buffer.byteLength(JSON.stringify(compact));
      // Keyed by the result object itself: the same object travels to the run accumulator via
      // progress.onTestEnd, and its one bundle of steps, attachments, and error stack must not be
      // charged twice against the one run budget.
      const admitted = budget.take(bytes, result);
      resultByExecution.set(key, {
        result: admitted === "refused" ? compact : result,
        detailBytes: admitted === "charged" ? bytes : 0,
      });
      updateStatus(result);
    };
    const stream = LiveRunStream.watch(options.liveReportPath, {
      onBegin: (record) => {
        if (options.signal?.aborted) {return;}
        options.onStatus?.({ passed, failed, completed: 0, total: record.total });
        options.progress.onBegin?.(record.total);
      },
      onTestEnd: (result, record) => {
        const observed = { ...result, projectName: record.projectName };
        retain(observed);
        if (options.signal?.aborted) {return;}
        options.onStatus?.({ passed, failed, completed: record.completed, total: record.total });
        options.progress.onTestEnd?.(observed, record.completed, record.total);
      },
      onError: options.onError,
    });
    return {
      stream,
      recoverResults: (finalResults) => {
        const recovered = new Map(resultByExecution);
        for (const result of finalResults) {recovered.delete(executionKey(result));}
        return [...recovered.values()].map(({ result }) => result).concat(finalResults);
      },
      env: {
        [LIVE_REPORT_FILE_ENV]: options.liveReportPath,
        PW_TEST_REPORTER: options.reporterPath,
      },
    };
  } catch (error) {
    const resolved = error instanceof Error ? error : new Error(String(error));
    try {options.onError(resolved);} catch { /* live reporting must not fail the run */ }
    return undefined;
  }
}
