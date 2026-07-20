import { describe, it, expect } from "vitest";
import { RunResultStore } from "../../traceability/run-result-store";

describe("RunResultStore", () => {
  it("retains ingested outcomes keyed exactly as toStatusMap emits them", () => {
    const store = new RunResultStore();
    store.ingest({ "/ws/a.feature:4": "passed", "/ws/a.feature::Divide": "passed" });
    expect(store.statusMap()).toEqual({
      "/ws/a.feature:4": "passed",
      "/ws/a.feature::Divide": "passed",
    });
  });

  it("merges freshest-wins per key: a re-run updates its own badge, others persist", () => {
    const store = new RunResultStore();
    store.ingest({ "/ws/a.feature:4": "passed", "/ws/a.feature:11": "failed" });
    store.ingest({ "/ws/a.feature:4": "failed" });
    expect(store.statusMap()).toEqual({
      "/ws/a.feature:4": "failed",
      "/ws/a.feature:11": "failed",
    });
  });

  it("fires onDidChange when new or changed outcomes land", () => {
    const store = new RunResultStore();
    let fires = 0;
    store.onDidChange(() => { fires += 1; });
    store.ingest({ "/ws/a.feature:4": "passed" });
    expect(fires).toBe(1);
    store.ingest({ "/ws/a.feature:11": "failed" });
    expect(fires).toBe(2);
    store.ingest({ "/ws/a.feature:4": "failed" });
    expect(fires).toBe(3);
  });

  it("does not fire when an identical re-ingest changes nothing", () => {
    const store = new RunResultStore();
    let fires = 0;
    store.onDidChange(() => { fires += 1; });
    store.ingest({ "/ws/a.feature:4": "passed" });
    expect(fires).toBe(1);
    store.ingest({ "/ws/a.feature:4": "passed" });
    expect(fires).toBe(1);
    store.ingest({});
    expect(fires).toBe(1);
  });

  it("stops firing once disposed", () => {
    const store = new RunResultStore();
    let fires = 0;
    store.onDidChange(() => { fires += 1; });
    store.dispose();
    store.ingest({ "/ws/a.feature:4": "passed" });
    expect(fires).toBe(0);
  });
});
