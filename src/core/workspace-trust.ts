export const WORKSPACE_TRUST_REQUIRED = "WORKSPACE_TRUST_REQUIRED";

export class WorkspaceTrustRequiredError extends Error {
  public readonly code = WORKSPACE_TRUST_REQUIRED;

  constructor() {
    super("Trust this workspace to run tests or use project-backed integrations.");
    this.name = "WorkspaceTrustRequiredError";
  }
}

export class WorkspaceTrustRevokedError extends Error {
  constructor() {
    super("Workspace trust was revoked.");
    this.name = "WorkspaceTrustRevokedError";
  }
}

export class RemoteOutcomeUnknownError extends Error {
  public readonly code = "REMOTE_OUTCOME_UNKNOWN";

  constructor(
    action: string,
    public readonly operationId: string,
    reason?: string
  ) {
    super(reason === undefined
      ? `${action} may have reached the remote service before workspace trust was revoked. Check the remote service before retrying.`
      : `${action} may have reached the remote service. ${reason} Check the remote service before retrying.`);
    this.name = "RemoteOutcomeUnknownError";
  }
}

export function isTrustRevocation(signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && signal.reason instanceof WorkspaceTrustRevokedError;
}

export interface PrivilegedOperation {
  readonly signal: AbortSignal;
  dispose(): void;
}

interface ActiveOperation {
  readonly controller: AbortController;
  readonly settled: Promise<void>;
  settle(): void;
}

const DRAIN_TIMEOUT_MS = 6_000;

/** One fail-closed admission and cancellation owner for workspace-controlled effects. */
export class WorkspaceTrust {
  private readonly active = new Set<ActiveOperation>();
  private disposed = false;
  private draining: Promise<void> | undefined;

  constructor(private readonly trusted: () => boolean) {}

  public get available(): boolean {
    return !this.disposed && this.trusted();
  }

  public require(): void {
    if (!this.available) {throw new WorkspaceTrustRequiredError();}
  }

  public begin(signal?: AbortSignal): PrivilegedOperation {
    this.require();
    if (signal?.aborted) {throw signal.reason ?? new Error("Aborted");}
    const controller = new AbortController();
    const abort = (): void => controller.abort(signal?.reason);
    signal?.addEventListener("abort", abort, { once: true });
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {settle = resolve;});
    const active = { controller, settled, settle };
    this.active.add(active);
    let finished = false;
    return {
      signal: controller.signal,
      dispose: () => {
        if (finished) {return;}
        finished = true;
        signal?.removeEventListener("abort", abort);
        this.active.delete(active);
        active.settle();
      },
    };
  }

  public async run<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal
  ): Promise<T> {
    const active = this.begin(signal);
    try {
      if (active.signal.aborted) {throw active.signal.reason ?? new Error("Aborted");}
      return await operation(active.signal);
    } finally {
      active.dispose();
    }
  }

  public dispose(): Promise<void> {
    if (this.draining) {return this.draining;}
    this.disposed = true;
    const operations = [...this.active];
    for (const { controller } of operations) {
      controller.abort(new WorkspaceTrustRevokedError());
    }
    const drained = Promise.all(operations.map(({ settled }) => settled)).then(() => undefined);
    let timer: ReturnType<typeof setTimeout>;
    const timeout = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, DRAIN_TIMEOUT_MS);
      timer.unref?.();
    });
    this.draining = Promise.race([drained, timeout]).finally(() => clearTimeout(timer));
    return this.draining;
  }
}
