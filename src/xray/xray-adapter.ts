import { ExtensionConfig } from "../core/extension-config";
import { KeyGrammar, TraceabilityAdapter } from "../traceability/traceability-adapter";
import { MetadataProvider } from "../traceability/traceability-model";

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

export class XrayAdapter implements TraceabilityAdapter {
  public readonly id = "xray";
  public readonly label = "Xray";

  constructor(private readonly config: ExtensionConfig) {}

  public get keyGrammar(): KeyGrammar {
    return {
      testPrefix: effectivePrefix(this.config.traceabilityTestTagPrefix, DEFAULT_TEST_PREFIX),
      reqPrefix: effectivePrefix(this.config.traceabilityReqTagPrefix, DEFAULT_REQ_PREFIX),
      keyShape: JIRA_KEY_SHAPE,
      canonicalizeKey: (key) => key.toUpperCase(),
      projectOf: projectFromKey,
    };
  }

  // Late-bound so P1 can hand back a cache-backed provider without changing the field's shape.
  public get metadataProvider(): MetadataProvider | undefined {
    return undefined;
  }

  public browseUrl(key: string): string | undefined {
    const site = normalizeSiteUrl(this.config.xraySiteUrl);
    return site ? `https://${site}/browse/${key}` : undefined;
  }
}
