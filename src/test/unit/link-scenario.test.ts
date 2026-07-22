import { describe, it, expect, vi } from "vitest";
import { FeatureParser } from "../../parsers/feature-parser";
import {
  authorScenarioTest,
  buildTestTag,
  computeLinkEdit,
  LinkEdit,
  linkScenarioPicks,
  scenarioGherkinSlice,
} from "../../traceability/link-scenario";
import { AuthoredTest } from "../../traceability/contracts";
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

describe("scenarioGherkinSlice", () => {
  const lines = (feature: string): string[] => feature.split("\n");

  it("slices a plain scenario from its keyword line through its steps, excluding the preceding tag lines", () => {
    const feature =
      "Feature: F\n\n@smoke @REQ_CALC-9\nScenario: Login\n  Given a user\n  When they log in\n  Then ok\n\nScenario: Other\n  Given x\n";
    expect(scenarioGherkinSlice(lines(feature), 4)).toBe(
      "Scenario: Login\n  Given a user\n  When they log in\n  Then ok"
    );
  });

  it("keeps a Scenario Outline's Examples tables and tagged Examples blocks, stopping at the next scenario's tags", () => {
    const feature = [
      "Feature: F",
      "",
      "Scenario Outline: Add",
      "  Given <a>",
      "  Then <b>",
      "",
      "  Examples:",
      "    | a | b |",
      "    | 1 | 2 |",
      "",
      "  @edge",
      "  Examples: edge",
      "    | a | b |",
      "    | 9 | 9 |",
      "",
      "@wip",
      "Scenario: Next",
      "  Given z",
    ].join("\n");

    const slice = scenarioGherkinSlice(lines(feature), 3);

    expect(slice).toContain("Scenario Outline: Add");
    expect(slice).toContain("@edge");
    expect(slice).toContain("Examples: edge");
    expect(slice).toContain("| 9 | 9 |");
    expect(slice).not.toContain("@wip");
    expect(slice).not.toContain("Scenario: Next");
  });

  it("includes doc-strings and data tables verbatim and stops at a following Rule", () => {
    const feature = [
      "Feature: F",
      "",
      "Scenario: Payload",
      "  Given a request:",
      '    """',
      '    { "k": 1 }',
      '    """',
      "  And rows:",
      "    | x |",
      "    | 1 |",
      "",
      "Rule: R",
      "  Scenario: Inner",
      "    Given y",
    ].join("\n");

    const slice = scenarioGherkinSlice(lines(feature), 3);

    expect(slice).toContain('"""');
    expect(slice).toContain('{ "k": 1 }');
    expect(slice).toContain("| 1 |");
    expect(slice).not.toContain("Rule: R");
    expect(slice).not.toContain("Scenario: Inner");
  });

  it("strips carriage returns so a CRLF document yields clean \\n-joined text", () => {
    const feature = "Feature: F\r\n\r\nScenario: A\r\n  Given x\r\n";
    expect(scenarioGherkinSlice(feature.split("\n"), 3)).toBe("Scenario: A\n  Given x");
  });

  it("slices the last scenario in a file to EOF, trimming trailing blank lines", () => {
    const feature = "Feature: F\n\nScenario: Last\n  Given x\n\n\n";
    expect(scenarioGherkinSlice(feature.split("\n"), 3)).toBe("Scenario: Last\n  Given x");
  });

  it("keeps a doc-string whose body line reads like a scenario, and still terminates at the next real scenario", () => {
    const feature = [
      "Feature: F",
      "",
      "Scenario: Has a docstring",
      "  Given a payload:",
      '    """',
      "    Scenario: not a real one",
      "    still inside the string",
      '    """',
      "  Then ok",
      "",
      "Scenario: Real next",
      "  Given z",
    ].join("\n");

    const slice = scenarioGherkinSlice(feature.split("\n"), 3);

    expect(slice).toContain("Scenario: not a real one");
    expect(slice).toContain("still inside the string");
    expect(slice.match(/"""/g)).toHaveLength(2);
    expect(slice).toContain("Then ok");
    expect(slice).not.toContain("Scenario: Real next");
  });

  it("keeps a doc-string body line that looks like a tag, and terminates at the next scenario's tags", () => {
    const feature = [
      "Feature: F",
      "",
      "Scenario: Tag-in-string",
      "  Given a note:",
      '    """',
      "    @not-a-tag lives in prose",
      '    """',
      "",
      "@wip",
      "Scenario: Next",
      "  Given z",
    ].join("\n");

    const slice = scenarioGherkinSlice(feature.split("\n"), 3);

    expect(slice).toContain("@not-a-tag lives in prose");
    expect(slice).not.toContain("@wip");
    expect(slice).not.toContain("Scenario: Next");
  });

  it("keeps doc-string prose beginning with Feature/Rule-style words", () => {
    const feature = [
      "Feature: F",
      "",
      "Scenario: Prose",
      "  Given docs:",
      '    """',
      "    Feature flags are described here",
      "    Rule of thumb: keep it short",
      '    """',
      "  Then ok",
      "",
      "Rule: R",
      "  Scenario: Inner",
      "    Given y",
    ].join("\n");

    const slice = scenarioGherkinSlice(feature.split("\n"), 3);

    expect(slice).toContain("Feature flags are described here");
    expect(slice).toContain("Rule of thumb: keep it short");
    expect(slice).toContain("Then ok");
    expect(slice).not.toContain("Rule: R");
    expect(slice).not.toContain("Scenario: Inner");
  });

  it("handles a backtick-fenced doc-string the same way as a triple-quote one", () => {
    const feature = [
      "Feature: F",
      "",
      "Scenario: Backtick docstring",
      "  Given json:",
      "    ```",
      "    Scenario: still prose",
      "    @nope",
      "    ```",
      "  Then ok",
      "",
      "Scenario: Next",
      "  Given z",
    ].join("\n");

    const slice = scenarioGherkinSlice(feature.split("\n"), 3);

    expect(slice).toContain("Scenario: still prose");
    expect(slice).toContain("@nope");
    expect(slice.match(/```/g)).toHaveLength(2);
    expect(slice).toContain("Then ok");
    expect(slice).not.toContain("Scenario: Next");
  });

  it("does not close a \"\"\"-fenced doc-string at a bare backtick line, nor a backtick fence at a bare \"\"\" line", () => {
    const tripleQuoted = [
      "Feature: F",
      "",
      "Scenario: Quote fence",
      "  Given a payload:",
      '    """',
      "    ```",
      "    still inside the quote fence",
      '    """',
      "  Then ok",
      "",
      "Scenario: Next",
      "  Given z",
    ].join("\n");

    const quoteSlice = scenarioGherkinSlice(tripleQuoted.split("\n"), 3);

    expect(quoteSlice).toContain("```");
    expect(quoteSlice).toContain("still inside the quote fence");
    expect(quoteSlice.match(/"""/g)).toHaveLength(2);
    expect(quoteSlice).toContain("Then ok");
    expect(quoteSlice).not.toContain("Scenario: Next");

    const backtickFenced = [
      "Feature: F",
      "",
      "Scenario: Backtick fence",
      "  Given a payload:",
      "    ```",
      '    """',
      "    still inside the backtick fence",
      "    ```",
      "  Then ok",
      "",
      "Scenario: Next",
      "  Given z",
    ].join("\n");

    const backtickSlice = scenarioGherkinSlice(backtickFenced.split("\n"), 3);

    expect(backtickSlice).toContain('"""');
    expect(backtickSlice).toContain("still inside the backtick fence");
    expect(backtickSlice.match(/```/g)).toHaveLength(2);
    expect(backtickSlice).toContain("Then ok");
    expect(backtickSlice).not.toContain("Scenario: Next");
  });

  it("trims trailing blank and comment-only lines so a stray comment between scenarios is left out", () => {
    const feature = [
      "Feature: F",
      "",
      "Scenario: A",
      "  Given x",
      "",
      "# a stray comment between scenarios",
      "",
      "Scenario: B",
      "  Given y",
    ].join("\n");

    expect(scenarioGherkinSlice(feature.split("\n"), 3)).toBe("Scenario: A\n  Given x");
  });
});

describe("authorScenarioTest", () => {
  const spec = { project: "CALC", summary: "Login", gherkin: "Scenario: Login\n  Given a user" };
  const noopUi = { confirm: () => Promise.resolve(true), info: (): void => {}, error: (): void => {} };

  it("never calls createTest when the confirmation modal is dismissed", async () => {
    const createTest = vi.fn(() => Promise.resolve<AuthoredTest>({ key: "CALC-9", warnings: [] }));
    const insertTag = vi.fn(() => Promise.resolve());

    await authorScenarioTest(
      spec,
      "Xray",
      { ...noopUi, confirm: () => Promise.resolve(false) },
      { createTest, insertTag, merge: () => {} }
    );

    expect(createTest).not.toHaveBeenCalled();
    expect(insertTag).not.toHaveBeenCalled();
  });

  it("inserts the tag, merges the key, and shows a success toast after a confirmed create", async () => {
    const inserted: string[] = [];
    const merged: string[] = [];
    const info: string[] = [];

    await authorScenarioTest(
      spec,
      "Xray",
      { confirm: () => Promise.resolve(true), info: (m) => info.push(m), error: () => {} },
      {
        createTest: () => Promise.resolve<AuthoredTest>({ key: "CALC-9", issueId: "1", warnings: [] }),
        insertTag: (key) => {
          inserted.push(key);
          return Promise.resolve();
        },
        merge: (key) => merged.push(key),
      }
    );

    expect(inserted).toEqual(["CALC-9"]);
    expect(merged).toEqual(["CALC-9"]);
    expect(info[0]).toContain("Created CALC-9");
  });

  it("lists non-empty warnings in the success toast", async () => {
    const info: string[] = [];

    await authorScenarioTest(
      spec,
      "Xray",
      { confirm: () => Promise.resolve(true), info: (m) => info.push(m), error: () => {} },
      {
        createTest: () => Promise.resolve<AuthoredTest>({ key: "CALC-9", warnings: ["Gherkin was adjusted"] }),
        insertTag: () => Promise.resolve(),
        merge: () => {},
      }
    );

    expect(info[0]).toContain("Gherkin was adjusted");
  });

  it("never inserts a tag it could not read back — reports the remote write and its issue id instead", async () => {
    const inserted: string[] = [];
    const errors: string[] = [];

    await authorScenarioTest(
      spec,
      "Xray",
      { confirm: () => Promise.resolve(true), info: () => {}, error: (m) => errors.push(m) },
      {
        createTest: () => Promise.resolve<AuthoredTest>({ issueId: "45678", warnings: [] }),
        insertTag: (key) => {
          inserted.push(key);
          return Promise.resolve();
        },
        merge: () => {},
      }
    );

    expect(inserted).toEqual([]);
    expect(errors[0]).toContain("was created");
    expect(errors[0]).toContain("45678");
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
