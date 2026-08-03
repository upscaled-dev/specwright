import * as vscode from "vscode";
import {
  EXECUTION_ALREADY_RUNNING,
  ExecutionAlreadyRunningError,
  ExecutionFailure,
} from "../core/execution-gateway";
import type { ExecutionGateway, RunCompletion, RunIntent } from "../core/run-contracts";
import type { PlaywrightJsonParser } from "../utils/playwright-json-parser";
import { runOutputFromCompletion, scenarioResultFromExecution } from "../ui/execution-adapter";
import type { Logger } from "../utils/logger";
import { errMsg } from "../utils/text";
import type { LiveTestRunProgress } from "./live-test-run-progress";

// The transcript needs no replay: every byte the run retained was emitted as an output event first,
// truncation notices included. Only the failure line can be missing from it, and only when the
// runner never printed it (a debug run with no readable report reports its error as output), so it
// is appended exactly when the transcript does not already carry it.
function appendFailureLine(live: LiveTestRunProgress, completion: RunCompletion): void {
  const failure = completion.failure;
  if (completion.state !== "partial" || !failure || completion.output.includes(failure)) {return;}
  live.appendOutput("stderr", `${failure}\n`);
}

export async function runGatewayTestRequest(options: {
  readonly controller: vscode.TestController;
  readonly request: vscode.TestRunRequest;
  readonly token: vscode.CancellationToken;
  readonly gateway: ExecutionGateway;
  readonly intent: RunIntent;
  readonly roots: readonly vscode.TestItem[];
  readonly parser: PlaywrightJsonParser;
  readonly workingDir: string;
  readonly logger: Logger;
  readonly createLive: (run: vscode.TestRun) => LiveTestRunProgress;
  readonly start: (root: vscode.TestItem, run: vscode.TestRun) => void;
  readonly summarize: (
    run: vscode.TestRun,
    result: ReturnType<typeof runOutputFromCompletion>,
    roots: readonly vscode.TestItem[]
  ) => void;
  readonly apply: (
    root: vscode.TestItem,
    run: vscode.TestRun,
    live: LiveTestRunProgress,
    result: ReturnType<typeof runOutputFromCompletion>
  ) => void;
  readonly cancel: (
    root: vscode.TestItem,
    run: vscode.TestRun,
    live: LiveTestRunProgress
  ) => void;
}): Promise<void> {
  if (options.gateway.running) {
    vscode.window.showWarningMessage(EXECUTION_ALREADY_RUNNING);
    return;
  }
  const run = options.controller.createTestRun(options.request);
  const live = options.createLive(run);
  const abort = new AbortController();
  const cancelSub = options.token.onCancellationRequested(() => abort.abort());
  if (options.token.isCancellationRequested) {abort.abort();}
  options.roots.forEach((root) => options.start(root, run));
  let completion: RunCompletion | undefined;
  let unrecoverable: string | undefined;
  try {
    completion = await options.gateway.execute(options.intent, {
      signal: abort.signal,
      onEvent: (event) => {
        if (event.kind === "case-finished") {
          live.apply(scenarioResultFromExecution(event.result), event.completed, event.total);
        } else if (event.kind === "output") {
          live.appendOutput(event.stream, event.text);
        }
      },
    });
  } catch (error) {
    if (error instanceof ExecutionFailure) {
      completion = error.completion;
    } else if (error instanceof ExecutionAlreadyRunningError) {
      vscode.window.showWarningMessage(error.message);
    } else {
      unrecoverable = errMsg(error);
      options.logger.error("Test execution failed", { error: unrecoverable });
    }
  } finally {
    cancelSub.dispose();
    if (completion !== undefined) {
      appendFailureLine(live, completion);
    }
    live.finishOutput();
    if (unrecoverable !== undefined) {
      const message = new vscode.TestMessage(unrecoverable);
      options.roots.forEach((root) => run.failed(root, message));
    } else if (completion?.state === "cancelled") {
      options.roots.forEach((root) => options.cancel(root, run, live));
    } else if (completion !== undefined) {
      const result = runOutputFromCompletion(completion, options.parser, options.workingDir);
      options.summarize(run, result, options.roots);
      options.roots.forEach((root) => options.apply(root, run, live, result));
    }
    run.end();
  }
}
