import { describe, it, expect, vi } from "vitest";
import type { Memento } from "vscode";
import { Logger } from "../../utils/logger";
import {
  ArtifactBuilder,
  RunArtifactStore,
  ShardCapture,
  buildArtifactResults,
  scopeArtifactDetails,
} from "../../traceability/run-artifact-store";
import { BatchSelection, PreflightDecision, RunArtifact, RunArtifactResult } from "../../traceability/contracts";
import { ScenarioResult } from "../../utils/playwright-json-parser";
import { EXECUTION_LIMITS } from "../../core/execution-limits";

const logger = Logger.create();

const SEL: BatchSelection = { kind: "all-mapped" };
const FEATURE_SEL: BatchSelection = { kind: "feature", filePath: "/ws/a.feature" };

// Mirror workspaceState: JSON-serialize on write so a round-trip catches anything non-JSON-safe.
function fakeMemento(initial: Record<string, unknown> = {}): Memento {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    keys: () => [...store.keys()],
    get: (key: string, def?: unknown) => (store.has(key) ? store.get(key) : def),
    update: (key: string, value: unknown) => {
      if (value === undefined) { store.delete(key); }
      else { store.set(key, JSON.parse(JSON.stringify(value))); }
      return Promise.resolve();
    },
  } as unknown as Memento;
}

function scenario(over: Partial<ScenarioResult> = {}): ScenarioResult {
  return { scenarioName: "S", status: "passed", featurePath: "/ws/a.feature", lineNumber: 3, ...over };
}

function shard(over: Partial<ShardCapture> = {}): ShardCapture {
  return { workingDir: "/ws", command: "npx playwright test", success: true, exitCode: 0, details: [], ...over };
}

function result(over: Partial<RunArtifactResult> = {}): RunArtifactResult {
  return {
    scenario: { filePath: "/ws/a.feature", line: 3, name: "S", kind: "scenario" },
    outcome: "passed",
    durationMs: 1,
    attempts: 1,
    flaky: false,
    evidenceRefs: [],
    ...over,
  };
}

function artifact(over: Partial<RunArtifact> = {}): RunArtifact {
  return { id: "id", createdAt: 1, results: [], shards: [], selection: SEL, preflight: [], state: "complete", ...over };
}

describe("buildArtifactResults", () => {
  it("fails closed when a mapped invocation owns no result lines", () => {
    expect(scopeArtifactDetails(
      [scenario()],
      {
        scenario: { filePath: "/ws/a.feature", line: 3, name: "S", kind: "scenario" },
        resultLines: [],
      },
      "/ws"
    )).toEqual([]);
  });

  it("emits one result per plain scenario, defaulting attempts and flaky", () => {
    const results = buildArtifactResults([scenario({ durationMs: 40 })], "/ws");
    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      scenario: { filePath: "/ws/a.feature", line: 3, name: "S", kind: "scenario" },
      outcome: "passed",
      durationMs: 40,
      attempts: 1,
      flaky: false,
      evidenceRefs: [],
    });
    expect(results[0]?.iterations).toBeUndefined();
  });

  it("carries through parsed attempts and flaky", () => {
    const [r] = buildArtifactResults([scenario({ attempts: 3, flaky: true })], "/ws");
    expect(r?.attempts).toBe(3);
    expect(r?.flaky).toBe(true);
  });

  it("keeps timed-out and interrupted distinct from failed", () => {
    expect(buildArtifactResults([scenario({ outcome: "timed-out", status: "failed" })], "/ws")[0]?.outcome).toBe("timed-out");
    expect(buildArtifactResults([scenario({ outcome: "interrupted", status: "failed" })], "/ws")[0]?.outcome).toBe("interrupted");
  });

  it("collapses multi-project entries of one scenario, worst outcome winning", () => {
    const results = buildArtifactResults(
      [
        scenario({ scenarioName: "A", status: "passed", durationMs: 100 }),
        scenario({ scenarioName: "A", status: "failed", durationMs: 120 }),
      ],
      "/ws"
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.outcome).toBe("failed");
    expect(results[0]?.durationMs).toBe(120);
  });

  it("groups outline example rows into one result with per-iteration data", () => {
    const results = buildArtifactResults(
      [
        scenario({ scenarioName: "Example #1", outlineName: "My outline", lineNumber: 10, status: "passed", durationMs: 100 }),
        scenario({ scenarioName: "Example #2", outlineName: "My outline", lineNumber: 10, status: "failed", durationMs: 200 }),
      ],
      "/ws"
    );
    expect(results).toHaveLength(1);
    expect(results[0]?.scenario.kind).toBe("outline");
    expect(results[0]?.scenario.name).toBe("My outline");
    expect(results[0]?.outcome).toBe("failed");
    expect(results[0]?.durationMs).toBe(300);
    expect(results[0]?.iterations).toEqual([
      { name: "Example #1", outcome: "passed", durationMs: 100, attempts: 1 },
      { name: "Example #2", outcome: "failed", durationMs: 200, attempts: 1 },
    ]);
  });

  it("relativizes evidence paths against the workspace root with forward slashes", () => {
    const [r] = buildArtifactResults([scenario({ attachmentPaths: ["/ws/test-results/a/trace.zip"] })], "/ws");
    expect(r?.evidenceRefs).toEqual(["test-results/a/trace.zip"]);
  });

  it("drops evidence outside the workspace rather than leak an absolute path", () => {
    const [r] = buildArtifactResults([scenario({ attachmentPaths: ["C:\\other\\trace.zip"] })], "C:\\ws");
    expect(r?.evidenceRefs).toEqual([]);
  });

  it("drops evidence when the workspace root is unknown", () => {
    const [r] = buildArtifactResults([scenario({ attachmentPaths: ["/anywhere/trace.zip"] })], undefined);
    expect(r?.evidenceRefs).toEqual([]);
  });
});

describe("ArtifactBuilder", () => {
  it("seals complete when every invocation produced results", () => {
    const builder = new ArtifactBuilder(SEL);
    builder.addShard(shard({ details: [scenario()] }));
    expect(builder.seal("complete").state).toBe("complete");
  });

  it("seals partial when an invocation failed without producing results", () => {
    const builder = new ArtifactBuilder(SEL);
    builder.addShard(shard({ success: false, exitCode: 1, details: [] }));
    expect(builder.seal("complete").state).toBe("partial");
  });

  it("stays complete when tests failed but the invocation produced results", () => {
    const builder = new ArtifactBuilder(SEL);
    builder.addShard(shard({ success: false, exitCode: 1, details: [scenario({ status: "failed" })] }));
    expect(builder.seal("complete").state).toBe("complete");
  });

  it("seals cancelled regardless of shard success", () => {
    const builder = new ArtifactBuilder(SEL);
    builder.addShard(shard({ success: false, exitCode: 1, details: [] }));
    expect(builder.seal("cancelled").state).toBe("cancelled");
  });

  it("accepts explicit gateway lifecycle states", () => {
    expect(new ArtifactBuilder(SEL).seal("complete").state).toBe("complete");
    expect(new ArtifactBuilder(SEL).seal("partial").state).toBe("partial");
    expect(new ArtifactBuilder(SEL).seal("cancelled").state).toBe("cancelled");
  });

  it("forward-slashes the shard working dir and records its exit state", () => {
    const builder = new ArtifactBuilder(SEL);
    builder.addShard(shard({ workingDir: "C:\\repo\\pkg", command: "cmd", success: false, exitCode: 2 }));
    expect(builder.seal("complete").shards[0]).toEqual({ workingDir: "C:/repo/pkg", command: "cmd", exitCode: 2, success: false });
  });

  it("aggregates shards and results across invocations under one selection", () => {
    const builder = new ArtifactBuilder(FEATURE_SEL);
    builder.addShard(shard({ command: "cmd1", details: [scenario({ scenarioName: "A", lineNumber: 3 })] }));
    builder.addShard(shard({ command: "cmd2", details: [scenario({ scenarioName: "B", lineNumber: 5 })] }));
    const art = builder.seal("complete");
    expect(art.shards.map((s) => s.command)).toEqual(["cmd1", "cmd2"]);
    expect(art.results.map((r) => r.scenario.name)).toEqual(["A", "B"]);
    expect(art.selection).toEqual(FEATURE_SEL);
    expect(typeof art.id).toBe("string");
    expect(typeof art.createdAt).toBe("number");
  });

  it("seals Test Set identity with only the exact mapped scenario refs", () => {
    const selection: BatchSelection = {
      kind: "test-set",
      testSetKey: "SHOP-301",
      scenarios: [{ filePath: "/ws/a.feature", line: 3, name: "S", kind: "scenario" }],
    };
    const artifact = new ArtifactBuilder(selection).seal("complete");

    expect(artifact.selection).toEqual(selection);
    expect(artifact.selection).not.toHaveProperty("memberKeys");
  });
});

describe("RunArtifactStore", () => {
  it("keeps artifacts newest first", () => {
    const store = new RunArtifactStore(fakeMemento(), logger);
    store.append(artifact({ id: "a" }));
    store.append(artifact({ id: "b" }));
    expect(store.latest()?.id).toBe("b");
    expect(store.list().map((a) => a.id)).toEqual(["b", "a"]);
  });

  it("evicts past the last 10, dropping the oldest silently", () => {
    const store = new RunArtifactStore(fakeMemento(), logger);
    for (let i = 0; i < 13; i += 1) { store.append(artifact({ id: `run-${i}` })); }
    expect(store.list()).toHaveLength(10);
    expect(store.list()[0]?.id).toBe("run-12");
    expect(store.list()[9]?.id).toBe("run-3");
  });

  it("prunes oldest artifacts until persisted workspace data fits the byte budget", () => {
    const memento = fakeMemento();
    const store = new RunArtifactStore(memento, logger);
    const command = "x".repeat(Math.floor(EXECUTION_LIMITS.artifactBytesPerWorkspace * 0.55));
    const largeArtifact = (id: string): RunArtifact => artifact({
      id,
      shards: [{ workingDir: "/ws", command, exitCode: 0, success: true }],
    });

    store.append(largeArtifact("old"));
    store.append(largeArtifact("new"));

    expect(store.list().map((item) => item.id)).toEqual(["new"]);
    const persisted = memento.get<RunArtifact[]>("specwright.runArtifacts") ?? [];
    expect(Buffer.byteLength(JSON.stringify(persisted))).toBeLessThanOrEqual(
      EXECUTION_LIMITS.artifactBytesPerWorkspace
    );
  });

  it("drops an artifact that cannot fit in the workspace byte budget by itself", () => {
    const memento = fakeMemento();
    const store = new RunArtifactStore(memento, logger);
    store.append(artifact({
      id: "too-large",
      shards: [{
        workingDir: "/ws",
        command: "x".repeat(EXECUTION_LIMITS.artifactBytesPerWorkspace),
        exitCode: 0,
        success: true,
      }],
    }));

    expect(store.list()).toEqual([]);
    expect(memento.get("specwright.runArtifacts")).toEqual([]);
  });

  it("does not return an older artifact when an oversized sealed batch is dropped", () => {
    const store = new RunArtifactStore(fakeMemento(), logger);
    store.append(artifact({ id: "older" }));
    const batch = store.beginBatch(SEL);
    store.contributeShard(batch, shard({
      command: "x".repeat(EXECUTION_LIMITS.artifactBytesPerWorkspace),
      details: [scenario()],
    }));

    expect(store.sealBatch(batch, "complete")).toBeUndefined();
    expect(store.latest()?.id).toBe("older");
  });

  it("rewrites oversized hydrated workspace state within the byte budget", () => {
    const command = "x".repeat(Math.floor(EXECUTION_LIMITS.artifactBytesPerWorkspace * 0.55));
    const memento = fakeMemento({
      "specwright.runArtifacts": [
        artifact({ id: "new", shards: [{ workingDir: "/ws", command, exitCode: 0, success: true }] }),
        artifact({ id: "old", shards: [{ workingDir: "/ws", command, exitCode: 0, success: true }] }),
      ],
    });

    const store = new RunArtifactStore(memento, logger);

    expect(store.list().map((item) => item.id)).toEqual(["new"]);
    const persisted = memento.get<RunArtifact[]>("specwright.runArtifacts") ?? [];
    expect(persisted.map((item) => item.id)).toEqual(["new"]);
    expect(Buffer.byteLength(JSON.stringify(persisted))).toBeLessThanOrEqual(
      EXECUTION_LIMITS.artifactBytesPerWorkspace
    );
  });

  it("latestOutcome scans newest-first for the test key (badge parity)", () => {
    const store = new RunArtifactStore(fakeMemento(), logger);
    store.append(artifact({ results: [result({ testKey: "T-1", outcome: "failed" })] }));
    store.append(artifact({ results: [result({ testKey: "T-1", outcome: "passed" })] }));
    expect(store.latestOutcome("T-1")).toBe("passed");
    expect(store.latestOutcome("T-2")).toBeUndefined();
  });

  it("opens, contributes to, and seals a batch into one stored artifact", () => {
    const store = new RunArtifactStore(fakeMemento(), logger);
    const batch = store.beginBatch(FEATURE_SEL);
    store.contributeShard(batch, shard({ details: [scenario()] }));
    const sealed = store.sealBatch(batch, "complete");
    expect(sealed?.state).toBe("complete");
    expect(sealed?.selection).toEqual(FEATURE_SEL);
    expect(store.latest()).toEqual(sealed);
  });

  it("seals partial when an invocation-scoped run captures no owned result", () => {
    const store = new RunArtifactStore(fakeMemento(), logger);
    const batch = store.beginBatch({
      kind: "scenario",
      scenario: { filePath: "/ws/a.feature", line: 3, name: "S", kind: "scenario" },
    });
    store.contributeShard(batch, shard({
      invocation: { filePath: "/ws/a.feature", line: 3, name: "S", kind: "scenario" },
    }));

    expect(store.sealBatch(batch, "complete")?.state).toBe("partial");
  });

  it("rejects a shard or seal carrying a foreign or stale batch handle", () => {
    const store = new RunArtifactStore(fakeMemento(), logger);
    const batch = store.beginBatch(FEATURE_SEL);
    store.contributeShard(batch + 1, shard({ details: [scenario({ scenarioName: "foreign" })] }));
    expect(store.sealBatch(batch + 1, "complete")).toBeUndefined();
    const sealed = store.sealBatch(batch, "complete");
    expect(sealed?.results).toEqual([]);
    expect(store.list()).toHaveLength(1);
  });

  it("ignores a contributed shard when no batch is open", () => {
    const store = new RunArtifactStore(fakeMemento(), logger);
    store.contributeShard(1, shard({ details: [scenario()] }));
    expect(store.sealBatch(1, "complete")).toBeUndefined();
    expect(store.latest()).toBeUndefined();
  });

  it("survives a reload via workspaceState", () => {
    const memento = fakeMemento();
    const store = new RunArtifactStore(memento, logger);
    const batch = store.beginBatch(FEATURE_SEL);
    store.contributeShard(batch, shard({ command: "npx playwright test a.feature", details: [scenario({ scenarioName: "Logs in", durationMs: 42 })] }));
    const sealed = store.sealBatch(batch, "complete");

    const reloaded = new RunArtifactStore(memento, logger);
    expect(reloaded.list()).toEqual(store.list());
    expect(reloaded.latest()).toEqual(sealed);
  });

  it("freezes stored artifacts and clones on append so later input mutation can't leak in", () => {
    const store = new RunArtifactStore(fakeMemento(), logger);
    const input = artifact({ id: "a", results: [result({ testKey: "T-1" })] });
    store.append(input);
    (input.results as RunArtifactResult[]).push(result({ testKey: "T-2" }));
    expect(store.latest()?.results).toHaveLength(1);
    expect(Object.isFrozen(store.latest())).toBe(true);
    expect(() => (store.latest()?.results as RunArtifactResult[]).push(result())).toThrow();
  });

  it("drops structurally invalid artifacts on hydration without throwing", () => {
    const stored = [
      artifact({ id: "good" }),
      { id: 7, results: [] },
      { id: "no-state", createdAt: 1, selection: SEL, results: [], shards: [], preflight: [] },
      artifact({ id: "also-good", results: [result({ testKey: "T-9", outcome: "failed" })] }),
    ];
    const store = new RunArtifactStore(fakeMemento({ "specwright.runArtifacts": stored }), logger);
    expect(store.list().map((a) => a.id)).toEqual(["good", "also-good"]);
    expect(store.latestOutcome("T-9")).toBe("failed");
  });

  it("hydrates old and new selection shapes without rewriting their meaning", () => {
    const stored = [
      artifact({ id: "old", selection: { kind: "all-mapped" } }),
      artifact({ id: "project", selection: { kind: "all-mapped", project: "CALC" } }),
      artifact({ id: "suite", selection: { kind: "suite" } }),
      artifact({
        id: "tagged-feature",
        selection: { kind: "feature", filePath: "/ws/a.feature", tagExpression: "@smoke" },
      }),
    ];
    const store = new RunArtifactStore(fakeMemento({ "specwright.runArtifacts": stored }), logger);

    expect(store.list().map((item) => item.selection)).toEqual(stored.map((item) => item.selection));
  });

  it("loads at most the cap from workspaceState", () => {
    const many = Array.from({ length: 15 }, (_, i) => artifact({ id: `run-${i}` }));
    const store = new RunArtifactStore(fakeMemento({ "specwright.runArtifacts": many }), logger);
    expect(store.list()).toHaveLength(10);
    expect(store.latest()?.id).toBe("run-0");
  });

  it("clear empties the buffer, persists the empty list, and reports how many went", () => {
    const memento = fakeMemento();
    const store = new RunArtifactStore(memento, logger);
    store.append(artifact({ id: "a" }));
    store.append(artifact({ id: "b" }));

    expect(store.clear()).toBe(2);
    expect(store.list()).toEqual([]);
    expect(store.latest()).toBeUndefined();
    expect(memento.get("specwright.runArtifacts")).toEqual([]);
    expect(new RunArtifactStore(memento, logger).list()).toEqual([]);
  });

  it("clear on an empty store reports nothing removed", () => {
    const store = new RunArtifactStore(fakeMemento(), logger);
    expect(store.clear()).toBe(0);
    expect(store.list()).toEqual([]);
  });

  it("clear leaves an open batch alone, so it seals and appends afterwards", () => {
    const store = new RunArtifactStore(fakeMemento(), logger);
    const batch = store.beginBatch(FEATURE_SEL);
    store.clear();
    store.contributeShard(batch, shard({ details: [scenario()] }));

    expect(store.sealBatch(batch, "complete")?.results).toHaveLength(1);
    expect(store.list()).toHaveLength(1);
  });

  // What an open Publish dialog listens to so a run recorded while it sits there reaches its dropdown.
  it("announces every change to the buffer, with the new list already readable", () => {
    const store = new RunArtifactStore(fakeMemento(), logger);
    const seen: number[] = [];
    store.onDidChange(() => seen.push(store.list().length));

    store.append(artifact({ id: "a" }));
    const batch = store.beginBatch(FEATURE_SEL);
    store.contributeShard(batch, shard({ details: [scenario()] }));
    store.sealBatch(batch, "complete");
    store.clear();

    expect(seen).toEqual([1, 2, 0]);
  });

  it("still announces a batch whose artifact was too large to retain", () => {
    const store = new RunArtifactStore(fakeMemento(), logger);
    let fired = 0;
    store.onDidChange(() => (fired += 1));

    store.append(artifact({
      id: "oversized",
      results: [result({ evidenceRefs: ["x".repeat(9 * 1024 * 1024)] })],
    }));

    expect(store.list()).toHaveLength(0);
    expect(fired).toBe(1);
  });

  it("says nothing while a batch is merely open, since the buffer has not changed", () => {
    const store = new RunArtifactStore(fakeMemento(), logger);
    let fired = 0;
    store.onDidChange(() => (fired += 1));

    const batch = store.beginBatch(FEATURE_SEL);
    store.contributeShard(batch, shard({ details: [scenario()] }));

    expect(fired).toBe(0);
  });
});

describe("testKey threading and preflight decisions", () => {
  it("buildArtifactResults resolves a mapped scenario's key and leaves an unmapped one bare", () => {
    const resolve = (s: { name: string }): string | undefined => (s.name === "Mapped" ? "CALC-1" : undefined);
    const [mapped] = buildArtifactResults([scenario({ scenarioName: "Mapped", lineNumber: 3 })], "/ws", resolve);
    const [unmapped] = buildArtifactResults([scenario({ scenarioName: "Other", lineNumber: 9 })], "/ws", resolve);
    expect(mapped?.testKey).toBe("CALC-1");
    expect(unmapped?.testKey).toBeUndefined();
  });

  it("threads the resolver factory through a captured batch so latestOutcome lights up", () => {
    const store = new RunArtifactStore(fakeMemento(), logger);
    const factory = vi.fn(() => (s: { name: string }) => (s.name === "Logs in" ? "CALC-7" : undefined));
    store.setKeyResolver(factory);
    const batch = store.beginBatch(FEATURE_SEL);
    store.contributeShard(batch, shard({ details: [scenario({ scenarioName: "Logs in", status: "failed" })] }));
    const sealed = store.sealBatch(batch, "complete");
    expect(factory).toHaveBeenCalledWith();
    expect(sealed?.results[0]?.testKey).toBe("CALC-7");
    expect(store.latestOutcome("CALC-7")).toBe("failed");
  });

  it("normalizes a relative report path before resolving its mapped key", () => {
    const store = new RunArtifactStore(fakeMemento(), logger);
    store.setKeyResolver(() => (scenarioRef) =>
      scenarioRef.filePath === "/ws/a.feature" ? "CALC-8" : undefined
    );
    const batch = store.beginBatch(SEL);

    store.contributeShard(batch, shard({
      workingDir: "/ws",
      details: [scenario({ featurePath: "a.feature" })],
    }));

    expect(store.sealBatch(batch, "complete")?.results[0]).toMatchObject({
      testKey: "CALC-8",
      scenario: { filePath: "/ws/a.feature" },
    });
  });

  it("freezes the resolver at beginBatch so a sync mid-batch can't split one artifact's keys", () => {
    const store = new RunArtifactStore(fakeMemento(), logger);
    let currentKey = "K1";
    // The factory snapshots currentKey's value when called (at beginBatch), mirroring how the
    // subsystem snapshots the links array; later mutation of currentKey must not leak in.
    store.setKeyResolver(() => {
      const frozen = currentKey;
      return (s) => (s.name === "S" ? frozen : undefined);
    });
    const batch = store.beginBatch(FEATURE_SEL);
    store.contributeShard(batch, shard({ details: [scenario({ scenarioName: "S", lineNumber: 3 })] }));
    currentKey = "K2"; // a sync landed between shards
    store.contributeShard(batch, shard({ details: [scenario({ scenarioName: "S", lineNumber: 8 })] }));
    const sealed = store.sealBatch(batch, "complete");
    expect(sealed?.results.map((r) => r.testKey)).toEqual(["K1", "K1"]);
  });

  it("resolves each outline shard against the invocation that produced it", () => {
    const outline = { filePath: "/ws/a.feature", line: 3, name: "Divide", kind: "outline" as const };
    const block = {
      filePath: "/ws/a.feature",
      line: 8,
      name: "Divide · edge cases",
      kind: "examplesBlock" as const,
      outlineName: "Divide",
      examplesBlockName: "edge cases",
    };
    const store = new RunArtifactStore(fakeMemento(), logger);
    store.setKeyResolver(() => (_scenario, invocation) =>
      invocation?.kind === "examplesBlock" ? "CALC-2" : "CALC-1"
    );
    const batch = store.beginBatch({ kind: "multi-select", scenarios: [outline, block] });
    store.contributeShard(batch, shard({
      details: [scenario({ scenarioName: "common", outlineName: "Divide", lineNumber: 9 })],
      invocation: outline,
    }));
    store.contributeShard(batch, shard({
      details: [
        scenario({ scenarioName: "zero", outlineName: "Divide", lineNumber: 14 }),
        scenario({ scenarioName: "negative", outlineName: "Divide", lineNumber: 15 }),
      ],
      invocation: block,
    }));

    expect(store.sealBatch(batch, "complete")?.results).toMatchObject([
      { testKey: "CALC-1", scenario: outline, iterations: [{ name: "common" }] },
      {
        testKey: "CALC-2",
        scenario: block,
        iterations: [{ name: "zero" }, { name: "negative" }],
      },
    ]);
  });

  it("seals the preflight decisions the batch opened with onto the artifact", () => {
    const store = new RunArtifactStore(fakeMemento(), logger);
    const decisions: PreflightDecision[] = [
      { scenario: { filePath: "/ws/a.feature", line: 7, name: "Untagged", kind: "scenario" }, state: "unmapped", outcome: "exclude" },
    ];
    const batch = store.beginBatch(SEL, decisions);
    store.contributeShard(batch, shard({ details: [scenario()] }));
    const sealed = store.sealBatch(batch, "complete");
    expect(sealed?.preflight).toEqual(decisions);
  });
});
