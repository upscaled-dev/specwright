import { describe, expect, it } from "vitest";
import { formatSyncedAgo, projectTraceabilityTree } from "../../traceability/traceability-tree-projection";
import type { TraceabilityModel, TraceabilitySnapshot } from "../../traceability/traceability-model";

const snapshot: TraceabilitySnapshot = {
  links: [{ testKey: "CALC-1", project: "CALC", scenario: { filePath: "/workspace/features/math.feature", line: 4, name: "adds", kind: "scenario" }, reqKeys: ["CALC-9"], lastResult: "passed" }],
  untraced: [{ scenario: { filePath: "/workspace/features/math.feature", line: 9, name: "subtracts", kind: "scenario" }, reqKeys: [] }],
  orphans: [], stale: false, completeProjects: [], errors: [],
};
const model = { get snapshot(): TraceabilitySnapshot { return snapshot; } } as TraceabilityModel;
function projection(value: TraceabilitySnapshot) {
  return projectTraceabilityTree({ get snapshot(): TraceabilitySnapshot { return value; } } as TraceabilityModel, "Xray", "test", true, undefined, true);
}
function row(value: TraceabilitySnapshot, label: string) {
  return projection(value).rows.find((candidate) => candidate.label === label);
}

describe("traceability tree projection", () => {
  it("preserves test grouping order and keeps host paths out of opaque row ids", () => {
    const projection = projectTraceabilityTree(model, "Xray", "test", true, undefined, true);
    expect(projection.state).toBe("ready");
    expect(projection.rows.map((row) => row.label)).toEqual(["Untraced scenarios", "subtracts", "Mapped tests", "CALC-1", "adds"]);
    expect(projection.rows.some((row) => row.id.includes("workspace"))).toBe(false);
    expect(projection.rows.find((row) => row.label === "adds")?.actions.map((action) => action.id)).toEqual(["open", "link", "run"]);
    expect(projection.rows.find((row) => row.label === "adds")?.actions.map((action) => action.icon)).toEqual(["go-to-file", "link", "play"]);
  });

  it("renders supported disconnected, untrusted, and empty state affordances", () => {
    const disconnected = projectTraceabilityTree(model, "Xray", "test", false, undefined, true);
    expect(disconnected.state).toBe("disconnected");
    expect(disconnected.rows[0]?.actions.map((action) => action.id)).toEqual(["connect", "hide"]);
    const untrusted = projectTraceabilityTree(model, "Xray", "test", true, undefined, false);
    expect(untrusted.state).toBe("untrusted");
    expect(untrusted.rows[0]?.actions.map((action) => action.id)).toEqual(["manage-trust"]);
    const empty = projectTraceabilityTree(undefined, "Xray", "test", true, undefined, true);
    expect(empty.state).toBe("empty");
    expect(empty.rows[0]?.actions).toEqual([]);
  });

  it("keeps by-file gaps before mapped files and source order within a file", () => {
    const projection = projectTraceabilityTree(model, "Xray", "file", true, undefined, true);
    expect(projection.rows.map((row) => row.label)).toEqual(["math.feature", "subtracts", "adds"]);
    expect(projection.rows[0]?.description).toBe("1 untraced");
    expect(projection.rows[0]?.actions.map((action) => action.id)).toEqual(["run"]);
  });

  it("adds the connection row with its advertised setup and project actions", () => {
    const projection = projectTraceabilityTree(model, "Xray", "test", true, {
      state: "unreachable", label: "Xray", message: "offline", sync: { syncedAt: Date.now() - 60_000, stale: true }, defaultProject: "CALC",
    }, true);
    const connection = projection.rows[0]!;
    expect(connection.label).toBe("Xray Cloud");
    expect(connection.description).toContain("project CALC");
    expect(connection.actions.map((action) => action.id)).toEqual(["connect", "switch-project", "select-sync-projects"]);
    expect(connection.tooltip).toContain("Xray");
  });

  it("keeps complete-project orphan gating and empty section guidance", () => {
    const emptyMapped: TraceabilitySnapshot = { ...snapshot, links: [], completeProjects: ["CALC"] };
    const projection = projectTraceabilityTree({ get snapshot(): TraceabilitySnapshot { return emptyMapped; } } as TraceabilityModel, "Xray", "test", true, undefined, true);
    expect(projection.rows.map((row) => row.label)).toContain("Available Xray tests");
    expect(projection.rows.map((row) => row.label)).toContain("No scenarios are mapped to a Xray test yet.");
  });

  it("bounds long Unicode display text while retaining an opaque stable identity", () => {
    const long = "😀".repeat(5_000);
    const longSnapshot: TraceabilitySnapshot = { ...snapshot, links: [{ ...snapshot.links[0]!, scenario: { ...snapshot.links[0]!.scenario, name: long } }] };
    const first = projectTraceabilityTree({ get snapshot(): TraceabilitySnapshot { return longSnapshot; } } as TraceabilityModel, "Xray", "test", true, undefined, true);
    const second = projectTraceabilityTree({ get snapshot(): TraceabilitySnapshot { return longSnapshot; } } as TraceabilityModel, "Xray", "test", true, undefined, true);
    const row = first.rows.find((candidate) => candidate.parentId?.startsWith("test:"));
    expect(row?.label.length).toBeLessThanOrEqual(4_096);
    expect(row?.id).toBe(second.rows.find((candidate) => candidate.parentId?.startsWith("test:"))?.id);
  });

  it("bounds composed labels, summaries, projects, and requirement lists while keeping opaque ids stable", () => {
    const long = "😀".repeat(5_000);
    const value: TraceabilitySnapshot = {
      ...snapshot,
      links: [{ ...snapshot.links[0]!, testKey: long, project: long, reqKeys: Array(2_000).fill(long), meta: { key: long, summary: long, status: { category: "pending", providerValue: long } } }],
      completeProjects: Array(2_000).fill(long),
    };
    const projection = projectTraceabilityTree({ get snapshot(): TraceabilitySnapshot { return value; } } as TraceabilityModel, long, "test", true, { state: "ok", label: long, message: long, defaultProject: long }, true);
    expect(projection.rows.every((candidate) => (candidate.label.length <= 4_096) && (candidate.description?.length ?? 0) <= 4_096 && (candidate.tooltip?.length ?? 0) <= 4_096)).toBe(true);
    expect(projection.rows.every((candidate) => !candidate.id.includes("workspace"))).toBe(true);
  });

  it("uses project-neutral test descriptions and warns when nothing has run", () => {
    const link = { ...snapshot.links[0]!, project: undefined, lastResult: undefined };
    const value = { ...snapshot, links: [link] };
    expect(row(value, "CALC-1")).toMatchObject({ description: "1 scenario", icon: "beaker", tone: "warning" });
  });

  it("keeps scenario default reveal and inline link/run actions with the local outcome icon", () => {
    const scenario = row(snapshot, "adds")!;
    expect(scenario).toMatchObject({ icon: "pass", tone: "success", defaultAction: "open" });
    expect(scenario.actions.map((action) => action.id)).toEqual(["open", "link", "run"]);
    const mapped = row(snapshot, "CALC-1")!;
    expect(mapped.defaultAction).toBeUndefined();
    expect(mapped.actions[0]).toMatchObject({ id: "open", icon: "link-external" });
  });

  it("renders untraced outline descriptions for plural, singular, requirements, and missing counts", () => {
    const outline = { ...snapshot.untraced[0]!, scenario: { ...snapshot.untraced[0]!.scenario, name: "Outline", kind: "outline" as const }, examples: 2, reqKeys: ["CALC-2"] };
    expect(row({ ...snapshot, untraced: [outline] }, "Outline")).toMatchObject({ description: "2 examples · REQ CALC-2", icon: "circle-large-outline" });
    expect(row({ ...snapshot, untraced: [{ ...outline, examples: 1 }] }, "Outline")?.description).toBe("1 example · REQ CALC-2");
    expect(row({ ...snapshot, untraced: [{ ...outline, examples: undefined }] }, "Outline")?.description).toBe("REQ CALC-2");
  });

  it("renders normalized remote status and aggregate local worst outcomes", () => {
    const remote = { ...snapshot.links[0]!, meta: { key: "CALC-1", summary: "Remote", status: { category: "pending" as const, providerValue: "TODO" } } };
    expect(row({ ...snapshot, links: [remote] }, "CALC-1")).toMatchObject({ description: "Remote", icon: "beaker", tone: "pending", tooltip: "CALC-1 · TODO" });
    const local = { ...snapshot, links: [{ ...snapshot.links[0]!, lastResult: "passed" as const }, { ...snapshot.links[0]!, scenario: { ...snapshot.links[0]!.scenario, line: 5 }, lastResult: "failed" as const }] };
    expect(row(local, "CALC-1")).toMatchObject({ icon: "beaker", tone: "error" });
  });

  it("lets a remote-missing warning outrank a pass and includes project detail", () => {
    const missing = { ...snapshot.links[0]!, remoteMissing: true, lastResult: "passed" as const };
    const test = row({ ...snapshot, links: [missing] }, "CALC-1")!;
    expect(test.icon).toBe("warning");
    expect(test.description).toContain("not found on remote");
    expect(test.tooltip).toContain("in project CALC");
  });

  it("marks drift without changing the non-drifting baseline", () => {
    const drift = { ...snapshot.links[0]!, drift: true };
    expect(row({ ...snapshot, links: [drift] }, "adds")).toMatchObject({ description: "REQ CALC-9 · drift" });
    expect(row({ ...snapshot, links: [drift] }, "adds")?.tooltip).toContain("remote test text differs");
    expect(row(snapshot, "adds")?.description).toBe("REQ CALC-9");
  });

  it("omits connection rows for empty snapshots and leads both populated layouts when present", () => {
    const indicator = { state: "ok" as const, label: "site", message: "connected" };
    expect(projectTraceabilityTree({ get snapshot(): TraceabilitySnapshot { return { ...snapshot, links: [], untraced: [] }; } } as TraceabilityModel, "Xray", "test", true, indicator, true).rows[0]?.label).toBe("No Xray-tagged scenarios found yet.");
    expect(projectTraceabilityTree(model, "Xray", "test", true, indicator, true).rows[0]?.label).toBe("Xray Cloud");
    expect(projectTraceabilityTree(model, "Xray", "file", true, indicator, true).rows[0]?.label).toBe("Xray Cloud");
  });

  it.each([
    ["checking", "loading", "muted", "Checking…"],
    ["ok", "cloud", "success", "Connected"],
    ["auth-failed", "key", "error", "Authentication failed"],
    ["unreachable", "debug-disconnect", "warning", "Unreachable"],
  ] as const)("renders %s connection semantics", (state, icon, tone, description) => {
    const connection = projectTraceabilityTree(model, "Xray", "test", true, { state, label: "site", message: "detail" }, true).rows[0]!;
    expect(connection).toMatchObject({ icon, tone, description, defaultAction: "connect" });
    expect(connection.tooltip?.startsWith("site\n")).toBe(true);
    expect(connection.tooltip).toContain("detail");
  });

  it("keeps summaries and iteration aggregates after the remote summary", () => {
    const links = [
      { ...snapshot.links[0]!, meta: { key: "CALC-1", summary: "Remote" }, iterations: { passed: 1, total: 2 } },
      { ...snapshot.links[0]!, scenario: { ...snapshot.links[0]!.scenario, line: 5 }, meta: { key: "CALC-1", summary: "Remote" }, iterations: { passed: 2, total: 3 } },
    ];
    expect(row({ ...snapshot, links }, "CALC-1")?.description).toBe("Remote · 3/5");
    expect(row({ ...snapshot, links: links.map((link) => ({ ...link, meta: undefined })) }, "CALC-1")?.description).toBe("CALC · 2 scenarios · 3/5");
  });

  it("renders complete-project orphan sections, summaries, tones, and default actions", () => {
    const withOrphan: TraceabilitySnapshot = { ...snapshot, completeProjects: ["CALC"], orphans: [{ testKey: "CALC-77", meta: { key: "CALC-77", summary: "Unused" } }] };
    const orphan = row(withOrphan, "CALC-77")!;
    expect(projection(withOrphan).rows.map((candidate) => candidate.label).slice(-2)).toEqual(["Available Xray tests", "CALC-77"]);
    expect(orphan).toMatchObject({ description: "Unused", icon: "beaker", tone: "info", defaultAction: "open" });
    expect(orphan.actions.map((action) => action.id)).toEqual(["open", "copy"]);
    const empty = { ...snapshot, completeProjects: ["CALC", "OPS"] };
    expect(projection(empty).rows.map((candidate) => candidate.label)).toContain("No available Xray tests in CALC, OPS.");
  });

  it("explains the default project without adding text when one is unset", () => {
    const set = projectTraceabilityTree(model, "Xray", "test", true, { state: "ok", label: "site", message: "detail", defaultProject: "CALC" }, true).rows[0]!;
    expect(set.description).toContain("project CALC");
    expect(set.tooltip).toContain("joins the sync scope while no sync project list is set.");
    expect(projectTraceabilityTree(model, "Xray", "test", true, { state: "ok", label: "site", message: "detail" }, true).rows[0]?.description).not.toContain("project");
  });

  it("sorts file roots by coverage gap then path and source-sorts untraced before mapped children", () => {
    const files: TraceabilitySnapshot = {
      ...snapshot,
      links: [
        { ...snapshot.links[0]!, scenario: { ...snapshot.links[0]!.scenario, filePath: "/workspace/features/z.feature", line: 2, name: "Z mapped" } },
        { ...snapshot.links[0]!, scenario: { ...snapshot.links[0]!.scenario, filePath: "/workspace/features/a.feature", line: 12, name: "A mapped" } },
      ],
      untraced: [
        { scenario: { filePath: "/workspace/features/a.feature", line: 20, name: "A late", kind: "scenario" }, reqKeys: [] },
        { scenario: { filePath: "/workspace/features/a.feature", line: 3, name: "A early", kind: "scenario" }, reqKeys: [] },
      ],
    };
    const rows = projectTraceabilityTree({ get snapshot(): TraceabilitySnapshot { return files; } } as TraceabilityModel, "Xray", "file", true, undefined, true).rows;
    expect(rows.map((candidate) => candidate.label)).toEqual(["a.feature", "A early", "A late", "A mapped", "z.feature", "Z mapped"]);
    expect(rows[0]?.description).toBe("2 untraced");
    expect(rows[3]).toMatchObject({ icon: "pass", tone: "success", defaultAction: "open" });
  });

  it("keeps connection first and complete-catalogue orphans last in file mode", () => {
    const value: TraceabilitySnapshot = { ...snapshot, completeProjects: ["CALC"], orphans: [{ testKey: "CALC-9", meta: { key: "CALC-9", summary: "Unused" } }] };
    const rows = projectTraceabilityTree({ get snapshot(): TraceabilitySnapshot { return value; } } as TraceabilityModel, "Xray", "file", true, { state: "ok", label: "site", message: "detail" }, true).rows;
    expect(rows[0]?.label).toBe("Xray Cloud");
    expect(rows.slice(-2).map((candidate) => candidate.label)).toEqual(["Available Xray tests", "CALC-9"]);
  });

  it.each([
    [0, "just now"], [59_999, "just now"], [60_000, "1m ago"], [3_600_000, "1h ago"], [86_400_000, "1d ago"],
  ])("formats synced age %i as %s", (elapsed, expected) => {
    expect(formatSyncedAgo(elapsed)).toBe(expected);
  });

  it("renders fresh, stale, and cached-sync connection text", () => {
    const fresh = projectTraceabilityTree(model, "Xray", "test", true, { state: "ok", label: "site", message: "detail", sync: { syncedAt: Date.now() - 60_000, stale: false } }, true).rows[0]!;
    expect(fresh.description).toContain("Connected · synced 1m ago");
    expect(fresh.tooltip).toContain("synced 1m ago");
    const stale = projectTraceabilityTree(model, "Xray", "test", true, { state: "ok", label: "site", message: "detail", sync: { syncedAt: Date.now() - 60_000, stale: true } }, true).rows[0]!;
    expect(stale.description).toContain("(stale)");
    const cached = projectTraceabilityTree(model, "Xray", "test", true, { state: "unreachable", label: "site", message: "detail", sync: { syncedAt: Date.now() - 60_000, stale: true } }, true).rows[0]!;
    expect(cached.description).toContain("showing data synced 1m ago");
  });
});
