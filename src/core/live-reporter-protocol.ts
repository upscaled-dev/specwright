/** Environment variable carrying the JSONL file written by the live reporter. */
export const LIVE_REPORT_FILE_ENV = "SPECWRIGHT_LIVE_REPORT_FILE";

export type LiveTestStatus =
  | "passed"
  | "failed"
  | "timedOut"
  | "skipped"
  | "interrupted";

export type LiveExpectedStatus = LiveTestStatus;

/** First record in a live report. */
export interface LiveRunBeginRecord {
  kind: "run-begin";
  rootDir: string;
  configFile?: string | undefined;
  total: number;
}

/** Current aggregate for one logical scenario. A later retry may revise the same result. */
export interface LiveTestEndRecord {
  kind: "test-end";
  file: string;
  line: number;
  title: string;
  titlePath: string[];
  status: LiveTestStatus;
  durationMs: number;
  errorMessage?: string | undefined;
  errorStack?: string | undefined;
  retry: number;
  retries: number;
  expectedStatus: LiveExpectedStatus;
  projectName: string;
  completed: number;
  total: number;
}

export type LiveReporterRecord = LiveRunBeginRecord | LiveTestEndRecord;
