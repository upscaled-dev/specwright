import type {
  ExecutionDiagnostic,
  ExecutionDiscovery,
  ExecutionIdentity,
  ExecutionOptions,
  ExecutionServiceGateway,
  PreparedExecution,
  RunCompletion,
  RunIntent,
} from "./run-contracts";

export const CORE_CLIENT_UNAVAILABLE = "execution.core-client.unavailable";
export const CORE_CLIENT_UNAVAILABLE_MESSAGE =
  "Core preview is unavailable because no verified Core Service artifact and matching Client Protocol schema are bundled.";

/** Opaque until Polywright supplies the versioned framing schema and generated DTO package. */
export interface CoreClientConnection {
  dispose(): Promise<void>;
}

/** Verification and spawn are one trusted operation, so callers cannot substitute a path. */
export interface CoreClientLaunchPort {
  launchVerified(identity: ExecutionIdentity, signal?: AbortSignal): Promise<CoreClientConnection>;
}

export class CoreClientUnavailableError extends Error {
  public readonly code = CORE_CLIENT_UNAVAILABLE;

  constructor() {
    super(CORE_CLIENT_UNAVAILABLE_MESSAGE);
    this.name = "CoreClientUnavailableError";
  }
}

/** Fail-closed endpoint used until a verified artifact and generated protocol package exist. */
export class UnavailableCoreExecutionGateway implements ExecutionServiceGateway {
  public readonly running = false;

  constructor(private readonly identity: ExecutionIdentity) {}

  public diagnose(): Promise<readonly ExecutionDiagnostic[]> {
    return Promise.resolve([Object.freeze({
      code: CORE_CLIENT_UNAVAILABLE,
      severity: "error" as const,
      message: CORE_CLIENT_UNAVAILABLE_MESSAGE,
      identity: this.identity,
    })]);
  }

  public discover(): Promise<ExecutionDiscovery> {
    return Promise.reject(new CoreClientUnavailableError());
  }

  public prepare(_intent: RunIntent): Promise<PreparedExecution> {
    return Promise.reject(new CoreClientUnavailableError());
  }

  public run(_prepared: PreparedExecution, _options?: ExecutionOptions): Promise<RunCompletion> {
    return Promise.reject(new CoreClientUnavailableError());
  }

  public debug(_prepared: PreparedExecution, _options?: ExecutionOptions): Promise<RunCompletion> {
    return Promise.reject(new CoreClientUnavailableError());
  }

  public cancel(_prepared?: PreparedExecution): Promise<void> {
    return Promise.resolve();
  }

  public dispose(): void {}
}
