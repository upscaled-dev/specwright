import type { ScenarioResult } from "../utils/playwright-json-parser";
import type { RunOutputResult } from "./test-executor";

/** Per-run callbacks used to publish Playwright results before the process exits. */
export interface RunProgressObserver {
  onBegin?(total: number): void;
  onTestEnd?(result: ScenarioResult, completed: number, total: number): void;
}

/** One open UI run that consumes live events and reconciles the completed report. */
export interface RunProgressSession {
  readonly progress: RunProgressObserver;
  complete(result: RunOutputResult): void;
  end(): void;
}

/** Fan one run's progress out to its independent UI consumers. */
export function combineRunProgressObservers(
  ...observers: Array<RunProgressObserver | undefined>
): RunProgressObserver | undefined {
  const active = observers.filter((observer): observer is RunProgressObserver => observer !== undefined);
  if (active.length === 0) {return undefined;}
  return {
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
  };
}
