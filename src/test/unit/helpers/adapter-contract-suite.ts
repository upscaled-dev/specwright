import { describe, it, expect } from "vitest";
import { FeatureParser } from "../../../parsers/feature-parser";
import {
  buildTraceabilitySnapshot,
  ParsedFeatureInput,
  TraceabilitySnapshot,
} from "../../../traceability/traceability-model";
import { extractKeys } from "../../../traceability/tag-extraction";
import {
  PublishTarget,
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
  readonly publishTarget: PublishTarget;
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

    it("records a published artifact and keeps its target listed", async () => {
      const harness = makeHarness();
      await harness.connect();
      const publishing = harness.adapter.resultPublishing;
      expect(publishing).toBeDefined();

      const result = await publishing!.publish(harness.makeArtifact(), harness.publishTarget);
      expect(result.ref?.key).toBe(harness.publishTarget.id);

      const targets = await publishing!.listTargets();
      expect(targets.some((t) => t.id === harness.publishTarget.id)).toBe(true);
    });
  });
}
