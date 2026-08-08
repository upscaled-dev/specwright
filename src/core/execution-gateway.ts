import { randomUUID } from "node:crypto";
import { DetailBudget } from "./execution-limits";
import {
  MAX_PARALLEL_PROCESSES_MAX,
  MAX_PARALLEL_PROCESSES_MIN,
} from "./extension-config";
import {
  snapshotRunIntent,
  type ExecutionCaseResult,
  type ExecutionDiagnostic,
  type ExecutionDiscovery,
  type ExecutionEvent,
  type ExecutionIdentity,
  type ExecutionOptions,
  type ExecutionServiceGateway,
  type PreparedExecution,
  type RunCompletion,
  type RunIntent,
  type RunTarget,
} from "./run-contracts";
import type { RunProgressObserver } from "./run-progress";
import type { RunOutputResult, TestExecutor } from "./test-executor";
import { isOutlineExampleRow, type FeatureParser } from "../parsers/feature-parser";
import { artifactCaptureTarget } from "../traceability/batch-selection";
import type { RunArtifactState } from "../traceability/contracts";
import type { OutlineExampleRow } from "../types";
import { refIdentity, scenarioRefFromResult, type ScenarioRef } from "../traceability/scenario-ref";
import type { ScenarioResult, StepResult } from "../utils/playwright-json-parser";
import { BoundedCommandOutput } from "./bounded-command-runner";
import { ExecutionAdmission, terminationLease } from "./execution-admission";
import type { WorkspaceTrust } from "./workspace-trust";
import type { LegacyDiscoveryPort } from "./legacy-discovery";

type EventListener = (event: ExecutionEvent) => void;

interface ExecuteOptions {
  readonly signal?: AbortSignal | undefined;
  readonly onEvent?: EventListener | undefined;
}

export const EXECUTION_ALREADY_RUNNING = "A test run is already in progress.";

export class ExecutionAlreadyRunningError extends Error {
  constructor() {
    super(EXECUTION_ALREADY_RUNNING);
    this.name = "ExecutionAlreadyRunningError";
  }
}

export class ExecutionFailure extends Error {
  constructor(readonly completion: RunCompletion) {
    super(completion.failure ?? "Test execution failed before a complete report was available.");
    this.name = "ExecutionFailure";
  }
}

function stepBytes(steps: readonly StepResult[]): number {
  return Buffer.byteLength(JSON.stringify(steps));
}

interface RetainedCase {
  readonly result: ExecutionCaseResult;
  // What this copy charged, so replacing it gives back exactly its own share.
  readonly detailBytes: number;
  // The share key this copy charged under, when it was the owner that paid; releasing the copy
  // must retire the key with the refund.
  readonly paidShare?: object | undefined;
}

// Steps and the error stack are the bulky half of a case and are retained for the whole run, so
// both are charged to the run's budget as one bundle; past the cap the case keeps its identity,
// outcome and message. A live-streamed case arrives as the very object the live session already
// paid for (keyed by the result itself), so it is admitted without paying again and the effective
// cap is the configured cap, not half of it. When a fresh copy's bundle does not fit, the small,
// high-value error stack still gets its own chance before the detail is dropped.
function retainCase(
  detail: ScenarioResult,
  scenario: ScenarioRef,
  budget: DetailBudget
): RetainedCase {
  const stepsBytes = detail.steps ? stepBytes(detail.steps) : 0;
  const stackBytes = detail.errorStack ? Buffer.byteLength(detail.errorStack) : 0;
  const bundle = budget.take(stepsBytes + stackBytes, detail);
  const stackAlone =
    bundle === "refused" && stackBytes > 0 && budget.take(stackBytes) === "charged";
  const steps = bundle !== "refused" && detail.steps
    ? Object.freeze([...detail.steps])
    : undefined;
  const errorStack = (bundle !== "refused" || stackAlone) && detail.errorStack
    ? detail.errorStack
    : undefined;
  let detailBytes = 0;
  if (bundle === "charged") {detailBytes = stepsBytes + stackBytes;}
  else if (stackAlone) {detailBytes = stackBytes;}
  return {
    detailBytes,
    ...(bundle === "charged" ? { paidShare: detail } : {}),
    result: Object.freeze({
      scenario,
      outcome: detail.outcome ?? detail.status,
      durationMs: detail.durationMs ?? 0,
      attempts: detail.attempts ?? 1,
      flaky: detail.flaky ?? false,
      ...(detail.errorMessage ? { errorMessage: detail.errorMessage } : {}),
      ...(errorStack ? { errorStack } : {}),
      ...(steps ? { steps } : {}),
    }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resultKey(result: ExecutionCaseResult): string {
  return refIdentity(result.scenario);
}

function resultSignature(result: ExecutionCaseResult): string {
  return `${result.outcome}\0${result.durationMs}\0${result.errorMessage ?? ""}\0${result.errorStack ?? ""}`;
}

const OUTCOME_SEVERITY: Record<ExecutionCaseResult["outcome"], number> = {
  passed: 0,
  skipped: 1,
  "timed-out": 2,
  interrupted: 3,
  failed: 4,
};

function resolveAggregate(results: Iterable<ExecutionCaseResult>): ExecutionCaseResult {
  let aggregate: ExecutionCaseResult | undefined;
  for (const result of results) {
    if (aggregate === undefined) {
      aggregate = result;
      continue;
    }
    const worst = OUTCOME_SEVERITY[result.outcome] > OUTCOME_SEVERITY[aggregate.outcome]
      ? result
      : aggregate;
    aggregate = Object.freeze({
      ...worst,
      durationMs: Math.max(aggregate.durationMs, result.durationMs),
      attempts: Math.max(aggregate.attempts, result.attempts),
      flaky: aggregate.flaky || result.flaky,
    });
  }
  if (aggregate === undefined) {throw new Error("Cannot aggregate an empty result set.");}
  return aggregate;
}

interface ScenarioResultState {
  readonly byProject: Map<string, RetainedCase>;
  aggregate: ExecutionCaseResult;
}

class RunResultAccumulator {
  private readonly byScenario = new Map<string, ScenarioResultState>();
  private executionTotal = 0;

  constructor(private readonly budget: DetailBudget) {}

  public update(detail: ScenarioResult): ExecutionCaseResult {
    const scenario = Object.freeze(scenarioRefFromResult(detail));
    const key = refIdentity(scenario);
    const project = detail.projectName ?? "";
    const state = this.byScenario.get(key);
    // The report repeats what the live stream already reported. The replaced copy gives its share
    // back before the replacement is charged, so detail that fits is never refused for room the
    // copy it replaces is about to free.
    const replaced = state?.byProject.get(project);
    if (replaced !== undefined) {this.budget.release(replaced.detailBytes, replaced.paidShare);}
    const retained = retainCase(detail, scenario, this.budget);
    if (state === undefined) {
      this.byScenario.set(key, {
        byProject: new Map([[project, retained]]),
        aggregate: retained.result,
      });
      this.executionTotal += 1;
      return retained.result;
    }
    if (!state.byProject.has(project)) {this.executionTotal += 1;}
    state.byProject.set(project, retained);
    state.aggregate = resolveAggregate(
      [...state.byProject.values()].map(({ result }) => result)
    );
    return state.aggregate;
  }

  public get executionCount(): number {
    return this.executionTotal;
  }

  public results(): ExecutionCaseResult[] {
    return [...this.byScenario.values()].map(({ aggregate }) => aggregate);
  }
}

function tally(results: readonly ExecutionCaseResult[]): { passed: number; failed: number } {
  let passed = 0;
  let failed = 0;
  for (const { outcome } of results) {
    if (outcome === "passed") {passed += 1;}
    else if (outcome !== "skipped") {failed += 1;}
  }
  return { passed, failed };
}

// Only a line that names a generated test can be targeted. An outline declaration line and an
// Examples-block line have none, so passing one would trip the stale-spec fallback on a healthy run;
// the runner greps the outline title instead and every row of that scope runs.
function targetLine(scenario: ScenarioRef, rows: readonly OutlineExampleRow[]): number {
  if (scenario.kind === "scenario") {return scenario.line;}
  return rows.some((row) => row.lineNumber === scenario.line) ? scenario.line : 0;
}

function scenarioOptions(
  scenario: ScenarioRef,
  rows: readonly OutlineExampleRow[],
  signal: AbortSignal | undefined,
  artifactBatch: number | undefined,
  progress: RunProgressObserver,
  tagExpression?: string
) {
  const line = targetLine(scenario, rows);
  return {
    filePath: scenario.filePath,
    ...(line > 0 ? { lineNumber: line } : {}),
    ...(scenario.kind === "scenario"
      ? { scenarioName: scenario.name }
      : { outlineName: scenario.outlineName ?? scenario.name }),
    ...(signal ? { signal } : {}),
    ...(artifactBatch !== undefined ? { artifactBatch } : {}),
    ...(tagExpression ? { tags: tagExpression } : {}),
    progress,
  };
}

export class LegacyDirectExecutionGateway implements ExecutionServiceGateway {
  private active = false;
  private readonly listeners = new Set<EventListener>();
  private operationAbort: AbortController | undefined;
  private operationDone: Promise<void> | undefined;

  constructor(
    private readonly executor: TestExecutor,
    private readonly featureParser: FeatureParser,
    private readonly workspaceTrust: WorkspaceTrust,
    private readonly admission: ExecutionAdmission = new ExecutionAdmission(),
    private readonly identity: ExecutionIdentity = Object.freeze({
      engine: "legacy-direct",
      schemaProfile: "legacy-v1",
    }),
    private readonly discovery?: LegacyDiscoveryPort
  ) {}

  public onEvent(listener: EventListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** True while a run holds the single execution slot, so a caller can decline before opening UI. */
  public get running(): boolean {
    return this.active;
  }

  public async diagnose(): Promise<readonly ExecutionDiagnostic[]> {
    this.workspaceTrust.require();
    await this.admission.ensureAvailable();
    return [];
  }

  public discover(options?: { readonly refresh?: boolean | undefined }): Promise<ExecutionDiscovery> {
    if (!this.discovery) {throw new Error("Legacy execution discovery is not configured.");}
    return this.discovery.discover(options);
  }

  public prepare(intent: RunIntent): Promise<PreparedExecution> {
    this.validate(intent);
    return Promise.resolve(Object.freeze({
      operationId: randomUUID(),
      identity: this.identity,
      intent: snapshotRunIntent(intent),
    }));
  }

  public run(prepared: PreparedExecution, options?: ExecutionOptions): Promise<RunCompletion> {
    return this.execute({ ...prepared.intent, mode: "run" }, options);
  }

  public debug(prepared: PreparedExecution, options?: ExecutionOptions): Promise<RunCompletion> {
    return this.execute({ ...prepared.intent, mode: "debug" }, options);
  }

  public async cancel(_prepared?: PreparedExecution): Promise<void> {
    this.operationAbort?.abort();
    await this.operationDone;
  }

  public async dispose(): Promise<void> {
    await this.cancel();
    this.listeners.clear();
  }

  /**
   * Admission for the single execution slot. Everything the run touches lives in `runIntent`, so
   * however that ends, including a dependency that throws before the first target is dispatched,
   * the slot is released.
   */
  public async execute(intent: RunIntent, options: ExecuteOptions = {}): Promise<RunCompletion> {
    return this.executeWithArtifactBatch(intent, options);
  }

  public async executeWithArtifactBatch(
    intent: RunIntent,
    options: ExecuteOptions = {},
    artifactBatch?: number,
    artifactOwnership?: readonly ScenarioRef[]
  ): Promise<RunCompletion> {
    this.validate(intent);
    this.workspaceTrust.require();
    if (this.active) {throw new ExecutionAlreadyRunningError();}
    this.active = true;
    const operationAbort = new AbortController();
    const forwardAbort = () => operationAbort.abort();
    options.signal?.addEventListener("abort", forwardAbort, { once: true });
    if (options.signal?.aborted) {operationAbort.abort();}
    this.operationAbort = operationAbort;
    let finishOperation: (() => void) | undefined;
    this.operationDone = new Promise<void>((resolve) => {finishOperation = resolve;});
    let trusted: ReturnType<WorkspaceTrust["begin"]> | undefined;
    try {
      await this.admission.ensureAvailable();
      if (operationAbort.signal.aborted) {
        return await this.runIntent(
          intent,
          { ...options, signal: operationAbort.signal },
          artifactBatch,
          artifactOwnership
        );
      }
      trusted = this.workspaceTrust.begin(operationAbort.signal);
      return await this.runIntent(intent, {
        ...options,
        signal: trusted.signal,
      }, artifactBatch, artifactOwnership);
    } finally {
      trusted?.dispose();
      options.signal?.removeEventListener("abort", forwardAbort);
      if (this.operationAbort === operationAbort) {this.operationAbort = undefined;}
      this.active = false;
      finishOperation?.();
      this.operationDone = undefined;
    }
  }

  private async runIntent(
    intent: RunIntent,
    options: ExecuteOptions,
    artifactBatch?: number,
    artifactOwnership?: readonly ScenarioRef[]
  ): Promise<RunCompletion> {
    const start = Date.now();
    const detailBudget = new DetailBudget();
    const runResults = new RunResultAccumulator(detailBudget);
    const liveSignatures = new Map<string, string>();
    const signal = options.signal;
    let finished = false;
    let failure: string | undefined;
    let state: RunArtifactState = "complete";
    const emit = (event: ExecutionEvent): void => {
      if (finished && event.kind !== "finished") {return;}
      if (event.kind === "finished") {
        if (finished) {return;}
        finished = true;
      }
      for (const listener of [options.onEvent, ...this.listeners]) {
        if (!listener) {continue;}
        try {listener(event);} catch { /* a UI listener cannot affect execution */ }
      }
    };
    const outputCapture = new BoundedCommandOutput((stream, text) => {
      if (finished) {return;}
      emit({ kind: "output", stream, text });
    });
    const emitOutput = outputCapture.onOutput;
    const progress: RunProgressObserver = {
      detailBudget,
      onBegin: (total) => emit({ kind: "begin", total }),
      // An abort stops the process and the remaining targets, never the bookkeeping: a case that
      // lands while the runner tears down still belongs to this run.
      onTestEnd: (detail, completed, total) => {
        if (finished) {return;}
        const aggregate = runResults.update(detail);
        const key = resultKey(aggregate);
        liveSignatures.set(key, resultSignature(aggregate));
        emit({ kind: "case-finished", result: aggregate, completed, total });
      },
      onOutput: emitOutput,
    };
    const consumeOutput = async (output: RunOutputResult): Promise<boolean> => {
      if (!output.outputStreamed) {
        if (output.output !== "") {emitOutput("stdout", output.output);}
        if (output.error && output.error !== "Cancelled") {emitOutput("stderr", output.error);}
      }
      const finalDetails = output.scenarioDetails ?? [];
      for (const detail of finalDetails) {
        const aggregate = runResults.update(detail);
        const key = resultKey(aggregate);
        if (liveSignatures.get(key) !== resultSignature(aggregate)) {
          liveSignatures.set(key, resultSignature(aggregate));
          emit({
            kind: "case-finished",
            result: aggregate,
            completed: runResults.executionCount,
            total: runResults.executionCount,
          });
        }
      }
      if (output.admissionUnsafe) {
        const unsafeFailure = output.infrastructureFailure
          ?? "The previous process tree could not be confirmed stopped.";
        try {
          await this.admission.block(output.terminationLease ?? terminationLease({
            kind: "debug-session",
            failure: unsafeFailure,
          }));
          failure = unsafeFailure;
        } catch (error) {
          failure = `${unsafeFailure} ${errorMessage(error)}`;
        }
        state = "partial";
        return false;
      }
      if (signal?.aborted) {
        state = "cancelled";
        return false;
      }
      if (output.infrastructureFailure || (!output.success && finalDetails.length === 0)) {
        failure = output.infrastructureFailure
          ?? output.error
          ?? "The test process failed without a complete report.";
        state = "partial";
        return false;
      }
      return true;
    };

    emit({ kind: "started", targetCount: intent.targets.length });
    const scenarioScopes = artifactOwnership ?? intent.targets.flatMap((target): readonly ScenarioRef[] => {
      if (target.kind === "scenario") {return [target.scenario];}
      if (target.kind === "scenarios") {return target.scenarios;}
      return [];
    });
    try {
      if (intent.maxWorkers !== undefined) {
        this.executor.setForceParallel(true, intent.maxWorkers);
      }
      for (const target of intent.targets) {
        if (signal?.aborted) {
          state = "cancelled";
          break;
        }
        await this.dispatch(
          intent.mode,
          target,
          signal,
          artifactBatch,
          progress,
          scenarioScopes,
          consumeOutput
        );
        if (state !== "complete") {break;}
      }
    } catch (error) {
      if (signal?.aborted) {
        state = "cancelled";
      } else {
        state = "partial";
        failure = errorMessage(error);
      }
    }

    if (intent.maxWorkers !== undefined) {
      try {
        this.executor.setForceParallel(false);
      } catch (error) {
        if (!signal?.aborted) {
          state = "partial";
          failure ??= errorMessage(error);
        }
      }
    }
    if (signal?.aborted && !this.admission.blocked) {state = "cancelled";}
    const results = runResults.results();
    const counts = tally(results);
    const completion: RunCompletion = Object.freeze({
      identity: this.identity,
      state,
      results: Object.freeze([...results]),
      output: outputCapture.format(),
      ...counts,
      durationMs: Math.max(1, Date.now() - start),
      ...(failure ? { failure } : {}),
    });
    // What was discarded is part of the transcript, so it rides the same stream every other line
    // does. A consumer that streamed the run learns of the loss without re-reading the completion,
    // which is how the same text used to reach some surfaces twice and others not at all.
    for (const notice of outputCapture.truncationNotices()) {
      emit({ kind: "output", stream: notice.stream, text: `${notice.text}\n` });
    }
    emit({ kind: "finished", completion });
    if (state === "partial") {throw new ExecutionFailure(completion);}
    return completion;
  }

  private validate(intent: RunIntent): void {
    const workers = intent.maxWorkers;
    if (
      workers !== undefined &&
      (!Number.isInteger(workers) ||
        workers < MAX_PARALLEL_PROCESSES_MIN ||
        workers > MAX_PARALLEL_PROCESSES_MAX)
    ) {
      throw new Error(
        `maxWorkers must be an integer between ${MAX_PARALLEL_PROCESSES_MIN} and ${MAX_PARALLEL_PROCESSES_MAX}.`
      );
    }
  }

  private async dispatch(
    mode: RunIntent["mode"],
    target: RunTarget,
    signal: AbortSignal | undefined,
    artifactBatch: number | undefined,
    progress: RunProgressObserver,
    scenarioScopes: readonly ScenarioRef[],
    consume: (output: RunOutputResult) => Promise<boolean>
  ): Promise<void> {
    if (target.kind === "scenario") {
      await this.runScenarioTarget(
        mode,
        target.scenario,
        signal,
        artifactBatch,
        progress,
        target.tagExpression,
        scenarioScopes,
        consume
      );
      return;
    }
    if (target.kind === "scenarios") {
      for (const scenario of target.scenarios) {
        if (signal?.aborted) {break;}
        const shouldContinue = await this.runScenarioTarget(
          mode,
          scenario,
          signal,
          artifactBatch,
          progress,
          undefined,
          scenarioScopes,
          consume
        );
        if (!shouldContinue) {break;}
      }
      return;
    }
    if (target.kind === "path") {
      if (mode === "debug") {
        await consume(await this.executor.debugScenarioWithOutput({
          filePath: target.path,
          ...(signal ? { signal } : {}),
          ...(artifactBatch !== undefined ? { artifactBatch } : {}),
          progress,
        }));
        return;
      }
      await consume(await this.executor.runPathFilterWithOutput(
        target.path,
        signal,
        artifactBatch,
        progress,
        target.tagExpression,
        target.titles
      ));
      return;
    }
    if (mode === "debug") {
      throw new Error(`Debug mode does not support the ${target.kind} target.`);
    }
    if (target.kind === "tag-expression") {
      await consume(await this.executor.runAllTestsWithTagsOutput(
        target.expression,
        signal,
        artifactBatch,
        progress
      ));
      return;
    }
    await consume(await this.executor.runSuiteWithOutput(signal, artifactBatch, progress));
  }

  private async runScenarioTarget(
    mode: RunIntent["mode"],
    scenario: ScenarioRef,
    signal: AbortSignal | undefined,
    artifactBatch: number | undefined,
    progress: RunProgressObserver,
    tagExpression: string | undefined,
    scenarioScopes: readonly ScenarioRef[],
    consume: (output: RunOutputResult) => Promise<boolean>
  ): Promise<boolean> {
    const rows = this.outlineRows(scenario.filePath);
    const capture = artifactCaptureTarget(scenario, rows, scenarioScopes);
    const exactLines = scenario.kind === "examplesBlock"
      ? capture.resultLines
      : scenario.kind === "outline" && scenario.line > 0 && targetLine(scenario, rows) === 0
        ? capture.resultLines
        : undefined;
    if (exactLines === undefined) {
      const options = scenarioOptions(
        scenario,
        rows,
        signal,
        artifactBatch,
        progress,
        tagExpression
      );
      return consume(mode === "debug"
        ? await this.executor.debugScenarioWithOutput(options, capture)
        : await this.executor.runScenarioWithOutput(options, capture));
    }
    for (const line of exactLines) {
      if (signal?.aborted) {return false;}
      const row = rows.find((candidate) => candidate.lineNumber === line);
      if (!row) {
        throw new Error(
          `Could not recover the exact example row ${scenario.filePath}:${line}. ` +
            "No broader outline target was executed."
        );
      }
      const rowRef: ScenarioRef = {
        filePath: scenario.filePath,
        line,
        name: row.outlineName,
        kind: "outline",
        outlineName: row.outlineName,
      };
      const options = scenarioOptions(
        rowRef,
        rows,
        signal,
        artifactBatch,
        progress,
        tagExpression
      );
      const target = { scenario, resultLines: [line] };
      const shouldContinue = await consume(mode === "debug"
        ? await this.executor.debugScenarioWithOutput(options, target)
        : await this.executor.runScenarioWithOutput(options, target));
      if (!shouldContinue) {return false;}
    }
    return true;
  }

  private outlineRows(filePath: string): OutlineExampleRow[] {
    return this.featureParser.parseFeatureFile(filePath)?.scenarios.filter(isOutlineExampleRow) ?? [];
  }

}
