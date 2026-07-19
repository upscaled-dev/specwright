import * as vscode from "vscode";
import { KeyGrammar } from "./contracts";
import { extractKeys } from "./tag-extraction";
import { TAG_TOKEN_PATTERN } from "../parsers/tag-regex";

export interface TagDiagnostic {
  readonly line: number;
  readonly startCol: number;
  readonly endCol: number;
  readonly message: string;
}

interface TagRef {
  readonly key: string;
  readonly line: number;
  readonly startCol: number;
  readonly endCol: number;
}

interface ExecutableUnit {
  readonly id: number;
  readonly kind: "scenario" | "outline" | "examplesBlock";
  readonly ownTestTags: TagRef[];
}

const SCENARIO_KEYWORDS = ["Scenario Outline:", "Scenario Template:", "Scenario:", "Example:"] as const;

/** Equal or prefix-overlapping test/req prefixes make tag classification ambiguous — a config error. */
export function prefixesOverlap(grammar: KeyGrammar): boolean {
  const test = grammar.testPrefix.toLowerCase();
  const req = grammar.reqPrefix.toLowerCase();
  return test.startsWith(req) || req.startsWith(test);
}

function collectTestTags(lineText: string, lineIdx: number, grammar: KeyGrammar): TagRef[] {
  const tags: TagRef[] = [];
  for (const match of lineText.matchAll(new RegExp(TAG_TOKEN_PATTERN, "g"))) {
    const token = match[0];
    const key = extractKeys([token], grammar).testKeys[0];
    if (key !== undefined) {
      const startCol = match.index ?? 0;
      tags.push({ key, line: lineIdx, startCol, endCol: startCol + token.length });
    }
  }
  return tags;
}

// Feature-level test tags inherit to every scenario (mirrors the parser's `[...featureTags, ...]`
// merge); Rule-/Background-level tags do not (the parser drops them). Examples-block test tags split
// that block into its own executable unit per §2.
function scanUnits(text: string, grammar: KeyGrammar): { featureTestTags: TagRef[]; units: ExecutableUnit[] } {
  const lines = text.replaceAll("\r\n", "\n").split("\n");
  let pending: TagRef[] = [];
  let featureTestTags: TagRef[] = [];
  const units: ExecutableUnit[] = [];
  let nextId = 0;
  let inOutline = false;
  let docString: string | undefined;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i] ?? "";
    const trimmed = raw.trim();

    if (docString !== undefined) {
      if (trimmed.startsWith(docString)) {
        docString = undefined;
      }
      continue;
    }
    if (trimmed.startsWith(`"""`) || trimmed.startsWith("```")) {
      docString = trimmed.startsWith(`"""`) ? `"""` : "```";
      continue;
    }
    if (trimmed === "" || trimmed.startsWith("#")) {
      continue;
    }
    if (trimmed.startsWith("@")) {
      pending.push(...collectTestTags(raw, i, grammar));
      continue;
    }
    if (trimmed.startsWith("Feature:")) {
      featureTestTags = pending;
      pending = [];
      continue;
    }
    if (trimmed.startsWith("Rule:") || trimmed.startsWith("Background:")) {
      pending = [];
      inOutline = false;
      continue;
    }
    const scenarioKeyword = SCENARIO_KEYWORDS.find((k) => trimmed.startsWith(k));
    if (scenarioKeyword) {
      const isOutline = scenarioKeyword === "Scenario Outline:" || scenarioKeyword === "Scenario Template:";
      units.push({ id: nextId++, kind: isOutline ? "outline" : "scenario", ownTestTags: pending });
      pending = [];
      inOutline = isOutline;
      continue;
    }
    if (trimmed.startsWith("Examples:") && inOutline) {
      if (pending.length > 0) {
        units.push({ id: nextId++, kind: "examplesBlock", ownTestTags: pending });
      }
      pending = [];
      continue;
    }
  }

  return { featureTestTags, units };
}

function tooManyTagsMessage(kind: ExecutableUnit["kind"]): string {
  const noun = kind === "examplesBlock" ? "Examples block" : kind === "outline" ? "Scenario Outline" : "scenario";
  return `This ${noun} carries more than one test tag; a unit maps to exactly one test.`;
}

/**
 * Grammar-driven tag-linting for a single `.feature` document (§3.4). Nothing Xray-specific — the
 * active adapter's `keyGrammar` supplies prefixes and key shape. Prefix-overlap is a config-level
 * problem surfaced elsewhere, so this returns nothing when the prefixes overlap.
 */
export function computeTagDiagnostics(text: string, grammar: KeyGrammar): TagDiagnostic[] {
  if (prefixesOverlap(grammar)) {
    return [];
  }
  const { featureTestTags, units } = scanUnits(text, grammar);
  const diagnostics: TagDiagnostic[] = [];

  for (const unit of units) {
    if (unit.ownTestTags.length > 1) {
      for (const tag of unit.ownTestTags) {
        diagnostics.push({ ...toRange(tag), message: tooManyTagsMessage(unit.kind) });
      }
    }
  }

  // Rule 2 + Rule 5: the same test key reaching two or more independent units — whether by an own
  // tag on each or by a feature-level tag inherited across scenarios — is unsupported.
  const unitsForKey = new Map<string, Set<number>>();
  const addUnit = (key: string, unitId: number): void => {
    const set = unitsForKey.get(key) ?? new Set<number>();
    set.add(unitId);
    unitsForKey.set(key, set);
  };
  const featureKeys = new Set(featureTestTags.map((t) => t.key));
  for (const unit of units) {
    for (const tag of unit.ownTestTags) {
      addUnit(tag.key, unit.id);
    }
    for (const key of featureKeys) {
      addUnit(key, unit.id);
    }
  }

  for (const unit of units) {
    for (const tag of unit.ownTestTags) {
      if ((unitsForKey.get(tag.key)?.size ?? 0) > 1) {
        diagnostics.push({
          ...toRange(tag),
          message: `Test ${tag.key} is mapped on more than one scenario; no provider supports fanning one test across scenarios.`,
        });
      }
    }
  }
  for (const tag of featureTestTags) {
    if ((unitsForKey.get(tag.key)?.size ?? 0) > 1) {
      diagnostics.push({
        ...toRange(tag),
        message: `Feature-level test ${tag.key} is inherited by multiple scenarios; a test maps to exactly one scenario.`,
      });
    }
  }

  return diagnostics.sort((a, b) => a.line - b.line || a.startCol - b.startCol);
}

function toRange(tag: TagRef): { line: number; startCol: number; endCol: number } {
  return { line: tag.line, startCol: tag.startCol, endCol: tag.endCol };
}

function isFeatureDoc(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === "file" && (doc.languageId === "gherkin" || doc.fileName.endsWith(".feature"));
}

const DEBOUNCE_MS = 300;

export class TagDiagnosticsProvider implements vscode.Disposable {
  public static readonly DIAGNOSTIC_SOURCE = "Specwright";
  public static readonly DIAGNOSTIC_CODE = "traceability-tag";

  private readonly collection: vscode.DiagnosticCollection;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private disposed = false;

  constructor(private readonly grammar: KeyGrammar) {
    this.collection = vscode.languages.createDiagnosticCollection("specwright-traceability-tags");
  }

  public start(): void {
    if (this.disposed) {return;}
    if (prefixesOverlap(this.grammar)) {
      vscode.window.showWarningMessage(
        `Traceability tag prefixes overlap ("${this.grammar.testPrefix}" vs "${this.grammar.reqPrefix}"); tag classification is ambiguous until they differ.`
      );
    }
    this.disposables.push(
      vscode.workspace.onDidOpenTextDocument((doc) => this.refresh(doc)),
      vscode.workspace.onDidChangeTextDocument((e) => this.schedule(e.document)),
      vscode.workspace.onDidCloseTextDocument((doc) => this.clear(doc))
    );
    for (const doc of vscode.workspace.textDocuments) {
      this.refresh(doc);
    }
  }

  private schedule(doc: vscode.TextDocument): void {
    if (this.disposed || !isFeatureDoc(doc)) {return;}
    const key = doc.uri.toString();
    const existing = this.timers.get(key);
    if (existing) {clearTimeout(existing);}
    this.timers.set(
      key,
      setTimeout(() => {
        this.timers.delete(key);
        this.refresh(doc);
      }, DEBOUNCE_MS)
    );
  }

  private refresh(doc: vscode.TextDocument): void {
    if (this.disposed || !isFeatureDoc(doc)) {return;}
    const diagnostics = computeTagDiagnostics(doc.getText(), this.grammar).map((d) => {
      const diag = new vscode.Diagnostic(
        new vscode.Range(d.line, d.startCol, d.line, d.endCol),
        d.message,
        vscode.DiagnosticSeverity.Warning
      );
      diag.source = TagDiagnosticsProvider.DIAGNOSTIC_SOURCE;
      diag.code = TagDiagnosticsProvider.DIAGNOSTIC_CODE;
      return diag;
    });
    this.collection.set(doc.uri, diagnostics);
  }

  private clear(doc: vscode.TextDocument): void {
    const key = doc.uri.toString();
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }
    this.collection.delete(doc.uri);
  }

  public dispose(): void {
    this.disposed = true;
    for (const [, timer] of this.timers) {clearTimeout(timer);}
    this.timers.clear();
    for (const d of this.disposables) {
      try { d.dispose(); } catch { /* ignore */ }
    }
    this.disposables.length = 0;
    this.collection.dispose();
  }
}
