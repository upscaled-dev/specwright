import type { Event } from "vscode";
import type { ScenarioRef } from "./scenario-ref";

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
  // The remote test's type, neutral shape (`kind` ∈ e.g. Gherkin/Steps/Unstructured for Xray). The
  // automation-binding hook reads it to classify preflight compatibility; absent on a partial
  // snapshot, which the hook treats as `unknown` (never blocking).
  readonly testType?: { readonly name: string; readonly kind: string } | undefined;
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

// The scope that produced a batch run. Resolution (`resolveBatchSelection`) expands each into the
// scenario set to preflight and the executor invocations to run. `test-plan-derived` is declared
// here but only resolvable once slice 2d adds the remote plan lookup.
export type BatchSelection =
  | { readonly kind: "scenario"; readonly scenario: ScenarioRef }
  | { readonly kind: "multi-select"; readonly scenarios: readonly ScenarioRef[] }
  | { readonly kind: "feature"; readonly filePath: string }
  | { readonly kind: "folder"; readonly folderPath: string }
  | { readonly kind: "tag-expression"; readonly expression: string }
  | { readonly kind: "all-mapped" }
  | { readonly kind: "test-plan-derived"; readonly planKey: string };

// Preflight verdict for one scenario about to run in a batch. `ready` means publishable-in-principle;
// every other state needs an explicit decision before the batch runs. `not-in-target-plan` is
// declared for slice 2d's plan lookup — 2c never produces it.
export type PreflightState =
  | "ready"
  | "unmapped"
  | "invalid-key"
  | "duplicate-mapping"
  | "incompatible-test-type"
  | "automation-binding-required"
  | "not-in-target-plan";

// What the user chose for a non-`ready` item. `repair` re-enters the linkScenario flow and
// re-classifies (never persisted); `cancel` runs nothing; the other two seal onto the artifact.
export type PreflightOutcome = "repair" | "exclude" | "local-only" | "cancel";

export interface PreflightItem {
  readonly scenario: ScenarioRef;
  readonly testKey?: string | undefined;
  readonly state: PreflightState;
  readonly decision?: PreflightOutcome | undefined;
  // A value-free note (e.g. why an `unknown` binding still resolves to `ready` on a partial snapshot).
  readonly detail?: string | undefined;
}

// The automation-binding hook's verdict for a target test's metadata. `unknown` (no metadata / a
// partial snapshot) never blocks — preflight maps it to `ready` with an honest note.
export type AutomationBindingClassification =
  | "compatible"
  | "incompatible-test-type"
  | "binding-required"
  | "unknown";

// Retry/flake is per-iteration data, never a top-level outcome: a result that passed on retry is
// `passed` with `flaky: true`, and `timed-out`/`interrupted` stay distinct from a plain `failed`.
export type RunArtifactOutcome = "passed" | "failed" | "skipped" | "timed-out" | "interrupted";

export type RunArtifactState = "complete" | "partial" | "cancelled";

// One example row of a Scenario Outline run.
export interface RunArtifactIteration {
  readonly name: string;
  readonly outcome: RunArtifactOutcome;
  readonly durationMs: number;
  readonly attempts: number;
}

export interface RunArtifactResult {
  // Absent means an unmapped scenario ran anyway; the scenario→key join lands with preflight (2c).
  readonly testKey?: string | undefined;
  readonly scenario: ScenarioRef;
  readonly outcome: RunArtifactOutcome;
  readonly durationMs: number;
  readonly attempts: number;
  readonly flaky: boolean;
  readonly iterations?: readonly RunArtifactIteration[] | undefined;
  // Workspace-relative, forward-slashed paths to Playwright evidence (screenshots/traces/videos);
  // paths only, never blobs.
  readonly evidenceRefs: readonly string[];
}

// One TestExecutor invocation within a batch (there is no Playwright `--shard` here, only
// `--workers`): its cwd, the command that ran, and the exit state it produced.
export interface ShardInfo {
  readonly workingDir: string;
  readonly command: string;
  readonly exitCode: number;
  readonly success: boolean;
}

// A non-`ready` preflight item's recorded resolution, sealed onto the artifact. `repair`/`cancel`
// never reach here — repair loops back into classification and cancel runs nothing.
export interface PreflightDecision {
  readonly scenario: ScenarioRef;
  readonly testKey?: string | undefined;
  readonly state: PreflightState;
  readonly outcome: "exclude" | "local-only";
}

// One immutable, multi-test capture of a local run: a batch opens a builder, each executor
// invocation contributes a shard, and closing the batch seals exactly one of these.
export interface RunArtifact {
  readonly id: string;
  readonly createdAt: number;
  readonly results: readonly RunArtifactResult[];
  readonly shards: readonly ShardInfo[];
  // The batch-scope descriptor that produced it.
  readonly selection: BatchSelection;
  // The recorded resolutions for every non-`ready` scenario in the batch; empty when all were ready.
  readonly preflight: readonly PreflightDecision[];
  readonly state: RunArtifactState;
}

// Immutable multi-test store: a publish buffer keeping the last few runs, newest first. Badge parity
// is `latestOutcome`; badges themselves still flow through the separate `RunResultStore`.
export interface RunArtifactStore {
  latestOutcome(testKey: string): RunArtifactOutcome | undefined;
  latest(): RunArtifact | undefined;
  list(): RunArtifact[];
  append(artifact: RunArtifact): void;
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

// A capability method that is declared on the interface but deliberately unimplemented at the current
// phase (e.g. the Xray automation-binding write, which lands in P3). Callers catch this to degrade
// gracefully rather than surface it as an unexpected failure.
export class NotSupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotSupportedError";
  }
}

export interface AutomationBindingCapability {
  // Pure, offline classification of a target test's automation compatibility for preflight. Provider
  // logic lives here, never in the neutral preflight core. `undefined`/partial metadata → `unknown`.
  // This is the P2 deliverable — validation only.
  classify(meta: TestCaseMetadata | undefined): AutomationBindingClassification;
  // Establishing the binding by writing to the remote is a P3 write path; it rejects with a
  // `NotSupportedError` until then. P2 never binds — it only classifies.
  bind(ref: TestCaseRef, signal?: AbortSignal): Promise<void>;
}

// The outcome of a remote search beyond the synced snapshot. An EMPTY `tests` with `complete: true`
// is an honest "no matches" (§5: a bad JQL clause returns 0 rows, it never errors), never an "invalid
// query"; `complete: false` means the fetch paged short or hit a transport fault.
export interface RemoteSearchResult {
  readonly tests: readonly TestCaseMetadata[];
  readonly complete: boolean;
}

// Optional capability: search the provider for tests the local snapshot never synced, and merge a
// picked test's metadata into the snapshot without a full sync. Capability-gated — the linkScenario
// picker only offers remote search when the active adapter exposes this.
export interface RemoteSearchCapability {
  search(text: string, signal?: AbortSignal): Promise<RemoteSearchResult>;
  // Additive, non-destructive merge of specific keys' metadata into the local snapshot (fires the
  // metadata change event). Never demotes catalogue completeness — it supplements, like a key batch.
  mergeKeys(keys: readonly string[], signal?: AbortSignal): Promise<void>;
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
  readonly remoteSearch?: RemoteSearchCapability | undefined;
  readonly resultPublishing?: ResultPublishingCapability | undefined;
  readonly attachments?: AttachmentCapability | undefined;

  dispose?(): void;
}
