import type { ExtensionConfig } from "../core/extension-config";
import type { Logger } from "../utils/logger";
import type { TraceabilityAdapter } from "./contracts";

export const INTEGRATION_ADAPTER_API_VERSION = 1;
export const INTEGRATION_ADAPTER_CAPABILITY_VERSION = 1;

export const INTEGRATION_ADAPTER_RESPONSE_LIMITS = Object.freeze({
  collectionItems: 10_000,
  totalItems: 50_000,
  stringLength: 1_000_000,
});

export const INTEGRATION_ADAPTER_CAPABILITIES = [
  "connection",
  "metadata",
  "coverage",
  "automationBinding",
  "remoteSearch",
  "projectDirectory",
  "organization",
  "testAuthoring",
  "resultPublishing",
  "attachments",
] as const;

export type IntegrationAdapterCapability = typeof INTEGRATION_ADAPTER_CAPABILITIES[number];

export type IntegrationAdapterErrorCode =
  | "duplicate-id"
  | "incompatible-api"
  | "incompatible-capability"
  | "malformed-factory"
  | "malformed-adapter"
  | "malformed-response"
  | "provider-failed"
  | "adapter-disposed"
  | "activation-failed"
  | "activation-cancelled"
  | "activation-timeout"
  | "disposal-failed"
  | "disposal-timeout";

export class IntegrationAdapterError extends Error {
  constructor(
    public readonly code: IntegrationAdapterErrorCode,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = "IntegrationAdapterError";
  }
}

// The only host services available to an in-process integration adapter. Provider-specific
// credentials and persistence are closed over by its factory.
export interface AdapterServices {
  readonly config: ExtensionConfig;
  readonly logger: Logger;
}

export interface TraceabilityAdapterFactory {
  readonly id: string;
  readonly apiVersion: number;
  readonly capabilityVersions: Readonly<Partial<Record<IntegrationAdapterCapability, number>>>;
  create(services: AdapterServices): TraceabilityAdapter;
}

export function currentAdapterVersions(
  ...capabilities: readonly IntegrationAdapterCapability[]
): Pick<TraceabilityAdapterFactory, "apiVersion" | "capabilityVersions"> {
  return {
    apiVersion: INTEGRATION_ADAPTER_API_VERSION,
    capabilityVersions: Object.fromEntries(
      capabilities.map((capability) => [capability, INTEGRATION_ADAPTER_CAPABILITY_VERSION])
    ),
  };
}
