import * as vscode from "vscode";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TagDiagnosticsProvider } from "../../traceability/tag-diagnostics";
import { JIRA_KEY_SHAPE } from "../../xray/xray-adapter";
import { fakeDoc } from "./helpers/command-manager-harness";

const grammar = { testPrefix: "TEST_", reqPrefix: "REQ_", keyShape: JIRA_KEY_SHAPE,
  canonicalizeKey: (key: string) => key.toUpperCase() };
function document(tags: string, fileName = "/shop/checkout.feature", languageId = "gherkin"): vscode.TextDocument {
  return { ...fakeDoc(`Feature: Checkout\n${tags}\nScenario: Pay\n  Given a basket\n`, fileName), fileName, languageId };
}

let opened: vscode.EventEmitter<vscode.TextDocument>;
let changed: vscode.EventEmitter<vscode.TextDocumentChangeEvent>;
let closed: vscode.EventEmitter<vscode.TextDocument>;
let collection: vscode.DiagnosticCollection;
let provider: TagDiagnosticsProvider;

beforeEach(() => {
  vi.useFakeTimers();
  opened = new vscode.EventEmitter();
  changed = new vscode.EventEmitter();
  closed = new vscode.EventEmitter();
  vi.spyOn(vscode.workspace, "onDidOpenTextDocument").mockImplementation(opened.event);
  vi.spyOn(vscode.workspace, "onDidChangeTextDocument").mockImplementation(changed.event);
  vi.spyOn(vscode.workspace, "onDidCloseTextDocument").mockImplementation(closed.event);
  vi.spyOn(vscode.workspace, "textDocuments", "get").mockReturnValue([]);
  collection = vscode.languages.createDiagnosticCollection("test-tags");
  vi.spyOn(vscode.languages, "createDiagnosticCollection").mockReturnValue(collection);
  provider = new TagDiagnosticsProvider(grammar);
});

afterEach(() => {
  provider.dispose();
  opened.dispose(); changed.dispose(); closed.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("tag diagnostics document lifecycle", () => {
  it("publishes actionable warnings and suggestions for existing and newly opened features", () => {
    const existing = document("@TEST_SHOP-1 @TEST_SHOP-2");
    vi.spyOn(vscode.workspace, "textDocuments", "get").mockReturnValue([existing]);
    provider.start();
    expect(collection.get(existing.uri)).toEqual([
      expect.objectContaining({ severity: vscode.DiagnosticSeverity.Warning, source: "Specwright", code: "traceability-tag" }),
      expect.objectContaining({ severity: vscode.DiagnosticSeverity.Warning }),
    ]);
    const suggestion = document("@SHOP-3", "/shop/profile.feature", "plaintext");
    opened.fire(suggestion);
    expect(collection.get(suggestion.uri)).toEqual([
      expect.objectContaining({ severity: vscode.DiagnosticSeverity.Information,
        message: "Did you mean @TEST_SHOP-3? Tags link to tests only with the TEST_ prefix.",
        range: expect.objectContaining({ start: new vscode.Position(1, 0), end: new vscode.Position(1, 7) }),
      }),
    ]);
  });

  it("debounces edits and replaces obsolete warnings with the latest feature content", () => {
    provider.start();
    const invalid = document("@TEST_SHOP-1 @TEST_SHOP-2");
    opened.fire(invalid);
    changed.fire({ document: invalid } as vscode.TextDocumentChangeEvent);
    vi.advanceTimersByTime(200);
    changed.fire({ document: document("@TEST_SHOP-1") } as vscode.TextDocumentChangeEvent);
    vi.advanceTimersByTime(299);
    expect(collection.get(invalid.uri)).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(collection.get(invalid.uri)).toEqual([]);
  });

  it("clears closed documents and prevents pending edits from restoring diagnostics", () => {
    provider.start();
    const doc = document("@SHOP-3");
    opened.fire(doc);
    changed.fire({ document: doc } as vscode.TextDocumentChangeEvent);
    closed.fire(doc);
    vi.runAllTimers();
    expect(collection.get(doc.uri)).toBeUndefined();
    closed.fire(doc);
    expect(collection.get(doc.uri)).toBeUndefined();
  });

  it("ignores non-feature editors and virtual documents", () => {
    provider.start();
    const text = document("@SHOP-3", "/shop/readme.txt", "plaintext");
    const virtual = { ...document("@SHOP-3"), uri: vscode.Uri.parse("untitled:checkout.feature") };
    for (const doc of [text, virtual]) {
      opened.fire(doc);
      changed.fire({ document: doc } as vscode.TextDocumentChangeEvent);
      vi.runAllTimers();
      expect(collection.get(doc.uri)).toBeUndefined();
    }
  });

  it("cancels scheduled work and remains inactive after disposal", () => {
    provider.start();
    const doc = document("@SHOP-3");
    changed.fire({ document: doc } as vscode.TextDocumentChangeEvent);
    provider.dispose();
    provider.start();
    opened.fire(doc);
    changed.fire({ document: doc } as vscode.TextDocumentChangeEvent);
    vi.runAllTimers();
    expect(collection.get(doc.uri)).toBeUndefined();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("explains overlapping prefixes before publishing ambiguous classifications", () => {
    provider.dispose();
    provider = new TagDiagnosticsProvider({ ...grammar, reqPrefix: "TEST_" });
    const warning = vi.spyOn(vscode.window, "showWarningMessage");
    provider.start();
    const doc = document("@TEST_SHOP-1 @TEST_SHOP-2");
    opened.fire(doc);
    expect(warning).toHaveBeenCalledWith(expect.stringContaining("prefixes overlap"));
    expect(collection.get(doc.uri)).toEqual([]);
  });
});
