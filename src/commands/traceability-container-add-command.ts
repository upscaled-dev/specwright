import * as vscode from "vscode";
import { RemoteOutcomeUnknownError } from "../core/workspace-trust";
import { describeContainerAdd, validateContainerTargetKey } from "../traceability/container-add-flow";
import { containerMemberIssueId, resolveContainerMembers } from "../traceability/container-create-flow";
import type {
  TestAuthoringCapability,
  TestContainerKind,
  TestContainerTarget,
  TraceabilityAdapter,
} from "../traceability/contracts";
import type { TraceabilitySnapshot } from "../traceability/traceability-model";
import type { Logger } from "../utils/logger";
import { errMsg, plural } from "../utils/text";
import { providerWarnings } from "../traceability/provider-warnings";

const NO_TEST_SELECTION = "Select tests on the Coverage Board's Mapping tab first.";
const RESYNC = "Sync traceability, then try again.";

type ResolveContainer = NonNullable<TestAuthoringCapability["resolveTestContainer"]>;
type AddToContainer = NonNullable<TestAuthoringCapability["addTestsToContainer"]>;
type ContainerLookup =
  | { readonly kind: "cancelled" }
  | { readonly kind: "completed"; readonly target: TestContainerTarget | undefined };

export interface ContainerAddCommandDeps {
  snapshot(): TraceabilitySnapshot | undefined;
  adapter(): TraceabilityAdapter | undefined;
  selectedTests(): readonly string[];
  targetProject(): string | undefined;
  credentialsPresent(): Promise<boolean>;
  siteUrl(): string;
  scheduleProjectSync(project: string, diagnostics?: Iterable<string>): void;
}

// A cancel before the seam is called proves nothing was sent. Once called, an abort cannot prove
// whether the single POST landed, so callers report ambiguity and never offer a blind retry.
export class RemoteWriteCancellation extends Error {
  constructor(readonly requestStarted: boolean) {
    super("Remote write cancelled");
  }
}

export function runContainerWrite<T>(
  title: string,
  write: (signal: AbortSignal) => Promise<T>
): Promise<T> {
  return Promise.resolve(vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title,
      cancellable: true,
    },
    async (_progress, token): Promise<T> => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      if (token.isCancellationRequested) {controller.abort();}
      if (controller.signal.aborted) {throw new RemoteWriteCancellation(false);}
      try {
        const result = await write(controller.signal);
        if (controller.signal.aborted) {throw new RemoteWriteCancellation(true);}
        return result;
      } catch (error) {
        if (error instanceof RemoteWriteCancellation) {throw error;}
        if (controller.signal.aborted) {throw new RemoteWriteCancellation(true);}
        throw error;
      }
    }
  ));
}

function projectTarget(site: string, project: string): string {
  return site !== "" ? `project ${project} on ${site}` : `project ${project}`;
}

function remoteOutcomeUnknown(error: unknown): RemoteOutcomeUnknownError | undefined {
  let current: unknown = error;
  const seen = new Set<unknown>();
  while (current instanceof Error && !seen.has(current)) {
    if (current instanceof RemoteOutcomeUnknownError) {return current;}
    seen.add(current);
    current = current.cause;
  }
  return undefined;
}

async function commandTarget(
  noun: string,
  deps: ContainerAddCommandDeps
): Promise<{
  adapter: TraceabilityAdapter;
  resolve: ResolveContainer;
  add: AddToContainer;
  project: string;
} | undefined> {
  const adapter = deps.adapter();
  const authoring = adapter?.testAuthoring;
  const resolve = authoring?.resolveTestContainer?.bind(authoring);
  const add = authoring?.addTestsToContainer?.bind(authoring);
  if (!adapter || !resolve || !add || !(await deps.credentialsPresent())) {
    vscode.window.showInformationMessage(`Connect to your test tracker before adding tests to a ${noun}.`);
    return undefined;
  }
  const project = deps.targetProject();
  if (project === undefined) {
    vscode.window.showInformationMessage(`Pick a project on the Coverage Board before choosing a ${noun}.`);
    return undefined;
  }
  return { adapter, resolve, add, project };
}

function resolveExistingContainer(
  kind: TestContainerKind,
  noun: string,
  key: string,
  resolve: ResolveContainer
): Promise<ContainerLookup> {
  return Promise.resolve(vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: `Resolving ${noun} ${key}…`,
      cancellable: true,
    },
    async (_progress, token): Promise<ContainerLookup> => {
      const controller = new AbortController();
      token.onCancellationRequested(() => controller.abort());
      if (token.isCancellationRequested) {controller.abort();}
      if (controller.signal.aborted) {return { kind: "cancelled" };}
      try {
        const target = await resolve(kind, key, controller.signal);
        return controller.signal.aborted
          ? { kind: "cancelled" }
          : { kind: "completed", target };
      } catch (error) {
        if (controller.signal.aborted) {return { kind: "cancelled" };}
        throw error;
      }
    }
  ));
}

async function confirmAppend(
  noun: string,
  key: string,
  project: string,
  count: number,
  providerLabel: string,
  siteUrl: string
): Promise<boolean> {
  const action = `Add to ${noun}`;
  const choice = await vscode.window.showWarningMessage(
    `Add ${count} selected ${plural(count, "test")} to ${providerLabel} ${noun} ${key} in ${projectTarget(siteUrl, project)}?`,
    { modal: true },
    action
  );
  return choice === action;
}

function reportFailure(
  noun: string,
  key: string,
  project: string,
  error: unknown,
  logger: Logger
): void {
  if (error instanceof RemoteWriteCancellation) {
    if (error.requestStarted) {
      vscode.window.showWarningMessage(
        `Cancelled while waiting for Xray. Tests may still have been added to ${noun} ${key}; inspect ${key} before retrying.`
      );
    }
    return;
  }
  const ambiguity = remoteOutcomeUnknown(error);
  if (ambiguity) {
    logger.warn(`Adding tests to a ${noun} has an unknown outcome`, {
      project,
      key,
      operationId: ambiguity.operationId,
    });
    vscode.window.showWarningMessage(
      `The request outcome is unknown. Tests may have been added to ${noun} ${key}; inspect ${key} before retrying.`
    );
    return;
  }
  logger.error(`Adding tests to a ${noun} failed`, { project, key, error: errMsg(error) });
  vscode.window.showErrorMessage(`Could not add tests to ${noun} ${key}: ${errMsg(error)}`);
}

export async function runContainerAddCommand(
  kind: TestContainerKind,
  noun: string,
  logger: Logger,
  deps: ContainerAddCommandDeps
): Promise<void> {
  const keys = deps.selectedTests();
  if (keys.length === 0) {
    vscode.window.showInformationMessage(NO_TEST_SELECTION);
    return;
  }
  const target = await commandTarget(noun, deps);
  if (target === undefined) {return;}
  const { adapter, resolve, add, project } = target;
  const snapshot = deps.snapshot();
  const members = resolveContainerMembers(keys, (key) => containerMemberIssueId(snapshot, key));
  if (members.kind === "unresolved") {
    const unresolved = members.keys.join(", ");
    logger.warn(`Adding tests to a ${noun} was blocked by tests with no synced issue id`, { keys: unresolved });
    vscode.window.showWarningMessage(
      `Nothing was added: there is no synced issue id for ${unresolved}, which is the only handle a ${noun} takes. ${RESYNC}`
    );
    return;
  }
  const entered = await vscode.window.showInputBox({
    title: `Add to existing ${noun}`,
    prompt: `Enter the exact ${noun} key in project ${project}.`,
    placeHolder: `${project}-123`,
    validateInput: (value) => {
      const checked = validateContainerTargetKey(value, project, adapter.keyGrammar);
      return checked.kind === "invalid" ? checked.message : undefined;
    },
  });
  if (entered === undefined) {return;}
  const checked = validateContainerTargetKey(entered, project, adapter.keyGrammar);
  if (checked.kind === "invalid") {
    vscode.window.showWarningMessage(checked.message);
    return;
  }
  let lookup: ContainerLookup;
  try {
    lookup = await resolveExistingContainer(kind, noun, checked.key, resolve);
  } catch (error) {
    logger.error(`Resolving a ${noun} failed`, { key: checked.key, error: errMsg(error) });
    vscode.window.showErrorMessage(`Could not resolve ${noun} ${checked.key}: ${errMsg(error)}`);
    return;
  }
  if (lookup.kind === "cancelled") {return;}
  const resolved = lookup.target;
  if (resolved?.kind !== kind || resolved.key !== checked.key) {
    vscode.window.showWarningMessage(
      `${checked.key} could not be resolved as a ${noun} in project ${project}. Nothing was added.`
    );
    return;
  }
  if (!(await confirmAppend(noun, resolved.key, project, keys.length, adapter.label, deps.siteUrl()))) {return;}
  try {
    const result = await runContainerWrite(`Adding selected tests to ${adapter.label} ${noun} ${resolved.key}…`, (signal) =>
      add(kind, resolved.issueId, members.issueIds, signal)
    );
    const report = describeContainerAdd(noun, resolved.key, keys.length, result);
    const warnings = providerWarnings(result.warning === undefined ? [] : [result.warning]);
    if (result.warning !== undefined) {
      logger.warn(`${adapter.label} returned a warning adding tests to a ${noun}`, {
        key: resolved.key,
        warnings: warnings.detail,
        warningsOmitted: warnings.omitted,
      });
    }
    deps.scheduleProjectSync(project, result.warning === undefined ? [] : [result.warning]);
    const message = warnings.count > 0 ? `${report.message} ${warnings.summary} logged.` : report.message;
    (report.inspect ? vscode.window.showWarningMessage : vscode.window.showInformationMessage)(message);
  } catch (error) {
    deps.scheduleProjectSync(project, [errMsg(error)]);
    reportFailure(noun, resolved.key, project, error, logger);
  }
}
