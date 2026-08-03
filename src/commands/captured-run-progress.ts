import * as vscode from "vscode";
import {
  combineRunProgressObservers,
  type RunProgressObserver,
  type RunProgressSession,
} from "../core/run-progress";
import type { RunOutputResult } from "../core/test-executor";
import type { ExecutionGateway, RunIntent } from "../core/run-contracts";
import type { PlaywrightJsonParser } from "../utils/playwright-json-parser";
import type { Logger } from "../utils/logger";
import { runIntentWithObserver } from "../ui/execution-adapter";

/**
 * Send captured runner output from every non-Test Explorer entry point to Specwright's output log.
 * These commands run the tests once through the captured executor path (no live terminal, no Test
 * Results stream), so without this echo the user would see no output at all.
 */
export function logCapturedRunOutput(
  logger: Logger,
  label: string,
  output: string,
  error?: string
): void {
  const parts = output.trim() === "" ? [] : [output];
  if (error && !output.includes(error)) {parts.push(error);}
  if (parts.length === 0) {return;}
  logger.info(`${label} output:\n${parts.join("\n")}`);
  logger.showOutput();
}

/** Run one captured command with cancellable notification and live completion counts. */
export async function runCapturedWithProgress(
  title: string,
  session: RunProgressSession | undefined,
  execute: (signal: AbortSignal, progress: RunProgressObserver) => Promise<RunOutputResult>,
  window: typeof vscode.window = vscode.window
): Promise<RunOutputResult> {
  const abort = new AbortController();
  try {
    const result = await window.withProgress(
      { location: vscode.ProgressLocation.Notification, title, cancellable: true },
      async (notification, token) => {
        const cancelSub = token.onCancellationRequested(() => abort.abort());
        if (token.isCancellationRequested) {abort.abort();}
        const notificationProgress: RunProgressObserver = {
          onBegin: (total) => notification.report({ message: `0 / ${total} completed` }),
          onTestEnd: (_result, completed, total) =>
            notification.report({ message: `${completed} / ${total} completed` }),
        };
        const progress = combineRunProgressObservers(session?.progress, notificationProgress)
          ?? notificationProgress;
        try {
          return await execute(abort.signal, progress);
        } finally {
          cancelSub.dispose();
        }
      }
    );
    session?.complete(result);
    return result;
  } catch (error) {
    session?.end();
    throw error;
  }
}

export function runGatewayWithProgress(
  title: string,
  session: RunProgressSession | undefined,
  gateway: ExecutionGateway,
  intent: RunIntent,
  parser: PlaywrightJsonParser,
  workingDir: string
): Promise<RunOutputResult> {
  return runCapturedWithProgress(
    title,
    session,
    (signal, progress) => runIntentWithObserver(
      gateway,
      intent,
      signal,
      progress,
      parser,
      workingDir
    )
  );
}
