import { describe, it, expect } from "vitest";
import * as vscode from "vscode";
import { FeatureTableFormatter } from "../../providers/feature-table-formatter";

function fakeDocument(text: string): vscode.TextDocument {
  return { getText: () => text } as unknown as vscode.TextDocument;
}

describe("FeatureTableFormatter", () => {
  it("returns [] when there is nothing to format", () => {
    const provider = new FeatureTableFormatter();
    const text = [
      "Feature: x",
      "  Scenario: s",
      "    Given a step",
    ].join("\n");
    expect(provider.provideDocumentFormattingEdits(fakeDocument(text))).toEqual([]);
  });

  it("returns [] when every table block is already aligned", () => {
    const provider = new FeatureTableFormatter();
    const text = [
      "Feature: x",
      "  Scenario: s",
      "    Examples:",
      "      | a | b   |",
      "      | 1 | xxx |",
    ].join("\n");
    expect(provider.provideDocumentFormattingEdits(fakeDocument(text))).toEqual([]);
  });

  it("returns one edit per modified table block", () => {
    const provider = new FeatureTableFormatter();
    const text = [
      "Feature: x",
      "  Scenario: A",
      "    | a | bb |",
      "    | xx | y |",
      "",
      "  Scenario: B",
      "    | name | age |",
      "    | Bob | 22 |",
    ].join("\n");
    const edits = provider.provideDocumentFormattingEdits(fakeDocument(text));
    expect(edits).toHaveLength(2);
    expect(edits[0]!.newText).toBe(
      ["    | a  | bb |", "    | xx | y  |"].join("\n")
    );
    expect(edits[0]!.range.start.line).toBe(2);
    expect(edits[0]!.range.end.line).toBe(3);
    expect(edits[1]!.newText).toBe(
      ["    | name | age |", "    | Bob  |  22 |"].join("\n")
    );
    expect(edits[1]!.range.start.line).toBe(6);
    expect(edits[1]!.range.end.line).toBe(7);
  });

  it("does not touch table-looking lines inside a doc string", () => {
    const provider = new FeatureTableFormatter();
    const text = [
      "Feature: x",
      "  Scenario: s",
      "    Given a doc string:",
      `      """`,
      "      | not | a | table |",
      "      | x | y | z |",
      `      """`,
      "    When table:",
      "      | a | bb |",
      "      | xx | y |",
    ].join("\n");
    const edits = provider.provideDocumentFormattingEdits(fakeDocument(text));
    expect(edits).toHaveLength(1);
    expect(edits[0]!.range.start.line).toBe(8);
    expect(edits[0]!.range.end.line).toBe(9);
    expect(edits[0]!.newText).toBe(
      ["      | a  | bb |", "      | xx | y  |"].join("\n")
    );
  });

  it("preserves leading indentation of the block", () => {
    const provider = new FeatureTableFormatter();
    const text = [
      "Feature: x",
      "        | a | bb |",
      "        | xx | y |",
    ].join("\n");
    const edits = provider.provideDocumentFormattingEdits(fakeDocument(text));
    expect(edits).toHaveLength(1);
    expect(edits[0]!.newText.startsWith("        | a  | bb |")).toBe(true);
  });

  it("preserves CRLF line endings between block lines", () => {
    const provider = new FeatureTableFormatter();
    const text = ["| a | bb |", "| xx | y |"].join("\r\n");
    const edits = provider.provideDocumentFormattingEdits(fakeDocument(text));
    expect(edits).toHaveLength(1);
    expect(edits[0]!.newText).toBe(["| a  | bb |", "| xx | y  |"].join("\r\n"));
  });
});
