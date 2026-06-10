import { describe, it, expect } from "vitest";
import * as vscode from "vscode";
import { StepReferenceProvider } from "../../providers/step-reference-provider";
import { StepResolver, ParsedStepDefWithFile } from "../../providers/step-resolver";
import { StepUsageIndex } from "../../providers/step-usage-index";
import type { StepUsage } from "../../providers/step-usage-index";

class FakeDocument {
  public readonly uri: { fsPath: string; scheme: string };
  private readonly text: string;
  private readonly lines: string[];

  constructor(text: string, fsPath: string) {
    this.text = text;
    this.lines = text.split("\n");
    this.uri = { fsPath, scheme: "file" };
  }

  public lineAt(line: number): { text: string } {
    return { text: this.lines[line] ?? "" };
  }

  public getText(): string {
    return this.text;
  }
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
    regex: isRegex
      ? new RegExp(`^${pattern}$`)
      : new RegExp(`^${pattern.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`),
  };
}

function makeResolverWithDefs(defs: ParsedStepDefWithFile[]): StepResolver {
  const resolver = new StepResolver();
  resolver.loadAllStepDefs = async (): Promise<ParsedStepDefWithFile[]> => defs;
  return resolver;
}

function makeIndexStub(
  byKey: Map<string, StepUsage[]>
): StepUsageIndex {
  const idx = {
    getUsagesForDef: async (def: ParsedStepDefWithFile): Promise<StepUsage[]> => {
      return byKey.get(`${def.filePath}:${def.line}`) ?? [];
    },
  } as unknown as StepUsageIndex;
  return idx;
}

const emptyContext: vscode.ReferenceContext = {
  includeDeclaration: false,
};

describe("StepReferenceProvider", () => {
  it("returns undefined when the cursor is not on a step-def call line", async () => {
    const filePath = "/ws/steps/a.ts";
    const def = defOf("I have a thing", filePath, 0);
    const provider = new StepReferenceProvider(
      makeResolverWithDefs([def]),
      makeIndexStub(new Map()),
      ["features/steps/**/*.ts"]
    );
    const source = [
      `Given("I have a thing", async () => {});`,
      "// nothing here",
    ].join("\n");
    const doc = new FakeDocument(source, filePath);
    const result = await provider.provideReferences(
      doc as unknown as vscode.TextDocument,
      pos(1, 5),
      emptyContext
    );
    expect(result).toBeUndefined();
  });

  it("returns an empty array for a step def with zero usages", async () => {
    const filePath = "/ws/steps/a.ts";
    const def = defOf("I am never called", filePath, 0);
    const provider = new StepReferenceProvider(
      makeResolverWithDefs([def]),
      makeIndexStub(new Map()),
      ["features/steps/**/*.ts"]
    );
    const source = `Given("I am never called", async () => {});`;
    const doc = new FakeDocument(source, filePath);
    const result = await provider.provideReferences(
      doc as unknown as vscode.TextDocument,
      pos(0, 3),
      emptyContext
    );
    expect(result).toEqual([]);
  });

  it("returns locations for all feature-file usages of the step def", async () => {
    const filePath = "/ws/steps/a.ts";
    const def = defOf("I have a thing", filePath, 0);
    const usages: StepUsage[] = [
      { featurePath: "/ws/a.feature", line: 4, stepText: "I have a thing", keyword: "Given" },
      { featurePath: "/ws/b.feature", line: 7, stepText: "I have a thing", keyword: "Given" },
    ];
    const byKey = new Map<string, StepUsage[]>();
    byKey.set(`${filePath}:0`, usages);

    const provider = new StepReferenceProvider(
      makeResolverWithDefs([def]),
      makeIndexStub(byKey),
      ["features/steps/**/*.ts"]
    );
    const source = `Given("I have a thing", async () => {});`;
    const doc = new FakeDocument(source, filePath);
    const result = await provider.provideReferences(
      doc as unknown as vscode.TextDocument,
      pos(0, 3),
      emptyContext
    );
    expect(result).toBeDefined();
    expect(result).toHaveLength(2);
    const paths = result!.map((loc) => (loc.uri as { fsPath: string }).fsPath).sort();
    expect(paths).toEqual(["/ws/a.feature", "/ws/b.feature"]);
    expect(result![0]!.range.start.line).toBe(4);
    expect(result![1]!.range.start.line).toBe(7);
  });

  it("handles a When call on a multi-def source file", async () => {
    const filePath = "/ws/steps/a.ts";
    const givenDef = defOf("I have a thing", filePath, 0);
    const whenDef = defOf("I do an action", filePath, 1);
    const usages: StepUsage[] = [
      { featurePath: "/ws/a.feature", line: 3, stepText: "I do an action", keyword: "When" },
    ];
    const byKey = new Map<string, StepUsage[]>();
    byKey.set(`${filePath}:0`, [
      { featurePath: "/ws/a.feature", line: 2, stepText: "I have a thing", keyword: "Given" },
    ]);
    byKey.set(`${filePath}:1`, usages);

    const provider = new StepReferenceProvider(
      makeResolverWithDefs([givenDef, whenDef]),
      makeIndexStub(byKey),
      ["features/steps/**/*.ts"]
    );
    const source = [
      `Given("I have a thing", async () => {});`,
      `When("I do an action", async () => {});`,
    ].join("\n");
    const doc = new FakeDocument(source, filePath);
    const result = await provider.provideReferences(
      doc as unknown as vscode.TextDocument,
      pos(1, 3),
      emptyContext
    );
    expect(result).toBeDefined();
    expect(result).toHaveLength(1);
    expect((result![0]!.uri as { fsPath: string }).fsPath).toBe("/ws/a.feature");
    expect(result![0]!.range.start.line).toBe(3);
  });

  it("returns [] when the def is on a recognized line but resolver returns no matching def for this file", async () => {
    const filePath = "/ws/steps/a.ts";
    const provider = new StepReferenceProvider(
      makeResolverWithDefs([]),
      makeIndexStub(new Map()),
      ["features/steps/**/*.ts"]
    );
    const source = `Given("I have a thing", async () => {});`;
    const doc = new FakeDocument(source, filePath);
    const result = await provider.provideReferences(
      doc as unknown as vscode.TextDocument,
      pos(0, 3),
      emptyContext
    );
    expect(result).toEqual([]);
  });
});
