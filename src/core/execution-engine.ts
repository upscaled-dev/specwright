import {
  snapshotRunIntent,
  type ExecutionDiagnostic,
  type ExecutionDiscovery,
  type ExecutionEngine,
  type ExecutionIdentity,
  type ExecutionOptions,
  type ExecutionServiceGateway,
  type PreparedExecution,
  type RunCompletion,
  type RunIntent,
} from "./run-contracts";

type EventListener = NonNullable<NonNullable<ExecutionOptions>["onEvent"]>;

interface ExecutionBinding {
  readonly gateway: ExecutionServiceGateway;
  readonly prepared: PreparedExecution;
  readonly exposed: PreparedExecution;
}

interface ActiveExecution {
  readonly binding: ExecutionBinding;
  readonly settled: Promise<void>;
  settle(): void;
}

export const LEGACY_SCHEMA_PROFILE = "legacy-v1";
export const CORE_SCHEMA_PROFILE = "client-v1";

export type ExecutionSelectionSource = () => ExecutionEngine | undefined;

/** Trusted, extension-owned inputs. Workspace settings and launch files are deliberately absent. */
export interface TrustedExecutionSelectionSources {
  readonly administratorPolicy?: ExecutionSelectionSource | undefined;
  readonly machineProfile?: ExecutionSelectionSource | undefined;
  readonly userProfile?: ExecutionSelectionSource | undefined;
  readonly developmentHostEnvironment?: ExecutionSelectionSource | undefined;
}

export class ExecutionSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExecutionSelectionError";
  }
}

function schemaProfile(engine: ExecutionEngine): string {
  return engine === "legacy-direct" ? LEGACY_SCHEMA_PROFILE : CORE_SCHEMA_PROFILE;
}

function isEngine(value: unknown): value is ExecutionEngine {
  return value === "legacy-direct" || value === "core-client";
}

export function developmentHostEngine(
  isDevelopmentHost: boolean,
  environmentValue: string | undefined
): ExecutionEngine | undefined {
  if (!isDevelopmentHost || environmentValue === undefined) {return undefined;}
  if (!isEngine(environmentValue)) {
    throw new ExecutionSelectionError(`Unsupported execution engine selection: ${environmentValue}`);
  }
  return environmentValue;
}

/** Resolves and freezes one selection snapshot before an operation reaches an engine. */
export class ExecutionSelectionOwner {
  constructor(private readonly sources: TrustedExecutionSelectionSources = {}) {}

  public begin(): ExecutionIdentity {
    const ordered = [
      this.sources.administratorPolicy,
      this.sources.machineProfile,
      this.sources.userProfile,
      this.sources.developmentHostEnvironment,
    ];
    for (const source of ordered) {
      const selected = source?.();
      if (selected === undefined) {continue;}
      if (!isEngine(selected)) {
        throw new ExecutionSelectionError(`Unsupported execution engine selection: ${String(selected)}`);
      }
      return Object.freeze({ engine: selected, schemaProfile: schemaProfile(selected) });
    }
    return Object.freeze({ engine: "legacy-direct", schemaProfile: LEGACY_SCHEMA_PROFILE });
  }
}

/** Selects exactly one engine per operation and never catches an engine outcome to fall back. */
export class SelectedExecutionGateway implements ExecutionServiceGateway {
  private readonly prepared = new Map<string, ExecutionBinding>();
  private readonly active = new Map<string, ActiveExecution>();
  private disposed = false;

  constructor(
    private readonly selection: ExecutionSelectionOwner,
    private readonly engines: Readonly<Record<ExecutionEngine, ExecutionServiceGateway>>
  ) {}

  public get running(): boolean {
    return this.active.size > 0;
  }

  public onEvent(listener: EventListener): { dispose(): void } {
    const subscriptions = Object.values(this.engines).flatMap((gateway) => {
      const source = gateway as ExecutionServiceGateway & {
        onEvent?: (candidate: EventListener) => { dispose(): void };
      };
      return source.onEvent ? [source.onEvent(listener)] : [];
    });
    return { dispose: () => subscriptions.forEach((subscription) => subscription.dispose()) };
  }

  public diagnose(): Promise<readonly ExecutionDiagnostic[]> {
    return this.selected().diagnose();
  }

  public discover(options?: { readonly refresh?: boolean | undefined }): Promise<ExecutionDiscovery> {
    return this.selected().discover(options);
  }

  public async prepare(intent: RunIntent): Promise<PreparedExecution> {
    if (this.active.size > 0) {throw new Error("A test run is already in progress.");}
    const gateway = this.selected();
    const prepared = await gateway.prepare(intent);
    if (this.prepared.has(prepared.operationId)) {
      throw new Error(`Execution operation ${prepared.operationId} is already prepared.`);
    }
    const exposed = Object.freeze({
      operationId: prepared.operationId,
      identity: Object.freeze({ ...prepared.identity }),
      intent: snapshotRunIntent(prepared.intent),
    });
    this.prepared.set(prepared.operationId, { gateway, prepared, exposed });
    return exposed;
  }

  public run(prepared: PreparedExecution, options?: ExecutionOptions): Promise<RunCompletion> {
    return this.invoke(prepared, options, "run");
  }

  public debug(prepared: PreparedExecution, options?: ExecutionOptions): Promise<RunCompletion> {
    return this.invoke(prepared, options, "debug");
  }

  public async cancel(prepared?: PreparedExecution): Promise<void> {
    if (prepared !== undefined) {
      const queued = this.prepared.get(prepared.operationId);
      if (queued?.exposed === prepared) {
        this.prepared.delete(prepared.operationId);
        await queued.gateway.cancel(queued.prepared);
        return;
      }
      const active = this.active.get(prepared.operationId);
      if (active?.binding.exposed === prepared) {
        try {await active.binding.gateway.cancel(active.binding.prepared);}
        finally {await active.settled;}
      }
      return;
    }
    await Promise.all([...this.active.values()].map(async ({ binding, settled }) => {
      try {await binding.gateway.cancel(binding.prepared);}
      finally {await settled;}
    }));
  }

  public async dispose(): Promise<void> {
    if (this.disposed) {return;}
    this.disposed = true;
    await this.cancel();
    const queued = [...this.prepared.values()];
    this.prepared.clear();
    await Promise.all(queued.map(({ gateway, prepared }) => gateway.cancel(prepared)));
    await Promise.all(
      [...new Set(Object.values(this.engines))].map((gateway) => Promise.resolve(gateway.dispose()))
    );
  }

  private selected(): ExecutionServiceGateway {
    if (this.disposed) {throw new Error("The execution gateway has been disposed.");}
    const identity = this.selection.begin();
    return this.engines[identity.engine];
  }

  private async invoke(
    prepared: PreparedExecution,
    options: ExecutionOptions,
    method: "run" | "debug"
  ): Promise<RunCompletion> {
    if (this.active.size > 0) {throw new Error("A test run is already in progress.");}
    const binding = this.prepared.get(prepared.operationId);
    if (binding?.exposed !== prepared) {
      throw new Error("The prepared execution does not belong to this gateway or was already consumed.");
    }
    this.prepared.delete(prepared.operationId);
    let settle!: () => void;
    const settled = new Promise<void>((resolve) => {settle = resolve;});
    const active = { binding, settled, settle };
    this.active.set(prepared.operationId, active);
    try {
      return await binding.gateway[method](binding.prepared, options);
    } finally {
      if (this.active.get(prepared.operationId) === active) {
        this.active.delete(prepared.operationId);
      }
      active.settle();
    }
  }
}
