import { ExtensionConfig } from "../core/extension-config";
import {
  ConnectionCapability,
  ConnectionVerifyResult,
  ExternalRef,
  KeyGrammar,
  MetadataCapability,
  TraceabilityAdapter,
} from "../traceability/contracts";
import { XrayCredentialStore } from "./xray-credential-store";

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

// Xray issue keys are definitionally uppercase; the metadata capability shares this exact function
// so its absent-set/catalogue keying can never drift from the keys the model derives from tags.
export const canonicalizeXrayKey = (key: string): string => key.toUpperCase();

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

export class XrayAdapter implements TraceabilityAdapter {
  public readonly id = "xray";
  public readonly label = "Xray";
  public readonly connection: ConnectionCapability | undefined;
  public readonly metadata: MetadataCapability | undefined;

  // The model degrades to the offline tag-only join when a capability is absent, so the browse-URL
  // command instance (built without a credential store or client) leaves both undefined.
  constructor(
    private readonly config: ExtensionConfig,
    credentialStore?: XrayCredentialStore,
    verify?: () => Promise<ConnectionVerifyResult>,
    metadata?: MetadataCapability
  ) {
    this.connection = credentialStore ? xrayConnection(config, credentialStore, verify) : undefined;
    this.metadata = metadata;
  }

  public get keyGrammar(): KeyGrammar {
    return {
      testPrefix: effectivePrefix(this.config.traceabilityTestTagPrefix, DEFAULT_TEST_PREFIX),
      reqPrefix: effectivePrefix(this.config.traceabilityReqTagPrefix, DEFAULT_REQ_PREFIX),
      keyShape: JIRA_KEY_SHAPE,
      canonicalizeKey: canonicalizeXrayKey,
      projectOf: projectFromKey,
    };
  }

  public browseUrl(ref: ExternalRef): string | undefined {
    const site = normalizeSiteUrl(this.config.xraySiteUrl);
    return site ? `https://${site}/browse/${ref.key}` : undefined;
  }

  public dispose(): void {
    (this.metadata as { dispose?: () => void } | undefined)?.dispose?.();
  }
}
