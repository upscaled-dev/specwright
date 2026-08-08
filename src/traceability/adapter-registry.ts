import type { TraceabilityAdapter } from "./contracts";
import {
  INTEGRATION_ADAPTER_API_VERSION,
  INTEGRATION_ADAPTER_CAPABILITIES,
  INTEGRATION_ADAPTER_CAPABILITY_VERSION,
  IntegrationAdapterError,
  type IntegrationAdapterErrorCode,
  type AdapterServices,
  type TraceabilityAdapterFactory,
} from "./adapter-contract";
import { validateAdapterShape, validatedAdapter } from "./validated-adapter";

export type { AdapterServices as AdapterContext, TraceabilityAdapterFactory } from "./adapter-contract";
export { IntegrationAdapterError } from "./adapter-contract";

export const ADAPTER_INITIALIZE_TIMEOUT_MS = 5_000;
export const ADAPTER_DISPOSE_TIMEOUT_MS = 2_000;

interface RegistryOptions {
  readonly initializeTimeoutMs?: number;
  readonly disposeTimeoutMs?: number;
}

function positiveDeadline(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isFinite(value) && value > 0 ? value : fallback;
}

function lifecycleError(
  code: IntegrationAdapterErrorCode,
  id: string,
  action: string,
  detail: string,
  cause?: unknown
): IntegrationAdapterError {
  return new IntegrationAdapterError(
    code,
    `Integration adapter "${id}" ${action} ${detail}.`,
    cause === undefined ? undefined : { cause }
  );
}

async function withinDeadline<T>(
  operation: Promise<T>,
  timeoutMs: number,
  timeoutError: () => Error
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(timeoutError()), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    if (timer !== undefined) {clearTimeout(timer);}
  }
}

export class TraceabilityAdapterRegistry {
  private readonly factories = new Map<string, TraceabilityAdapterFactory>();
  private readonly initializeTimeoutMs: number;
  private readonly disposeTimeoutMs: number;

  constructor(options: RegistryOptions = {}) {
    this.initializeTimeoutMs = positiveDeadline(options.initializeTimeoutMs, ADAPTER_INITIALIZE_TIMEOUT_MS);
    this.disposeTimeoutMs = positiveDeadline(options.disposeTimeoutMs, ADAPTER_DISPOSE_TIMEOUT_MS);
  }

  public register(factory: TraceabilityAdapterFactory): void {
    const normalized = this.normalizeFactory(factory);
    if (this.factories.has(normalized.id)) {
      throw lifecycleError(
        "duplicate-id",
        normalized.id,
        "registration",
        "was rejected because the ID is already registered"
      );
    }
    this.factories.set(normalized.id, normalized);
  }

  public has(id: string): boolean {
    return this.factories.has(id);
  }

  public ids(): string[] {
    return [...this.factories.keys()].sort();
  }

  public async activate(
    id: string,
    services: AdapterServices,
    signal?: AbortSignal
  ): Promise<TraceabilityAdapter | undefined> {
    const factory = this.factories.get(id);
    if (!factory) {return undefined;}
    const adapter = this.construct(factory, services);
    return this.initialize(adapter, signal);
  }

  private async initialize(
    adapter: TraceabilityAdapter,
    signal?: AbortSignal
  ): Promise<TraceabilityAdapter> {
    const id = adapter.id;
    const initialize = adapter.initialize;
    if (!initialize) {return adapter;}

    const controller = new AbortController();
    let rejectCancellation: ((error: IntegrationAdapterError) => void) | undefined;
    const cancel = (): void => {
      controller.abort();
      rejectCancellation?.(lifecycleError("activation-cancelled", id, "activation", "was cancelled"));
    };
    signal?.addEventListener("abort", cancel, { once: true });
    const initialized = Promise.resolve().then(() => initialize.call(adapter, controller.signal));
    const cancelled = new Promise<never>((_resolve, reject) => {
      rejectCancellation = reject;
    });
    if (signal?.aborted) {cancel();}
    try {
      await withinDeadline(
        Promise.race([initialized, cancelled]),
        this.initializeTimeoutMs,
        () => {
          controller.abort();
          return lifecycleError(
            "activation-timeout",
            id,
            "activation",
            `did not finish within ${this.initializeTimeoutMs} ms`
          );
        }
      );
      return adapter;
    } catch (error) {
      const activationError = error instanceof IntegrationAdapterError
        && (error.code === "activation-cancelled" || error.code === "activation-timeout")
        ? error
        : lifecycleError("activation-failed", id, "activation", "failed", error);
      try {
        await adapter.dispose?.();
      } catch (cleanupError) {
        throw new IntegrationAdapterError(
          activationError.code,
          `${activationError.message} Cleanup also failed.`,
          { cause: new AggregateError([activationError, cleanupError]) }
        );
      }
      throw activationError;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  private construct(factory: TraceabilityAdapterFactory, services: AdapterServices): TraceabilityAdapter {
    let source: TraceabilityAdapter;
    try {
      source = factory.create(services);
      validateAdapterShape(factory.id, factory.capabilityVersions, source);
      return validatedAdapter(
        source,
        () => this.disposeSource(factory.id, source),
        (error) => services.logger.warn("Integration adapter activity was rejected", {
          adapterId: factory.id,
          code: error.code,
          error: error.message,
        })
      );
    } catch (error) {
      if (error instanceof IntegrationAdapterError) {throw error;}
      throw lifecycleError("activation-failed", factory.id, "construction", "failed", error);
    }
  }

  private async disposeSource(id: string, source: TraceabilityAdapter): Promise<void> {
    if (!source.dispose) {return;}
    let disposed: Promise<void | undefined>;
    try {
      disposed = Promise.resolve(source.dispose());
    } catch (error) {
      throw lifecycleError("disposal-failed", id, "disposal", "failed", error);
    }
    try {
      await withinDeadline(
        disposed,
        this.disposeTimeoutMs,
        () => lifecycleError(
          "disposal-timeout",
          id,
          "disposal",
          `did not finish within ${this.disposeTimeoutMs} ms`
        )
      );
    } catch (error) {
      if (error instanceof IntegrationAdapterError) {throw error;}
      throw lifecycleError("disposal-failed", id, "disposal", "failed", error);
    }
  }

  private normalizeFactory(factory: TraceabilityAdapterFactory): TraceabilityAdapterFactory {
    let id = "unknown";
    try {
      id = factory.id;
      const apiVersion = factory.apiVersion;
      const capabilityVersions = factory.capabilityVersions;
      const create = factory.create;
      if (typeof id !== "string" || id.trim() === "" || typeof create !== "function") {
        throw lifecycleError("malformed-factory", String(id), "registration", "has a malformed factory");
      }
      if (apiVersion !== INTEGRATION_ADAPTER_API_VERSION) {
        throw lifecycleError(
          "incompatible-api",
          id,
          "registration",
          `requires API version ${String(apiVersion)} but the host supports ${INTEGRATION_ADAPTER_API_VERSION}`
        );
      }
      if (
        typeof capabilityVersions !== "object"
        || capabilityVersions === null
        || Array.isArray(capabilityVersions)
      ) {
        throw lifecycleError("malformed-factory", id, "registration", "has malformed capability versions");
      }
      const entries = Object.entries(capabilityVersions);
      if (entries.length > INTEGRATION_ADAPTER_CAPABILITIES.length) {
        throw lifecycleError("malformed-factory", id, "registration", "has malformed capability versions");
      }
      const supported = new Set<string>(INTEGRATION_ADAPTER_CAPABILITIES);
      for (const [capability, version] of entries) {
        if (!supported.has(capability) || version !== INTEGRATION_ADAPTER_CAPABILITY_VERSION) {
          throw lifecycleError(
            "incompatible-capability",
            id,
            "registration",
            `requires capability "${capability}" version ${String(version)} but the host supports ${INTEGRATION_ADAPTER_CAPABILITY_VERSION}`
          );
        }
      }
      return Object.freeze({
        id,
        apiVersion,
        capabilityVersions: Object.freeze(Object.fromEntries(entries)),
        create: create.bind(factory),
      });
    } catch (error) {
      if (error instanceof IntegrationAdapterError) {throw error;}
      throw lifecycleError("malformed-factory", String(id), "registration", "has a malformed factory", error);
    }
  }
}
