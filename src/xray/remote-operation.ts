import { randomUUID } from "node:crypto";
import type { RemoteOperationName as CoreRemoteOperationName } from "../core/remote-operation-name";
import { RemoteOutcomeUnknownError } from "../core/workspace-trust";
import type { Logger } from "../utils/logger";

export type RemoteOperationClass = "read" | "idempotent-write" | "non-idempotent-write";
export type RetryBudget = "authentication" | "read" | "write";
export type OutcomeCertainty = "confirmed" | "failed" | "unknown";

export type RemoteOperationName = CoreRemoteOperationName;

export interface RemoteOperationPolicy {
  readonly class: RemoteOperationClass;
  readonly budget: RetryBudget;
  readonly attempts: number;
  readonly idempotencyKey: boolean;
}

const READ: RemoteOperationPolicy = { class: "read", budget: "read", attempts: 4, idempotencyKey: false };

// This is the audit seam for every production request made by the Xray/Jira integration. Mutation
// entries without a provider idempotency key deliberately have one attempt. A caller may only retry
// one after a provider-specific reconciliation has proved that the first attempt did not commit.
export const REMOTE_OPERATION_POLICY: Readonly<Record<RemoteOperationName, RemoteOperationPolicy>> = {
  "xray.authenticate": { class: "read", budget: "authentication", attempts: 2, idempotencyKey: false },
  "xray.graphql.read": READ,
  "xray.test.create": { class: "non-idempotent-write", budget: "write", attempts: 1, idempotencyKey: false },
  "xray.test-set.create": { class: "non-idempotent-write", budget: "write", attempts: 1, idempotencyKey: false },
  "xray.test-plan.create": { class: "non-idempotent-write", budget: "write", attempts: 1, idempotencyKey: false },
  "xray.test-set.add-tests": { class: "non-idempotent-write", budget: "write", attempts: 1, idempotencyKey: false },
  "xray.test-plan.add-tests": { class: "non-idempotent-write", budget: "write", attempts: 1, idempotencyKey: false },
  "xray.execution.create": { class: "non-idempotent-write", budget: "write", attempts: 1, idempotencyKey: false },
  "xray.gherkin.update": { class: "non-idempotent-write", budget: "write", attempts: 1, idempotencyKey: false },
  "xray.execution.import-json": { class: "non-idempotent-write", budget: "write", attempts: 1, idempotencyKey: false },
  "xray.execution.import-cucumber": { class: "non-idempotent-write", budget: "write", attempts: 1, idempotencyKey: false },
  "jira.attachment-meta.read": READ,
  "jira.attachment.upload": { class: "non-idempotent-write", budget: "write", attempts: 1, idempotencyKey: false },
  "jira.issue-types.read": READ,
  "jira.issues.read": READ,
  "jira.projects.read": READ,
  "jira.profile.read": READ,
};

export interface OperationIdentity {
  readonly id: string;
  readonly name: RemoteOperationName;
}

export function operationIdentity(name: RemoteOperationName, id: string = randomUUID()): OperationIdentity {
  return { id, name };
}

export class RetryableRemoteError extends Error {
  constructor(
    message: string,
    public readonly retryAfterMs?: number
  ) {
    super(message);
    this.name = "RetryableRemoteError";
  }
}

export function retryAfterMilliseconds(value: string | null, now = Date.now()): number | undefined {
  if (value === null) {return undefined;}
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) {return Math.ceil(seconds * 1000);}
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - now) : undefined;
}

export function abortableRemoteSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {reject(signal.reason ?? new Error("Aborted")); return;}
    const onAbort = (): void => {clearTimeout(timer); reject(signal?.reason ?? new Error("Aborted"));};
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const BACKOFF_BASE_MS = 300;
const BACKOFF_CAP_MS = 8_000;

function delayFor(attempt: number, random: () => number, retryAfterMs?: number): number {
  const exponential = Math.min(BACKOFF_CAP_MS, BACKOFF_BASE_MS * 2 ** (attempt - 1));
  return Math.max(retryAfterMs ?? 0, exponential + Math.floor(random() * BACKOFF_BASE_MS));
}

export interface RunRemoteOperationDeps {
  readonly identity: OperationIdentity;
  readonly logger?: Logger | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly random: () => number;
  readonly abortError: () => Error;
}

export async function runRemoteOperation<T>(
  run: (attempt: number) => Promise<T>,
  deps: RunRemoteOperationDeps
): Promise<T> {
  const policy = REMOTE_OPERATION_POLICY[deps.identity.name];
  for (let attempt = 1; ; attempt += 1) {
    if (deps.signal?.aborted) {throw deps.abortError();}
    try {
      const result = await run(attempt);
      deps.logger?.info("Remote operation completed", {
        operationId: deps.identity.id,
        operation: deps.identity.name,
        operationClass: policy.class,
        attempt,
        outcomeCertainty: "confirmed" satisfies OutcomeCertainty,
      });
      return result;
    } catch (error) {
      if (!(error instanceof RetryableRemoteError)) {
        deps.logger?.warn("Remote operation failed", {
          operationId: deps.identity.id,
          operation: deps.identity.name,
          operationClass: policy.class,
          attempt,
          outcomeCertainty: "failed" satisfies OutcomeCertainty,
        });
        throw error;
      }
      if (policy.class !== "read" && !policy.idempotencyKey) {
        deps.logger?.warn("Remote operation outcome is unknown", {
          operationId: deps.identity.id,
          operation: deps.identity.name,
          operationClass: policy.class,
          attempt,
          outcomeCertainty: "unknown" satisfies OutcomeCertainty,
        });
        throw new RemoteOutcomeUnknownError(
          deps.identity.name,
          deps.identity.id,
          "The response did not prove whether the operation committed."
        );
      }
      if (attempt >= policy.attempts || deps.signal?.aborted) {
        deps.logger?.warn("Remote operation failed", {
          operationId: deps.identity.id,
          operation: deps.identity.name,
          operationClass: policy.class,
          attempt,
          outcomeCertainty: "failed" satisfies OutcomeCertainty,
        });
        throw error;
      }
      const backoffMs = delayFor(attempt, deps.random, error.retryAfterMs);
      deps.logger?.info("Remote operation retry scheduled", {
        operationId: deps.identity.id,
        operation: deps.identity.name,
        operationClass: policy.class,
        attempt,
        backoffMs,
        outcomeCertainty: "failed" satisfies OutcomeCertainty,
      });
      await deps.sleep(backoffMs, deps.signal);
    }
  }
}
