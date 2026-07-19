import { ExtensionConfig } from "../core/extension-config";
import { Logger } from "../utils/logger";
import { TraceabilityAdapter } from "./contracts";

// The neutral slice of extension state every adapter is entitled to. Provider-specific
// dependencies (credential store, secrets) are closed over by the factory itself, not passed here.
export interface AdapterContext {
  readonly config: ExtensionConfig;
  readonly logger: Logger;
}

export interface TraceabilityAdapterFactory {
  readonly id: string;
  create(ctx: AdapterContext): TraceabilityAdapter;
}

export class TraceabilityAdapterRegistry {
  private readonly factories = new Map<string, TraceabilityAdapterFactory>();

  public register(factory: TraceabilityAdapterFactory): void {
    this.factories.set(factory.id, factory);
  }

  public has(id: string): boolean {
    return this.factories.has(id);
  }

  public ids(): string[] {
    return [...this.factories.keys()];
  }

  public create(id: string, ctx: AdapterContext): TraceabilityAdapter | undefined {
    return this.factories.get(id)?.create(ctx);
  }
}
