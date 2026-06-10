import { describe, it, expect, beforeEach } from "vitest";
import * as vscode from "vscode";
import { UnusedStepDiagnosticsProvider } from "../../providers/unused-step-diagnostics-provider";
import { StepResolver, ParsedStepDefWithFile } from "../../providers/step-resolver";
import { StepUsageIndex } from "../../providers/step-usage-index";
import type { Logger } from "../../utils/logger";

class FakeDocument {
  public readonly uri: { fsPath: string; scheme: string; toString: () => string };
  public readonly fileName: string;
  private readonly text: string;

  constructor(text: string, fsPath: string) {
    this.text = text;
    this.fileName = fsPath;
    this.uri = { fsPath, scheme: "file", toString: () => `file://${fsPath}` };
  }

  public getText(): string {
    return this.text;
  }

  public lineAt(line: number): { text: string } {
    const lines = this.text.split("\n");
    return { text: lines[line] ?? "" };
  }
}

interface FakeIndexHandle {
  setCount(filePath: string, line: number, count: number): void;
  fireChange(): void;
  asIndex: StepUsageIndex;
}

function makeFakeIndex(): FakeIndexHandle {
  const counts = new Map<string, number>();
  const subscribers: Array<() => void> = [];
  const asIndex = {
    countUsagesForDef: async (def: ParsedStepDefWithFile): Promise<number> =>
      counts.get(`${def.filePath}:${def.line}`) ?? 0,
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
    fireChange: () => {
      for (const cb of [...subscribers]) {cb();}
    },
    asIndex,
  };
}

function makeFakeResolver(stepFiles: string[]): StepResolver {
  return {
    findStepFiles: async (_globs: string[]): Promise<string[]> => stepFiles,
  } as unknown as StepResolver;
}

const stubLogger = {
  info: (): void => {},
  warn: (): void => {},
  error: (): void => {},
  debug: (): void => {},
} as unknown as Logger;

interface CollectionProbe {
  getDiagnostics(uri: { toString: () => string }): vscode.Diagnostic[];
}

function probeCollection(provider: UnusedStepDiagnosticsProvider): CollectionProbe {
  const internals = provider as unknown as {
    collection: {
      get: (uri: { toString: () => string }) => vscode.Diagnostic[] | undefined;
    } | undefined;
  };
  return {
    getDiagnostics: (uri) => internals.collection?.get(uri) ?? [],
  };
}

describe("UnusedStepDiagnosticsProvider", () => {
  beforeEach(() => {
    (vscode.languages as unknown as { __resetCounters: () => void }).__resetCounters();
  });

  it("emits an Information diagnostic for a def with zero usages", async () => {
    const filePath = "/ws/steps/a.ts";
    const source = `Given("I am never called", async () => {});`;
    const doc = new FakeDocument(source, filePath);
    const fake = makeFakeIndex();
    const resolver = makeFakeResolver([filePath]);
    const provider = new UnusedStepDiagnosticsProvider(resolver, fake.asIndex, [filePath], stubLogger);
    provider.start();

    await provider.refreshDocument(doc as unknown as vscode.TextDocument);

    const diags = probeCollection(provider).getDiagnostics(doc.uri);
    expect(diags).toHaveLength(1);
    const d = diags[0]!;
    expect(d.severity).toBe(vscode.DiagnosticSeverity.Information);
    expect(d.code).toBe(UnusedStepDiagnosticsProvider.DIAGNOSTIC_CODE);
    expect(d.source).toBe(UnusedStepDiagnosticsProvider.DIAGNOSTIC_SOURCE);
    expect(d.message).toBe("Step definition is never used: `I am never called`");
    expect(d.range.start.line).toBe(0);
    expect(d.range.start.character).toBe(0);
    expect(d.range.end.line).toBe(0);
    expect(d.range.end.character).toBe(source.length);

    provider.dispose();
  });

  it("emits no diagnostic for a def with at least one usage", async () => {
    const filePath = "/ws/steps/a.ts";
    const source = `Given("I have a thing", async () => {});`;
    const doc = new FakeDocument(source, filePath);
    const fake = makeFakeIndex();
    fake.setCount(filePath, 0, 3);
    const resolver = makeFakeResolver([filePath]);
    const provider = new UnusedStepDiagnosticsProvider(resolver, fake.asIndex, [filePath], stubLogger);
    provider.start();

    await provider.refreshDocument(doc as unknown as vscode.TextDocument);

    const diags = probeCollection(provider).getDiagnostics(doc.uri);
    expect(diags).toEqual([]);

    provider.dispose();
  });

  it("only flags the unused defs in a multi-def file", async () => {
    const filePath = "/ws/steps/a.ts";
    const source = [
      `Given("I have a thing", async () => {});`,
      `When("I do an action", async () => {});`,
      `Then("I see a result", async () => {});`,
    ].join("\n");
    const doc = new FakeDocument(source, filePath);
    const fake = makeFakeIndex();
    fake.setCount(filePath, 0, 2);
    fake.setCount(filePath, 1, 0);
    fake.setCount(filePath, 2, 5);
    const resolver = makeFakeResolver([filePath]);
    const provider = new UnusedStepDiagnosticsProvider(resolver, fake.asIndex, [filePath], stubLogger);
    provider.start();

    await provider.refreshDocument(doc as unknown as vscode.TextDocument);

    const diags = probeCollection(provider).getDiagnostics(doc.uri);
    expect(diags).toHaveLength(1);
    expect(diags[0]!.range.start.line).toBe(1);
    expect(diags[0]!.message).toBe("Step definition is never used: `I do an action`");

    provider.dispose();
  });

  it("refreshes when the usage index fires onDidChangeUsages", async () => {
    const filePath = "/ws/steps/a.ts";
    const source = `Given("I have a thing", async () => {});`;
    const doc = new FakeDocument(source, filePath);
    const fake = makeFakeIndex();
    fake.setCount(filePath, 0, 0);
    const resolver = makeFakeResolver([filePath]);
    const provider = new UnusedStepDiagnosticsProvider(resolver, fake.asIndex, [filePath], stubLogger);

    (vscode.workspace as unknown as { textDocuments: ReadonlyArray<unknown> }).textDocuments = [doc];
    provider.start();
    await provider.refreshDocument(doc as unknown as vscode.TextDocument);
    expect(probeCollection(provider).getDiagnostics(doc.uri)).toHaveLength(1);

    fake.setCount(filePath, 0, 4);
    fake.fireChange();
    await new Promise((r) => setTimeout(r, 350));

    expect(probeCollection(provider).getDiagnostics(doc.uri)).toHaveLength(0);

    (vscode.workspace as unknown as { textDocuments: ReadonlyArray<unknown> }).textDocuments = [];
    provider.dispose();
  });

  it("emits no diagnostics for a doc whose path is not in the resolved step files", async () => {
    const filePath = "/ws/elsewhere/notSteps.ts";
    const source = `Given("I am never called", async () => {});`;
    const doc = new FakeDocument(source, filePath);
    const fake = makeFakeIndex();
    const resolver = makeFakeResolver(["/ws/steps/a.ts"]);
    const provider = new UnusedStepDiagnosticsProvider(resolver, fake.asIndex, ["features/steps/**/*.ts"], stubLogger);
    provider.start();

    await provider.refreshDocument(doc as unknown as vscode.TextDocument);

    const diags = probeCollection(provider).getDiagnostics(doc.uri);
    expect(diags).toEqual([]);

    provider.dispose();
  });

  it("emits no diagnostics for a non-step-def file extension", async () => {
    const filePath = "/ws/steps/a.feature";
    const source = `Given("I am never called", async () => {});`;
    const doc = new FakeDocument(source, filePath);
    const fake = makeFakeIndex();
    const resolver = makeFakeResolver([filePath]);
    const provider = new UnusedStepDiagnosticsProvider(resolver, fake.asIndex, [filePath], stubLogger);
    provider.start();

    await provider.refreshDocument(doc as unknown as vscode.TextDocument);

    const diags = probeCollection(provider).getDiagnostics(doc.uri);
    expect(diags).toEqual([]);

    provider.dispose();
  });
});
