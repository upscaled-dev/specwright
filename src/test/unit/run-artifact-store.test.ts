import { describe, it, expect } from "vitest";
import type { Memento } from "vscode";
import { Logger } from "../../utils/logger";
import {
  ArtifactBuilder,
  RunArtifactStore,
  ShardCapture,
  buildArtifactResults,
} from "../../traceability/run-artifact-store";
import { RunArtifact, RunArtifactResult } from "../../traceability/contracts";
import { ScenarioResult } from "../../utils/playwright-json-parser";

const logger = Logger.create();

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
  return { id: "id", createdAt: 1, results: [], shards: [], selection: "sel", preflight: [], state: "complete", ...over };
}

describe("buildArtifactResults", () => {
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
    const builder = new ArtifactBuilder("sel");
    builder.addShard(shard({ details: [scenario()] }));
    expect(builder.seal(false).state).toBe("complete");
  });

  it("seals partial when an invocation failed without producing results", () => {
    const builder = new ArtifactBuilder("sel");
    builder.addShard(shard({ success: false, exitCode: 1, details: [] }));
    expect(builder.seal(false).state).toBe("partial");
  });

  it("stays complete when tests failed but the invocation produced results", () => {
    const builder = new ArtifactBuilder("sel");
    builder.addShard(shard({ success: false, exitCode: 1, details: [scenario({ status: "failed" })] }));
    expect(builder.seal(false).state).toBe("complete");
  });

  it("seals cancelled regardless of shard success", () => {
    const builder = new ArtifactBuilder("sel");
    builder.addShard(shard({ success: false, exitCode: 1, details: [] }));
    expect(builder.seal(true).state).toBe("cancelled");
  });

  it("forward-slashes the shard working dir and records its exit state", () => {
    const builder = new ArtifactBuilder("sel");
    builder.addShard(shard({ workingDir: "C:\\repo\\pkg", command: "cmd", success: false, exitCode: 2 }));
    expect(builder.seal(false).shards[0]).toEqual({ workingDir: "C:/repo/pkg", command: "cmd", exitCode: 2, success: false });
  });

  it("aggregates shards and results across invocations under one selection", () => {
    const builder = new ArtifactBuilder("Group X");
    builder.addShard(shard({ command: "cmd1", details: [scenario({ scenarioName: "A", lineNumber: 3 })] }));
    builder.addShard(shard({ command: "cmd2", details: [scenario({ scenarioName: "B", lineNumber: 5 })] }));
    const art = builder.seal(false);
    expect(art.shards.map((s) => s.command)).toEqual(["cmd1", "cmd2"]);
    expect(art.results.map((r) => r.scenario.name)).toEqual(["A", "B"]);
    expect(art.selection).toBe("Group X");
    expect(typeof art.id).toBe("string");
    expect(typeof art.createdAt).toBe("number");
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

  it("latestOutcome scans newest-first for the test key (badge parity)", () => {
    const store = new RunArtifactStore(fakeMemento(), logger);
    store.append(artifact({ results: [result({ testKey: "T-1", outcome: "failed" })] }));
    store.append(artifact({ results: [result({ testKey: "T-1", outcome: "passed" })] }));
    expect(store.latestOutcome("T-1")).toBe("passed");
    expect(store.latestOutcome("T-2")).toBeUndefined();
  });

  it("opens, contributes to, and seals a batch into one stored artifact", () => {
    const store = new RunArtifactStore(fakeMemento(), logger);
    const batch = store.beginBatch("Feature A");
    store.contributeShard(batch, shard({ details: [scenario()] }));
    const sealed = store.sealBatch(batch, false);
    expect(sealed?.state).toBe("complete");
    expect(sealed?.selection).toBe("Feature A");
    expect(store.latest()).toEqual(sealed);
  });

  it("rejects a shard or seal carrying a foreign or stale batch handle", () => {
    const store = new RunArtifactStore(fakeMemento(), logger);
    const batch = store.beginBatch("Feature A");
    store.contributeShard(batch + 1, shard({ details: [scenario({ scenarioName: "foreign" })] }));
    expect(store.sealBatch(batch + 1, false)).toBeUndefined();
    const sealed = store.sealBatch(batch, false);
    expect(sealed?.results).toEqual([]);
    expect(store.list()).toHaveLength(1);
  });

  it("ignores a contributed shard when no batch is open", () => {
    const store = new RunArtifactStore(fakeMemento(), logger);
    store.contributeShard(1, shard({ details: [scenario()] }));
    expect(store.sealBatch(1, false)).toBeUndefined();
    expect(store.latest()).toBeUndefined();
  });

  it("survives a reload via workspaceState", () => {
    const memento = fakeMemento();
    const store = new RunArtifactStore(memento, logger);
    const batch = store.beginBatch("Feature A");
    store.contributeShard(batch, shard({ command: "npx playwright test a.feature", details: [scenario({ scenarioName: "Logs in", durationMs: 42 })] }));
    const sealed = store.sealBatch(batch, false);

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
      { id: "no-state", createdAt: 1, selection: "x", results: [], shards: [], preflight: [] },
      artifact({ id: "also-good", results: [result({ testKey: "T-9", outcome: "failed" })] }),
    ];
    const store = new RunArtifactStore(fakeMemento({ "specwright.runArtifacts": stored }), logger);
    expect(store.list().map((a) => a.id)).toEqual(["good", "also-good"]);
    expect(store.latestOutcome("T-9")).toBe("failed");
  });

  it("loads at most the cap from workspaceState", () => {
    const many = Array.from({ length: 15 }, (_, i) => artifact({ id: `run-${i}` }));
    const store = new RunArtifactStore(fakeMemento({ "specwright.runArtifacts": many }), logger);
    expect(store.list()).toHaveLength(10);
    expect(store.latest()?.id).toBe("run-0");
  });
});
