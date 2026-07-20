import { describe, it, expect } from "vitest";
import * as vscode from "vscode";
import { tagKeyLines, TagDecorationProvider, TAG_DECORATION_COLOR } from "../../traceability/tag-decoration";
import { KeyGrammar } from "../../traceability/contracts";
import { JIRA_KEY_SHAPE, projectFromKey } from "../../xray/xray-adapter";
import { InMemoryTraceabilityAdapter } from "../../traceability/in-memory-adapter";

const XRAY_GRAMMAR: KeyGrammar = {
  testPrefix: "TEST_",
  reqPrefix: "REQ_",
  keyShape: JIRA_KEY_SHAPE,
  canonicalizeKey: (key) => key.toUpperCase(),
  projectOf: projectFromKey,
};

const FEATURE = [
  "Feature: F",
  "",
  "@TEST_CALC-1 @REQ_CALC-9",
  "Scenario: A",
  "  Given x",
  "",
  "@smoke",
  "Scenario: B",
  "  Given y",
  "",
  "@TC-1",
  "Scenario: C",
  "  Given z",
].join("\n");

interface FakeEditor {
  document: { uri: { scheme: string }; languageId: string; fileName: string; getText: () => string };
  decorations: Array<{ type: unknown; ranges: readonly vscode.Range[] }>;
  setDecorations: (type: unknown, ranges: readonly vscode.Range[]) => void;
}

function fakeEditor(languageId: string, fileName: string, text = FEATURE, scheme = "file"): FakeEditor {
  const editor: FakeEditor = {
    document: { uri: { scheme }, languageId, fileName, getText: () => text },
    decorations: [],
    setDecorations: (type, ranges) => { editor.decorations.push({ type, ranges }); },
  };
  return editor;
}

describe("tagKeyLines", () => {
  it("returns the 0-based lines carrying a @TEST_/@REQ_ tag and nothing else", () => {
    expect(tagKeyLines(FEATURE, XRAY_GRAMMAR)).toEqual([2]);
  });

  it("sources prefixes from the active adapter grammar, not a hardcoded Xray regex", () => {
    const inMemory = new InMemoryTraceabilityAdapter().keyGrammar;
    // The in-memory grammar (TC-/RQ-, numeric keys) decorates a different line than Xray's.
    expect(tagKeyLines(FEATURE, inMemory)).toEqual([10]);
  });

  it("ignores line endings so a CRLF feature file decorates the same lines", () => {
    expect(tagKeyLines(FEATURE.replaceAll("\n", "\r\n"), XRAY_GRAMMAR)).toEqual([2]);
  });
});

describe("TagDecorationProvider", () => {
  it("decorates only the tag lines of a .feature document, whole-line", () => {
    const provider = new TagDecorationProvider(XRAY_GRAMMAR);
    const editor = fakeEditor("gherkin", "/ws/a.feature");
    provider.applyTo(editor as unknown as vscode.TextEditor);
    const applied = editor.decorations[0]!;
    expect(applied.ranges.map((r) => r.start.line)).toEqual([2]);
    expect(applied.ranges.every((r) => r.start.character === 0)).toBe(true);
    provider.dispose();
  });

  it("clears decorations on a non-feature document (gating by document type)", () => {
    const provider = new TagDecorationProvider(XRAY_GRAMMAR);
    const editor = fakeEditor("plaintext", "/ws/notes.txt");
    provider.applyTo(editor as unknown as vscode.TextEditor);
    expect(editor.decorations[0]!.ranges).toEqual([]);
    provider.dispose();
  });

  it("uses the contributed theme color so the wash adapts to the active theme", () => {
    expect(TAG_DECORATION_COLOR).toBe("specwright.traceabilityTagBackground");
  });
});
