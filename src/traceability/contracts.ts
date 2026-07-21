import type { Event } from "vscode";

export interface KeyGrammar {
  testPrefix: string;
  reqPrefix: string;
  keyShape: RegExp;
  canonicalizeKey(key: string): string;
  projectOf?: ((key: string) => string) | undefined;
}

// Neutral references to remote entities. Only the canonical key is guaranteed; the specialized
// refs add a discriminant for call sites that must distinguish entity kinds. No provider carries
// Jira/Xray vocabulary here.
export interface ExternalRef {
  readonly key: string;
}

export interface TestCaseRef extends ExternalRef {
  readonly kind: "testCase";
}

export interface RequirementRef extends ExternalRef {
  readonly kind: "requirement";
}

export interface ExecutionRef extends ExternalRef {
  readonly kind: "execution";
}

// Provider-specific status strings collapse to a shared category (drives the shared badge icon);
// `providerValue` keeps the original for the tooltip, `color` is an optional provider hint.
export interface NormalizedStatus {
  readonly category: "passed" | "failed" | "pending" | "unknown";
  readonly providerValue: string;
  readonly color?: string | undefined;
}

export interface TestCaseMetadata {
  readonly key: string;
  readonly summary?: string | undefined;
  readonly status?: NormalizedStatus | undefined;
  // Stored Gherkin backing the P1 drift indicator; absent until the client slice populates it.
  readonly gherkin?: string | undefined;
  // Canonical keys of the requirements this test covers (flat, provider-neutral). The coverage
  // capability and P4 board read these; the tree join ignores them today.
  readonly coverageKeys?: readonly string[] | undefined;
}

// The scope of a sync. `projectKeys` requests a full catalogue for orphan detection (an empty set
// means "derive from the keys the local tags reference"); `testKeys` are the specific keys the
// local join needs metadata for.
export interface SyncScope {
  readonly projectKeys?: readonly string[] | undefined;
  readonly testKeys?: readonly string[] | undefined;
}

// The offline-first metadata snapshot. `completeness` describes catalogue integrity only (project
// scope present, every project's pages complete, no catalogue errors — a supplemental key batch,
// present or failed, never affects it) and gates orphan derivation: orphans are only authoritative
// on a `"complete"` catalogue fetch — a `"partial"` or `"unknown"` snapshot must never yield orphan
// counts.
export interface RemoteMetadataSnapshot {
  readonly tests: ReadonlyMap<string, TestCaseMetadata>;
  readonly fetchedScopes: readonly string[];
  // The project keys whose full catalogue this snapshot attempted; authoritative for key-absence
  // verdicts only when `completeness === "complete"` (which already implies every catalogue page
  // complete with no catalogue errors — `errors` may still carry key-batch failures).
  readonly catalogueProjects: readonly string[];
  // Canonical keys a *successful* key-batch fetch explicitly queried and the remote did not return —
  // authoritative absence evidence regardless of `completeness` (§5 key-batch leniency: getTests
  // silently omits nonexistent keys and still returns 200). A failed or partial batch contributes
  // nothing.
  readonly verifiedAbsentKeys: readonly string[];
  readonly syncedAt?: number | undefined;
  readonly stale: boolean;
  readonly completeness: "complete" | "partial" | "unknown";
  readonly errors: readonly string[];
}

export type RunArtifactOutcome = "passed" | "failed" | "skipped";

export interface RunArtifactResult {
  readonly testKey: string;
  readonly outcome: RunArtifactOutcome;
}

// One immutable, multi-test capture of a local run. The full shape (shards, iterations, evidence)
// lands in P2; P1 carries only what publishing and badges consume.
export interface RunArtifact {
  readonly id: string;
  readonly createdAt: number;
  readonly results: readonly RunArtifactResult[];
}

// Badge-feeding subset of the artifact store; the full immutable multi-test store lands in P2.
export interface RunArtifactStore {
  latestOutcome(testKey: string): RunArtifactOutcome | undefined;
}

export interface PublishTarget {
  readonly id: string;
  readonly label: string;
}

export interface PublishResult {
  readonly targetId: string;
  readonly ref?: ExecutionRef | undefined;
}

export type ConnectionVerifyStatus = "ok" | "auth-failed" | "unreachable";

export interface ConnectionVerifyResult {
  status: ConnectionVerifyStatus;
  message: string;
}

// Read-side view of the provider connection. The connect/disconnect actions live in provider
// commands + the credential store, not here — this capability only reports state.
export interface ConnectionCapability {
  readonly onDidChange: Event<void>;
  readonly label: string;
  isConnected(): Promise<boolean>;
  // `verify` runs a live, cheap handshake against the provider; `isConnected()` stays "credentials
  // stored" and continues to gate tree visibility — the two deliberately differ so the offline tree
  // still shows when the network doesn't.
  verify?(): Promise<ConnectionVerifyResult>;
}

export interface MetadataCapability {
  readonly onDidChange: Event<void>;
  snapshot(): RemoteMetadataSnapshot;
  sync(scope: SyncScope, signal?: AbortSignal): Promise<void>;
}

export interface CoverageCapability {
  coverageFor(ref: TestCaseRef, signal?: AbortSignal): Promise<readonly RequirementRef[]>;
}

export interface AutomationBindingCapability {
  bind(ref: TestCaseRef, signal?: AbortSignal): Promise<void>;
}

export interface ResultPublishingCapability {
  listTargets(signal?: AbortSignal): Promise<readonly PublishTarget[]>;
  publish(artifact: RunArtifact, target: PublishTarget): Promise<PublishResult>;
}

export interface AttachmentCapability {
  attach(target: ExecutionRef, files: readonly string[], signal?: AbortSignal): Promise<void>;
}

// A small base plus independently optional capabilities — the model reads whichever capabilities an
// adapter exposes and degrades gracefully when one is absent. Never one large interface.
export interface TraceabilityAdapter {
  readonly id: string;
  readonly label: string;
  readonly keyGrammar: KeyGrammar;
  browseUrl(ref: ExternalRef): string | undefined;

  readonly connection?: ConnectionCapability | undefined;
  readonly metadata?: MetadataCapability | undefined;
  readonly coverage?: CoverageCapability | undefined;
  readonly automationBinding?: AutomationBindingCapability | undefined;
  readonly resultPublishing?: ResultPublishingCapability | undefined;
  readonly attachments?: AttachmentCapability | undefined;

  dispose?(): void;
}
