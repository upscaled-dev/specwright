import {
  startExecution,
  type ExecutionCaseResult,
  type ExecutionEvent,
  type ExecutionGateway,
  type RunCompletion,
  type RunIntent,
} from "../core/run-contracts";
import type { RunProgressObserver } from "../core/run-progress";
import type { RunOutputResult } from "../core/test-executor";
import type { PlaywrightJsonParser, ScenarioResult } from "../utils/playwright-json-parser";
import { ExecutionFailure } from "../core/execution-gateway";

function statusOf(result: ExecutionCaseResult): ScenarioResult["status"] {
  if (result.outcome === "passed" || result.outcome === "skipped") {return result.outcome;}
  return "failed";
}

export function scenarioResultFromExecution(result: ExecutionCaseResult): ScenarioResult {
  const status = statusOf(result);
  return {
    featurePath: result.scenario.filePath,
    ...(result.scenario.line > 0 ? { lineNumber: result.scenario.line } : {}),
    scenarioName: result.scenario.name,
    status,
    durationMs: result.durationMs,
    ...(result.errorMessage ? { errorMessage: result.errorMessage } : {}),
    ...(result.errorStack ? { errorStack: result.errorStack } : {}),
    ...(result.scenario.outlineName ? { outlineName: result.scenario.outlineName } : {}),
    ...(result.outcome !== status ? { outcome: result.outcome } : {}),
    ...(result.attempts > 1 ? { attempts: result.attempts } : {}),
    ...(result.flaky ? { flaky: true } : {}),
    ...(result.steps ? { steps: [...result.steps] } : {}),
  };
}

export function runOutputFromCompletion(
  completion: RunCompletion,
  parser: PlaywrightJsonParser,
  workingDir: string
): RunOutputResult {
  const scenarioDetails = completion.results.map(scenarioResultFromExecution);
  return {
    success: completion.state === "complete" && completion.failed === 0,
    output: completion.output,
    ...(completion.state === "cancelled"
      ? { error: "Cancelled" }
      : completion.failure
        ? { error: completion.failure }
        : completion.failed > 0
          ? { error: `${completion.failed} ${completion.failed === 1 ? "test failed" : "tests failed"}` }
          : {}),
    duration: completion.durationMs,
    scenarioDetails,
    scenarioResults: parser.toStatusMap(scenarioDetails, workingDir),
  };
}

export async function runIntentWithObserver(
  gateway: ExecutionGateway,
  intent: RunIntent,
  signal: AbortSignal,
  progress: RunProgressObserver,
  parser: PlaywrightJsonParser,
  workingDir: string
): Promise<RunOutputResult> {
  let completion: RunCompletion;
  try {
    completion = await startExecution(gateway, intent, {
      signal,
      onEvent: (event: ExecutionEvent) => {
        if (event.kind === "case-finished") {
          progress.onTestEnd?.(
            scenarioResultFromExecution(event.result),
            event.completed,
            event.total
          );
        } else if (event.kind === "output") {
          progress.onOutput?.(event.stream, event.text);
        } else if (event.kind === "begin") {
          progress.onBegin?.(event.total);
        }
      },
    });
  } catch (error) {
    if (!(error instanceof ExecutionFailure)) {throw error;}
    completion = error.completion;
  }
  return runOutputFromCompletion(completion, parser, workingDir);
}
