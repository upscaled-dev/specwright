import { describe, it, expect } from "vitest";
import * as vscode from "vscode";
import { StepCompletionProvider } from "../../providers/step-completion-provider";
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

describe("StepCompletionProvider context detection", () => {
  const defs = [defOf("I have a thing", "/ws/features/steps/foo.ts", 5)];
  const provider = new StepCompletionProvider(
    ["features/steps/**/*.ts"],
    makeResolverWithDefs(defs)
  );

  it("returns undefined for blank lines", async () => {
    const doc = new FakeDocument("");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 0)
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined for tag lines", async () => {
    const doc = new FakeDocument("@smoke");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 6)
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined for comment lines", async () => {
    const doc = new FakeDocument("  # comment line");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 16)
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined for Scenario header lines", async () => {
    const doc = new FakeDocument("  Scenario: foo");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 15)
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined for table rows starting with |", async () => {
    const doc = new FakeDocument("    | a | b |");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 13)
    );
    expect(result).toBeUndefined();
  });

  it("returns completions when on a Given line with text", async () => {
    const doc = new FakeDocument("  Given I have");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 14)
    );
    expect(result).toBeDefined();
    expect(result!.length).toBe(1);
  });
});

describe("StepCompletionProvider keyword resolution", () => {
  const defs = [defOf("I have {int} users", "/ws/features/steps/foo.ts", 5)];

  it("uses concrete keyword for Given/When/Then", async () => {
    const provider = new StepCompletionProvider(
      ["features/steps/**/*.ts"],
      makeResolverWithDefs(defs)
    );
    const doc = new FakeDocument("  When I have");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 13)
    );
    expect(result![0]!.detail).toBe("Playwright-BDD · When");
  });

  it("resolves And to the previous concrete Given", async () => {
    const provider = new StepCompletionProvider(
      ["features/steps/**/*.ts"],
      makeResolverWithDefs(defs)
    );
    const text = [
      "Feature: F",
      "  Scenario: S",
      "    Given I am ready",
      "    And I have",
    ].join("\n");
    const doc = new FakeDocument(text);
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(3, 14)
    );
    expect(result).toBeDefined();
    expect(result![0]!.detail).toBe("Playwright-BDD · Given");
  });

  it("returns undefined for an orphan And with no prior concrete keyword", async () => {
    const provider = new StepCompletionProvider(
      ["features/steps/**/*.ts"],
      makeResolverWithDefs(defs)
    );
    const text = [
      "Feature: F",
      "  Scenario: S",
      "    And I have",
    ].join("\n");
    const doc = new FakeDocument(text);
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(2, 14)
    );
    expect(result).toBeUndefined();
  });

  it("resolves * to the previous concrete When", async () => {
    const provider = new StepCompletionProvider(
      ["features/steps/**/*.ts"],
      makeResolverWithDefs(defs)
    );
    const text = [
      "    When I click",
      "    * I have",
    ].join("\n");
    const doc = new FakeDocument(text);
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(1, 12)
    );
    expect(result![0]!.detail).toBe("Playwright-BDD · When");
  });
});

describe("StepCompletionProvider deduplication and shape", () => {
  it("dedupes step definitions with the same pattern", async () => {
    const defs = [
      defOf("I have a widget", "/ws/features/steps/a.ts", 3),
      defOf("I have a widget", "/ws/features/steps/b.ts", 9),
      defOf("I see a result", "/ws/features/steps/a.ts", 12),
    ];
    const provider = new StepCompletionProvider(
      ["features/steps/**/*.ts"],
      makeResolverWithDefs(defs)
    );
    const doc = new FakeDocument("  Given I have");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 14)
    );
    expect(result).toHaveLength(2);
  });

  it("sets detail prefix starting with Playwright-BDD", async () => {
    const defs = [defOf("I have a thing", "/ws/features/steps/a.ts", 1)];
    const provider = new StepCompletionProvider(
      ["features/steps/**/*.ts"],
      makeResolverWithDefs(defs)
    );
    const doc = new FakeDocument("  Then I have");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 13)
    );
    expect(result![0]!.detail!.startsWith("Playwright-BDD")).toBe(true);
  });

  it("never sets preselect", async () => {
    const defs = [defOf("I have a thing", "/ws/features/steps/a.ts", 1)];
    const provider = new StepCompletionProvider(
      ["features/steps/**/*.ts"],
      makeResolverWithDefs(defs)
    );
    const doc = new FakeDocument("  Given I have");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 14)
    );
    expect((result![0] as { preselect?: boolean }).preselect).toBeUndefined();
  });

  it("returns undefined when no defs are available", async () => {
    const provider = new StepCompletionProvider(
      ["features/steps/**/*.ts"],
      makeResolverWithDefs([])
    );
    const doc = new FakeDocument("  Given anything");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 16)
    );
    expect(result).toBeUndefined();
  });

  it("sets filterText equal to the visible label so VS Code default filtering applies", async () => {
    const defs = [defOf("I have a thing", "/ws/features/steps/a.ts", 1)];
    const provider = new StepCompletionProvider(
      ["features/steps/**/*.ts"],
      makeResolverWithDefs(defs)
    );
    const doc = new FakeDocument("  Given I have");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 14)
    );
    expect(result![0]!.filterText).toBe("I have a thing");
  });
});

describe("StepCompletionProvider snippet & humanization integration", () => {
  it("inserts a SnippetString with tab-stop placeholders for a Cucumber-expression def", async () => {
    const defs = [defOf("I have {int} users", "/ws/features/steps/a.ts", 1, false)];
    const provider = new StepCompletionProvider(
      ["features/steps/**/*.ts"],
      makeResolverWithDefs(defs)
    );
    const doc = new FakeDocument("  Given I have");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 14)
    );
    const insertText = result![0]!.insertText;
    expect(insertText).toBeInstanceOf(vscode.SnippetString);
    expect((insertText as vscode.SnippetString).value).toBe("I have ${1:int} users$0");
  });

  it("inserts a plain string (no SnippetString) when the pattern has no placeholders", async () => {
    const defs = [defOf("I am ready", "/ws/features/steps/a.ts", 1, false)];
    const provider = new StepCompletionProvider(
      ["features/steps/**/*.ts"],
      makeResolverWithDefs(defs)
    );
    const doc = new FakeDocument("  Given I am");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 12)
    );
    expect(result![0]!.insertText).toBe("I am ready");
  });

  it("humanizes a regex-only def into a {int} label visible in the completion item", async () => {
    const defs = [defOf(String.raw`^I have (\d+) users$`, "/ws/features/steps/a.ts", 1, true)];
    const provider = new StepCompletionProvider(
      ["features/steps/**/*.ts"],
      makeResolverWithDefs(defs)
    );
    const doc = new FakeDocument("  Given I have");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 14)
    );
    expect(result![0]!.label).toBe("I have {int} users");
    const insertText = result![0]!.insertText;
    expect(insertText).toBeInstanceOf(vscode.SnippetString);
    expect((insertText as vscode.SnippetString).value).toBe("I have ${1:int} users$0");
  });

  it("falls back to the raw regex source when humanization cannot strip all metachars", async () => {
    const defs = [defOf("^foo|bar$", "/ws/features/steps/a.ts", 1, true)];
    const provider = new StepCompletionProvider(
      ["features/steps/**/*.ts"],
      makeResolverWithDefs(defs)
    );
    const doc = new FakeDocument("  Given foo");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 11)
    );
    expect(result![0]!.label).toBe("^foo|bar$");
    // No humanization → insertText should be the literal raw label, not a snippet.
    expect(result![0]!.insertText).toBe("^foo|bar$");
  });
});

describe("StepCompletionProvider doc-string suppression", () => {
  it("returns undefined for a Given line inside a doc-string block", async () => {
    const defs = [defOf("I have a thing", "/ws/features/steps/a.ts", 1)];
    const provider = new StepCompletionProvider(
      ["features/steps/**/*.ts"],
      makeResolverWithDefs(defs)
    );
    const text = [
      "Feature: F",
      "  Scenario: S",
      "    Given some setup",
      `    """`,
      "    Given x",
      `    """`,
    ].join("\n");
    const doc = new FakeDocument(text);
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(4, 11)
    );
    expect(result).toBeUndefined();
  });
});

describe("StepCompletionProvider But keyword resolution", () => {
  it("resolves But to the previous concrete Then", async () => {
    const defs = [defOf("I have a thing", "/ws/features/steps/a.ts", 1)];
    const provider = new StepCompletionProvider(
      ["features/steps/**/*.ts"],
      makeResolverWithDefs(defs)
    );
    const text = [
      "Feature: F",
      "  Scenario: S",
      "    Then I see something",
      "    But I have",
    ].join("\n");
    const doc = new FakeDocument(text);
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(3, 14)
    );
    expect(result).toBeDefined();
    expect(result![0]!.detail).toBe("Playwright-BDD · Then");
  });

  it("returns undefined for an orphan But with no prior concrete keyword", async () => {
    const defs = [defOf("I have a thing", "/ws/features/steps/a.ts", 1)];
    const provider = new StepCompletionProvider(
      ["features/steps/**/*.ts"],
      makeResolverWithDefs(defs)
    );
    const text = [
      "Feature: F",
      "  Scenario: S",
      "    But I have",
    ].join("\n");
    const doc = new FakeDocument(text);
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(2, 14)
    );
    expect(result).toBeUndefined();
  });
});

describe("StepCompletionProvider scenario-boundary keyword resolution", () => {
  const defs = [defOf("I have a thing", "/ws/features/steps/a.ts", 1)];

  it("returns undefined for `And` at the top of a new Scenario, ignoring the prior scenario's keywords", async () => {
    const provider = new StepCompletionProvider(
      ["features/steps/**/*.ts"],
      makeResolverWithDefs(defs)
    );
    const text = [
      "Feature: F",
      "  Scenario: A",
      "    Given x",
      "    When y",
      "  Scenario: B",
      "    And I have",
    ].join("\n");
    const doc = new FakeDocument(text);
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(5, 14)
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined for `But` after a `Background:` header with no concrete keyword in the current scenario", async () => {
    const provider = new StepCompletionProvider(
      ["features/steps/**/*.ts"],
      makeResolverWithDefs(defs)
    );
    const text = [
      "Feature: F",
      "  Scenario: A",
      "    Then z",
      "  Background:",
      "    But I have",
    ].join("\n");
    const doc = new FakeDocument(text);
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(4, 14)
    );
    expect(result).toBeUndefined();
  });
});
