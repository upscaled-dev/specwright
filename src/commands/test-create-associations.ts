import * as vscode from "vscode";
import type { WorkspaceTrust } from "../core/workspace-trust";
import { describeContainerAdd } from "../traceability/container-add-flow";
import type { AuthoredTest, TestContainerKind, TestContainerTarget, TraceabilityAdapter } from "../traceability/contracts";
import { providerWarnings } from "../traceability/provider-warnings";
import type { Logger } from "../utils/logger";
import {
  promptExistingContainer,
  remoteOutcomeUnknown,
  RemoteWriteCancellation,
  reportContainerAddFailure,
  runContainerWrite,
} from "./traceability-container-add-command";

function containerName(kind: TestContainerKind): string {
  return kind === "test-set" ? "Test Set" : "Test Plan";
}

function targetNames(targets: readonly TestContainerTarget[]): string {
  return targets.map((target) => `${containerName(target.kind)} ${target.key}`).join(" and ");
}

// Undefined means setup was cancelled or failed. An empty list is the explicit create-only choice,
// or the previous flow for adapters without both existing-container seams.
export async function prepareTestCreateAssociations(
  adapter: TraceabilityAdapter,
  project: string,
  logger: Logger
): Promise<readonly TestContainerTarget[] | undefined> {
  const authoring = adapter.testAuthoring;
  const resolve = authoring?.resolveTestContainer?.bind(authoring);
  if (!resolve || !authoring?.addTestsToContainer) {return [];}
  const choice = await vscode.window.showQuickPick([
    { label: "Create only", kinds: [] },
    { label: "Add to an existing Test Set", kinds: ["test-set"] },
    { label: "Add to an existing Test Plan", kinds: ["test-plan"] },
    { label: "Add to an existing Test Set and Test Plan", kinds: ["test-set", "test-plan"] },
  ] as const, { title: "Associate new tests", placeHolder: "Choose optional membership for the new tests" });
  if (choice === undefined) {return;}
  const targets: TestContainerTarget[] = [];
  for (const kind of choice.kinds) {
    const target = await promptExistingContainer(kind, containerName(kind), project, adapter, resolve, logger);
    if (target === undefined) {return;}
    targets.push(target);
  }
  return targets;
}

export function testCreateAssociationConfirmation(targets: readonly TestContainerTarget[]): string {
  return targets.length === 0 ? "" : ` Add the created tests to ${targetNames(targets)}.`;
}

// Membership takes the create response's ids, including remote tests whose local tag could not be
// written. A failed membership never changes the create result or attempts another create.
export async function associateCreatedTests(
  adapter: TraceabilityAdapter,
  targets: readonly TestContainerTarget[],
  tests: readonly AuthoredTest[],
  project: string,
  logger: Logger,
  trust: WorkspaceTrust,
  signal?: AbortSignal
): Promise<void> {
  if (targets.length === 0) {return;}
  const add = adapter.testAuthoring?.addTestsToContainer?.bind(adapter.testAuthoring);
  const names = tests.map((test) => test.key ?? (test.issueId ? `issue id ${test.issueId}` : "test with unreadable key and id"));
  const prefix = tests.length > 0 ? `Created tests remain: ${names.join(", ")}. ` : "No tests were created. ";
  const ids = [...new Set(tests.flatMap((test) => (test.issueId?.trim() ? [test.issueId] : [])))];
  const missing = tests.filter((test) => !test.issueId?.trim());
  if (missing.length > 0) {
    vscode.window.showWarningMessage(`${prefix}No returned issue id for ${missing.map((test) => test.key ?? "test with unreadable key").join(", ")}; these tests cannot be associated.`);
  }
  const reportUnattempted = (remaining: readonly TestContainerTarget[], reason = ""): void => {
    if (remaining.length > 0) {
      vscode.window.showWarningMessage(`${prefix}${reason}Association not attempted for ${targetNames(remaining)}.`);
    }
  };
  const stopReason = (): string | undefined => {
    if (!trust.available) {return "Workspace trust is no longer available. ";}
    if (signal?.aborted) {return "Association cancelled. ";}
    return undefined;
  };
  for (const [index, target] of targets.entries()) {
    const reason = stopReason();
    if (reason !== undefined) {
      reportUnattempted(targets.slice(index), reason);
      return;
    }
    if (!add || ids.length === 0) {
      reportUnattempted(targets.slice(index), !add ? "The tracker no longer supports association. " : "No returned test issue IDs are available. ");
      return;
    }
    const noun = containerName(target.kind);
    try {
      const result = await runContainerWrite(`Adding created tests to ${noun} ${target.key}…`, (abort) => {
        trust.require();
        return add(target.kind, target.issueId, ids, abort);
      }, signal);
      const report = describeContainerAdd(noun, target.key, ids.length, result, "created");
      const warnings = providerWarnings(result.warning === undefined ? [] : [result.warning]);
      if (warnings.count > 0) {
        logger.warn(`${adapter.label} returned a warning associating created tests`, {
          key: target.key, warnings: warnings.detail, warningsOmitted: warnings.omitted,
        });
      }
      const message = `${report.inspect ? prefix : ""}${report.message}${warnings.count > 0 ? ` ${warnings.summary} logged.` : ""}`;
      (report.inspect ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(message);
      if (result.addedTests === undefined) {
        reportUnattempted(targets.slice(index + 1));
        return;
      }
    } catch (error) {
      if (error instanceof RemoteWriteCancellation && !error.requestStarted) {
        reportUnattempted(targets.slice(index), stopReason() ?? "Association cancelled. ");
        return;
      }
      reportContainerAddFailure(noun, target.key, project, error, logger, prefix);
      if (error instanceof RemoteWriteCancellation || remoteOutcomeUnknown(error) || stopReason() !== undefined) {
        reportUnattempted(targets.slice(index + 1), stopReason() ?? (error instanceof RemoteWriteCancellation ? "Association cancelled. " : ""));
        return;
      }
    }
  }
}
