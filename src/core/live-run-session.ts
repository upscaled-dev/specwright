import * as fs from "node:fs";
import { LIVE_REPORT_FILE_ENV } from "./live-reporter-protocol";
import { LiveRunStream } from "./live-run-stream";
import type { RunProgressObserver } from "./run-progress";
import type { ScenarioStatus } from "../utils/playwright-json-parser";

export interface LiveRunHandle {
  readonly stream: LiveRunStream;
  readonly env: NodeJS.ProcessEnv;
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
  readonly onStatus: (status: LiveRunStatus) => void;
  readonly onError: (error: Error) => void;
}

/** Create one extension-owned reporter side channel. Failure leaves the test run usable. */
export function openLiveRunSession(options: LiveRunSessionOptions): LiveRunHandle | undefined {
  try {
    fs.writeFileSync(options.liveReportPath, "", "utf8");
    let passed = 0;
    let failed = 0;
    const statusByScenario = new Map<string, ScenarioStatus>();
    const stream = LiveRunStream.watch(options.liveReportPath, {
      onBegin: (record) => {
        if (options.signal?.aborted) {return;}
        options.onStatus({ passed, failed, completed: 0, total: record.total });
        options.progress.onBegin?.(record.total);
      },
      onTestEnd: (result, record) => {
        if (options.signal?.aborted) {return;}
        const key = result.lineNumber === undefined
          ? `${result.featurePath}\0${result.scenarioName}`
          : `${result.featurePath}\0${result.lineNumber}`;
        const previous = statusByScenario.get(key);
        if (previous !== result.status) {
          if (previous === "passed") {passed -= 1;}
          else if (previous === "failed") {failed -= 1;}
          if (result.status === "passed") {passed += 1;}
          else if (result.status === "failed") {failed += 1;}
          statusByScenario.set(key, result.status);
        }
        options.onStatus({ passed, failed, completed: record.completed, total: record.total });
        options.progress.onTestEnd?.(result, record.completed, record.total);
      },
      onError: options.onError,
    });
    return {
      stream,
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
