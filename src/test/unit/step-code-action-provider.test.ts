import { describe, it, expect } from "vitest";
import * as vscode from "vscode";
import { StepCodeActionProvider } from "../../providers/step-code-action-provider";
import {
  AmbiguousStepInfo,
  StepDiagnosticsProvider,
  UnmatchedStepInfo,
} from "../../providers/step-diagnostics-provider";
import { StepResolver } from "../../providers/step-resolver";
import type { ExtensionConfig } from "../../core/extension-config";
import type { Logger } from "../../utils/logger";

function makeDiagnostic(line: number, text: string, ours = true): vscode.Diagnostic {
  const range = new vscode.Range(line, 4, line, 4 + text.length);
  const d = new vscode.Diagnostic(range, `Step has no matching definition: ${text}`, 0);
  if (ours) {
    d.source = StepDiagnosticsProvider.DIAGNOSTIC_SOURCE;
    d.code = StepDiagnosticsProvider.DIAGNOSTIC_CODE;
  } else {
    d.source = "other-source";
    d.code = "other-code";
  }
  return d;
}

function makeAmbiguousDiagnostic(line: number, text: string): vscode.Diagnostic {
  const range = new vscode.Range(line, 4, line, 4 + text.length);
  const d = new vscode.Diagnostic(range, `Step matches multiple definitions: ${text}`, 1);
  d.source = StepDiagnosticsProvider.DIAGNOSTIC_SOURCE;
  d.code = StepDiagnosticsProvider.AMBIGUOUS_DIAGNOSTIC_CODE;
  return d;
}

class StubDiagnosticsProvider {
  private readonly map = new Map<vscode.Diagnostic, UnmatchedStepInfo>();
  private readonly ambigMap = new Map<vscode.Diagnostic, AmbiguousStepInfo>();
  public attach(d: vscode.Diagnostic, info: UnmatchedStepInfo): void {
    this.map.set(d, info);
  }
  public attachAmbiguous(d: vscode.Diagnostic, info: AmbiguousStepInfo): void {
    this.ambigMap.set(d, info);
  }
  public getUnmatchedStepInfo(_uri: vscode.Uri, d: vscode.Diagnostic): UnmatchedStepInfo | undefined {
    return this.map.get(d);
  }
  public getAmbiguousStepInfo(_uri: vscode.Uri, d: vscode.Diagnostic): AmbiguousStepInfo | undefined {
    return this.ambigMap.get(d);
  }
}

function makeContext(diagnostics: vscode.Diagnostic[]): vscode.CodeActionContext {
  return { diagnostics, triggerKind: 1, only: undefined } as unknown as vscode.CodeActionContext;
}

describe("StepCodeActionProvider", () => {
  it("returns no actions when no diagnostics match our source/code", () => {
    const stub = new StubDiagnosticsProvider();
    const provider = new StepCodeActionProvider(stub as unknown as StepDiagnosticsProvider);
    const doc = { uri: vscode.Uri.file("/tmp/x.feature") } as unknown as vscode.TextDocument;
    const range = new vscode.Range(0, 0, 0, 0);
    const ctx = makeContext([makeDiagnostic(2, "foo", false)]);
    const actions = provider.provideCodeActions(doc, range, ctx);
    expect(actions).toEqual([]);
  });

  it("emits one action per matching diagnostic with the correct command + args", () => {
    const stub = new StubDiagnosticsProvider();
    const provider = new StepCodeActionProvider(stub as unknown as StepDiagnosticsProvider);

    const d1 = makeDiagnostic(2, "I press button");
    const info1: UnmatchedStepInfo = { line: 2, keyword: "When", effectiveKeyword: "When", text: "I press button" };
    stub.attach(d1, info1);

    const d2 = makeDiagnostic(3, "I see result");
    const info2: UnmatchedStepInfo = { line: 3, keyword: "Then", effectiveKeyword: "Then", text: "I see result" };
    stub.attach(d2, info2);

    const dOther = makeDiagnostic(4, "noise", false);

    const doc = { uri: vscode.Uri.file("/tmp/feat.feature") } as unknown as vscode.TextDocument;
    const range = new vscode.Range(2, 0, 2, 0);
    const ctx = makeContext([d1, d2, dOther]);
    const actions = provider.provideCodeActions(doc, range, ctx);

    expect(actions).toHaveLength(2);
    expect(actions[0]!.title).toContain("I press button");
    expect(actions[0]!.command?.command).toBe("playwrightBddRunner.generateStepDefinitionForStep");
    expect(actions[0]!.command?.arguments?.[1]).toEqual(info1);
    expect(actions[1]!.command?.arguments?.[1]).toEqual(info2);
  });

  it("marks an action isPreferred when its diagnostic is the only one on the cursor line", () => {
    const stub = new StubDiagnosticsProvider();
    const provider = new StepCodeActionProvider(stub as unknown as StepDiagnosticsProvider);
    const d1 = makeDiagnostic(5, "x");
    const info1: UnmatchedStepInfo = { line: 5, keyword: "Given", effectiveKeyword: "Given", text: "x" };
    stub.attach(d1, info1);

    const doc = { uri: vscode.Uri.file("/tmp/feat.feature") } as unknown as vscode.TextDocument;
    const range = new vscode.Range(5, 0, 5, 0);
    const ctx = makeContext([d1]);
    const actions = provider.provideCodeActions(doc, range, ctx);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.isPreferred).toBe(true);
  });

  it("truncates long step text in the action title", () => {
    const stub = new StubDiagnosticsProvider();
    const provider = new StepCodeActionProvider(stub as unknown as StepDiagnosticsProvider);
    const longText = "x".repeat(120);
    const d1 = makeDiagnostic(0, longText);
    stub.attach(d1, { line: 0, keyword: "Given", effectiveKeyword: "Given", text: longText });

    const doc = { uri: vscode.Uri.file("/tmp/feat.feature") } as unknown as vscode.TextDocument;
    const range = new vscode.Range(0, 0, 0, 0);
    const ctx = makeContext([d1]);
    const actions = provider.provideCodeActions(doc, range, ctx);
    expect(actions[0]!.title.length).toBeLessThan(longText.length + 40);
    expect(actions[0]!.title).toMatch(/…$/);
  });

  it("emits one Go-to-definition action per match for an ambiguous diagnostic", () => {
    const stub = new StubDiagnosticsProvider();
    const provider = new StepCodeActionProvider(stub as unknown as StepDiagnosticsProvider);
    const diag = makeAmbiguousDiagnostic(2, "I have a thing");
    stub.attachAmbiguous(diag, {
      line: 2,
      text: "I have a thing",
      matches: [
        { filePath: "/ws/steps/a.ts", line: 5 },
        { filePath: "/ws/steps/b.ts", line: 9 },
        { filePath: "/ws/steps/c.ts", line: 1 },
      ],
    });

    const doc = { uri: vscode.Uri.file("/tmp/feat.feature") } as unknown as vscode.TextDocument;
    const range = new vscode.Range(2, 0, 2, 0);
    const ctx = makeContext([diag]);
    const actions = provider.provideCodeActions(doc, range, ctx);

    expect(actions).toHaveLength(3);
    expect(actions[0]!.title).toBe("Go to definition 1: /ws/steps/a.ts:6");
    expect(actions[1]!.title).toBe("Go to definition 2: /ws/steps/b.ts:10");
    expect(actions[2]!.title).toBe("Go to definition 3: /ws/steps/c.ts:2");

    for (const action of actions) {
      expect(action.command?.command).toBe("vscode.open");
      expect(action.diagnostics).toEqual([diag]);
    }

    const firstArgs = actions[0]!.command?.arguments;
    expect(firstArgs).toBeDefined();
    const firstUri = firstArgs![0] as { fsPath: string };
    expect(firstUri.fsPath).toBe("/ws/steps/a.ts");
    const firstOpts = firstArgs![1] as { selection: { start: { line: number; character: number } } };
    expect(firstOpts.selection.start.line).toBe(5);
    expect(firstOpts.selection.start.character).toBe(0);
  });

  it("emits only the Create action for an unmatched diagnostic, no Go-to-definition actions", () => {
    const stub = new StubDiagnosticsProvider();
    const provider = new StepCodeActionProvider(stub as unknown as StepDiagnosticsProvider);
    const d1 = makeDiagnostic(2, "I press button");
    stub.attach(d1, {
      line: 2,
      keyword: "When",
      effectiveKeyword: "When",
      text: "I press button",
    });

    const doc = { uri: vscode.Uri.file("/tmp/feat.feature") } as unknown as vscode.TextDocument;
    const range = new vscode.Range(2, 0, 2, 0);
    const ctx = makeContext([d1]);
    const actions = provider.provideCodeActions(doc, range, ctx);
    expect(actions).toHaveLength(1);
    expect(actions[0]!.title).toContain("Create step definition for");
    expect(actions[0]!.command?.command).toBe(
      "playwrightBddRunner.generateStepDefinitionForStep"
    );
  });

  it("still offers the quick fix for a reconstructed (value-equal) diagnostic", async () => {
    // VS Code does not hand back the Diagnostic instances we published — it
    // reconstructs equivalent ones for CodeActionContext.diagnostics.
    const resolver = new StepResolver();
    resolver.loadAllStepDefs = async () => [];
    const config = {
      stepDefinitionPaths: ["features/steps/**/*.ts"],
    } as unknown as ExtensionConfig;
    const stubLogger = {
      info: (): void => {},
      warn: (): void => {},
      error: (): void => {},
      debug: (): void => {},
    } as unknown as Logger;
    const diagnosticsProvider = new StepDiagnosticsProvider(resolver, config, stubLogger);
    diagnosticsProvider.start();

    const stepLine = "    Given I have a thing";
    const uri = vscode.Uri.file("/ws/a.feature");
    const doc = {
      uri,
      fileName: "/ws/a.feature",
      languageId: "gherkin",
      getText: () => ["Feature: A", "  Scenario: S", stepLine].join("\n"),
    } as unknown as vscode.TextDocument;
    await diagnosticsProvider.refreshDocument(doc);

    const clone = new vscode.Diagnostic(
      new vscode.Range(2, 4, 2, stepLine.length),
      "Step has no matching definition: I have a thing",
      vscode.DiagnosticSeverity.Error
    );
    clone.source = StepDiagnosticsProvider.DIAGNOSTIC_SOURCE;
    clone.code = StepDiagnosticsProvider.DIAGNOSTIC_CODE;

    expect(diagnosticsProvider.getUnmatchedStepInfo(uri, clone)).toEqual({
      line: 2,
      keyword: "Given",
      effectiveKeyword: "Given",
      text: "I have a thing",
    });

    const provider = new StepCodeActionProvider(diagnosticsProvider);
    const cursor = new vscode.Range(new vscode.Position(2, 0), new vscode.Position(2, 0));
    const actions = provider.provideCodeActions(doc, cursor, makeContext([clone]));
    expect(actions).toHaveLength(1);
    expect(actions[0]!.title).toContain("I have a thing");
    expect(actions[0]!.command?.command).toBe(
      "playwrightBddRunner.generateStepDefinitionForStep"
    );

    diagnosticsProvider.dispose();
  });
});
