import * as vscode from "vscode";
import { KeyGrammar } from "./contracts";
import { extractKeys } from "./tag-extraction";
import { TAG_TOKEN_PATTERN } from "../parsers/tag-regex";

// Contributed in package.json with a faint, theme-aware teal default so the wash adapts to the
// active color theme rather than being a hardcoded literal.
export const TAG_DECORATION_COLOR = "specwright.traceabilityTagBackground";

interface DecoratableDocument {
  readonly uri: { readonly scheme: string };
  readonly languageId: string;
  readonly fileName: string;
  getText(): string;
}

function isFeatureDocument(doc: DecoratableDocument): boolean {
  return doc.uri.scheme === "file" && (doc.languageId === "gherkin" || doc.fileName.endsWith(".feature"));
}

/**
 * 0-based indices of every line carrying a `@TEST_`/`@REQ_` tag. Prefixes and key shape come from
 * the active adapter's grammar — nothing Xray-specific is hardcoded here. A tag line may hold several
 * tokens; one matching key decorates the whole line, so the wash never lands per-character.
 */
export function tagKeyLines(text: string, grammar: KeyGrammar): number[] {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  const out: number[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.trimStart().startsWith("@")) {
      continue;
    }
    const tokens = [...line.matchAll(new RegExp(TAG_TOKEN_PATTERN, "g"))].map((m) => m[0]);
    const { testKeys, reqKeys } = extractKeys(tokens, grammar);
    if (testKeys.length > 0 || reqKeys.length > 0) {
      out.push(i);
    }
  }
  return out;
}

const DEBOUNCE_MS = 300;

/**
 * Faint whole-line wash on `@TEST_`/`@REQ_` tag lines in `.feature` files (§12 View 1). Panel-gated
 * exactly like the tag-grammar diagnostics: the subsystem builds one per active adapter and disposes
 * it on teardown, so the grammar is always the live provider's. Provider-neutral — the prefixes ride
 * in through {@link tagKeyLines}, never a hardcoded regex.
 */
export class TagDecorationProvider implements vscode.Disposable {
  private readonly decorationType: vscode.TextEditorDecorationType;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(private readonly grammar: KeyGrammar) {
    this.decorationType = vscode.window.createTextEditorDecorationType({
      isWholeLine: true,
      backgroundColor: new vscode.ThemeColor(TAG_DECORATION_COLOR),
      overviewRulerColor: new vscode.ThemeColor(TAG_DECORATION_COLOR),
      overviewRulerLane: vscode.OverviewRulerLane.Left,
    });
  }

  public start(): void {
    if (this.disposed) {
      return;
    }
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.refreshAll()),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document))
    );
    this.refreshAll();
  }

  // Non-feature editors get an empty set so a decoration never lingers if a file's language flips.
  public applyTo(editor: vscode.TextEditor): void {
    const doc = editor.document;
    const lines = isFeatureDocument(doc) ? tagKeyLines(doc.getText(), this.grammar) : [];
    editor.setDecorations(
      this.decorationType,
      lines.map((line) => new vscode.Range(line, 0, line, 0))
    );
  }

  private refreshAll(): void {
    if (this.disposed) {
      return;
    }
    for (const editor of vscode.window.visibleTextEditors) {
      this.applyTo(editor);
    }
  }

  private schedule(doc: vscode.TextDocument): void {
    if (this.disposed || !isFeatureDocument(doc)) {
      return;
    }
    const key = doc.uri.toString();
    const existing = this.timers.get(key);
    if (existing) {
      clearTimeout(existing);
    }
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.refreshAll();
      }, DEBOUNCE_MS)
    );
  }

  public dispose(): void {
    this.disposed = true;
    for (const [, timer] of this.timers) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const d of this.disposables) {
      try { d.dispose(); } catch { /* ignore */ }
    }
    this.disposables.length = 0;
    this.decorationType.dispose();
  }
}
