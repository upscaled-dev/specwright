import { describe, it, expect } from "vitest";
import { FeatureParser } from "../../parsers/feature-parser";
import {
  buildTestTag,
  computeLinkEdit,
  LinkEdit,
  linkScenarioPicks,
} from "../../traceability/link-scenario";
import { buildTraceabilitySnapshot } from "../../traceability/traceability-model";
import { InMemoryTraceabilityAdapter } from "../../traceability/in-memory-adapter";
import { JIRA_KEY_SHAPE, projectFromKey } from "../../xray/xray-adapter";
import { KeyGrammar } from "../../traceability/contracts";

const JIRA_GRAMMAR: KeyGrammar = {
  testPrefix: "TEST_",
  reqPrefix: "REQ_",
  keyShape: JIRA_KEY_SHAPE,
  canonicalizeKey: (key) => key.toUpperCase(),
  projectOf: projectFromKey,
};

function applyEdit(lines: readonly string[], edit: LinkEdit): string[] {
  const next = [...lines];
  if (edit.kind === "insertLine") {next.splice(edit.line, 0, edit.text);}
  else if (edit.kind === "replaceLine") {next[edit.line] = edit.text;}
  return next;
}

// Mirrors the command handler's WorkspaceEdit semantics: split on the document's own EOL (so each
// part is EOL-free line content), apply the structured edit, and rejoin with that EOL.
function applyLinkEditExact(text: string, edit: LinkEdit): string {
  if (edit.kind === "unchanged") {return text;}
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const parts = text.split(eol);
  if (edit.kind === "insertLine") {parts.splice(edit.line, 0, edit.text);}
  else {parts[edit.line] = edit.text;}
  return parts.join(eol);
}

describe("buildTestTag", () => {
  it("builds the tag from the adapter grammar prefix, never a hard-coded one", () => {
    expect(buildTestTag(JIRA_GRAMMAR, "CALC-1")).toBe("@TEST_CALC-1");
    expect(buildTestTag(new InMemoryTraceabilityAdapter().keyGrammar, "5")).toBe("@TC-5");
  });
});

describe("linkScenarioPicks", () => {
  it("is empty for an unsynced adapter so the command prompts to connect/sync instead of showing a blank picker", () => {
    const adapter = new InMemoryTraceabilityAdapter();
    expect(linkScenarioPicks(adapter.metadata.snapshot())).toEqual([]);
  });

  it("lists synced test cases sorted by key with their summaries", async () => {
    const adapter = new InMemoryTraceabilityAdapter();
    adapter.seedCatalogue([{ key: "12", summary: "twelve" }, { key: "3", summary: "three" }], "complete");
    await adapter.metadata.sync({ testKeys: ["12", "3"] });
    expect(linkScenarioPicks(adapter.metadata.snapshot())).toEqual([
      { key: "12", summary: "twelve" },
      { key: "3", summary: "three" },
    ]);
  });
});

describe("computeLinkEdit", () => {
  const lines = (feature: string): string[] => feature.split("\n");

  it("inserts a fresh tag line above a scenario that has no tags", () => {
    const feature = "Feature: F\n\nScenario: Untagged\n  Given x\n";
    const edit = computeLinkEdit(lines(feature), 3, "5", new InMemoryTraceabilityAdapter().keyGrammar);
    expect(edit).toEqual({ kind: "insertLine", line: 2, text: "@TC-5" });
  });

  it("preserves indentation when inserting", () => {
    const feature = "Feature: F\n\n  Scenario: Indented\n    Given x\n";
    const edit = computeLinkEdit(lines(feature), 3, "CALC-1", JIRA_GRAMMAR);
    expect(edit).toEqual({ kind: "insertLine", line: 2, text: "  @TEST_CALC-1" });
  });

  it("appends to an existing tag line rather than adding a second line", () => {
    const feature = "Feature: F\n\n@REQ_CALC-9\nScenario: A\n  Given x\n";
    const edit = computeLinkEdit(lines(feature), 4, "CALC-1", JIRA_GRAMMAR);
    expect(edit).toEqual({ kind: "replaceLine", line: 2, text: "@REQ_CALC-9 @TEST_CALC-1" });
  });

  it("is idempotent — re-linking the same key is a no-op", () => {
    const feature = "Feature: F\n\n@TEST_CALC-1\nScenario: A\n  Given x\n";
    expect(computeLinkEdit(lines(feature), 4, "CALC-1", JIRA_GRAMMAR)).toEqual({ kind: "unchanged" });
  });

  it("treats a case-variant existing tag as already linked", () => {
    const feature = "Feature: F\n\n@test_calc-1\nScenario: A\n  Given x\n";
    expect(computeLinkEdit(lines(feature), 4, "CALC-1", JIRA_GRAMMAR)).toEqual({ kind: "unchanged" });
  });

  it("replaces the existing test tag when a different key is chosen (re-map), keeping req tags", () => {
    const feature = "Feature: F\n\n@TEST_CALC-1 @REQ_CALC-9\nScenario: A\n  Given x\n";
    const edit = computeLinkEdit(lines(feature), 4, "CALC-2", JIRA_GRAMMAR);
    expect(edit).toEqual({ kind: "replaceLine", line: 2, text: "@TEST_CALC-2 @REQ_CALC-9" });
  });

  it("preserves indentation when re-mapping an indented scenario's tag line", () => {
    const feature = "Feature: F\n\n  @TEST_CALC-1\n  Scenario: A\n    Given x\n";
    const edit = computeLinkEdit(lines(feature), 4, "CALC-2", JIRA_GRAMMAR);
    expect(edit).toEqual({ kind: "replaceLine", line: 2, text: "  @TEST_CALC-2" });
  });

  it("re-maps the test tag on a split Examples block, not the outline tag", () => {
    const feature =
      "Feature: F\n\n@TEST_CALC-1\nScenario Outline: O\n  When step <a>\n\n  @TEST_CALC-2\n  Examples: edge\n    | a |\n    | 1 |\n";
    const edit = computeLinkEdit(lines(feature), 8, "CALC-3", JIRA_GRAMMAR);
    expect(edit).toEqual({ kind: "replaceLine", line: 6, text: "  @TEST_CALC-3" });
  });

  it("re-maps only the first test tag when a scenario line carries several", () => {
    const feature = "Feature: F\n\n@TEST_CALC-1 @TEST_CALC-2\nScenario: A\n  Given x\n";
    const edit = computeLinkEdit(lines(feature), 4, "CALC-9", JIRA_GRAMMAR);
    expect(edit).toEqual({ kind: "replaceLine", line: 2, text: "@TEST_CALC-9 @TEST_CALC-2" });
  });

  it("appends after arbitrary existing tags, preserving their order", () => {
    const feature = "Feature: F\n\n@smoke @REQ_CALC-9 @wip\nScenario: A\n  Given x\n";
    const edit = computeLinkEdit(lines(feature), 4, "CALC-1", JIRA_GRAMMAR);
    expect(edit).toEqual({ kind: "replaceLine", line: 2, text: "@smoke @REQ_CALC-9 @wip @TEST_CALC-1" });
  });

  it("inserts above a scenario without touching a distant feature-level tag", () => {
    const feature = "@TEST_CALC-1\nFeature: F\n\nScenario: A\n  Given x\n";
    const edit = computeLinkEdit(lines(feature), 4, "CALC-2", JIRA_GRAMMAR);
    expect(edit).toEqual({ kind: "insertLine", line: 3, text: "@TEST_CALC-2" });
  });

  it("re-maps a scenario's own tag inside a Rule, not the Rule line", () => {
    const feature = "Feature: F\n\nRule: R1\n\n  @TEST_CALC-1\n  Scenario: A\n    Given x\n";
    const edit = computeLinkEdit(lines(feature), 6, "CALC-2", JIRA_GRAMMAR);
    expect(edit).toEqual({ kind: "replaceLine", line: 4, text: "  @TEST_CALC-2" });
  });

  it("re-maps a CRLF document byte-exact, never leaving a doubled carriage return", () => {
    const feature = "Feature: F\r\n\r\n@TEST_CALC-1\r\nScenario: A\r\n  Given x\r\n";
    const edit = computeLinkEdit(feature.split("\n"), 4, "CALC-2", JIRA_GRAMMAR);
    expect(edit).toEqual({ kind: "replaceLine", line: 2, text: "@TEST_CALC-2" });
    const result = applyLinkEditExact(feature, edit);
    expect(result).toBe("Feature: F\r\n\r\n@TEST_CALC-2\r\nScenario: A\r\n  Given x\r\n");
    expect(result).not.toContain("\r\r");
  });

  it("is idempotent on a CRLF document", () => {
    const feature = "Feature: F\r\n\r\n@TEST_CALC-1\r\nScenario: A\r\n  Given x\r\n";
    expect(computeLinkEdit(feature.split("\n"), 4, "CALC-1", JIRA_GRAMMAR)).toEqual({ kind: "unchanged" });
  });
});

describe("linkScenario end-to-end model update", () => {
  const grammar = new InMemoryTraceabilityAdapter().keyGrammar;

  function snapshotFrom(feature: string): ReturnType<typeof buildTraceabilitySnapshot> {
    const parsed = FeatureParser.create().parseFeatureContent(feature);
    return buildTraceabilitySnapshot(
      [{ filePath: "/ws/a.feature", scenarios: parsed?.scenarios ?? [] }],
      {},
      grammar
    );
  }

  it("moves an untraced scenario into a mapped link after the tag is inserted, and re-running is a no-op", () => {
    const feature = "Feature: F\n\nScenario: Untagged\n  Given x\n";
    const before = snapshotFrom(feature);
    expect(before.links).toEqual([]);
    expect(before.untraced.map((u) => u.scenario.name)).toEqual(["Untagged"]);

    const scenarioLine = before.untraced[0]!.scenario.line;
    const edit = computeLinkEdit(feature.split("\n"), scenarioLine, "5", grammar);
    const linked = applyEdit(feature.split("\n"), edit).join("\n");

    const after = snapshotFrom(linked);
    expect(after.untraced).toEqual([]);
    expect(after.links.map((l) => l.testKey)).toEqual(["5"]);

    const secondEdit = computeLinkEdit(linked.split("\n"), scenarioLine + 1, "5", grammar);
    expect(secondEdit).toEqual({ kind: "unchanged" });
  });
});
