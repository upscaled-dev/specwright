import { describe, expect, it } from "vitest";
import {
  isHostEnvelope,
  parseClientEnvelope,
  WEBVIEW_PROTOCOL_VERSION,
  type BoardHostMessage,
  type SurfaceName,
} from "../../webview/protocol";

function client(surface: SurfaceName | "shell", body: object, overrides: Record<string, unknown> = {}): object {
  return { version: WEBVIEW_PROTOCOL_VERSION, session: "session", revision: surface === "shell" ? 0 : 4, surface, body, ...overrides };
}

function boardRender(matrixRows = 1): Extract<BoardHostMessage, { type: "render" }> {
  const section = { total: 0, filtered: 0, page: 0, pageSize: 25, pageCount: 0, query: "", filtering: false };
  const verb = { label: "Action", enabled: false, hint: "Pick an item" };
  return {
    type: "render", scenarios: [], available: [], mapped: [], sections: { untraced: section, available: section, mapped: section }, pageSize: 25,
    matrix: [{ file: "features/large.feature", count: matrixRows, rows: Array.from({ length: matrixRows }, (_, index) => ({
      requirement: `REQ-${index}`, test: `TEST-${index}`, scenario: `Scenario ${index}`, tag: `@TEST_${index}`,
      result: "passed", file: "features/large.feature", projects: ["CALC"],
    })) }], executions: [], availableEmptyText: "No tests", filtering: false, projects: ["CALC"], project: "", scoped: false,
    createVerb: verb, syncVerb: verb, untracedHelper: "", testSetVerb: verb, addToTestSetVerb: verb, testPlanVerb: verb,
    addToTestPlanVerb: verb, availableHelper: "", executionVerb: verb, runSelectedVerb: verb, mappedHelper: "",
  };
}

describe("webview protocol", () => {
  it("accepts only exact, bounded privileged client messages", () => {
    expect(parseClientEnvelope(client("link", { type: "confirm", id: "CALC-1" }))).toBeDefined();
    expect(parseClientEnvelope(client("link", { type: "confirm", id: "x".repeat(513) }))).toBeUndefined();
    expect(parseClientEnvelope(client("link", { type: "confirm", id: "CALC-1", extra: true }))).toBeUndefined();
    expect(parseClientEnvelope(client("publish", { type: "confirm", runId: "run", request: { mode: "append", executionKey: "CALC-1" }, attachments: Array(65).fill("a") }))).toBeDefined();
    expect(parseClientEnvelope(client("publish", { type: "confirm", runId: "run", request: { mode: "append", executionKey: "CALC-1" }, attachments: Array(129).fill("a") }))).toBeUndefined();
  });

  it("rejects malformed, wrong-version, wrong-session and unknown-surface envelopes", () => {
    expect(parseClientEnvelope(client("board", { type: "drop", scenario: "s", key: "CALC-1" }, { version: 2 }))).toBeUndefined();
    expect(parseClientEnvelope(client("board", { type: "drop", scenario: "s", key: "CALC-1" }, { surface: "unknown" }))).toBeUndefined();
    expect(isHostEnvelope({ version: 1, session: "other", revision: 2, surface: "board", body: boardRender() }, "session", 1)).toBe(false);
  });

  it("rejects stale and malformed host messages without rejecting a valid current render", () => {
    const valid = { version: 1, session: "session", revision: 2, surface: "board", body: boardRender() };
    expect(isHostEnvelope(valid, "session", 1)).toBe(true);
    expect(isHostEnvelope(valid, "session", 2)).toBe(false);
    expect(isHostEnvelope({ ...valid, revision: 3, body: { type: "render" } }, "session", 2)).toBe(false);
    expect(isHostEnvelope({ ...valid, surface: "publish", body: { type: "publish-busy", busy: true } }, "session", 1)).toBe(true);
    expect(isHostEnvelope({ ...valid, surface: "publish", body: { type: "publish-busy", busy: true, extra: true } }, "session", 1)).toBe(false);
  });

  it("preserves unpaginated large-board projections", () => {
    const matrix = { version: 1, session: "session", revision: 2, surface: "board", body: boardRender(300) };
    expect(isHostEnvelope(matrix, "session", 1)).toBe(true);

    const base = boardRender(0);
    const links = Array.from({ length: 300 }, (_, index) => ({
      name: `Scenario ${index}`, location: `features/large.feature:${index + 1}`, unlinkId: `scenario-${index}`,
    }));
    const mapped = {
      version: 1, session: "session", revision: 2, surface: "board",
      body: { ...base, mapped: [{ key: "CALC-1", pills: [], links, selected: false }] },
    };
    expect(isHostEnvelope(mapped, "session", 1)).toBe(true);

    const activities = Array.from({ length: 300 }, (_, index) => ({
      action: `Publish ${index}`, resultsImported: "1", passRate: "100%", publishedAt: "now",
    }));
    const executions = {
      version: 1, session: "session", revision: 2, surface: "board",
      body: { ...base, executions: [{ kind: "group", key: "CALC-1", keyLabel: "CALC-1", summary: "Run", latestPublishedAt: "now", activityCount: 300, activities }] },
    };
    expect(isHostEnvelope(executions, "session", 1)).toBe(true);
  });

  it("rejects a projection whose card-level string arrays and links exceed the aggregate budget", () => {
    const base = boardRender(0);
    const scenarios = Array.from({ length: 300 }, (_, index) => ({
      name: `Scenario ${index}`, location: "features/large.feature:1", dropId: `scenario-${index}`,
      pills: Array(64).fill("@smoke"), reqKeys: Array(64).fill("REQ-1"), selected: false,
    }));
    const link = { name: "Scenario", location: "features/large.feature:1", unlinkId: "scenario-1" };
    const mapped = Array.from({ length: 100 }, (_, index) => ({
      key: `CALC-${index}`, pills: Array(64).fill("smoke"), links: Array(64).fill(link), selected: false,
    }));
    const envelope = {
      version: 1, session: "session", revision: 2, surface: "board", body: { ...base, scenarios, mapped },
    };

    expect(isHostEnvelope(envelope, "session", 1)).toBe(false);
  });

  it("rejects matrix projects and execution activities that collectively exceed the aggregate budget", () => {
    const base = boardRender(0);
    const scenarios = Array.from({ length: 200 }, (_, index) => ({
      name: `Scenario ${index}`, location: "features/large.feature:1", dropId: `scenario-${index}`,
      pills: Array(64).fill("@smoke"), reqKeys: Array(64).fill("REQ-1"), selected: false,
    }));
    const row = {
      requirement: "REQ-1", test: "TEST-1", scenario: "Scenario", tag: "@TEST_1",
      result: "passed", file: "features/large.feature", projects: Array(64).fill("CALC"),
    };
    const matrix = Array.from({ length: 200 }, (_, index) => ({ file: `features/${index}.feature`, count: 1, rows: [row] }));
    const activity = { action: "Publish", resultsImported: "1", passRate: "100%", publishedAt: "now" };
    const executions = Array.from({ length: 200 }, (_, index) => ({
      kind: "group", key: `CALC-${index}`, keyLabel: `CALC-${index}`, summary: "Run",
      latestPublishedAt: "now", activityCount: 64, activities: Array(64).fill(activity),
    }));
    const envelope = {
      version: 1, session: "session", revision: 2, surface: "board", body: { ...base, scenarios, matrix, executions },
    };

    expect(isHostEnvelope(envelope, "session", 1)).toBe(false);
  });
});
