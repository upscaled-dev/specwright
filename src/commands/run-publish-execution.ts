import * as vscode from "vscode";
import { ExecutionFailure } from "../core/execution-gateway";
import { startExecution, type ExecutionGateway } from "../core/run-contracts";
import { withExecutionClientContext, type RunInitiator } from "../ui/execution-client-context";
import type { BatchInvocation } from "../traceability/batch-selection";
import type { BatchSelection, PreflightDecision } from "../traceability/contracts";
import type { ScenarioRef } from "../traceability/scenario-ref";
import { executionTargets } from "./run-publish-selection";

export async function runPublishBatch(
  gateway: ExecutionGateway,
  selection: BatchSelection,
  invocations: readonly BatchInvocation[],
  decisions: readonly PreflightDecision[],
  initiatedBy: RunInitiator,
  artifactOwnership: readonly ScenarioRef[],
  outputSink?: ((output: string, failure?: string) => void) | undefined
): Promise<string | undefined> {
  const controller = new AbortController();
  const scoped = selection.kind === "all-mapped" && selection.project
    ? ` scoped to ${selection.project} (project scope)`
    : "";
  let artifactId: string | undefined;
  try {
    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: `Running batch locally${scoped}…`,
        cancellable: true,
      },
      async (progress, token) => {
        const cancelSub = token.onCancellationRequested(() => controller.abort());
        if (token.isCancellationRequested) {controller.abort();}
        try {
          const completion = await startExecution(
            gateway,
            withExecutionClientContext({
              mode: "run",
              targets: executionTargets(invocations),
            }, { selection, decisions, initiatedBy, artifactOwnership }),
            {
              signal: controller.signal,
              onEvent: (event) => {
                if (event.kind === "case-finished") {
                  progress.report({ message: `${event.completed} / ${event.total} completed` });
                }
              },
            }
          );
          artifactId = completion.artifactId;
          outputSink?.(completion.output, completion.failure);
        } finally {
          cancelSub.dispose();
        }
      }
    );
  } catch (error) {
    if (error instanceof ExecutionFailure) {
      artifactId = error.completion.artifactId;
      outputSink?.(error.completion.output, error.completion.failure);
    }
    throw error;
  }
  return artifactId;
}
