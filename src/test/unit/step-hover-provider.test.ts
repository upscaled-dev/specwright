import { describe, it, expect } from "vitest";
import * as vscode from "vscode";
import { StepHoverProvider } from "../../providers/step-hover-provider";
import { StepResolver, ParsedStepDefWithFile } from "../../providers/step-resolver";

class FakeDocument {
  private readonly text: string;
  private readonly lines: string[];
  constructor(text: string) {
    this.text = text;
    this.lines = text.split("\n");
  }
  public lineAt(line: number): { text: string } {
    return { text: this.lines[line] ?? "" };
  }
  public getText(): string {
    return this.text;
  }
}

function makeResolverWithDefs(defs: ParsedStepDefWithFile[]): StepResolver {
  const resolver = new StepResolver();
  resolver.loadAllStepDefs = async (): Promise<ParsedStepDefWithFile[]> => defs;
  return resolver;
}

function pos(line: number, char: number): vscode.Position {
  return new vscode.Position(line, char);
}

function defOf(
  pattern: string,
  filePath: string,
  line: number,
  isRegex = false
): ParsedStepDefWithFile {
  return {
    pattern,
    filePath,
    line,
    isRegex,
    regex: isRegex ? new RegExp(`^${pattern}$`) : new RegExp(`^${pattern.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  };
}

describe("StepHoverProvider basic shape", () => {
  it("returns undefined for non-step lines (comment)", async () => {
    const defs = [defOf("I have a thing", "/ws/features/steps/a.ts", 5)];
    const provider = new StepHoverProvider(["features/steps/**/*.ts"], makeResolverWithDefs(defs));
    const doc = new FakeDocument("  # a comment");
    const result = await provider.provideHover(doc as unknown as vscode.TextDocument, pos(0, 5));
    expect(result).toBeUndefined();
  });

  it("returns undefined for Scenario header lines", async () => {
    const defs = [defOf("I have a thing", "/ws/features/steps/a.ts", 5)];
    const provider = new StepHoverProvider(["features/steps/**/*.ts"], makeResolverWithDefs(defs));
    const doc = new FakeDocument("  Scenario: foo");
    const result = await provider.provideHover(doc as unknown as vscode.TextDocument, pos(0, 5));
    expect(result).toBeUndefined();
  });

  it("returns undefined for blank lines", async () => {
    const defs = [defOf("I have a thing", "/ws/features/steps/a.ts", 5)];
    const provider = new StepHoverProvider(["features/steps/**/*.ts"], makeResolverWithDefs(defs));
    const doc = new FakeDocument("");
    const result = await provider.provideHover(doc as unknown as vscode.TextDocument, pos(0, 0));
    expect(result).toBeUndefined();
  });
});

describe("StepHoverProvider match resolution", () => {
  it("returns undefined when no step definition matches", async () => {
    const defs = [defOf("I see a result", "/ws/features/steps/a.ts", 2)];
    const provider = new StepHoverProvider(["features/steps/**/*.ts"], makeResolverWithDefs(defs));
    const text = [
      "Feature: F",
      "  Scenario: S",
      "    Given I have a thing",
    ].join("\n");
    const doc = new FakeDocument(text);
    const result = await provider.provideHover(doc as unknown as vscode.TextDocument, pos(2, 10));
    expect(result).toBeUndefined();
  });

  it("returns a hover with a single matching pattern and source location", async () => {
    const defs = [defOf("I have a thing", "/ws/features/steps/foo.ts", 5)];
    const provider = new StepHoverProvider(["features/steps/**/*.ts"], makeResolverWithDefs(defs));
    const text = [
      "Feature: F",
      "  Scenario: S",
      "    Given I have a thing",
    ].join("\n");
    const doc = new FakeDocument(text);
    const result = await provider.provideHover(doc as unknown as vscode.TextDocument, pos(2, 10));
    expect(result).toBeDefined();
    const md = result!.contents[0] as vscode.MarkdownString;
    expect(md.value).toContain("Playwright-BDD step");
    expect(md.value).toContain("1 match");
    expect(md.value).not.toContain("1 matches");
    expect(md.value).toContain("`I have a thing`");
    expect(md.value).toContain("/ws/features/steps/foo.ts:6");
    // Hover content interpolates raw step-file text, so it must stay untrusted.
    expect(md.isTrusted).toBe(false);
  });

  it("lists every match when more than one step definition matches", async () => {
    const defs = [
      defOf("I have a thing", "/ws/features/steps/a.ts", 5),
      defOf("I have a thing", "/ws/features/steps/b.ts", 9),
    ];
    const provider = new StepHoverProvider(["features/steps/**/*.ts"], makeResolverWithDefs(defs));
    const text = [
      "Feature: F",
      "  Scenario: S",
      "    Given I have a thing",
    ].join("\n");
    const doc = new FakeDocument(text);
    const result = await provider.provideHover(doc as unknown as vscode.TextDocument, pos(2, 10));
    expect(result).toBeDefined();
    const md = result!.contents[0] as vscode.MarkdownString;
    expect(md.value).toContain("2 matches");
    expect(md.value).toContain("/ws/features/steps/a.ts:6");
    expect(md.value).toContain("/ws/features/steps/b.ts:10");
  });
});

describe("StepHoverProvider keyword resolution", () => {
  it("returns a hover for `And` that resolves to a prior concrete keyword", async () => {
    const defs = [defOf("I have a thing", "/ws/features/steps/a.ts", 5)];
    const provider = new StepHoverProvider(["features/steps/**/*.ts"], makeResolverWithDefs(defs));
    const text = [
      "Feature: F",
      "  Scenario: S",
      "    Given I am ready",
      "    And I have a thing",
    ].join("\n");
    const doc = new FakeDocument(text);
    const result = await provider.provideHover(doc as unknown as vscode.TextDocument, pos(3, 10));
    expect(result).toBeDefined();
  });

  it("returns undefined for an orphan And with no prior concrete keyword", async () => {
    const defs = [defOf("I have a thing", "/ws/features/steps/a.ts", 5)];
    const provider = new StepHoverProvider(["features/steps/**/*.ts"], makeResolverWithDefs(defs));
    const text = [
      "Feature: F",
      "  Scenario: S",
      "    And I have a thing",
    ].join("\n");
    const doc = new FakeDocument(text);
    const result = await provider.provideHover(doc as unknown as vscode.TextDocument, pos(2, 10));
    expect(result).toBeUndefined();
  });

  it("returns undefined for an orphan But across a scenario boundary", async () => {
    const defs = [defOf("I have a thing", "/ws/features/steps/a.ts", 5)];
    const provider = new StepHoverProvider(["features/steps/**/*.ts"], makeResolverWithDefs(defs));
    const text = [
      "Feature: F",
      "  Scenario: A",
      "    Given x",
      "    When y",
      "  Scenario: B",
      "    But I have a thing",
    ].join("\n");
    const doc = new FakeDocument(text);
    const result = await provider.provideHover(doc as unknown as vscode.TextDocument, pos(5, 10));
    expect(result).toBeUndefined();
  });
});

describe("StepHoverProvider doc-string suppression", () => {
  it("returns undefined for a Given line inside a doc-string block", async () => {
    const defs = [defOf("I have a thing", "/ws/features/steps/a.ts", 1)];
    const provider = new StepHoverProvider(["features/steps/**/*.ts"], makeResolverWithDefs(defs));
    const text = [
      "Feature: F",
      "  Scenario: S",
      "    Given some setup",
      `    """`,
      "    Given I have a thing",
      `    """`,
    ].join("\n");
    const doc = new FakeDocument(text);
    const result = await provider.provideHover(doc as unknown as vscode.TextDocument, pos(4, 10));
    expect(result).toBeUndefined();
  });
});
