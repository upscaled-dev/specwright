import * as vscode from "vscode";
import {
  ConnectionCapability,
  ExternalRef,
  KeyGrammar,
  MetadataCapability,
  PublishResult,
  PublishTarget,
  RemoteMetadataSnapshot,
  ResultPublishingCapability,
  RunArtifact,
  SyncScope,
  TestCaseMetadata,
  TraceabilityAdapter,
} from "./contracts";
import { AdapterContext, TraceabilityAdapterFactory } from "./adapter-registry";

export const IN_MEMORY_PROVIDER_ID = "in-memory";

// Deliberately non-Jira: a numeric key body (never `PROJECT-123`), no project derivation, and a
// canonicalization that strips leading zeros. This is what keeps the core honest — anything that
// assumes the Xray grammar breaks here first.
const IN_MEMORY_GRAMMAR: KeyGrammar = {
  testPrefix: "TC-",
  reqPrefix: "RQ-",
  keyShape: /^\d+$/,
  canonicalizeKey: (key) => String(Number.parseInt(key, 10)),
};

export interface PublishRecord {
  readonly artifact: RunArtifact;
  readonly targetId: string;
}

export interface InMemoryFixture {
  connected?: boolean;
  label?: string;
  targets?: readonly PublishTarget[];
}

/**
 * The contract-test reference adapter (§3.6). It stands in for a real provider so the core is
 * exercised against a non-Jira grammar and can simulate partial catalogues and sync errors without
 * a network. Not registered in the public settings enum — the subsystem resolves it only from a
 * hand-typed `traceability.provider` value.
 */
export class InMemoryTraceabilityAdapter implements TraceabilityAdapter, vscode.Disposable {
  public readonly id = IN_MEMORY_PROVIDER_ID;
  public readonly label = "In-Memory";
  public readonly keyGrammar = IN_MEMORY_GRAMMAR;

  public readonly connection: ConnectionCapability;
  public readonly metadata: MetadataCapability;
  public readonly resultPublishing: ResultPublishingCapability;

  private readonly _onConnectionChange = new vscode.EventEmitter<void>();
  private readonly _onMetadataChange = new vscode.EventEmitter<void>();

  private connected: boolean;

  private tests = new Map<string, TestCaseMetadata>();
  private fetchedScopes: string[] = [];
  private catalogueProjects: string[] = [];
  private verifiedAbsentKeys: string[] = [];
  private completeness: RemoteMetadataSnapshot["completeness"] = "unknown";
  private syncedAt: number | undefined;
  private errors: string[] = [];

  // Seeded fixture the next sync draws from, plus the outcome that sync should simulate.
  private catalogue = new Map<string, TestCaseMetadata>();
  private nextCompleteness: "complete" | "partial" = "complete";
  private nextError: string | undefined;

  private targets: PublishTarget[];
  private readonly _publications: PublishRecord[] = [];

  constructor(fixture: InMemoryFixture = {}) {
    this.connected = fixture.connected ?? false;
    this.targets = [...(fixture.targets ?? [])];

    // The label is fixed for the fixture; `isConnected` reads live state through the arrow's `this`.
    this.connection = {
      onDidChange: this._onConnectionChange.event,
      label: fixture.label ?? "in-memory-fixture",
      isConnected: () => Promise.resolve(this.connected),
      verify: () => Promise.resolve({ status: "ok", message: "Connected (in-memory)" }),
    };
    this.metadata = {
      onDidChange: this._onMetadataChange.event,
      snapshot: () => this.snapshot(),
      sync: (scope, signal) => this.sync(scope, signal),
    };
    this.resultPublishing = {
      listTargets: () => Promise.resolve([...this.targets]),
      publish: (artifact, target) => this.publish(artifact, target),
    };
  }

  public browseUrl(ref: ExternalRef): string | undefined {
    return `memory://tests/${ref.key}`;
  }

  // --- fixture controls (contract-test only) --------------------------------

  public setConnected(value: boolean): void {
    if (this.connected === value) {
      return;
    }
    this.connected = value;
    this._onConnectionChange.fire();
  }

  public seedCatalogue(
    tests: readonly TestCaseMetadata[],
    completeness: "complete" | "partial" = "complete"
  ): void {
    this.catalogue = new Map(tests.map((test) => [test.key, test]));
    this.nextCompleteness = completeness;
    this.nextError = undefined;
  }

  public seedSyncError(message: string): void {
    this.nextError = message;
  }

  public get publications(): readonly PublishRecord[] {
    return this._publications;
  }

  // --- capability bodies ----------------------------------------------------

  private snapshot(): RemoteMetadataSnapshot {
    return {
      tests: new Map(this.tests),
      fetchedScopes: [...this.fetchedScopes],
      catalogueProjects: [...this.catalogueProjects],
      verifiedAbsentKeys: [...this.verifiedAbsentKeys],
      syncedAt: this.syncedAt,
      stale: false,
      completeness: this.completeness,
      errors: [...this.errors],
    };
  }

  private sync(scope: SyncScope, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) {
      return Promise.resolve();
    }
    this.fetchedScopes = [...(scope.projectKeys ?? []), ...(scope.testKeys ?? [])];
    this.catalogueProjects = (scope.projectKeys ?? []).map((key) => key.toUpperCase());
    this.syncedAt = Date.now();
    if (this.nextError !== undefined) {
      // A failed fetch surfaces in `errors` and demotes completeness (offline-first: last-known
      // metadata is kept, orphans are suppressed) rather than throwing. A failed batch proves no
      // absence.
      this.errors = [this.nextError];
      this.completeness = "unknown";
      this.verifiedAbsentKeys = [];
      this.nextError = undefined;
    } else {
      this.errors = [];
      this.tests = new Map(this.catalogue);
      this.completeness = this.nextCompleteness;
      const present = new Set([...this.catalogue.keys()].map((key) => key.toUpperCase()));
      this.verifiedAbsentKeys = (scope.testKeys ?? [])
        .map((key) => key.toUpperCase())
        .filter((key) => !present.has(key));
    }
    this._onMetadataChange.fire();
    return Promise.resolve();
  }

  private publish(artifact: RunArtifact, target: PublishTarget): Promise<PublishResult> {
    this._publications.push({ artifact, targetId: target.id });
    if (!this.targets.some((existing) => existing.id === target.id)) {
      this.targets = [...this.targets, target];
    }
    return Promise.resolve({ targetId: target.id, ref: { kind: "execution", key: target.id } });
  }

  public dispose(): void {
    this._onConnectionChange.dispose();
    this._onMetadataChange.dispose();
  }
}

export function createInMemoryAdapterFactory(
  fixture: InMemoryFixture = {}
): TraceabilityAdapterFactory {
  return {
    id: IN_MEMORY_PROVIDER_ID,
    create: (_ctx: AdapterContext) => new InMemoryTraceabilityAdapter(fixture),
  };
}
