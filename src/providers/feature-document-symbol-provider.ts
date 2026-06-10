import * as vscode from "vscode";
import { computeSkipRanges } from "./feature-skip-ranges";
import { SCENARIO_BOUNDARY_RE } from "./scenario-boundary";
import { TAG_TOKEN_PATTERN } from "../parsers/tag-regex";

type BlockKind = "feature" | "rule" | "background" | "scenario" | "scenarioOutline" | "scenarioTemplate" | "example";

interface RawBlock {
  kind: BlockKind;
  name: string;
  tags: string[];
  startLine: number;
  endLine: number;
}

const KEYWORD_TABLE: ReadonlyArray<{ keyword: string; kind: BlockKind }> = [
  { keyword: "Feature:", kind: "feature" },
  { keyword: "Rule:", kind: "rule" },
  { keyword: "Background:", kind: "background" },
  { keyword: "Scenario Outline:", kind: "scenarioOutline" },
  { keyword: "Scenario Template:", kind: "scenarioTemplate" },
  { keyword: "Scenario:", kind: "scenario" },
  { keyword: "Example:", kind: "example" },
];

function kindToSymbol(kind: BlockKind): vscode.SymbolKind {
  if (kind === "feature") {return vscode.SymbolKind.Class;}
  if (kind === "rule") {return vscode.SymbolKind.Namespace;}
  if (kind === "background") {return vscode.SymbolKind.Constructor;}
  return vscode.SymbolKind.Method;
}

const DEFAULT_NAMES: Record<BlockKind, string> = {
  feature: "Feature",
  rule: "Rule",
  background: "Background",
  scenario: "Scenario",
  scenarioOutline: "Scenario Outline",
  scenarioTemplate: "Scenario Template",
  example: "Example",
};

function classify(trimmed: string): { kind: BlockKind; name: string } | undefined {
  for (const { keyword, kind } of KEYWORD_TABLE) {
    if (trimmed.startsWith(keyword)) {
      return { kind, name: trimmed.substring(keyword.length).trim() };
    }
  }
  return undefined;
}

function parseTags(trimmed: string): string[] {
  const tags: string[] = [];
  for (const m of trimmed.matchAll(new RegExp(TAG_TOKEN_PATTERN, "g"))) {
    tags.push(m[0]);
  }
  return tags;
}

function isSkippableLine(trimmed: string): boolean {
  return trimmed === "" || trimmed.startsWith("#");
}

export class FeatureDocumentSymbolProvider implements vscode.DocumentSymbolProvider {
  public provideDocumentSymbols(document: vscode.TextDocument): vscode.DocumentSymbol[] {
    return buildSymbols(document.getText());
  }
}

export function buildSymbols(text: string): vscode.DocumentSymbol[] {
  const lines = text.split("\n");
  const blocks = collectBlocks(lines, computeSkipRanges(text));
  computeEndLines(blocks, lines.length);
  return assembleSymbols(blocks);
}

function collectBlocks(lines: string[], skipLines: Set<number>): RawBlock[] {
  const blocks: RawBlock[] = [];
  let pendingTags: string[] = [];

  for (let i = 0; i < lines.length; i++) {
    // Lines inside docstrings (and other non-structural lines) must not
    // produce phantom symbols for keyword-looking text.
    if (skipLines.has(i)) {continue;}
    const rawLine = lines[i] ?? "";
    const trimmed = rawLine.trim();
    if (isSkippableLine(trimmed)) {continue;}

    if (trimmed.startsWith("@")) {
      pendingTags = pendingTags.concat(parseTags(trimmed));
      continue;
    }

    if (!SCENARIO_BOUNDARY_RE.test(rawLine)) {
      pendingTags = [];
      continue;
    }

    const c = classify(trimmed);
    if (!c) {
      pendingTags = [];
      continue;
    }
    blocks.push({
      kind: c.kind,
      name: c.name,
      tags: c.kind === "background" ? [] : pendingTags,
      startLine: i,
      endLine: i,
    });
    pendingTags = [];
  }

  return blocks;
}

function computeEndLines(blocks: RawBlock[], totalLines: number): void {
  const lastLine = Math.max(0, totalLines - 1);
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    if (!b) {continue;}
    if (b.kind === "feature") {
      b.endLine = lastLine;
      continue;
    }
    b.endLine = b.kind === "rule"
      ? findRuleEndLine(blocks, i, lastLine)
      : findChildEndLine(blocks, i, lastLine);
  }
}

function findRuleEndLine(blocks: RawBlock[], i: number, lastLine: number): number {
  const start = blocks[i]?.startLine ?? 0;
  for (let j = i + 1; j < blocks.length; j++) {
    const next = blocks[j];
    if (!next) {continue;}
    if (next.kind === "rule" || next.kind === "feature") {
      return Math.max(start, next.startLine - 1);
    }
  }
  return lastLine;
}

function findChildEndLine(blocks: RawBlock[], i: number, lastLine: number): number {
  const start = blocks[i]?.startLine ?? 0;
  const next = blocks[i + 1];
  if (!next) {return lastLine;}
  return Math.max(start, next.startLine - 1);
}

function assembleSymbols(blocks: RawBlock[]): vscode.DocumentSymbol[] {
  const featureBlock = blocks.find((b) => b.kind === "feature");
  if (!featureBlock) {return [];}

  const featureSymbol = makeSymbol(featureBlock);
  let currentRuleSymbol: vscode.DocumentSymbol | undefined;
  let currentRuleBlock: RawBlock | undefined;

  for (const block of blocks) {
    if (block === featureBlock) {continue;}
    const symbol = makeSymbol(block);
    if (block.kind === "rule") {
      currentRuleBlock = block;
      currentRuleSymbol = symbol;
      featureSymbol.children.push(symbol);
      continue;
    }
    const parent = pickParent(featureSymbol, currentRuleSymbol, currentRuleBlock, block);
    if (parent === featureSymbol) {
      currentRuleSymbol = undefined;
      currentRuleBlock = undefined;
    }
    parent.children.push(symbol);
  }

  return [featureSymbol];
}

function pickParent(
  featureSymbol: vscode.DocumentSymbol,
  currentRuleSymbol: vscode.DocumentSymbol | undefined,
  currentRuleBlock: RawBlock | undefined,
  block: RawBlock
): vscode.DocumentSymbol {
  if (currentRuleSymbol && currentRuleBlock && block.startLine <= currentRuleBlock.endLine) {
    return currentRuleSymbol;
  }
  return featureSymbol;
}

function makeSymbol(block: RawBlock): vscode.DocumentSymbol {
  const safeEnd = Math.max(block.endLine, block.startLine);
  const range = new vscode.Range(block.startLine, 0, safeEnd, 0);
  const selectionRange = new vscode.Range(block.startLine, 0, block.startLine, 0);
  const name = block.name.length > 0 ? block.name : DEFAULT_NAMES[block.kind];
  const detail = block.tags.length > 0 ? block.tags.join(" ") : "";
  return new vscode.DocumentSymbol(name, detail, kindToSymbol(block.kind), range, selectionRange);
}
