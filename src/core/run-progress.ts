import type { ScenarioResult } from "../utils/playwright-json-parser";
import type { DetailBudget } from "./execution-limits";
import type { RunOutputResult } from "./test-executor";

/** Observed execution stages; counts describe logical scenarios, never attempts. */
export type RunProgress =
  | { readonly phase: "preparing" }
  | { readonly phase: "generating" }
  | { readonly phase: "finishing" }
  | {
      readonly phase: "running";
      readonly completed?: number | undefined;
      readonly total?: number | undefined;
      readonly retrying?: number | undefined;
      readonly retry?: { readonly title: string; readonly attempt: number; readonly projectName: string } | undefined;
    };

export function formatRunProgress(progress: RunProgress): string {
  if (progress.phase === "preparing") {return "Preparing run";}
  if (progress.phase === "generating") {return "Generating tests";}
  if (progress.phase === "finishing") {return "Finishing run";}
  const counts = progress.total === undefined ? "" : ` ${progress.completed ?? 0}/${progress.total}`;
  return `Running${counts}${progress.retrying ? ", retrying tests" : ""}`;
}

/** Optional presentation cannot change execution or prevent another consumer receiving progress. */
export function reportRunProgress(observer: RunProgressObserver | undefined, progress: RunProgress): void {
  try {observer?.onProgress?.(progress);} catch { /* progress is optional */ }
}

/** Per-run callbacks used to publish Playwright results before the process exits. */
export interface RunProgressObserver {
  /** The dispatching run's own live-detail budget, so N invocations cannot retain N times the cap. */
  readonly detailBudget?: DetailBudget | undefined;
  onProgress?(progress: RunProgress): void;
  onBegin?(total: number): void;
  onTestEnd?(result: ScenarioResult, completed: number, total: number): void;
  onOutput?(stream: "stdout" | "stderr", text: string): void;
}

/** One open UI run that consumes live events and reconciles the completed report. */
export interface RunProgressSession {
  readonly progress: RunProgressObserver;
  complete(result: RunOutputResult): void;
  end(): void;
}

// `detailBudget` is deliberately not forwarded: only the gateway's own observer reaches the executor,
// so a combined observer carrying one would hand each invocation its own budget.
/** Fan one run's progress out to its independent UI consumers. */
export function combineRunProgressObservers(
  ...observers: Array<RunProgressObserver | undefined>
): RunProgressObserver | undefined {
  const active = observers.filter((observer): observer is RunProgressObserver => observer !== undefined);
  if (active.length === 0) {return undefined;}
  const hasOutputConsumer = active.some((observer) => observer.onOutput !== undefined);
  return {
    onProgress: (progress) => {
      for (const observer of active) {reportRunProgress(observer, progress);}
    },
    onBegin: (total) => {
      for (const observer of active) {
        try {observer.onBegin?.(total);} catch { /* one UI consumer cannot block another */ }
      }
    },
    onTestEnd: (result, completed, total) => {
      for (const observer of active) {
        try {
          observer.onTestEnd?.(result, completed, total);
        } catch { /* one UI consumer cannot block another */ }
      }
    },
    ...(hasOutputConsumer ? {
      onOutput: (stream: "stdout" | "stderr", output: string) => {
        for (const observer of active) {
          try {observer.onOutput?.(stream, output);} catch { /* one UI consumer cannot block another */ }
        }
      },
    } : {}),
  };
}
