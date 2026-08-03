import type {
  BatchSelection,
  PreflightDecision,
  RunArtifactOutcome,
} from "../traceability/contracts";
import type { ScenarioRef } from "../traceability/scenario-ref";
import type { StepResult } from "../utils/playwright-json-parser";

export type RunMode = "run" | "debug";

export type RunInitiator =
  | "test-explorer"
  | "code-lens"
  | "editor"
  | "explorer"
  | "palette"
  | "traceability-tree"
  | "coverage-board";

export type RunTarget =
  | { readonly kind: "scenario"; readonly scenario: ScenarioRef; readonly tagExpression?: string | undefined }
  | { readonly kind: "scenarios"; readonly scenarios: readonly ScenarioRef[] }
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
  readonly selection: BatchSelection;
  readonly targets: readonly RunTarget[];
  readonly decisions?: readonly PreflightDecision[] | undefined;
  readonly maxWorkers?: number | undefined;
  readonly metadata?: { readonly initiatedBy?: RunInitiator | undefined } | undefined;
}

export interface ExecutionCaseResult {
  readonly scenario: ScenarioRef;
  readonly outcome: RunArtifactOutcome;
  readonly durationMs: number;
  readonly attempts: number;
  readonly flaky: boolean;
  readonly errorMessage?: string | undefined;
  readonly errorStack?: string | undefined;
  // Bulky, so it rides the live session's per-run detail budget; the Test Explorer summary renders
  // one line per step from it.
  readonly steps?: readonly StepResult[] | undefined;
}

export interface RunCompletion {
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
  // The runner's own case count for one dispatched target, reported when its reporter opens.
  | { readonly kind: "begin"; readonly total: number }
  | {
      readonly kind: "case-finished";
      readonly result: ExecutionCaseResult;
      readonly completed: number;
      readonly total: number;
    }
  | { readonly kind: "output"; readonly stream: "stdout" | "stderr"; readonly text: string }
  | { readonly kind: "finished"; readonly completion: RunCompletion };

export interface ExecutionGateway {
  /** True while a run holds the single execution slot. */
  readonly running: boolean;
  execute(
    intent: RunIntent,
    options?: {
      readonly signal?: AbortSignal | undefined;
      readonly onEvent?: ((event: ExecutionEvent) => void) | undefined;
    }
  ): Promise<RunCompletion>;
}
