import { describe, it, expect } from "vitest";
import * as vscode from "vscode";
import { StepUsageCodeLensProvider } from "../../providers/step-usage-codelens-provider";
import { ParsedStepDefWithFile } from "../../providers/step-resolver";
import { StepUsageIndex } from "../../providers/step-usage-index";

class FakeDocument {
  public readonly uri: { fsPath: string; scheme: string };
  private readonly text: string;

  constructor(text: string, fsPath: string) {
    this.text = text;
    this.uri = { fsPath, scheme: "file" };
  }

  public getText(): string {
    return this.text;
  }
}

interface FakeIndex {
  setCount(filePath: string, line: number, count: number): void;
  asIndex: StepUsageIndex;
}

function makeFakeIndex(): FakeIndex {
  const counts = new Map<string, number>();
  const subscribers: Array<() => void> = [];
  const asIndex = {
    countUsagesForDef: async (def: ParsedStepDefWithFile): Promise<number> => {
      return counts.get(`${def.filePath}:${def.line}`) ?? 0;
    },
    onDidChangeUsages: (cb: () => void): { dispose: () => void } => {
      subscribers.push(cb);
      return {
        dispose: () => {
          const i = subscribers.indexOf(cb);
          if (i > -1) {subscribers.splice(i, 1);}
        },
      };
    },
  } as unknown as StepUsageIndex;
  return {
    setCount: (filePath, line, count) => {
      counts.set(`${filePath}:${line}`, count);
    },
    asIndex,
  };
}

describe("StepUsageCodeLensProvider", () => {
  it("renders 'Unused' for a single def with zero usages", async () => {
    const filePath = "/ws/steps/a.ts";
    const source = `Given("I am never called", async () => {});`;
    const doc = new FakeDocument(source, filePath);
    const fake = makeFakeIndex();
    const provider = new StepUsageCodeLensProvider(fake.asIndex);

    const lenses = await provider.provideCodeLenses(doc as unknown as vscode.TextDocument);

    expect(lenses).toHaveLength(1);
    const cmd = lenses[0]!.command as { title: string; command: string };
    expect(cmd.title).toBe("Unused");
    provider.dispose();
  });

  it("renders 'Used 5 times' for five usages", async () => {
    const filePath = "/ws/steps/a.ts";
    const source = `Given("I have a thing", async () => {});`;
    const doc = new FakeDocument(source, filePath);
    const fake = makeFakeIndex();
    fake.setCount(filePath, 0, 5);
    const provider = new StepUsageCodeLensProvider(fake.asIndex);

    const lenses = await provider.provideCodeLenses(doc as unknown as vscode.TextDocument);

    expect(lenses).toHaveLength(1);
    const cmd = lenses[0]!.command as { title: string };
    expect(cmd.title).toBe("Used 5 times");
    provider.dispose();
  });

  it("renders 'Used 1 time' (singular) for exactly one usage", async () => {
    const filePath = "/ws/steps/a.ts";
    const source = `When("I do an action", async () => {});`;
    const doc = new FakeDocument(source, filePath);
    const fake = makeFakeIndex();
    fake.setCount(filePath, 0, 1);
    const provider = new StepUsageCodeLensProvider(fake.asIndex);

    const lenses = await provider.provideCodeLenses(doc as unknown as vscode.TextDocument);

    expect(lenses).toHaveLength(1);
    const cmd = lenses[0]!.command as { title: string };
    expect(cmd.title).toBe("Used 1 time");
    provider.dispose();
  });

  it("produces one lens per def in a multi-def file", async () => {
    const filePath = "/ws/steps/a.ts";
    const source = [
      `Given("I have a thing", async () => {});`,
      `When("I do an action", async () => {});`,
      `Then("I see a result", async () => {});`,
    ].join("\n");
    const doc = new FakeDocument(source, filePath);
    const fake = makeFakeIndex();
    fake.setCount(filePath, 0, 2);
    fake.setCount(filePath, 1, 1);
    fake.setCount(filePath, 2, 0);
    const provider = new StepUsageCodeLensProvider(fake.asIndex);

    const lenses = await provider.provideCodeLenses(doc as unknown as vscode.TextDocument);

    expect(lenses).toHaveLength(3);
    const titles = lenses.map((l) => (l.command as { title: string }).title);
    expect(titles).toEqual(["Used 2 times", "Used 1 time", "Unused"]);
    provider.dispose();
  });

  it("uses editor.action.findReferences with document.uri + Position at the def line", async () => {
    const filePath = "/ws/steps/a.ts";
    const source = [
      "",
      "",
      `Given("I have a thing", async () => {});`,
    ].join("\n");
    const doc = new FakeDocument(source, filePath);
    const fake = makeFakeIndex();
    fake.setCount(filePath, 2, 3);
    const provider = new StepUsageCodeLensProvider(fake.asIndex);

    const lenses = await provider.provideCodeLenses(doc as unknown as vscode.TextDocument);

    expect(lenses).toHaveLength(1);
    const lens = lenses[0]!;
    expect(lens.range.start.line).toBe(2);
    const cmd = lens.command as { command: string; arguments: unknown[] };
    expect(cmd.command).toBe("editor.action.findReferences");
    expect(cmd.arguments).toHaveLength(2);
    const uri = cmd.arguments[0] as { fsPath: string };
    expect(uri.fsPath).toBe(filePath);
    const position = cmd.arguments[1] as vscode.Position;
    expect(position.line).toBe(2);
    expect(position.character).toBe(0);
    provider.dispose();
  });

  it("returns no lenses when the file has no step defs", async () => {
    const filePath = "/ws/steps/a.ts";
    const source = `export const x = 1;`;
    const doc = new FakeDocument(source, filePath);
    const fake = makeFakeIndex();
    const provider = new StepUsageCodeLensProvider(fake.asIndex);

    const lenses = await provider.provideCodeLenses(doc as unknown as vscode.TextDocument);

    expect(lenses).toEqual([]);
    provider.dispose();
  });
});
