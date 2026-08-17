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
  executionClientContext,
  executionClientContextForCapture,
  type ArtifactOwnershipResolver,
  type ClientRunIntent,
} from "./execution-client-context";
import { randomUUID } from "node:crypto";

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
    const startedAt = Date.now();
    const prepared = await this.prepare(intent, startedAt);
    return this.executeCaptured(prepared, options, intent.mode, startedAt);
  }

  public onEvent(listener: (event: ExecutionEvent) => void) {
    this.listeners.add(listener);
    return { dispose: () => this.listeners.delete(listener) };
  }

  public diagnose(): Promise<readonly ExecutionDiagnostic[]> {return this.engine.diagnose();}

  public discover(options?: { readonly refresh?: boolean | undefined }): Promise<ExecutionDiscovery> {
    return this.engine.discover(options);
  }

  public async prepare(intent: RunIntent, startedAt = Date.now()): Promise<PreparedExecution> {
    const initiatedBy = executionClientContext(intent)?.initiatedBy ?? "unknown";
    try {
      const capture = executionClientContextForCapture(intent, this.artifactOwnership);
      const prepared = await this.engine.prepare(intent);
      this.captures.set(prepared.operationId, capture);
      return prepared;
    } catch (error) {
      this.logLifecycle(
        { operationId: randomUUID(), identity: { engine: "legacy-direct", schemaProfile: "unknown" }, intent },
        intent.mode,
        startedAt,
        "prepare-rejected",
        "missing",
        "failed",
        undefined,
        undefined,
        undefined,
        initiatedBy
      );
      throw error;
    }
  }

  public run(prepared: PreparedExecution, options?: ExecutionOptions): Promise<RunCompletion> {
    return this.executeCaptured(prepared, options, "run", Date.now());
  }

  public debug(prepared: PreparedExecution, options?: ExecutionOptions): Promise<RunCompletion> {
    return this.executeCaptured(prepared, options, "debug", Date.now());
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
    mode: "run" | "debug",
    startedAt: number
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
        this.logLifecycle(prepared, mode, startedAt, completion.state, "missing", "confirmed", completion);
        this.emit({ kind: "finished", completion }, options?.onEvent);
        return completion;
      } catch (error) {
        if (error instanceof ExecutionFailure) {
          this.logLifecycle(prepared, mode, startedAt, error.completion.state, "missing", "failed", error.completion);
          this.emit({ kind: "finished", completion: error.completion }, options?.onEvent);
        }
        if (!(error instanceof ExecutionFailure)) { this.logLifecycle(prepared, mode, startedAt, "unexpected-rejection", "missing", "failed"); }
        throw error;
      }
    }
    let handle: number;
    try { handle = this.artifacts.beginBatch(capture.selection, capture.decisions ?? []); }
    catch (error) { this.logLifecycle(prepared, mode, startedAt, "batch-rejected", "captured", "failed", undefined, capture); throw error; }
    let sink: { dispose(): void } | undefined;
    try { sink = this.executor.registerArtifactSink(handle, this.artifacts); }
    catch (error) {
      const artifactId = this.seal(handle, "partial");
      this.logLifecycle(prepared, mode, startedAt, "sink-rejected", "captured", "failed", undefined, capture, artifactId);
      throw error;
    }
    try {
      const completion = await this.engine.executeWithArtifactBatch(
        { ...prepared.intent, mode },
        forwarded,
        handle,
        capture.artifactOwnership
      );
      const sealed = this.withArtifact(completion, handle);
      this.logLifecycle(prepared, mode, startedAt, sealed.state, "captured", "confirmed", sealed, capture);
      this.emit({ kind: "finished", completion: sealed }, options?.onEvent);
      return sealed;
    } catch (error) {
      if (error instanceof ExecutionFailure) {
        const sealed = this.withArtifact(error.completion, handle);
        this.logLifecycle(prepared, mode, startedAt, sealed.state, "captured", "failed", sealed, capture);
        this.emit({ kind: "finished", completion: sealed }, options?.onEvent);
        throw new ExecutionFailure(sealed);
      }
      const artifactId = this.seal(handle, "partial");
      this.logLifecycle(prepared, mode, startedAt, "unexpected-rejection", "captured", "failed", undefined, capture, artifactId);
      throw error;
    } finally {
      try { sink.dispose(); } catch { /* a sink cannot affect execution */ }
    }
  }

  private logLifecycle(
    prepared: PreparedExecution,
    mode: "run" | "debug",
    startedAt: number,
    state: string,
    captureState: "captured" | "missing",
    outcomeCertainty: "confirmed" | "failed",
    completion?: RunCompletion,
    capture?: ReturnType<typeof executionClientContextForCapture>,
    artifactId?: string,
    initiatedBy?: string
  ): void {
    try {
      this.logger.info("Legacy execution lifecycle", {
        operationId: prepared.operationId,
        mode,
        engine: "legacy-direct",
        schemaProfile: prepared.identity.schemaProfile ?? "unknown",
        initiatedBy: capture?.initiatedBy ?? initiatedBy ?? "unknown",
        durationMs: Date.now() - startedAt,
        state,
        outcomeCertainty,
        cancelled: completion?.state === "cancelled",
        captureState,
        ...(artifactId ?? completion?.artifactId ? { artifactId: artifactId ?? completion?.artifactId } : {}),
      });
    } catch { /* lifecycle diagnostics cannot affect execution */ }
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
