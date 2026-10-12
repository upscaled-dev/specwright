import * as vscode from "vscode";
import {
  combineRunProgressObservers,
  formatRunProgress,
  type RunProgress,
  type RunProgressObserver,
  type RunProgressSession,
} from "../core/run-progress";
import type { RunOutputResult } from "../core/test-executor";
import type { ExecutionGateway, RunIntent } from "../core/run-contracts";
import type { PlaywrightJsonParser } from "../utils/playwright-json-parser";
import type { Logger } from "../utils/logger";
import { runIntentWithObserver } from "../ui/execution-adapter";

/**
 * Keep captured command output available in Specwright's log after the run completes.
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
        let state: RunProgress = { phase: "running" };
        const report = (): void => {
          try {notification.report({ message: formatRunProgress(state) });} catch { /* progress is optional */ }
        };
        report();
        const notificationProgress: RunProgressObserver = {
          onProgress: (progress) => {state = progress; report();},
          onBegin: (total) => {state = { phase: "running", completed: 0, total }; report();},
          onTestEnd: (_result, completed, total) => {
            if (state.phase === "finishing") {return;}
            state = { ...state, phase: "running", completed, total };
            report();
          },
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
