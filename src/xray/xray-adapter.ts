import { ExtensionConfig } from "../core/extension-config";
import {
  ConnectionCapability,
  ConnectionVerifyResult,
  ExternalRef,
  KeyGrammar,
  TraceabilityAdapter,
} from "../traceability/contracts";
import { TraceabilityAdapterFactory } from "../traceability/adapter-registry";
import { XrayCredentialStore } from "./xray-credential-store";
import type {
  XrayConnectionOutcome,
  XrayConnectionTestDeps,
  XrayProbeOptions,
} from "./xray-connection-test";

type XrayProbe = (
  deps: XrayConnectionTestDeps,
  options?: XrayProbeOptions
) => Promise<XrayConnectionOutcome>;

// A Jira/Xray issue key: a project part (which may itself contain hyphens/underscores), then a
// trailing `-<number>`. The project is everything before that last `-<number>` — so JIRA_KEY_SHAPE
// and projectFromKey agree on multi-segment keys like AB-CD-123.
export const JIRA_KEY_SHAPE = /^[A-Za-z][A-Za-z0-9_-]*-\d+$/;

/** `CALC-1043` → `CALC`, `AB-CD-123` → `AB-CD`: everything before the trailing `-<number>`. */
export function projectFromKey(key: string): string {
  const match = /^(.*)-\d+$/.exec(key);
  return match?.[1] ?? key;
}

/**
 * Accept a bare host, a full URL, or a trailing-slashed value and reduce it to a bare host.
 * Lowercased: hostnames are case-insensitive, and the result keys SecretStorage entries — case
 * variants of one site must resolve to one credential slot.
 */
export function normalizeSiteUrl(raw: string): string {
  let host = raw.trim().replace(/^https?:\/\//i, "");
  while (host.endsWith("/")) {
    host = host.slice(0, -1);
  }
  return host.toLowerCase();
}

const DEFAULT_TEST_PREFIX = "TEST_";
const DEFAULT_REQ_PREFIX = "REQ_";

// An empty/whitespace prefix would match every tag; treat it as unset and fall back to the default.
function effectivePrefix(prefix: string, fallback: string): string {
  return prefix.trim() === "" ? fallback : prefix;
}

// Thin read-side view of the landed connection slice: the credential store's change event, the
// normalized site as the label, and a credential probe. Connect/disconnect stay in the Xray
// commands — this capability only reports state to the neutral subsystem.
function xrayConnection(
  config: ExtensionConfig,
  credentialStore: XrayCredentialStore,
  verify?: () => Promise<ConnectionVerifyResult>
): ConnectionCapability {
  return {
    onDidChange: credentialStore.onDidChange,
    get label(): string {
      return normalizeSiteUrl(config.xraySiteUrl);
    },
    isConnected: (): Promise<boolean> => {
      if (normalizeSiteUrl(config.xraySiteUrl) === "") {
        return Promise.resolve(false);
      }
      return credentialStore.hasCredentials(config.xraySiteUrl);
    },
    ...(verify ? { verify } : {}),
  };
}

// An auth-only probe can only land in the ok/auth/network stages: ok is a verified handshake,
// network means the site was unreachable, and every other stage is an authentication failure.
function toVerifyResult(outcome: XrayConnectionOutcome): ConnectionVerifyResult {
  if (outcome.ok) {
    return { status: "ok", message: outcome.message };
  }
  if (outcome.stage === "network") {
    return { status: "unreachable", message: outcome.message };
  }
  return { status: "auth-failed", message: outcome.message };
}

export class XrayAdapter implements TraceabilityAdapter {
  public readonly id = "xray";
  public readonly label = "Xray";
  public readonly connection: ConnectionCapability | undefined;

  // `metadata` is left undefined until the client slice; the model degrades to the offline
  // tag-only join when a capability is absent.
  constructor(
    private readonly config: ExtensionConfig,
    credentialStore?: XrayCredentialStore,
    verify?: () => Promise<ConnectionVerifyResult>
  ) {
    this.connection = credentialStore ? xrayConnection(config, credentialStore, verify) : undefined;
  }

  public get keyGrammar(): KeyGrammar {
    return {
      testPrefix: effectivePrefix(this.config.traceabilityTestTagPrefix, DEFAULT_TEST_PREFIX),
      reqPrefix: effectivePrefix(this.config.traceabilityReqTagPrefix, DEFAULT_REQ_PREFIX),
      keyShape: JIRA_KEY_SHAPE,
      canonicalizeKey: (key) => key.toUpperCase(),
      projectOf: projectFromKey,
    };
  }

  public browseUrl(ref: ExternalRef): string | undefined {
    const site = normalizeSiteUrl(this.config.xraySiteUrl);
    return site ? `https://${site}/browse/${ref.key}` : undefined;
  }
}

export function createXrayAdapterFactory(
  credentialStore: XrayCredentialStore,
  probe: XrayProbe
): TraceabilityAdapterFactory {
  return {
    id: "xray",
    create: (ctx) => {
      const verify = (): Promise<ConnectionVerifyResult> =>
        probe(
          {
            site: ctx.config.xraySiteUrl,
            credentialStore,
            logger: ctx.logger,
            knownTestKeys: () => [],
          },
          { authOnly: true }
        ).then(toVerifyResult);
      return new XrayAdapter(ctx.config, credentialStore, verify);
    },
  };
}
