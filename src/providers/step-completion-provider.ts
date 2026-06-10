import * as vscode from "vscode";
import { Logger } from "../utils/logger";
import { StepResolver, ParsedStepDefWithFile } from "./step-resolver";
import { humanizeRegexSource, patternToSnippet } from "./pattern-humanizer";
import { STEP_KEYWORDS } from "./step-keywords";
import { computeSkipRanges } from "./feature-skip-ranges";
import { SCENARIO_BOUNDARY_RE } from "./scenario-boundary";
import { toWorkspaceRelative } from "../utils/workspace-path";

const STEP_LINE_RE = new RegExp(String.raw`^(\s*)(${STEP_KEYWORDS})\s+(.*)$`);
const CONCRETE_STEP_LINE_RE = /^\s*(Given|When|Then)\s+/;

type ConcreteKeyword = "Given" | "When" | "Then";

interface DedupedDef {
  pattern: string;
  isRegex: boolean;
  filePaths: string[];
  lines: number[];
}

export class StepCompletionProvider implements vscode.CompletionItemProvider {
  private readonly stepGlobs: string[];
  private readonly resolver: StepResolver;
  private readonly logger: Logger;

  constructor(stepGlobs: string[], resolver: StepResolver, logger?: Logger) {
    this.stepGlobs = stepGlobs;
    this.resolver = resolver;
    this.logger = logger ?? Logger.create();
  }

  public async provideCompletionItems(
    document: vscode.TextDocument,
    position: vscode.Position
  ): Promise<vscode.CompletionItem[] | undefined> {
    const lineUpToCursor = document.lineAt(position.line).text.slice(0, position.character);
    const match = STEP_LINE_RE.exec(lineUpToCursor);
    if (!match) {return undefined;}

    const skipRanges = computeSkipRanges(document.getText());
    if (skipRanges.has(position.line)) {return undefined;}

    const keyword = match[2] as "Given" | "When" | "Then" | "And" | "But" | "*";
    const effectiveKeyword = this.resolveEffectiveKeyword(document, position.line, keyword);
    if (!effectiveKeyword) {return undefined;}

    const defs = await this.safeLoadDefs();
    if (!defs) {return undefined;}

    const deduped = dedupeByPattern(defs);
    if (deduped.size === 0) {return undefined;}

    const items: vscode.CompletionItem[] = [];
    for (const entry of deduped.values()) {
      items.push(buildCompletionItem(entry, effectiveKeyword));
    }
    return items;
  }

  private async safeLoadDefs(): Promise<Awaited<ReturnType<StepResolver["loadAllStepDefs"]>> | undefined> {
    try {
      return await this.resolver.loadAllStepDefs(this.stepGlobs);
    } catch (error) {
      this.logger.warn("StepCompletionProvider: failed to load step defs", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private resolveEffectiveKeyword(
    document: vscode.TextDocument,
    line: number,
    keyword: "Given" | "When" | "Then" | "And" | "But" | "*"
  ): ConcreteKeyword | undefined {
    if (keyword === "Given" || keyword === "When" || keyword === "Then") {
      return keyword;
    }
    for (let i = line - 1; i >= 0; i--) {
      const text = document.lineAt(i).text;
      if (SCENARIO_BOUNDARY_RE.test(text)) {return undefined;}
      const m = CONCRETE_STEP_LINE_RE.exec(text);
      if (m) {return m[1] as ConcreteKeyword;}
    }
    return undefined;
  }
}

function dedupeByPattern(defs: ParsedStepDefWithFile[]): Map<string, DedupedDef> {
  const deduped = new Map<string, DedupedDef>();
  for (const def of defs) {
    const existing = deduped.get(def.pattern);
    if (existing) {
      if (!existing.filePaths.includes(def.filePath)) {
        existing.filePaths.push(def.filePath);
        existing.lines.push(def.line);
      }
      continue;
    }
    deduped.set(def.pattern, {
      pattern: def.pattern,
      isRegex: def.isRegex,
      filePaths: [def.filePath],
      lines: [def.line],
    });
  }
  return deduped;
}

function buildCompletionItem(entry: DedupedDef, effectiveKeyword: ConcreteKeyword): vscode.CompletionItem {
  const { label, humanized } = humanizeRegexSource(entry.pattern, entry.isRegex);
  const item = new vscode.CompletionItem(label, vscode.CompletionItemKind.Snippet);
  const snippet = patternToSnippet(label);
  // `humanized` here means "label is safe to wrap as a snippet" (no leftover regex metachars), not merely "we tried to humanize".
  if (humanized && snippet !== label) {
    item.insertText = new vscode.SnippetString(snippet);
  } else {
    item.insertText = label;
  }
  item.detail = `Playwright-BDD · ${effectiveKeyword}`;
  item.documentation = buildDocumentation(entry);
  item.filterText = label;
  return item;
}

function buildDocumentation(entry: DedupedDef): vscode.MarkdownString {
  const md = new vscode.MarkdownString();
  for (let i = 0; i < entry.filePaths.length; i++) {
    const file = entry.filePaths[i] ?? "";
    const lineNo = (entry.lines[i] ?? 0) + 1;
    md.appendMarkdown(`\`${toWorkspaceRelative(file)}:${lineNo}\`\n\n`);
  }
  return md;
}

