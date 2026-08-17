import { snapshotRunIntent, type RunIntent } from "../core/run-contracts";
import type { BatchSelection, PreflightDecision } from "../traceability/contracts";
import type { ScenarioRef } from "../traceability/scenario-ref";

export type RunInitiator =
  | "test-explorer"
  | "code-lens"
  | "editor"
  | "explorer"
  | "palette"
  | "traceability-tree";

export interface ExecutionClientContext {
  readonly selection: BatchSelection;
  readonly decisions?: readonly PreflightDecision[] | undefined;
  readonly initiatedBy?: RunInitiator | undefined;
  readonly artifactOwnership?: readonly ScenarioRef[] | undefined;
}

export interface ClientRunIntent extends RunIntent {
  readonly selection: BatchSelection;
  readonly decisions?: readonly PreflightDecision[] | undefined;
  readonly metadata?: { readonly initiatedBy?: RunInitiator | undefined } | undefined;
}

export type ArtifactOwnershipResolver = () => readonly ScenarioRef[];

const contexts = new WeakMap<RunIntent, ExecutionClientContext>();

export function withExecutionClientContext(
  intent: RunIntent,
  context: ExecutionClientContext
): ClientRunIntent {
  const projected = { ...snapshotRunIntent(intent) } as ClientRunIntent;
  const artifactOwnership = context.artifactOwnership?.map((ref) => Object.freeze({ ...ref }));
  Object.defineProperties(projected, {
    selection: { enumerable: false, value: context.selection },
    decisions: { enumerable: false, value: context.decisions },
    metadata: {
      enumerable: false,
      value: context.initiatedBy ? Object.freeze({ initiatedBy: context.initiatedBy }) : undefined,
    },
  });
  const frozen = Object.freeze(projected);
  contexts.set(frozen, Object.freeze({
    ...context,
    ...(artifactOwnership ? { artifactOwnership: Object.freeze(artifactOwnership) } : {}),
  }));
  return frozen;
}

export function executionClientContext(intent: RunIntent): ExecutionClientContext | undefined {
  return contexts.get(intent);
}

/** Freezes the complete mapped ownership set beside, never inside, the portable run intent. */
export function executionClientContextForCapture(
  intent: RunIntent,
  ownership?: ArtifactOwnershipResolver
): ExecutionClientContext | undefined {
  const context = executionClientContext(intent);
  if (!context) {return undefined;}
  const refs = ownership?.() ?? context.artifactOwnership ?? [];
  return Object.freeze({
    ...context,
    artifactOwnership: Object.freeze(refs.map((ref) => Object.freeze({ ...ref }))),
  });
}
