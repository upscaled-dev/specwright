import { plural, serverText, truncate } from "../utils/text";

const MAX_WARNING_ITEMS = 12;
const MAX_WARNING_CHARS = 240;
const MAX_DIAGNOSTIC_CHARS = 2_000;
const MAX_CLASSIFIED_ITEMS = 64;
const MAX_CLASSIFIED_CHARS = 1_000;
const REINDEX_DIAGNOSTIC = /\bre(?:[-\s]?index)(?:ed|ing)?\b/i;

export interface ProviderWarningDigest {
  readonly count: number;
  readonly detail: string;
  readonly omitted: number;
  readonly summary: string;
}

/** A bounded, scrubbed view of provider warnings for logs and count-only user messages. */
export function providerWarnings(warnings: readonly string[]): ProviderWarningDigest {
  const details: string[] = [];
  let length = 0;
  for (const warning of warnings.slice(0, MAX_WARNING_ITEMS)) {
    const separator = details.length === 0 ? 0 : 2;
    const available = MAX_DIAGNOSTIC_CHARS - length - separator;
    if (available <= 0) {break;}
    const readable = serverText(warning) || "(empty warning)";
    const detail = truncate(readable, Math.min(MAX_WARNING_CHARS, available));
    details.push(detail);
    length += separator + detail.length;
  }
  const omitted = warnings.length - details.length;
  const count = warnings.length;
  return {
    count,
    detail: details.join("; "),
    omitted,
    summary: `${count} provider ${plural(count, "warning")}`,
  };
}

/** True when a globally bounded provider diagnostic stream names Jira/Xray index recovery. */
export function hasReindexDiagnostic(diagnostics: Iterable<string>): boolean {
  const iterator = diagnostics[Symbol.iterator]();
  let items = 0;
  let chars = 0;
  while (items < MAX_CLASSIFIED_ITEMS && chars < MAX_CLASSIFIED_CHARS) {
    const next = iterator.next();
    if (next.done) {return false;}
    items += 1;
    const available = MAX_CLASSIFIED_CHARS - chars;
    const diagnostic = next.value.slice(0, available);
    chars += diagnostic.length;
    if (REINDEX_DIAGNOSTIC.test(diagnostic)) {return true;}
  }
  return false;
}
