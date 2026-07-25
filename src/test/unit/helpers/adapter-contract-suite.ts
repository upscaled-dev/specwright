import { describe, it, expect } from "vitest";
import { FeatureParser } from "../../../parsers/feature-parser";
import {
  buildTraceabilitySnapshot,
  ParsedFeatureInput,
  TraceabilitySnapshot,
} from "../../../traceability/traceability-model";
import { extractKeys } from "../../../traceability/tag-extraction";
import {
  PublishRequest,
  RunArtifact,
  SyncScope,
  TestCaseMetadata,
  TraceabilityAdapter,
} from "../../../traceability/contracts";

// The control surface a provider binds to run the shared contract suite. The in-memory adapter
// implements it directly; a future Xray binding implements it over a mocked transport + credential
// store — the suite itself stays provider-agnostic (drives connect/sync only through this harness
// and the neutral capabilities).
export interface AdapterContractHarness {
  readonly adapter: TraceabilityAdapter;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  seedCatalogue(tests: readonly TestCaseMetadata[], completeness: "complete" | "partial"): void;
  seedSyncError(message: string): void;
  readonly syncScope: SyncScope;
  // A tag set exercising the adapter's grammar, with the canonical keys it must extract.
  readonly grammarSample: {
    readonly tags: string[];
    readonly testKeys: string[];
    readonly reqKeys: string[];
  };
  // A canonical key that is both referenced by `mappedFeature` locally and seeded in the catalogue.
  readonly mappedKey: string;
  // A catalogue key with no local scenario (an orphan on a complete fetch).
  readonly orphanKey: string;
  makeArtifact(): RunArtifact;
  readonly publishRequest: PublishRequest;
}

function mappedFeature(harness: AdapterContractHarness): ParsedFeatureInput {
  const prefix = harness.adapter.keyGrammar.testPrefix;
  const content = `Feature: Contract\n\n@${prefix}${harness.mappedKey}\nScenario: mapped\n  Given a step\n`;
  const parsed = FeatureParser.create().parseFeatureContent(content);
  return { filePath: "/ws/contract.feature", scenarios: parsed?.scenarios ?? [] };
}

function join(harness: AdapterContractHarness): TraceabilitySnapshot {
  const remote = harness.adapter.metadata?.snapshot();
  return buildTraceabilitySnapshot([mappedFeature(harness)], {}, harness.adapter.keyGrammar, remote);
}

export function runAdapterContractTests(makeHarness: () => AdapterContractHarness): void {
  describe("traceability adapter contract", () => {
    it("extracts keys through its own grammar (no Jira assumptions)", () => {
      const { adapter, grammarSample } = makeHarness();
      const extracted = extractKeys(grammarSample.tags, adapter.keyGrammar);
      expect(extracted.testKeys).toEqual(grammarSample.testKeys);
      expect(extracted.reqKeys).toEqual(grammarSample.reqKeys);
    });

    it("reports connection state and fires onDidChange on connect", async () => {
      const harness = makeHarness();
      const connection = harness.adapter.connection;
      expect(connection).toBeDefined();
      expect(await connection!.isConnected()).toBe(false);

      let fired = 0;
      const sub = connection!.onDidChange(() => { fired += 1; });
      await harness.connect();

      expect(await connection!.isConnected()).toBe(true);
      expect(fired).toBeGreaterThan(0);

      if (connection!.verify) {
        const result = await connection!.verify();
        expect(["ok", "auth-failed", "unreachable"]).toContain(result.status);
        expect(typeof result.message).toBe("string");
      }
      sub.dispose();
    });

    it("flags orphans and merges metadata on a complete catalogue fetch", async () => {
      const harness = makeHarness();
      await harness.connect();
      harness.seedCatalogue(
        [
          { key: harness.mappedKey, summary: "mapped test" },
          { key: harness.orphanKey, summary: "orphan test" },
        ],
        "complete"
      );
      await harness.adapter.metadata!.sync(harness.syncScope);

      const remote = harness.adapter.metadata!.snapshot();
      expect(remote.completeness).toBe("complete");
      expect(remote.syncedAt).toBeTypeOf("number");

      const snap = join(harness);
      const mapped = snap.links.find((l) => l.testKey === harness.mappedKey);
      expect(mapped?.meta?.summary).toBe("mapped test");
      expect(snap.orphans.map((o) => o.testKey)).toEqual([harness.orphanKey]);
    });

    it("never derives orphans from a partial catalogue fetch", async () => {
      const harness = makeHarness();
      await harness.connect();
      harness.seedCatalogue(
        [{ key: harness.mappedKey }, { key: harness.orphanKey }],
        "partial"
      );
      await harness.adapter.metadata!.sync(harness.syncScope);

      const remote = harness.adapter.metadata!.snapshot();
      expect(remote.completeness).toBe("partial");
      expect(join(harness).orphans).toEqual([]);
    });

    it("records a sync error on the snapshot and suppresses orphans", async () => {
      const harness = makeHarness();
      await harness.connect();
      harness.seedCatalogue([{ key: harness.orphanKey }], "complete");
      harness.seedSyncError("transport failure");
      await harness.adapter.metadata!.sync(harness.syncScope);

      const remote = harness.adapter.metadata!.snapshot();
      expect(remote.errors).toContain("transport failure");
      expect(join(harness).orphans).toEqual([]);
    });

    it("resolves a browse link that carries the key", () => {
      const { adapter, mappedKey } = makeHarness();
      const url = adapter.browseUrl({ key: mappedKey });
      expect(url).toBeDefined();
      expect(url).toContain(mappedKey);
    });

    // Publishing is an optional capability (P3 for Xray); gate the test on its presence so an
    // adapter that has yet to implement it still runs the connection/metadata contract cleanly.
    const supportsPublishing = makeHarness().adapter.resultPublishing !== undefined;
    (supportsPublishing ? it : it.skip)("publishes an artifact and returns a listed execution ref", async () => {
      const harness = makeHarness();
      await harness.connect();
      const publishing = harness.adapter.resultPublishing;
      expect(publishing).toBeDefined();

      const outcome = await publishing!.publish(harness.makeArtifact(), harness.publishRequest);
      expect(outcome.ref.kind).toBe("execution");
      expect(outcome.ref.key).toBeTruthy();

      const targets = await publishing!.searchTargets("execution", "");
      expect(targets.some((t) => t.ref.key === outcome.ref.key)).toBe(true);
    });

    // The kinds are distinct target spaces: a provider with no project concept answers empty, but
    // none may answer one kind with another kind's targets.
    (supportsPublishing ? it : it.skip)("never answers the project kind with execution targets", async () => {
      const harness = makeHarness();
      await harness.connect();
      const publishing = harness.adapter.resultPublishing!;
      await publishing.publish(harness.makeArtifact(), harness.publishRequest);

      const executions = await publishing.searchTargets("execution", "");
      const projects = await publishing.searchTargets("project", "");

      expect(executions.length).toBeGreaterThan(0);
      expect(projects.some((target) => executions.some((execution) => execution.ref.key === target.ref.key))).toBe(false);
    });
  });
}
