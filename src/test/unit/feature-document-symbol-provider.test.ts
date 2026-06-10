import { describe, it, expect } from "vitest";
import * as vscode from "vscode";
import {
  FeatureDocumentSymbolProvider,
  buildSymbols,
} from "../../providers/feature-document-symbol-provider";

const NL = "\n";
const lines = (...rows: string[]): string => rows.join(NL);

function fakeDocument(text: string): vscode.TextDocument {
  return { getText: () => text } as unknown as vscode.TextDocument;
}

describe("FeatureDocumentSymbolProvider — empty / malformed", () => {
  it("returns [] for empty content", () => {
    expect(buildSymbols("")).toEqual([]);
  });

  it("returns [] when there is no Feature: line", () => {
    const content = lines(
      "Scenario: orphan",
      "  Given I have 0 widgets"
    );
    expect(buildSymbols(content)).toEqual([]);
  });

  it("provideDocumentSymbols delegates to buildSymbols on document text", () => {
    const provider = new FeatureDocumentSymbolProvider();
    const result = provider.provideDocumentSymbols(fakeDocument(""));
    expect(result).toEqual([]);
  });
});

describe("FeatureDocumentSymbolProvider — simple feature", () => {
  it("returns one Feature root with two Scenario children", () => {
    const content = lines(
      "Feature: Plain",
      "",
      "  Scenario: First",
      "    Given I have 0 widgets",
      "",
      "  Scenario: Second",
      "    Given I have 1 widget"
    );
    const result = buildSymbols(content);
    expect(result).toHaveLength(1);
    const root = result[0]!;
    expect(root.name).toBe("Plain");
    expect(root.kind).toBe(vscode.SymbolKind.Class);
    expect(root.children).toHaveLength(2);
    expect(root.children[0]!.name).toBe("First");
    expect(root.children[0]!.kind).toBe(vscode.SymbolKind.Method);
    expect(root.children[1]!.name).toBe("Second");
    expect(root.children[1]!.kind).toBe(vscode.SymbolKind.Method);
  });
});

describe("FeatureDocumentSymbolProvider — Background + Scenarios", () => {
  it("returns Feature root with Background + 2 Scenario children", () => {
    const content = lines(
      "Feature: WithBg",
      "",
      "  Background:",
      "    Given I am logged in",
      "",
      "  Scenario: First",
      "    Given I have 0 widgets",
      "",
      "  Scenario: Second",
      "    Given I have 1 widget"
    );
    const root = buildSymbols(content)[0]!;
    expect(root.children).toHaveLength(3);
    expect(root.children[0]!.kind).toBe(vscode.SymbolKind.Constructor);
    expect(root.children[0]!.name).toBe("Background");
    expect(root.children[1]!.kind).toBe(vscode.SymbolKind.Method);
    expect(root.children[1]!.name).toBe("First");
    expect(root.children[2]!.kind).toBe(vscode.SymbolKind.Method);
    expect(root.children[2]!.name).toBe("Second");
  });
});

describe("FeatureDocumentSymbolProvider — Rule containing scenarios", () => {
  it("nests scenarios under their Rule", () => {
    const content = lines(
      "Feature: WithRule",
      "",
      "  Rule: My Rule",
      "",
      "    Scenario: First in rule",
      "      Given I have 0 widgets",
      "",
      "    Scenario: Second in rule",
      "      Given I have 1 widget"
    );
    const root = buildSymbols(content)[0]!;
    expect(root.children).toHaveLength(1);
    const rule = root.children[0]!;
    expect(rule.kind).toBe(vscode.SymbolKind.Namespace);
    expect(rule.name).toBe("My Rule");
    expect(rule.children).toHaveLength(2);
    expect(rule.children[0]!.name).toBe("First in rule");
    expect(rule.children[1]!.name).toBe("Second in rule");
  });

  it("places scenarios after the Rule block back under the Feature when a second Rule appears", () => {
    const content = lines(
      "Feature: TwoRules",
      "",
      "  Rule: A",
      "    Scenario: in-A",
      "      Given step",
      "",
      "  Rule: B",
      "    Scenario: in-B",
      "      Given step"
    );
    const root = buildSymbols(content)[0]!;
    expect(root.children).toHaveLength(2);
    const ruleA = root.children[0]!;
    const ruleB = root.children[1]!;
    expect(ruleA.name).toBe("A");
    expect(ruleB.name).toBe("B");
    expect(ruleA.children).toHaveLength(1);
    expect(ruleA.children[0]!.name).toBe("in-A");
    expect(ruleB.children).toHaveLength(1);
    expect(ruleB.children[0]!.name).toBe("in-B");
  });
});

describe("FeatureDocumentSymbolProvider — tags as detail", () => {
  it("emits tags as detail joined with a space", () => {
    const content = lines(
      "Feature: Tagged",
      "",
      "  @smoke @wip",
      "  Scenario: First",
      "    Given step"
    );
    const root = buildSymbols(content)[0]!;
    const scenario = root.children[0]!;
    expect(scenario.detail).toBe("@smoke @wip");
  });

  it("emits empty detail when scenario has no tags", () => {
    const content = lines(
      "Feature: Untagged",
      "",
      "  Scenario: First",
      "    Given step"
    );
    const root = buildSymbols(content)[0]!;
    expect(root.children[0]!.detail).toBe("");
  });
});

describe("FeatureDocumentSymbolProvider — mixed block kinds", () => {
  it("picks up Scenario, Scenario Outline, Example, Background with correct kinds", () => {
    const content = lines(
      "Feature: Mixed",
      "",
      "  Background:",
      "    Given I am logged in",
      "",
      "  Scenario: Plain",
      "    When I do A",
      "",
      "  Scenario Outline: Outline",
      "    When I do <thing>",
      "    Examples:",
      "      | thing |",
      "      | A     |",
      "",
      "  Example: Sample",
      "    When I do B"
    );
    const root = buildSymbols(content)[0]!;
    expect(root.name).toBe("Mixed");
    expect(root.kind).toBe(vscode.SymbolKind.Class);
    const kinds = root.children.map((c) => c.kind);
    const names = root.children.map((c) => c.name);
    expect(names).toContain("Background");
    expect(names).toContain("Plain");
    expect(names).toContain("Outline");
    expect(names).toContain("Sample");

    const bg = root.children.find((c) => c.name === "Background")!;
    expect(bg.kind).toBe(vscode.SymbolKind.Constructor);
    for (const c of root.children) {
      if (c === bg) {continue;}
      expect(c.kind).toBe(vscode.SymbolKind.Method);
    }
    expect(kinds).toHaveLength(4);
  });

  it("recognises Scenario Template as a Method symbol", () => {
    const content = lines(
      "Feature: Template",
      "",
      "  Scenario Template: My Template",
      "    Given step"
    );
    const root = buildSymbols(content)[0]!;
    expect(root.children).toHaveLength(1);
    expect(root.children[0]!.name).toBe("My Template");
    expect(root.children[0]!.kind).toBe(vscode.SymbolKind.Method);
  });
});

describe("FeatureDocumentSymbolProvider — ranges", () => {
  it("sets the Feature range to span the whole document and selectionRange to its keyword line", () => {
    const content = lines(
      "Feature: Spans",
      "",
      "  Scenario: One",
      "    Given step"
    );
    const root = buildSymbols(content)[0]!;
    expect(root.selectionRange.start.line).toBe(0);
    expect(root.selectionRange.end.line).toBe(0);
    expect(root.range.start.line).toBe(0);
    expect(root.range.end.line).toBe(3);
  });

  it("sets a scenario's range to end before the next scenario's keyword line", () => {
    const content = lines(
      "Feature: Spans",
      "",
      "  Scenario: One",
      "    Given step",
      "    And another step",
      "",
      "  Scenario: Two",
      "    Given step"
    );
    const root = buildSymbols(content)[0]!;
    const one = root.children[0]!;
    expect(one.selectionRange.start.line).toBe(2);
    expect(one.range.start.line).toBe(2);
    expect(one.range.end.line).toBe(5);
  });
});
