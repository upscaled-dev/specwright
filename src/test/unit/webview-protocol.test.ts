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

function host(surface: SurfaceName | "shell", body: object): object {
  return { version: WEBVIEW_PROTOCOL_VERSION, session: "session", revision: 2, surface, body };
}

function acceptedHost(surface: SurfaceName | "shell", body: object): boolean {
  return isHostEnvelope(host(surface, body), "session", 1);
}

function boardRender(matrixRows = 1): Extract<BoardHostMessage, { type: "render" }> {
  const section = { total: 0, filtered: 0, page: 0, pageSize: 25, pageCount: 0, query: "", filtering: false, selection: "none" } as const;
  const verb = { label: "Action", enabled: false, hint: "Pick an item" };
  return {
    type: "render", scenarios: [], available: [], mapped: [], sections: { untraced: section, available: section, mapped: section }, pageSize: 25,
    matrix: [{ file: "features/large.feature", count: matrixRows, rows: Array.from({ length: matrixRows }, (_, index) => ({
      requirement: `REQ-${index}`, test: `TEST-${index}`, scenario: `Scenario ${index}`, tag: `@TEST_${index}`,
      result: "passed", file: "features/large.feature", projects: ["CALC"],
    })) }], matrixPage: { filtered: matrixRows, page: 0, pageSize: 25, pageCount: Math.ceil(matrixRows / 25) },
    executions: [], availableEmptyText: "No tests", filtering: false, projects: ["CALC"], project: "", scoped: false,
    createVerb: verb, syncVerb: verb, syncScopeVerb: verb, untracedHelper: "", testSetVerb: verb, addToTestSetVerb: verb, testPlanVerb: verb,
    addToTestPlanVerb: verb, mappingHelper: "", executionVerb: verb,
  };
}

describe("webview protocol", () => {
  it("routes shell navigation and link selection through their own message contracts", () => {
    expect(parseClientEnvelope(client("shell", { type: "ready" }))).toBeDefined();
    expect(parseClientEnvelope(client("shell", { type: "tab", tab: "publish" }))).toBeDefined();
    expect(parseClientEnvelope(client("shell", { type: "tab", tab: "settings" }))).toBeUndefined();
    expect(parseClientEnvelope(client("link", { type: "cancel" }))).toBeDefined();
    expect(parseClientEnvelope(client("link", { type: "search", value: "CALC" }))).toBeDefined();
    expect(parseClientEnvelope(client("link", { type: "openLinked", key: "CALC-7" }))).toBeDefined();
    expect(parseClientEnvelope(client("link", { type: "unlink", key: "CALC-7" }))).toBeDefined();
    expect(parseClientEnvelope(client("link", { type: "unlink", key: 7 }))).toBeUndefined();

    expect(acceptedHost("shell", { type: "activate", tab: "mapping" })).toBe(true);
    expect(acceptedHost("shell", { type: "linkTab", visible: true, title: "Link CALC-7" })).toBe(true);
    expect(acceptedHost("shell", { type: "linkTab", visible: "yes" })).toBe(false);
    expect(acceptedHost("shell", { type: "activate", tab: "settings" })).toBe(false);
  });

  it("accepts populated link picker results and rejects malformed remote rows", () => {
    expect(acceptedHost("link", { type: "reset", title: "Link test", searchPlaceholder: "Search tests" })).toBe(true);
    expect(acceptedHost("link", { type: "busy", busy: false })).toBe(true);
    expect(acceptedHost("link", { type: "rows", rows: [
      { id: "CALC-7", key: "CALC-7", kind: "test", summary: "Adds tax" },
      { id: "create", key: "", kind: "create", summary: "Create new test" },
    ] })).toBe(true);
    expect(acceptedHost("link", { type: "linked", rows: [
      { key: "CALC-7", summary: "Adds tax", remoteMissing: false },
      { key: "CALC-8", remoteMissing: true },
    ] })).toBe(true);
    expect(acceptedHost("link", { type: "rows", rows: [{ id: "CALC-7", key: "CALC-7", kind: "issue" }] })).toBe(false);
    expect(acceptedHost("link", { type: "linked", rows: [{ key: "CALC-8", remoteMissing: "yes" }] })).toBe(false);
    expect(acceptedHost("link", { type: "rows", rows: [{ id: "CALC-7", key: "CALC-7", kind: "test", token: "secret" }] })).toBe(false);
  });

  it("accepts publish creation and search requests with bounded user input", () => {
    const create = { mode: "create-new", project: "CALC", summary: "Nightly run", testPlanKey: "CALC-2", environments: ["chrome", "firefox"] };
    expect(parseClientEnvelope(client("publish", { type: "confirm", runId: "run-1", request: create, attachments: ["/tmp/trace.zip"] }))).toBeDefined();
    expect(parseClientEnvelope(client("publish", { type: "confirm", runId: "run-1", request: { ...create, environments: [4] }, attachments: [] }))).toBeUndefined();
    expect(parseClientEnvelope(client("publish", { type: "confirm", runId: "run-1", request: { ...create, project: "x".repeat(513) }, attachments: [] }))).toBeUndefined();
    expect(parseClientEnvelope(client("publish", { type: "confirm", runId: "run-1", request: { ...create, unknown: true }, attachments: [] }))).toBeUndefined();
    expect(parseClientEnvelope(client("publish", { type: "confirm", runId: "run-1", request: null, attachments: [] }))).toBeUndefined();
    expect(parseClientEnvelope(client("publish", { type: "search", token: 8, kind: "test-plan", query: "CALC" }))).toBeDefined();
    expect(parseClientEnvelope(client("publish", { type: "search", token: -1, kind: "test-plan", query: "CALC" }))).toBeUndefined();
    expect(parseClientEnvelope(client("publish", { type: "attachPending", runId: "run-1" }))).toBeDefined();
    expect(parseClientEnvelope(client("publish", { type: "browse" }))).toBeDefined();
  });

  it("admits the populated publish model and validates search and attachment results", () => {
    const run = {
      id: "run-1", label: "Checkout", subtitle: "4 scenarios", defaultSummary: "Checkout nightly run",
      project: { value: "CALC", fromDerivation: true, fromScope: false }, prefillPlanKey: "CALC-2",
      republish: { target: "CALC-9", publishedAt: 1_700_000_000, mode: "append", outcomeUnknown: false, operationId: "op-1" },
      pendingAttachments: { target: "CALC-9", count: 2 },
    };
    const attachment = { path: "/tmp/trace.zip", name: "trace.zip", size: 42 };
    const model = {
      title: "Publish run", runs: [run], selectedRunId: "run-1", jiraSearchAvailable: true,
      knownProjectKeys: ["CALC"], attachments: { available: true, suggestions: [attachment], uploadLimitBytes: 1024, evidenceStream: "both" },
    };
    expect(acceptedHost("publish", { type: "model", model })).toBe(true);
    expect(acceptedHost("publish", { type: "runs", runs: [run], selectedRunId: "run-1" })).toBe(true);
    expect(acceptedHost("publish", { type: "retry", runs: [run], selectedRunId: "run-1" })).toBe(true);
    for (const override of [{ project: "CALC" }, { republish: { target: "CALC-9", publishedAt: "yesterday" } }, { pendingAttachments: 2 }]) {
      expect(acceptedHost("publish", { type: "model", model: { ...model, runs: [{ ...run, ...override }] } })).toBe(false);
    }
    expect(acceptedHost("publish", { type: "search-result", token: 8, kind: "execution", items: [{ key: "CALC-9", label: "Nightly run" }] })).toBe(true);
    expect(acceptedHost("publish", { type: "browse-result", items: [attachment] })).toBe(true);
    expect(acceptedHost("publish", { type: "attachment-error", text: "File unavailable" })).toBe(true);
    expect(acceptedHost("publish", { type: "pending-busy", runId: "run-1", busy: true })).toBe(true);
    expect(acceptedHost("publish", { type: "pending-result", runId: "run-1", remaining: 1 })).toBe(true);
    expect(acceptedHost("publish", { type: "settled" })).toBe(true);

    expect(acceptedHost("publish", { type: "model", model: { ...model, runs: [{ ...run, republish: "CALC-9" }] } })).toBe(false);
    expect(acceptedHost("publish", { type: "model", model: { ...model, runs: [{ ...run, project: { value: "CALC", fromDerivation: "yes" } }] } })).toBe(false);
    expect(acceptedHost("publish", { type: "model", model: { ...model, runs: [{ ...run, pendingAttachments: { target: "CALC-9", count: -1 } }] } })).toBe(false);
    expect(acceptedHost("publish", { type: "model", model: { ...model, attachments: { ...model.attachments, evidenceStream: "unfiltered" } } })).toBe(false);
    expect(acceptedHost("publish", { type: "search-result", token: 8, kind: "execution", items: [{ key: "CALC-9", label: 4 }] })).toBe(false);
    expect(acceptedHost("publish", { type: "browse-result", items: [{ ...attachment, size: -1 }] })).toBe(false);
    expect(acceptedHost("publish", { type: "pending-result", runId: "run-1", remaining: -1 })).toBe(false);
    expect(acceptedHost("publish", { type: "search-result", token: 8, kind: "execution", items: [], secret: "echo" })).toBe(false);
  });
  it("accepts only exact, bounded privileged client messages", () => {
    expect(parseClientEnvelope(client("board", { type: "addToTestPlan" }))).toBeDefined();
    expect(parseClientEnvelope(client("board", { type: "runSelected" }))).toBeUndefined();
    expect(parseClientEnvelope(client("link", { type: "confirm", id: "CALC-1" }))).toBeDefined();
    expect(parseClientEnvelope(client("link", { type: "confirm", id: "x".repeat(513) }))).toBeUndefined();
    expect(parseClientEnvelope(client("link", { type: "confirm", id: "CALC-1", extra: true }))).toBeUndefined();
    expect(parseClientEnvelope(client("publish", { type: "confirm", runId: "run", request: { mode: "append", executionKey: "CALC-1" }, attachments: Array(65).fill("a") }))).toBeDefined();
    expect(parseClientEnvelope(client("publish", { type: "confirm", runId: "run", request: { mode: "append", executionKey: "CALC-1" }, attachments: Array(129).fill("a") }))).toBeUndefined();
  });

  // The Executions rows and the test card keys share this message, and the key is the whole request.
  it("accepts an open request only for a non-empty issue key", () => {
    expect(parseClientEnvelope(client("board", { type: "open", key: "CALC-1" }))).toBeDefined();
    expect(parseClientEnvelope(client("board", { type: "open", key: "" }))).toBeUndefined();
    expect(parseClientEnvelope(client("board", { type: "open" }))).toBeUndefined();
    expect(parseClientEnvelope(client("board", { type: "open", key: "CALC-1", extra: true }))).toBeUndefined();
    expect(parseClientEnvelope(client("board", { type: "open", key: "x".repeat(513) }))).toBeUndefined();
  });

  // The select-all posts an intent, never a key list, so the whole message is one list name and one flag.
  it("accepts a select-all intent for a known test list only", () => {
    expect(parseClientEnvelope(client("board", { type: "select-scope", section: "available", on: true }))).toBeDefined();
    expect(parseClientEnvelope(client("board", { type: "select-scope", section: "mapped", on: false }))).toBeDefined();
    expect(parseClientEnvelope(client("board", { type: "select-scope", section: "untraced", on: true }))).toBeUndefined();
    expect(parseClientEnvelope(client("board", { type: "select-scope", section: "everything", on: true }))).toBeUndefined();
    expect(parseClientEnvelope(client("board", { type: "select-scope", section: "available" }))).toBeUndefined();
    expect(parseClientEnvelope(client("board", { type: "select-scope", section: "available", on: "yes" }))).toBeUndefined();
    expect(parseClientEnvelope(client("board", { type: "select-scope", target: "test", section: "available", on: true }))).toBeUndefined();
    expect(parseClientEnvelope(client("board", { type: "select-scope", section: "available", on: true, keys: ["CALC-1"] }))).toBeUndefined();
  });

  it("rejects a section meta with an unknown select-all state", () => {
    const base = boardRender();
    const body = { ...base, sections: { ...base.sections, available: { ...base.sections.available, selection: "most" } } };
    expect(isHostEnvelope({ version: 1, session: "session", revision: 2, surface: "board", body }, "session", 1)).toBe(false);
  });

  it("accepts Matrix page requests and rejects malformed Matrix page metadata", () => {
    expect(parseClientEnvelope(client("board", { type: "page", section: "matrix", step: "next" }))).toBeDefined();
    const base = boardRender();
    const envelope = { version: 1, session: "session", revision: 2, surface: "board" };
    expect(isHostEnvelope({ ...envelope, body: { ...base, matrixPage: { ...base.matrixPage, pageSize: 0 } } }, "session", 1)).toBe(false);
    expect(isHostEnvelope({ ...envelope, body: { ...base, matrixPage: { ...base.matrixPage, extra: true } } }, "session", 1)).toBe(false);
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
    expect(acceptedHost("board", { type: "syncProgress", text: "Refreshing CALC" })).toBe(true);
    expect(acceptedHost("board", { type: "syncProgress", text: 5 })).toBe(false);
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

    const unknown = {
      kind: "unknown", key: "", keyLabel: "Unknown execution", summary: "Unmatched run",
      activityCount: 1, action: "Publish", resultsImported: "1", passRate: "100%", publishedAt: "now",
    };
    expect(acceptedHost("board", { ...base, executions: [unknown] })).toBe(true);
    expect(acceptedHost("board", { ...base, executions: [{ ...unknown, key: "CALC-9" }] })).toBe(false);
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
