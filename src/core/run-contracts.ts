export type ExecutionEngine = "legacy-direct" | "core-client";

export interface ExecutionCaseRef {
  readonly filePath: string;
  readonly line: number;
  readonly name: string;
  readonly kind: "scenario" | "outline" | "examplesBlock";
  readonly outlineName?: string | undefined;
  readonly examplesBlockName?: string | undefined;
}

export type ExecutionOutcome = "passed" | "failed" | "skipped" | "timed-out" | "interrupted";

export interface ExecutionIdentity {
  readonly engine: ExecutionEngine;
  readonly schemaProfile: string;
}

export interface ExecutionDiagnostic {
  readonly code: string;
  readonly severity: "info" | "warning" | "error";
  readonly message: string;
  readonly identity: ExecutionIdentity;
}

export interface ExecutionDiscovery {
  readonly cases: readonly ExecutionDefinition[];
  readonly diagnostics: readonly ExecutionDiagnostic[];
}

export interface ExecutionDefinition {
  readonly id: string;
  readonly name: string;
  readonly source: { readonly path: string; readonly line: number };
  readonly suites: readonly {
    readonly name: string;
    readonly source?: { readonly path: string; readonly line: number } | undefined;
  }[];
  readonly tags: readonly string[];
  readonly parameterized?: {
    readonly groupName: string;
    readonly groupLine: number;
    readonly blockLine?: number | undefined;
    readonly blockName?: string | undefined;
    readonly substitutedName?: string | undefined;
  } | undefined;
}

export interface PreparedExecution {
  readonly operationId: string;
  readonly identity: ExecutionIdentity;
  readonly intent: RunIntent;
}

/** A source-language step result. Kept here so the gateway contract has no runner DTO imports. */
export interface ExecutionStepResult {
  readonly title: string;
  readonly status: "passed" | "failed";
  readonly durationMs?: number | undefined;
}

export type RunMode = "run" | "debug";

export type RunTarget =
  | { readonly kind: "scenario"; readonly scenario: ExecutionCaseRef; readonly tagExpression?: string | undefined }
  | { readonly kind: "scenarios"; readonly scenarios: readonly ExecutionCaseRef[] }
  // `titles` narrows a path target to named scenarios of that file, which is what makes a batched
  // selection precise: the path scopes the run to one feature, the titles to scenarios inside it.
  | {
      readonly kind: "path";
      readonly path: string;
      readonly tagExpression?: string | undefined;
      readonly titles?: readonly string[] | undefined;
    }
  | { readonly kind: "tag-expression"; readonly expression: string }
  | { readonly kind: "suite" };

export interface RunIntent {
  readonly mode: RunMode;
  readonly targets: readonly RunTarget[];
  readonly maxWorkers?: number | undefined;
}

function snapshotCaseRef(ref: ExecutionCaseRef): ExecutionCaseRef {
  return Object.freeze({ ...ref });
}

function snapshotTarget(target: RunTarget): RunTarget {
  if (target.kind === "scenario") {
    return Object.freeze({
      ...target,
      scenario: snapshotCaseRef(target.scenario),
    });
  }
  if (target.kind === "scenarios") {
    return Object.freeze({
      kind: "scenarios",
      scenarios: Object.freeze(target.scenarios.map(snapshotCaseRef)),
    });
  }
  if (target.kind === "path") {
    return Object.freeze({
      ...target,
      ...(target.titles ? { titles: Object.freeze([...target.titles]) } : {}),
    });
  }
  return Object.freeze({ ...target });
}

/** Takes the immutable portable snapshot that crosses an execution-engine boundary. */
export function snapshotRunIntent(intent: RunIntent): RunIntent {
  return Object.freeze({
    mode: intent.mode,
    targets: Object.freeze(intent.targets.map(snapshotTarget)),
    ...(intent.maxWorkers !== undefined ? { maxWorkers: intent.maxWorkers } : {}),
  });
}

export interface ExecutionCaseResult {
  readonly scenario: ExecutionCaseRef;
  readonly outcome: ExecutionOutcome;
  readonly durationMs: number;
  readonly attempts: number;
  readonly flaky: boolean;
  readonly errorMessage?: string | undefined;
  readonly errorStack?: string | undefined;
  // Bulky, so it rides the live session's per-run detail budget; the Test Explorer summary renders
  // one line per step from it.
  readonly steps?: readonly ExecutionStepResult[] | undefined;
}

export interface RunCompletion {
  readonly identity: ExecutionIdentity;
  readonly state: "complete" | "partial" | "cancelled";
  readonly results: readonly ExecutionCaseResult[];
  readonly output: string;
  readonly passed: number;
  readonly failed: number;
  readonly durationMs: number;
  readonly artifactId?: string | undefined;
  readonly failure?: string | undefined;
}

export type ExecutionEvent =
  | { readonly kind: "started"; readonly targetCount: number }
  // The engine's own case count for one dispatched target, emitted when that target starts.
  | { readonly kind: "begin"; readonly total: number }
  | {
      readonly kind: "case-finished";
      readonly result: ExecutionCaseResult;
      readonly completed: number;
      readonly total: number;
    }
  | { readonly kind: "output"; readonly stream: "stdout" | "stderr"; readonly text: string }
  | { readonly kind: "finished"; readonly completion: RunCompletion };

/** The production execution-service seam. It stays free of editor and runner-specific types. */
export interface ExecutionGateway {
  readonly running: boolean;
  diagnose(): Promise<readonly ExecutionDiagnostic[]>;
  discover(options?: { readonly refresh?: boolean | undefined }): Promise<ExecutionDiscovery>;
  prepare(intent: RunIntent): Promise<PreparedExecution>;
  run(
    prepared: PreparedExecution,
    options?: {
      readonly signal?: AbortSignal | undefined;
      readonly onEvent?: ((event: ExecutionEvent) => void) | undefined;
    }
  ): Promise<RunCompletion>;
  debug(
    prepared: PreparedExecution,
    options?: {
      readonly signal?: AbortSignal | undefined;
      readonly onEvent?: ((event: ExecutionEvent) => void) | undefined;
    }
  ): Promise<RunCompletion>;
  cancel(prepared?: PreparedExecution): Promise<void>;
  dispose(): void | Promise<void>;
}

export type ExecutionServiceGateway = ExecutionGateway;
export type ExecutionOptions = Parameters<ExecutionGateway["run"]>[1];

export class ExecutionDiagnosticError extends Error {
  constructor(readonly diagnostic: ExecutionDiagnostic) {
    super(diagnostic.message);
    this.name = "ExecutionDiagnosticError";
  }
}

export async function requireExecutionAvailable(gateway: ExecutionGateway): Promise<void> {
  const unavailable = (await gateway.diagnose()).find(({ severity }) => severity === "error");
  if (unavailable) {throw new ExecutionDiagnosticError(unavailable);}
}

export async function startExecution(
  gateway: ExecutionGateway,
  intent: RunIntent,
  options?: ExecutionOptions
): Promise<RunCompletion> {
  await requireExecutionAvailable(gateway);
  const prepared = await gateway.prepare(intent);
  return intent.mode === "debug"
    ? gateway.debug(prepared, options)
    : gateway.run(prepared, options);
}
