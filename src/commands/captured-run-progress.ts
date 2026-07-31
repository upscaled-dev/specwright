import * as vscode from "vscode";
import {
  combineRunProgressObservers,
  type RunProgressObserver,
  type RunProgressSession,
} from "../core/run-progress";
import type { RunOutputResult } from "../core/test-executor";

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
