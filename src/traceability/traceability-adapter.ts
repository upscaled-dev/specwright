import type { MetadataProvider } from "./traceability-model";

export interface KeyGrammar {
  testPrefix: string;
  reqPrefix: string;
  keyShape: RegExp;
  canonicalizeKey(key: string): string;
  projectOf?: ((key: string) => string) | undefined;
}

export interface TraceabilityAdapter {
  id: string;
  label: string;
  keyGrammar: KeyGrammar;
  browseUrl(key: string): string | undefined;
  metadataProvider?: MetadataProvider | undefined;
  dispose?(): void;
}
