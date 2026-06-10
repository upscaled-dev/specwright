import { describe, it, expect } from "vitest";
import * as vscode from "vscode";
import { TagCompletionProvider } from "../../providers/tag-completion-provider";
import type { TagIndex } from "../../providers/tag-index";

class FakeDocument {
  private readonly lines: string[];
  constructor(text: string) {
    this.lines = text.split("\n");
  }
  public lineAt(line: number): { text: string } {
    return { text: this.lines[line] ?? "" };
  }
}

function pos(line: number, char: number): vscode.Position {
  return new vscode.Position(line, char);
}

function makeIndex(tags: string[]): TagIndex {
  return {
    getAllTags: async (): Promise<string[]> => tags,
    dispose: (): void => {},
  } as unknown as TagIndex;
}

describe("TagCompletionProvider context detection", () => {
  const provider = new TagCompletionProvider(makeIndex(["@smoke", "@wip"]));

  it("returns undefined on a Scenario header line", async () => {
    const doc = new FakeDocument("Scenario: foo");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 13)
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined on a blank line", async () => {
    const doc = new FakeDocument("");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 0)
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined on a comment line", async () => {
    const doc = new FakeDocument("# comment");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 9)
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined on a Given step line", async () => {
    const doc = new FakeDocument("  Given I have a thing");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 22)
    );
    expect(result).toBeUndefined();
  });

  it("returns undefined for an inline @mention inside step text", async () => {
    const doc = new FakeDocument("Given user @mention");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 19)
    );
    expect(result).toBeUndefined();
  });
});

describe("TagCompletionProvider item shape", () => {
  it("builds items whose detail starts with Playwright-BDD", async () => {
    const provider = new TagCompletionProvider(makeIndex(["@smoke"]));
    const doc = new FakeDocument("@");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 1)
    );
    expect(result).toBeDefined();
    expect(result![0]!.detail!.startsWith("Playwright-BDD")).toBe(true);
  });

  it("never sets preselect", async () => {
    const provider = new TagCompletionProvider(makeIndex(["@smoke"]));
    const doc = new FakeDocument("@");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 1)
    );
    expect((result![0] as { preselect?: boolean }).preselect).toBeUndefined();
  });

  it("insertText is a plain string equal to the label", async () => {
    const provider = new TagCompletionProvider(makeIndex(["@smoke"]));
    const doc = new FakeDocument("@");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 1)
    );
    expect(typeof result![0]!.insertText).toBe("string");
    expect(result![0]!.insertText).toBe(result![0]!.label);
  });

  it("range covers the @-prefixed partial token so accepting replaces it", async () => {
    const provider = new TagCompletionProvider(makeIndex(["@smoke"]));
    const doc = new FakeDocument("  @sm");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 5)
    );
    const range = (result![0] as { range?: vscode.Range }).range;
    expect(range).toBeDefined();
    expect(range!.start.line).toBe(0);
    expect(range!.start.character).toBe(2);
    expect(range!.end.line).toBe(0);
    expect(range!.end.character).toBe(5);
  });

  it("returns [] when the tag index is empty", async () => {
    const provider = new TagCompletionProvider(makeIndex([]));
    const doc = new FakeDocument("@");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 1)
    );
    expect(result).toEqual([]);
  });

  it("sets filterText equal to the label", async () => {
    const provider = new TagCompletionProvider(makeIndex(["@smoke"]));
    const doc = new FakeDocument("@");
    const result = await provider.provideCompletionItems(
      doc as unknown as vscode.TextDocument,
      pos(0, 1)
    );
    expect(result![0]!.filterText).toBe("@smoke");
  });
});
