import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ExtensionConfig } from "../../core/extension-config";
import { StepDiagnosticsProvider } from "../../providers/step-diagnostics-provider";
import { UnusedStepDiagnosticsProvider } from "../../providers/unused-step-diagnostics-provider";
import { StepResolver } from "../../providers/step-resolver";
import type { StepUsageIndex } from "../../providers/step-usage-index";
import { extractStepDefsFromSource } from "../../providers/step-definition-provider";
import { Logger } from "../../utils/logger";
import { fakeDoc } from "./helpers/command-manager-harness";

function document(text: string, fileName: string, languageId = "plaintext"): vscode.TextDocument {
  return { ...fakeDoc(text, fileName), fileName, languageId };
}
const feature = document("Feature: Checkout\n  Scenario: Pay\n    Given a basket\n    Then paid\n", "/shop/checkout.feature");
const steps = document("Given('a basket', async () => {});\n", "/shop/checkout.steps.ts");
const definitions = extractStepDefsFromSource(steps.getText()).map((def) => ({ ...def, filePath: steps.uri.fsPath }));

let resolver: StepResolver;
let collection: vscode.DiagnosticCollection;
let opened: vscode.EventEmitter<vscode.TextDocument>;
let changed: vscode.EventEmitter<vscode.TextDocumentChangeEvent>;
let closed: vscode.EventEmitter<vscode.TextDocument>;
let provider: StepDiagnosticsProvider | UnusedStepDiagnosticsProvider;

beforeEach(() => {
  vi.useFakeTimers();
  resolver = new StepResolver();
  vi.spyOn(resolver, "loadAllStepDefs").mockResolvedValue(definitions);
  vi.spyOn(resolver, "findStepFiles").mockResolvedValue([steps.uri.fsPath]);
  collection = vscode.languages.createDiagnosticCollection("test-steps");
  vi.spyOn(vscode.languages, "createDiagnosticCollection").mockReturnValue(collection);
  opened = new vscode.EventEmitter(); changed = new vscode.EventEmitter(); closed = new vscode.EventEmitter();
  vi.spyOn(vscode.workspace, "onDidOpenTextDocument").mockImplementation(opened.event);
  vi.spyOn(vscode.workspace, "onDidChangeTextDocument").mockImplementation(changed.event);
  vi.spyOn(vscode.workspace, "onDidCloseTextDocument").mockImplementation(closed.event);
  vi.spyOn(vscode.workspace, "textDocuments", "get").mockReturnValue([]);
});

afterEach(() => {
  provider?.dispose(); resolver.dispose();
  opened.dispose(); changed.dispose(); closed.dispose();
  vi.restoreAllMocks(); vi.useRealTimers();
});

function stepProvider(): StepDiagnosticsProvider {
  const result = new StepDiagnosticsProvider(resolver, ExtensionConfig.create(), Logger.create());
  provider = result;
  return result;
}

describe("step diagnostics editor lifecycle", () => {
  it("publishes unresolved and ambiguous metadata that survives VS Code diagnostic reconstruction", async () => {
    const diagnostics = stepProvider();
    vi.mocked(resolver.loadAllStepDefs).mockResolvedValue([...definitions, { ...definitions[0]!, filePath: "/other/steps.ts" }]);
    diagnostics.start();
    await diagnostics.refreshDocument(feature);
    const [ambiguous, unmatched] = collection.get(feature.uri)!;
    expect(ambiguous!.message).toContain("a basket");
    expect(unmatched!.message).toContain("paid");
    expect(diagnostics.getAmbiguousStepInfo(feature.uri, { ...ambiguous! })).toMatchObject({
      text: "a basket", matches: [{ filePath: "/other/steps.ts", line: 0 }, { filePath: "/shop/checkout.steps.ts", line: 0 }],
    });
    expect(diagnostics.getUnmatchedStepInfo(feature.uri, { ...unmatched!, code: { value: "unmatched-step", target: vscode.Uri.parse("https://example.test") } }))
      .toMatchObject({ text: "paid", effectiveKeyword: "Then", line: 3 });
    closed.fire(feature);
    expect(collection.get(feature.uri)).toBeUndefined();
    expect(diagnostics.getUnmatchedStepInfo(feature.uri, unmatched!)).toBeUndefined();
    expect(diagnostics.getAmbiguousStepInfo(feature.uri, ambiguous!)).toBeUndefined();
  });

  it("debounces changed features and cancels closed or disposed work", async () => {
    const diagnostics = stepProvider();
    diagnostics.start(); diagnostics.start();
    opened.fire(feature);
    await vi.waitFor(() => expect(collection.get(feature.uri)).toHaveLength(1));
    const fixed = document("Feature: Checkout\nScenario: Pay\nGiven a basket\n", feature.fileName, "feature");
    changed.fire({ document: feature } as vscode.TextDocumentChangeEvent);
    await vi.advanceTimersByTimeAsync(200);
    changed.fire({ document: fixed } as vscode.TextDocumentChangeEvent);
    await vi.advanceTimersByTimeAsync(299);
    expect(collection.get(feature.uri)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(collection.get(feature.uri)).toEqual([]);
    changed.fire({ document: feature } as vscode.TextDocumentChangeEvent);
    closed.fire(feature);
    await vi.runAllTimersAsync();
    expect(collection.get(feature.uri)).toBeUndefined();
    changed.fire({ document: feature } as vscode.TextDocumentChangeEvent);
    diagnostics.dispose(); diagnostics.start(); diagnostics.setStepGlobs([]);
    await diagnostics.refreshDocument(feature);
    await vi.runAllTimersAsync();
    expect(collection.get(feature.uri)).toBeUndefined();
  });

  it.each([new Error("scan failed"), "scan failed"])("retains previous diagnostics when definitions cannot be read: %s", async (error) => {
    const diagnostics = stepProvider(); diagnostics.start();
    await diagnostics.refreshDocument(feature);
    const previous = collection.get(feature.uri);
    vi.mocked(resolver.loadAllStepDefs).mockRejectedValue(error);
    await diagnostics.refreshDocument(feature);
    expect(collection.get(feature.uri)).toBe(previous);
  });

  it("ignores results arriving after disposal", async () => {
    const diagnostics = stepProvider(); diagnostics.start();
    let finish!: (value: typeof definitions) => void;
    vi.mocked(resolver.loadAllStepDefs).mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const pending = diagnostics.refreshDocument(feature);
    diagnostics.dispose(); finish(definitions); await pending;
    expect(collection.get(feature.uri)).toBeUndefined();
  });

  it("refreshes open feature documents after changing glob scope and ignores other files", async () => {
    const diagnostics = stepProvider();
    await diagnostics.refreshDocument(feature);
    expect(collection.get(feature.uri)).toBeUndefined();
    vi.spyOn(vscode.workspace, "textDocuments", "get").mockReturnValue([feature, steps]);
    diagnostics.start();
    diagnostics.setStepGlobs(["steps/*.ts", "support/*.ts"]);
    await vi.waitFor(() => expect(collection.get(feature.uri)).toHaveLength(1));
    expect(resolver.loadAllStepDefs).toHaveBeenLastCalledWith(["steps/*.ts", "support/*.ts"]);
    diagnostics.setStepGlobs([]);
    await diagnostics.refreshDocument(steps);
    changed.fire({ document: steps } as vscode.TextDocumentChangeEvent);
    expect(collection.get(steps.uri)).toBeUndefined();
  });
});

describe("unused step diagnostics failures and lifecycle", () => {
  function unusedProvider(count = vi.fn(async () => 0)): UnusedStepDiagnosticsProvider {
    const index = { countUsagesForDef: count, onDidChangeUsages: () => ({ dispose: () => {} }) } as unknown as StepUsageIndex;
    const result = new UnusedStepDiagnosticsProvider(resolver, index, ["steps/*.ts"], Logger.create());
    provider = result;
    return result;
  }

  it.each(["discovery", "usage"])("retains the previous unused warning on a %s failure", async (failure) => {
    const count = vi.fn(async () => 0);
    const diagnostics = unusedProvider(count); diagnostics.start();
    await diagnostics.refreshDocument(steps);
    const previous = collection.get(steps.uri);
    expect(previous?.[0]?.message).toContain("a basket");
    if (failure === "discovery") { vi.mocked(resolver.findStepFiles).mockRejectedValue(new Error("scan failed")); }
    else { count.mockRejectedValue(new Error("index failed")); }
    await diagnostics.refreshDocument(steps);
    expect(collection.get(steps.uri)).toBe(previous);
  });

  it.each(["discovery", "usage"])("does not publish an asynchronous %s result after disposal", async (stage) => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const count = vi.fn(async () => { if (stage === "usage") { await pending; } return 0; });
    if (stage === "discovery") { vi.mocked(resolver.findStepFiles).mockImplementation(async () => { await pending; return [steps.uri.fsPath]; }); }
    const diagnostics = unusedProvider(count); diagnostics.start();
    const refresh = diagnostics.refreshDocument(steps);
    if (stage === "usage") { await vi.waitFor(() => expect(count).toHaveBeenCalled()); }
    diagnostics.dispose(); release(); await refresh;
    expect(collection.get(steps.uri)).toBeUndefined();
  });

  it("refreshes after scope changes, debounces edits and cancels closed files", async () => {
    const count = vi.fn(async () => 0);
    const diagnostics = unusedProvider(count);
    await diagnostics.refreshDocument(steps);
    diagnostics.start(); diagnostics.start();
    opened.fire(steps);
    await vi.waitFor(() => expect(collection.get(steps.uri)).toHaveLength(1));
    vi.spyOn(vscode.workspace, "textDocuments", "get").mockReturnValue([steps]);
    diagnostics.setStepGlobs(["steps/*.ts", "shared/*.ts"]);
    count.mockResolvedValue(1);
    changed.fire({ document: steps } as vscode.TextDocumentChangeEvent);
    changed.fire({ document: steps } as vscode.TextDocumentChangeEvent);
    await vi.advanceTimersByTimeAsync(300);
    expect(collection.get(steps.uri)).toEqual([]);
    changed.fire({ document: steps } as vscode.TextDocumentChangeEvent);
    closed.fire(steps); closed.fire(steps);
    await vi.runAllTimersAsync();
    expect(collection.get(steps.uri)).toBeUndefined();
    diagnostics.setStepGlobs([]);
    diagnostics.dispose(); diagnostics.start(); diagnostics.setStepGlobs(["other/*.ts"]);
  });
});
