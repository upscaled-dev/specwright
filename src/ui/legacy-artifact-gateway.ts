import {
  ExecutionFailure,
  LegacyDirectExecutionGateway,
} from "../core/execution-gateway";
import type {
  ExecutionDiagnostic,
  ExecutionDiscovery,
  ExecutionEvent,
  ExecutionGateway,
  ExecutionOptions,
  PreparedExecution,
  RunCompletion,
  RunIntent,
} from "../core/run-contracts";
import type { RunArtifactState } from "../traceability/contracts";
import type { RunArtifactStore } from "../traceability/run-artifact-store";
import type { Logger } from "../utils/logger";
import type { TestExecutor } from "../core/test-executor";
import {
  executionClientContextForCapture,
  type ArtifactOwnershipResolver,
  type ClientRunIntent,
} from "./execution-client-context";

export class LegacyArtifactGateway implements ExecutionGateway {
  private readonly captures = new Map<string, ReturnType<typeof executionClientContextForCapture>>();
  private readonly listeners = new Set<(event: ExecutionEvent) => void>();

  constructor(
    private readonly engine: LegacyDirectExecutionGateway,
    private readonly artifacts: RunArtifactStore,
    private readonly logger: Logger,
    private readonly executor: Pick<TestExecutor, "registerArtifactSink">,
    private readonly artifactOwnership?: ArtifactOwnershipResolver
  ) {}

  public get running(): boolean {return this.engine.running;}

  public execute(intent: ClientRunIntent, options?: ExecutionOptions): Promise<RunCompletion>;
  public execute(intent: RunIntent, options?: ExecutionOptions): Promise<RunCompletion>;
  public async execute(intent: RunIntent, options?: ExecutionOptions): Promise<RunCompletion> {
    const prepared = await this.prepare(intent);
    return intent.mode === "debug" ? this.debug(prepared, options) : this.run(prepared, options);
  }

  public onEvent(listener: (event: ExecutionEvent) => void) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public diagnose(): Promise<readonly ExecutionDiagnostic[]> {return this.engine.diagnose();}

  public discover(options?: { readonly refresh?: boolean | undefined }): Promise<ExecutionDiscovery> {
    return this.engine.discover(options);
  }

  public async prepare(intent: RunIntent): Promise<PreparedExecution> {
    const prepared = await this.engine.prepare(intent);
    this.captures.set(
      prepared.operationId,
      executionClientContextForCapture(intent, this.artifactOwnership)
    );
    return prepared;
  }

  public run(prepared: PreparedExecution, options?: ExecutionOptions): Promise<RunCompletion> {
    return this.executeCaptured(prepared, options, "run");
  }

  public debug(prepared: PreparedExecution, options?: ExecutionOptions): Promise<RunCompletion> {
    return this.executeCaptured(prepared, options, "debug");
  }

  public cancel(prepared?: PreparedExecution): Promise<void> {return this.engine.cancel(prepared);}

  public async dispose(): Promise<void> {
    this.captures.clear();
    this.listeners.clear();
    await this.engine.dispose();
  }

  private async executeCaptured(
    prepared: PreparedExecution,
    options: ExecutionOptions,
    mode: "run" | "debug"
  ): Promise<RunCompletion> {
    const capture = this.captures.get(prepared.operationId);
    this.captures.delete(prepared.operationId);
    const forwarded = {
      ...options,
      onEvent: (event: ExecutionEvent) => {
        if (event.kind === "finished") {return;}
        this.emit(event, options?.onEvent);
      },
    };
    if (!capture) {
      try {
        const completion = await this.engine[mode](prepared, forwarded);
        this.emit({ kind: "finished", completion }, options?.onEvent);
        return completion;
      } catch (error) {
        if (error instanceof ExecutionFailure) {
          this.emit({ kind: "finished", completion: error.completion }, options?.onEvent);
        }
        throw error;
      }
    }
    const handle = this.artifacts.beginBatch(capture.selection, capture.decisions ?? []);
    const sink = this.executor.registerArtifactSink(handle, this.artifacts);
    try {
      const completion = await this.engine.executeWithArtifactBatch(
        { ...prepared.intent, mode },
        forwarded,
        handle,
        capture.artifactOwnership
      );
      const sealed = this.withArtifact(completion, handle);
      this.emit({ kind: "finished", completion: sealed }, options?.onEvent);
      return sealed;
    } catch (error) {
      if (error instanceof ExecutionFailure) {
        const sealed = this.withArtifact(error.completion, handle);
        this.emit({ kind: "finished", completion: sealed }, options?.onEvent);
        throw new ExecutionFailure(sealed);
      }
      this.seal(handle, "partial");
      throw error;
    } finally {
      sink.dispose();
    }
  }

  private emit(
    event: ExecutionEvent,
    operationListener?: ((event: ExecutionEvent) => void) | undefined
  ): void {
    for (const listener of [operationListener, ...this.listeners]) {
      try {listener?.(event);} catch { /* a consumer cannot affect execution */ }
    }
  }

  private withArtifact(completion: RunCompletion, handle: number): RunCompletion {
    const artifactId = this.seal(handle, completion.state);
    return Object.freeze({ ...completion, ...(artifactId ? { artifactId } : {}) });
  }

  private seal(handle: number, state: RunArtifactState): string | undefined {
    try {
      const artifact = this.artifacts.sealBatch(handle, state);
      if (artifact === undefined) {return undefined;}
      if (artifact.state !== state) {
        this.logger.warn("The sealed run artifact disagrees with the run outcome", {
          run: state,
          artifact: artifact.state,
        });
      }
      return artifact.id;
    } catch (error) {
      this.logger.warn(`Failed to seal the run artifact: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    }
  }
}
