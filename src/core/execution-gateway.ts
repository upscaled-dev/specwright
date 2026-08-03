import { DetailBudget } from "./execution-limits";
import {
  MAX_PARALLEL_PROCESSES_MAX,
  MAX_PARALLEL_PROCESSES_MIN,
} from "./extension-config";
import type {
  ExecutionCaseResult,
  ExecutionEvent,
  ExecutionGateway,
  RunCompletion,
  RunIntent,
  RunTarget,
} from "./run-contracts";
import type { RunProgressObserver } from "./run-progress";
import type { RunOutputResult, TestExecutor } from "./test-executor";
import { isOutlineExampleRow, type FeatureParser } from "../parsers/feature-parser";
import { artifactCaptureTarget } from "../traceability/batch-selection";
import type { RunArtifactState } from "../traceability/contracts";
import type { RunArtifactStore } from "../traceability/run-artifact-store";
import type { OutlineExampleRow } from "../types";
import { refIdentity, scenarioRefFromResult, type ScenarioRef } from "../traceability/scenario-ref";
import type { Logger } from "../utils/logger";
import type { ScenarioResult, StepResult } from "../utils/playwright-json-parser";
import { BoundedCommandOutput } from "./bounded-command-runner";

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

export class ExtensionExecutionGateway implements ExecutionGateway {
  private active = false;
  private admissionBlocked = false;
  private readonly listeners = new Set<EventListener>();

  constructor(
    private readonly executor: TestExecutor,
    private readonly artifactStore: RunArtifactStore | undefined,
    private readonly featureParser: FeatureParser,
    private readonly logger: Logger,
    // Which scenarios the tracker maps, so artifact capture can tell a separately mapped Examples
    // block from rows the enclosing outline owns. Run membership cannot answer that.
    private readonly mappedScenarios: () => readonly ScenarioRef[]
  ) {}

  public onEvent(listener: EventListener): { dispose(): void } {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  /** True while a run holds the single execution slot, so a caller can decline before opening UI. */
  public get running(): boolean {
    return this.active;
  }

  /**
   * Admission for the single execution slot. Everything the run touches lives in `runIntent`, so
   * however that ends, including a dependency that throws before the first target is dispatched,
   * the slot is released.
   */
  public async execute(intent: RunIntent, options: ExecuteOptions = {}): Promise<RunCompletion> {
    this.validate(intent);
    if (this.active) {throw new ExecutionAlreadyRunningError();}
    this.active = true;
    try {
      return await this.runIntent(intent, options);
    } finally {
      if (!this.admissionBlocked) {this.active = false;}
    }
  }

  private async runIntent(intent: RunIntent, options: ExecuteOptions): Promise<RunCompletion> {
    const start = Date.now();
    const detailBudget = new DetailBudget();
    const runResults = new RunResultAccumulator(detailBudget);
    // One snapshot for the whole run: a sync landing mid-run must not build one artifact against two.
    const mapped = Object.freeze([...this.mappedScenarios()]);
    const liveSignatures = new Map<string, string>();
    const signal = options.signal;
    let finished = false;
    let failure: string | undefined;
    let state: RunArtifactState = "complete";
    let artifactId: string | undefined;
    let handle: number | undefined;
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

    emit({ kind: "started", targetCount: intent.targets.length });
    try {
      handle = this.artifactStore?.beginBatch(intent.selection, intent.decisions ?? []);
      if (intent.maxWorkers !== undefined) {
        this.executor.setForceParallel(true, intent.maxWorkers);
      }
      for (const target of intent.targets) {
        if (signal?.aborted) {
          state = "cancelled";
          break;
        }
        const targetResults = await this.dispatch(
          intent.mode,
          target,
          signal,
          handle,
          progress,
          mapped
        );
        for (const output of targetResults) {
          if (!output.outputStreamed) {
            if (output.output !== "") {emitOutput("stdout", output.output);}
            if (output.error && output.error !== "Cancelled") {
              emitOutput("stderr", output.error);
            }
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
            this.admissionBlocked = true;
            failure = output.infrastructureFailure
              ?? "The previous process tree could not be confirmed stopped.";
            state = "partial";
            break;
          }
          if (signal?.aborted) {
            state = "cancelled";
            break;
          }
          if (output.infrastructureFailure || (!output.success && finalDetails.length === 0)) {
            failure = output.infrastructureFailure
              ?? output.error
              ?? "The test process failed without a complete report.";
            state = "partial";
            break;
          }
        }
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
    if (signal?.aborted && !this.admissionBlocked) {state = "cancelled";}
    if (handle !== undefined) {artifactId = this.seal(handle, state);}
    const results = runResults.results();
    const counts = tally(results);
    const completion: RunCompletion = Object.freeze({
      state,
      results: Object.freeze([...results]),
      output: outputCapture.format(),
      ...counts,
      durationMs: Math.max(1, Date.now() - start),
      ...(artifactId ? { artifactId } : {}),
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

  // The artifact is a publish buffer, not the run's verdict: its own state and any storage failure
  // are recorded for diagnosis and never change what the run reports.
  private seal(handle: number, state: RunArtifactState): string | undefined {
    try {
      const artifact = this.artifactStore?.sealBatch(handle, state);
      if (artifact === undefined) {return undefined;}
      if (artifact.state !== state) {
        this.logger.warn("The sealed run artifact disagrees with the run outcome", {
          run: state,
          artifact: artifact.state,
        });
      }
      return artifact.id;
    } catch (error) {
      this.logger.warn(`Failed to seal the run artifact: ${errorMessage(error)}`);
      return undefined;
    }
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
    mapped: readonly ScenarioRef[]
  ): Promise<readonly RunOutputResult[]> {
    if (target.kind === "scenario") {
      return this.runScenarioTarget(
        mode,
        target.scenario,
        signal,
        artifactBatch,
        progress,
        mapped,
        target.tagExpression
      );
    }
    if (target.kind === "scenarios") {
      const outputs: RunOutputResult[] = [];
      for (const scenario of target.scenarios) {
        if (signal?.aborted) {break;}
        outputs.push(...await this.runScenarioTarget(
          mode,
          scenario,
          signal,
          artifactBatch,
          progress,
          mapped
        ));
      }
      return outputs;
    }
    if (target.kind === "path") {
      if (mode === "debug") {
        return [await this.executor.debugScenarioWithOutput({
          filePath: target.path,
          ...(signal ? { signal } : {}),
          ...(artifactBatch !== undefined ? { artifactBatch } : {}),
          progress,
        })];
      }
      return [await this.executor.runPathFilterWithOutput(
        target.path,
        signal,
        artifactBatch,
        progress,
        target.tagExpression,
        target.titles
      )];
    }
    if (mode === "debug") {
      throw new Error(`Debug mode does not support the ${target.kind} target.`);
    }
    if (target.kind === "tag-expression") {
      return [await this.executor.runAllTestsWithTagsOutput(
        target.expression,
        signal,
        artifactBatch,
        progress
      )];
    }
    return [await this.executor.runSuiteWithOutput(signal, artifactBatch, progress)];
  }

  private async runScenarioTarget(
    mode: RunIntent["mode"],
    scenario: ScenarioRef,
    signal: AbortSignal | undefined,
    artifactBatch: number | undefined,
    progress: RunProgressObserver,
    mapped: readonly ScenarioRef[],
    tagExpression?: string
  ): Promise<RunOutputResult[]> {
    const rows = this.outlineRows(scenario.filePath);
    const capture = artifactCaptureTarget(scenario, rows, mapped);
    const exactLines = scenario.kind === "examplesBlock"
      ? capture.resultLines
      : scenario.kind === "outline" && scenario.line > 0 && targetLine(scenario, rows) === 0
        ? capture.resultLines
        : undefined;
    if (exactLines === undefined) {
      return [await this.runScenario(
        mode,
        scenario,
        signal,
        artifactBatch,
        progress,
        mapped,
        tagExpression
      )];
    }
    if (rows.length === 0) {
      throw new Error(
        `Could not resolve exact example rows for ${scenario.filePath}:${scenario.line}. ` +
          "No broader outline target was executed."
      );
    }
    const outputs: RunOutputResult[] = [];
    for (const line of exactLines) {
      if (signal?.aborted) {break;}
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
      outputs.push(mode === "debug"
        ? await this.executor.debugScenarioWithOutput(options, target)
        : await this.executor.runScenarioWithOutput(options, target));
    }
    return outputs;
  }

  private runScenario(
    mode: RunIntent["mode"],
    scenario: ScenarioRef,
    signal: AbortSignal | undefined,
    artifactBatch: number | undefined,
    progress: RunProgressObserver,
    mapped: readonly ScenarioRef[],
    tagExpression?: string
  ): Promise<RunOutputResult> {
    const rows = this.outlineRows(scenario.filePath);
    const target = artifactCaptureTarget(scenario, rows, mapped);
    const options = scenarioOptions(scenario, rows, signal, artifactBatch, progress, tagExpression);
    return mode === "debug"
      ? this.executor.debugScenarioWithOutput(options, target)
      : this.executor.runScenarioWithOutput(options, target);
  }

  private outlineRows(filePath: string): OutlineExampleRow[] {
    return this.featureParser.parseFeatureFile(filePath)?.scenarios.filter(isOutlineExampleRow) ?? [];
  }

}
