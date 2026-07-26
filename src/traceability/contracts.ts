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
  // The remote issue id (Xray addresses mutations by `issueId`, not the Jira key). Retained on the
  // snapshot so a future push-text path can target `updateGherkinTestDefinition` without a re-fetch;
  // absent on a partial snapshot that never read it.
  readonly issueId?: string | undefined;
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
// scope present, every project's pages complete, no catalogue errors; a supplemental key batch,
// present or failed, never affects it) and gates orphan derivation: orphans are only authoritative
// on a `"complete"` catalogue fetch; a `"partial"` or `"unknown"` snapshot must never yield orphan
// counts.
export interface RemoteMetadataSnapshot {
  readonly tests: ReadonlyMap<string, TestCaseMetadata>;
  readonly fetchedScopes: readonly string[];
  // The project keys whose full catalogue this snapshot attempted; authoritative for key-absence
  // verdicts only when `completeness === "complete"` (which already implies every catalogue page
  // complete with no catalogue errors; `errors` may still carry key-batch failures).
  readonly catalogueProjects: readonly string[];
  // Canonical keys a *successful* key-batch fetch explicitly queried and the remote did not return,
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
// declared for slice 2d's plan lookup; 2c never produces it.
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
// partial snapshot) never blocks; preflight maps it to `ready` with an honest note.
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
// never reach here; repair loops back into classification and cancel runs nothing.
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

// A remote container a batch can publish into: an existing Test Execution to append to, or a Test
// Plan to associate a new execution with. `ref` carries the canonical key for browse links.
export interface PublishTarget {
  readonly id: string;
  readonly label: string;
  readonly ref: ExternalRef;
}

// The user's resolved publish choice. Create-new drives the Cucumber multipart importer (project +
// summary + optional plan/environments); append drives the Xray JSON importer (top-level execution
// key, project derived from it). Always asked, never a remembered key (§2).
export type PublishRequest =
  | {
      readonly mode: "create-new";
      readonly project: string;
      readonly summary: string;
      readonly testPlanKey?: string | undefined;
      readonly environments?: readonly string[] | undefined;
    }
  | { readonly mode: "append"; readonly executionKey: string };

// The result of a successful publish: the created/appended execution, how many results the import
// carried, and any honest notes (e.g. scenarios dropped because their source changed since the run,
// or evidence files skipped for size). `issueEvidenceFiles` are per-result evidence paths the
// `xray.attachTo` mode routes to the Jira issue rather than the payload; the flow uploads them
// (alongside the dialog's run-level picks) after a successful import.
export interface PublishOutcome {
  readonly ref: ExecutionRef;
  readonly imported: number;
  readonly warnings: readonly string[];
  readonly issueEvidenceFiles?: readonly string[] | undefined;
}

export type ConnectionVerifyStatus = "ok" | "auth-failed" | "unreachable";

export interface ConnectionVerifyResult {
  status: ConnectionVerifyStatus;
  message: string;
}

// Read-side view of the provider connection. The connect/disconnect actions live in provider
// commands + the credential store, not here; this capability only reports state.
export interface ConnectionCapability {
  readonly onDidChange: Event<void>;
  readonly label: string;
  isConnected(): Promise<boolean>;
  // `verify` runs a live, cheap handshake against the provider; `isConnected()` stays "credentials
  // stored" and continues to gate tree visibility; the two deliberately differ so the offline tree
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
  // This is the P2 deliverable, validation only.
  classify(meta: TestCaseMetadata | undefined): AutomationBindingClassification;
  // `bind` writes an automation binding to the remote. For Xray it stays `NotSupportedError` by
  // adjudication, not for lack of an API: the mutation root DOES expose `updateTestType`, but the
  // only "binding" that would mean is converting an existing remote test's type, a destructive
  // change to an issue we don't own. An `incompatible-test-type` is repaired by linking a different
  // test or authoring a new one (`TestAuthoringCapability`), never by mutating theirs.
  bind(ref: TestCaseRef, signal?: AbortSignal): Promise<void>;
}

// A brand-new remote test authored from a local scenario. `summary` is the scenario name; `gherkin`
// is the verbatim source slice, the same text the drift badge and the push compare.
export interface NewTestSpec {
  readonly project: string;
  readonly summary: string;
  readonly gherkin: string;
}

// A brand-new remote container (a Test Set or a Test Plan) authored from tests picked on the board:
// where it lands, what it is called, and the remote issue ids of the tests it holds.
export interface NewContainerSpec {
  readonly project: string;
  readonly summary: string;
  readonly testIssueIds: readonly string[];
}

// A brand-new, EMPTY remote Test Execution: where it lands and what it is called. It carries no tests and
// no environments by design, so a later publish is what appends both.
export interface NewExecutionSpec {
  readonly project: string;
  readonly summary: string;
}

// The authored issue (a test, or one of the containers the seams below create), read back from the SAME
// create response, no follow-up fetch. `key` is absent only when the response carried no readable key:
// the issue still exists remotely (and `issueId` may pin it), so the flow surfaces that rather than
// inserting a tag, or naming a container, it could not read back.
export interface AuthoredTest {
  readonly key?: string | undefined;
  readonly issueId?: string | undefined;
  readonly warnings: readonly string[];
}

// Optional capability: author a brand-new remote test from a local scenario's Gherkin. Capability-
// gated; the linkScenario picker only offers "create a new test" when the active adapter exposes it
// (the live, credentialed adapter, never the browse-only instance). This is the only authoring write
// the extension makes; converting an existing test's type stays out of scope (see `bind` above).
export interface TestAuthoringCapability {
  createTest(spec: NewTestSpec, signal?: AbortSignal): Promise<AuthoredTest>;
  // Optional: create a container holding the given tests, addressed by their remote issue ids. One
  // mutation creates the whole container, so the caller resolves every member's issue id before
  // calling. A container short of members cannot be repaired from the response.
  createTestSet?(spec: NewContainerSpec, signal?: AbortSignal): Promise<AuthoredTest>;
  createTestPlan?(spec: NewContainerSpec, signal?: AbortSignal): Promise<AuthoredTest>;
  // Optional: create an empty Test Execution to publish results into later. It takes no members, so it
  // has no issue ids to resolve and no selection to read.
  createTestExecution?(spec: NewExecutionSpec, signal?: AbortSignal): Promise<AuthoredTest>;
  // Optional: replace an existing remote test's Gherkin body with local text, addressed by the remote
  // `issueId` (the only handle the write takes, never a key). Resolves to the text read back from the
  // same response, or `undefined` when it carried none, so the caller verifies instead of assuming.
  // Read at call time, like the bulk create's capability check: the board always paints its Push
  // affordance, and an adapter without this seam reports an unconnected tracker instead of writing.
  pushGherkin?(issueId: string, gherkin: string, signal?: AbortSignal): Promise<string | undefined>;
}

// The outcome of a remote search beyond the synced snapshot. An EMPTY `tests` with `complete: true`
// is an honest "no matches" (§5: a bad JQL clause returns 0 rows, it never errors), never an "invalid
// query"; `complete: false` means the fetch paged short or hit a transport fault.
export interface RemoteSearchResult {
  readonly tests: readonly TestCaseMetadata[];
  readonly complete: boolean;
}

// Optional capability: search the provider for tests the local snapshot never synced, and merge a
// picked test's metadata into the snapshot without a full sync. Capability-gated; the linkScenario
// picker only offers remote search when the active adapter exposes this.
export interface RemoteSearchCapability {
  search(text: string, signal?: AbortSignal): Promise<RemoteSearchResult>;
  // Additive, non-destructive merge of specific keys' metadata into the local snapshot (fires the
  // metadata change event). Never demotes catalogue completeness; it supplements, like a key batch.
  mergeKeys(keys: readonly string[], signal?: AbortSignal): Promise<void>;
}

// The projects a connection can reach. `truncated` means the provider capped the list, so absence from
// `projects` is never proof a project does not exist.
export interface ProjectDirectory {
  readonly projects: readonly { readonly key: string; readonly name: string }[];
  readonly truncated: boolean;
}

// Optional capability: enumerate the projects the current credentials can reach, so a surface can offer
// them without the workspace having to name them first. Offline-first like `metadata`: `cached` answers
// from the last-known list synchronously (empty before the first refresh) and kicks a background refresh
// once it has aged out, which fires the provider's metadata change event so the surface repaints; `list`
// is the awaited fetch. Capability-gated: an adapter that cannot enumerate projects omits it.
export interface ProjectDirectoryCapability {
  cached(): ProjectDirectory;
  list(signal?: AbortSignal): Promise<ProjectDirectory>;
}

export interface ResultPublishingCapability {
  // Search the tracker for the targets a publish can name: executions to append to, test plans to
  // associate a new execution with, projects to create one in. Requires provider credentials for the
  // query API; rejects with a `NotSupportedError` when they are absent, and the dialog falls back to a
  // plain key input (the import response is then the only validator).
  searchTargets(
    kind: "execution" | "test-plan" | "project",
    query: string,
    signal?: AbortSignal
  ): Promise<readonly PublishTarget[]>;
  // One batch → one execution: create-new imports via the create path, append via the append path.
  // The reconcile filter (`publishableResults`) runs INSIDE; a result being present in the artifact
  // is not consent to publish it. Deferred creation: this single call creates the execution WITH its
  // results; it never invokes a remote runner.
  publish(artifact: RunArtifact, request: PublishRequest, signal?: AbortSignal): Promise<PublishOutcome>;
}

export interface AttachmentCapability {
  attach(target: ExecutionRef, files: readonly string[], signal?: AbortSignal): Promise<void>;
}

// A small base plus independently optional capabilities; the model reads whichever capabilities an
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
  readonly projectDirectory?: ProjectDirectoryCapability | undefined;
  readonly testAuthoring?: TestAuthoringCapability | undefined;
  readonly resultPublishing?: ResultPublishingCapability | undefined;
  readonly attachments?: AttachmentCapability | undefined;

  dispose?(): void;
}
