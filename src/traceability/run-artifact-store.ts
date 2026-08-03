import { EventEmitter, type Event, type Memento } from "vscode";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import {
  ScenarioResult,
  isAbsolutePathKey,
  normalizePathKey,
} from "../utils/playwright-json-parser";
import { Logger } from "../utils/logger";
import { EXECUTION_LIMITS } from "../core/execution-limits";
import type { ScenarioRef } from "./scenario-ref";
import {
  BatchSelection,
  PreflightDecision,
  RunArtifact,
  RunArtifactIteration,
  RunArtifactOutcome,
  RunArtifactResult,
  RunArtifactState,
  RunArtifactStore as RunArtifactStoreContract,
  ShardInfo,
} from "./contracts";

// Resolves a ran scenario to the remote test key it maps to, from the same traceability snapshot
// preflight classifies against. Absent (or returning undefined) leaves a result unmapped.
export type ArtifactKeyResolver = (
  scenario: ScenarioRef,
  invocation?: ScenarioRef
) => string | undefined;

// Produces a resolver frozen over the snapshot as it stands NOW. `beginBatch` calls this once, so a
// sync landing mid-batch cannot split an artifact's test keys across shards.
export type ArtifactKeyResolverFactory = () => ArtifactKeyResolver;

// The mapped unit that owns one traceability-command invocation. Outline-shaped runs can execute
// more rows than that unit owns, so `resultLines` narrows only the artifact capture, not the run UI.
export interface ArtifactCaptureTarget {
  readonly scenario: ScenarioRef;
  readonly resultLines?: readonly number[] | undefined;
}

export function scopeArtifactDetails(
  details: readonly ScenarioResult[],
  target: ArtifactCaptureTarget | undefined,
  workingDir?: string
): ScenarioResult[] {
  const lines = target?.resultLines;
  const filePath = target?.scenario.filePath;
  const cwd = workingDir ? normalizePathKey(workingDir) : undefined;
  const normalized = details.map((detail) => {
    const featurePath = normalizePathKey(detail.featurePath);
    const absolute = cwd !== undefined && !isAbsolutePathKey(featurePath)
      ? path.posix.join(cwd, featurePath)
      : featurePath;
    return absolute === detail.featurePath ? detail : { ...detail, featurePath: absolute };
  });
  if (lines === undefined || filePath === undefined) {return normalized;}
  const normalizedTarget = normalizePathKey(filePath);
  const file = cwd !== undefined && !isAbsolutePathKey(normalizedTarget)
    ? path.posix.join(cwd, normalizedTarget)
    : normalizedTarget;
  return normalized.filter((detail) => {
    if (detail.lineNumber === undefined || !lines.includes(detail.lineNumber)) {return false;}
    return detail.featurePath === file;
  });
}

// What one TestExecutor invocation hands the open builder at a capture seam. `details` are the same
// parsed scenarios that feed RunResultStore.ingest; the report they came from is already unlinked.
export interface ShardCapture {
  readonly workingDir: string;
  readonly command: string;
  readonly success: boolean;
  readonly exitCode: number;
  readonly details: readonly ScenarioResult[];
  readonly workspaceRoot?: string | undefined;
  readonly invocation?: ScenarioRef | undefined;
}

const OUTCOME_SEVERITY: Record<RunArtifactOutcome, number> = {
  passed: 0,
  skipped: 1,
  "timed-out": 2,
  interrupted: 3,
  failed: 4,
};

function detailOutcome(detail: ScenarioResult): RunArtifactOutcome {
  return detail.outcome ?? detail.status;
}

function worst(a: RunArtifactOutcome, b: RunArtifactOutcome): RunArtifactOutcome {
  return OUTCOME_SEVERITY[b] > OUTCOME_SEVERITY[a] ? b : a;
}

// Playwright writes absolute evidence paths; the contract is workspace-relative, forward-slashed
// refs only (the regex-path gotcha demands forward slashes on every emitted path). An attachment
// outside the workspace, or one we can't relativize, is dropped rather than leak an absolute
// directory tree into the (future) publish payload.
function evidenceRef(absPath: string, workspaceRoot: string | undefined): string | undefined {
  if (workspaceRoot === undefined) {return undefined;}
  const rel = path.posix.relative(normalizePathKey(workspaceRoot), normalizePathKey(absPath));
  return rel !== "" && !rel.startsWith("..") ? rel : undefined;
}

function addEvidence(target: Set<string>, detail: ScenarioResult, workspaceRoot: string | undefined): void {
  for (const attachment of detail.attachmentPaths ?? []) {
    const ref = evidenceRef(attachment, workspaceRoot);
    if (ref !== undefined) {target.add(ref);}
  }
}

function groupKey(detail: ScenarioResult): string {
  const featurePath = normalizePathKey(detail.featurePath);
  return detail.outlineName !== undefined
    ? `outline\u0000${featurePath}\u0000${detail.outlineName}`
    : `scenario\u0000${featurePath}\u0000${detail.lineNumber ?? ""}\u0000${detail.scenarioName}`;
}

// A plain scenario, collapsing any multi-project/repeat-each entries (worst outcome wins).
function buildScenarioResult(
  rep: ScenarioResult,
  group: readonly ScenarioResult[],
  workspaceRoot: string | undefined
): RunArtifactResult {
  let outcome = detailOutcome(rep);
  let durationMs = 0;
  let attempts = 1;
  let flaky = false;
  const evidence = new Set<string>();
  for (const detail of group) {
    outcome = worst(outcome, detailOutcome(detail));
    durationMs = Math.max(durationMs, detail.durationMs ?? 0);
    attempts = Math.max(attempts, detail.attempts ?? 1);
    flaky = flaky || (detail.flaky ?? false);
    addEvidence(evidence, detail, workspaceRoot);
  }
  const scenario: ScenarioRef = {
    filePath: normalizePathKey(rep.featurePath),
    line: rep.lineNumber ?? 0,
    name: rep.scenarioName,
    kind: "scenario",
  };
  return { scenario, outcome, durationMs, attempts, flaky, evidenceRefs: [...evidence] };
}

// A Scenario Outline, one iteration per example row (multi-project rows of the same example merge).
function buildOutlineResult(
  rep: ScenarioResult,
  outlineName: string,
  group: readonly ScenarioResult[],
  workspaceRoot: string | undefined
): RunArtifactResult {
  const byExample = new Map<string, ScenarioResult[]>();
  for (const detail of group) {
    const existing = byExample.get(detail.scenarioName);
    if (existing) {existing.push(detail);} else {byExample.set(detail.scenarioName, [detail]);}
  }

  const iterations: RunArtifactIteration[] = [];
  let outcome: RunArtifactOutcome | undefined;
  let durationMs = 0;
  let attempts = 1;
  let flaky = false;
  const evidence = new Set<string>();

  for (const [name, entries] of byExample) {
    const first = entries[0];
    if (first === undefined) {continue;}
    let iterOutcome = detailOutcome(first);
    let iterDuration = 0;
    let iterAttempts = 1;
    for (const detail of entries) {
      iterOutcome = worst(iterOutcome, detailOutcome(detail));
      iterDuration = Math.max(iterDuration, detail.durationMs ?? 0);
      iterAttempts = Math.max(iterAttempts, detail.attempts ?? 1);
      flaky = flaky || (detail.flaky ?? false);
      addEvidence(evidence, detail, workspaceRoot);
    }
    iterations.push({ name, outcome: iterOutcome, durationMs: iterDuration, attempts: iterAttempts });
    outcome = outcome === undefined ? iterOutcome : worst(outcome, iterOutcome);
    durationMs += iterDuration;
    attempts = Math.max(attempts, iterAttempts);
  }

  const scenario: ScenarioRef = {
    filePath: normalizePathKey(rep.featurePath),
    line: rep.lineNumber ?? 0,
    name: outlineName,
    kind: "outline",
    outlineName,
  };
  return {
    scenario,
    outcome: outcome ?? "skipped",
    durationMs,
    attempts,
    flaky,
    iterations,
    evidenceRefs: [...evidence],
  };
}

// Fold one invocation's parsed scenarios into artifact results: outline example rows collapse into
// a single result carrying per-iteration data, plain scenarios into one result each. `resolveKey`
// threads the scenario→testKey mapping so a mapped scenario's result carries its key (badge parity
// and, later, the publish set); an unmapped scenario simply runs without one.
export function buildArtifactResults(
  details: readonly ScenarioResult[],
  workspaceRoot: string | undefined,
  resolveKey?: ArtifactKeyResolver
): RunArtifactResult[] {
  const groups = new Map<string, ScenarioResult[]>();
  for (const detail of details) {
    const key = groupKey(detail);
    const existing = groups.get(key);
    if (existing) {existing.push(detail);} else {groups.set(key, [detail]);}
  }

  const results: RunArtifactResult[] = [];
  for (const group of groups.values()) {
    const rep = group[0];
    if (rep === undefined) {continue;}
    const result =
      rep.outlineName !== undefined
        ? buildOutlineResult(rep, rep.outlineName, group, workspaceRoot)
        : buildScenarioResult(rep, group, workspaceRoot);
    const testKey = resolveKey?.(result.scenario);
    results.push(testKey !== undefined ? { ...result, testKey } : result);
  }
  return results;
}

// Accumulates one batch: shards contribute at the capture seams, `seal` produces the immutable
// artifact. A shard that failed without producing any results marks the batch partial; an explicit
// cancel wins over that.
export class ArtifactBuilder {
  private readonly shards: ShardInfo[] = [];
  private readonly results: RunArtifactResult[] = [];
  private invocationFailed = false;

  constructor(
    private readonly selection: BatchSelection,
    private readonly resolveKey?: ArtifactKeyResolver,
    private readonly decisions: readonly PreflightDecision[] = []
  ) {}

  public addShard(capture: ShardCapture): void {
    this.shards.push({
      workingDir: normalizePathKey(capture.workingDir),
      command: capture.command,
      exitCode: capture.exitCode,
      success: capture.success,
    });
    const resolveKey = this.resolveKey
      ? (scenario: ScenarioRef) => this.resolveKey?.(scenario, capture.invocation)
      : undefined;
    const details = scopeArtifactDetails(capture.details, undefined, capture.workingDir);
    const results = buildArtifactResults(details, capture.workspaceRoot, resolveKey);
    const invocation = capture.invocation
      ? { ...capture.invocation, filePath: normalizePathKey(capture.invocation.filePath) }
      : undefined;
    this.results.push(...results.map((result) => (
      invocation ? { ...result, scenario: invocation } : result
    )));
    if (details.length === 0 && (!capture.success || capture.invocation !== undefined)) {
      this.invocationFailed = true;
    }
  }

  public seal(requestedState: RunArtifactState): RunArtifact {
    let state: RunArtifactState = requestedState;
    if (requestedState === "complete" && this.invocationFailed) {state = "partial";}
    return {
      id: randomUUID(),
      createdAt: Date.now(),
      results: this.results,
      shards: this.shards,
      selection: this.selection,
      preflight: [...this.decisions],
      state,
    };
  }
}

const KNOWN_STATES: readonly RunArtifactState[] = ["complete", "partial", "cancelled"];

// workspaceState is a boundary: an artifact written by an older build (or hand-corrupted) is dropped
// silently rather than trusted: this is a publish buffer, so a missing element costs nothing.
function isValidArtifact(value: unknown): value is RunArtifact {
  if (typeof value !== "object" || value === null) {return false;}
  const artifact = value as Record<string, unknown>;
  const selection = artifact["selection"];
  return (
    typeof artifact["id"] === "string" &&
    typeof artifact["createdAt"] === "number" &&
    typeof selection === "object" &&
    selection !== null &&
    typeof (selection as { kind?: unknown }).kind === "string" &&
    Array.isArray(artifact["results"]) &&
    Array.isArray(artifact["shards"]) &&
    Array.isArray(artifact["preflight"]) &&
    KNOWN_STATES.includes(artifact["state"] as RunArtifactState)
  );
}

function deepFreeze<T>(value: T): T {
  if (typeof value === "object" && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value)) {deepFreeze(nested);}
  }
  return value;
}

function serializedBytes(artifacts: readonly RunArtifact[]): number {
  return Buffer.byteLength(JSON.stringify(artifacts));
}

function pruneArtifacts(artifacts: RunArtifact[], maxArtifacts: number): boolean {
  let changed = false;
  while (
    artifacts.length > maxArtifacts ||
    serializedBytes(artifacts) > EXECUTION_LIMITS.artifactBytesPerWorkspace
  ) {
    artifacts.pop();
    changed = true;
  }
  return changed;
}

// The last few sealed run artifacts, newest first, mirrored into workspaceState so they survive a
// reload. A publish buffer, not a history feature: older artifacts drop silently past the cap.
export class RunArtifactStore implements RunArtifactStoreContract {
  private static readonly STORAGE_KEY = "specwright.runArtifacts";
  private static readonly MAX = 10;

  private readonly artifacts: RunArtifact[];
  private openBuilder: ArtifactBuilder | undefined;
  private openHandle: number | undefined;
  private nextHandle = 1;
  private keyResolverFactory: ArtifactKeyResolverFactory | undefined;
  private readonly changeEmitter = new EventEmitter<void>();

  // The buffer changed. A Publish dialog left open across a run re-derives its dropdown from this rather
  // than showing the list the store held when it opened.
  public readonly onDidChange: Event<void> = this.changeEmitter.event;

  constructor(
    private readonly memento: Memento,
    private readonly logger: Logger
  ) {
    const stored = memento.get<unknown>(RunArtifactStore.STORAGE_KEY);
    const candidates = Array.isArray(stored) ? stored : [];
    this.artifacts = candidates
      .filter(isValidArtifact)
      .slice(0, RunArtifactStore.MAX)
      .map((artifact) => deepFreeze(artifact));
    const pruned = pruneArtifacts(this.artifacts, RunArtifactStore.MAX);
    if (pruned || this.artifacts.length !== candidates.length) {this.save();}
  }

  // Installed once at wiring time (the traceability model outlives batches and provider swaps). The
  // factory is invoked at `beginBatch` to freeze one resolver per artifact, so a sync landing between
  // shards can't split a batch's testKeys.
  public setKeyResolver(factory: ArtifactKeyResolverFactory): void {
    this.keyResolverFactory = factory;
  }

  // The handle keys every shard/seal to its batch so a command-driven run firing at the shared
  // executor seam mid-batch can't inject a foreign shard into the open Test Explorer artifact.
  public beginBatch(selection: BatchSelection, decisions: readonly PreflightDecision[] = []): number {
    this.openBuilder = new ArtifactBuilder(selection, this.keyResolverFactory?.(), decisions);
    this.openHandle = this.nextHandle;
    this.nextHandle += 1;
    return this.openHandle;
  }

  public contributeShard(handle: number, capture: ShardCapture): void {
    if (handle !== this.openHandle) {return;}
    this.openBuilder?.addShard(capture);
  }

  public sealBatch(handle: number, state: RunArtifactState): RunArtifact | undefined {
    const builder = this.openBuilder;
    if (handle !== this.openHandle || builder === undefined) {return undefined;}
    this.openBuilder = undefined;
    this.openHandle = undefined;
    const sealed = builder.seal(state);
    this.append(sealed);
    return this.artifacts.find((artifact) => artifact.id === sealed.id);
  }

  public append(artifact: RunArtifact): void {
    const stored = deepFreeze(structuredClone(artifact));
    if (serializedBytes([stored]) > EXECUTION_LIMITS.artifactBytesPerWorkspace) {
      this.logger.warn("Run artifact exceeds the workspace storage budget and was not retained", {
        artifactId: stored.id,
        maxBytes: EXECUTION_LIMITS.artifactBytesPerWorkspace,
      });
      // The batch still closed; announce it so listeners refresh even though the
      // buffer kept its previous contents.
      this.persist();
      return;
    }
    this.artifacts.unshift(stored);
    pruneArtifacts(this.artifacts, RunArtifactStore.MAX);
    this.persist();
  }

  public latest(): RunArtifact | undefined {
    return this.artifacts[0];
  }

  // Empties the buffer and returns how many artifacts went. An open builder is left alone: a batch
  // running through a clear seals and appends afterwards, which is the record the user just asked for.
  public clear(): number {
    const removed = this.artifacts.length;
    this.artifacts.length = 0;
    this.persist();
    return removed;
  }

  public list(): RunArtifact[] {
    return [...this.artifacts];
  }

  public latestOutcome(testKey: string): RunArtifactOutcome | undefined {
    for (const artifact of this.artifacts) {
      for (const result of artifact.results) {
        if (result.testKey === testKey) {return result.outcome;}
      }
    }
    return undefined;
  }

  // Every mutation of the buffer lands here, so this is where the change is announced. Subscribers read
  // the in-memory list, which is already current, so the announcement does not wait on the write.
  private persist(): void {
    this.changeEmitter.fire();
    this.save();
  }

  private save(): void {
    Promise.resolve(this.memento.update(RunArtifactStore.STORAGE_KEY, this.artifacts)).catch(
      (error: unknown) => {
        this.logger.warn("Failed to persist run artifacts", { error: String(error) });
      }
    );
  }
}
