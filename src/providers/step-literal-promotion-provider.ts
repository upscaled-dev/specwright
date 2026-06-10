import * as vscode from "vscode";
import { Logger } from "../utils/logger";
import { StepResolver, ParsedStepDefWithFile, ParsedFeatureStep } from "./step-resolver";
import { extractFirstString } from "./step-definition-provider";
import { STEP_KEYWORDS } from "./step-keywords";
import {
  findLiteralCandidates,
  findLiteralInDefPattern,
  literalOccurrenceOrdinal,
  LiteralCandidate,
} from "./step-literal-promotion-helpers";

const STEP_LINE_RE = new RegExp(String.raw`^(\s*)(${STEP_KEYWORDS})\s+(.+?)\s*$`);
const STEP_CALL_RE = /(^|[^A-Za-z0-9_$.])(Given|When|Then|Step)\s*\(\s*([\s\S]*)$/;

export class StepLiteralPromotionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.RefactorRewrite];

  private readonly resolver: StepResolver;
  private readonly stepGlobs: string[];
  private readonly logger: Logger;

  constructor(resolver: StepResolver, stepGlobs: string[], logger?: Logger) {
    this.resolver = resolver;
    this.stepGlobs = stepGlobs;
    this.logger = logger ?? Logger.create();
  }

  public async provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection
  ): Promise<vscode.CodeAction[] | undefined> {
    const cursorLine = range.start.line;
    const featureText = document.getText();
    const step = findFeatureStep(this.resolver.parseFeatureSteps(featureText), cursorLine);
    if (!step) {return undefined;}

    const lineText = document.lineAt(cursorLine).text;
    const lineMatch = STEP_LINE_RE.exec(lineText);
    if (!lineMatch) {return undefined;}
    const stepTextStartCol = (lineMatch[1]?.length ?? 0) + (lineMatch[2]?.length ?? 0) + 1;

    const defs = await this.safeLoadDefs();
    if (!defs) {return undefined;}

    const matches = this.resolver.findStepMatches(step.text, defs);
    if (matches.length !== 1) {return undefined;}
    const match = matches[0];
    if (!match) {return undefined;}
    if (match.isRegex) {return undefined;}

    const candidates = filterCandidatesByCursor(
      findLiteralCandidates(step.text),
      range.start.character,
      stepTextStartCol
    );
    if (candidates.length === 0) {return undefined;}

    const defDoc = await this.safeOpenDef(match.filePath);
    if (!defDoc) {return undefined;}
    const defLineText = defDoc.lineAt(match.line).text;
    const defStringRange = findFirstStringRange(defLineText);
    if (!defStringRange) {return undefined;}

    const actions: vscode.CodeAction[] = [];
    for (const candidate of candidates) {
      // For string candidates the quotes are part of the literal: cucumber's
      // {string} consumes them, so the def edit must replace the quoted span.
      const ordinal = literalOccurrenceOrdinal(step.text, candidate.text, candidate.stepStart);
      const inPattern = findLiteralInDefPattern(match.pattern, candidate.text, ordinal);
      if (!inPattern) {continue;}

      const defLiteralStart = defStringRange.contentStart + inPattern.start;
      const defLiteralEnd = defStringRange.contentStart + inPattern.end;

      const action = buildAction({
        candidate,
        featureUri: document.uri,
        featureLine: cursorLine,
        featureStepTextStartCol: stepTextStartCol,
        defUri: defDoc.uri,
        defLine: match.line,
        defLiteralStart,
        defLiteralEnd,
      });
      actions.push(action);
    }
    return actions;
  }

  private async safeLoadDefs(): Promise<ParsedStepDefWithFile[] | undefined> {
    try {
      return await this.resolver.loadAllStepDefs(this.stepGlobs);
    } catch (error) {
      this.logger.warn("StepLiteralPromotionProvider: failed to load step defs", {
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }

  private async safeOpenDef(filePath: string): Promise<vscode.TextDocument | undefined> {
    try {
      return await vscode.workspace.openTextDocument(vscode.Uri.file(filePath));
    } catch (error) {
      this.logger.warn("StepLiteralPromotionProvider: failed to open def file", {
        filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}

function findFeatureStep(steps: ParsedFeatureStep[], line: number): ParsedFeatureStep | undefined {
  for (const s of steps) {
    if (s.line === line) {return s;}
  }
  return undefined;
}

function filterCandidatesByCursor(
  candidates: LiteralCandidate[],
  cursorChar: number,
  stepTextStartCol: number
): LiteralCandidate[] {
  if (cursorChar <= stepTextStartCol) {return candidates;}
  const relative = cursorChar - stepTextStartCol;
  const hit = candidates.find((c) => relative >= c.stepStart && relative <= c.stepEnd);
  return hit ? [hit] : candidates;
}

interface BuildActionArgs {
  candidate: LiteralCandidate;
  featureUri: vscode.Uri;
  featureLine: number;
  featureStepTextStartCol: number;
  defUri: vscode.Uri;
  defLine: number;
  defLiteralStart: number;
  defLiteralEnd: number;
}

function buildAction(args: BuildActionArgs): vscode.CodeAction {
  const { candidate } = args;
  const title = `Convert ${candidate.text} to ${candidate.placeholder} parameter`;
  const action = new vscode.CodeAction(title, vscode.CodeActionKind.RefactorRewrite);

  const featureStart = args.featureStepTextStartCol + candidate.stepStart;
  const featureEnd = args.featureStepTextStartCol + candidate.stepEnd;
  const featureRange = new vscode.Range(args.featureLine, featureStart, args.featureLine, featureEnd);
  const featureReplacement = featureReplacementText(candidate);

  const defRange = new vscode.Range(args.defLine, args.defLiteralStart, args.defLine, args.defLiteralEnd);

  const edit = new vscode.WorkspaceEdit();
  edit.replace(args.featureUri, featureRange, featureReplacement);
  edit.replace(args.defUri, defRange, candidate.placeholder);
  action.edit = edit;
  return action;
}

function featureReplacementText(candidate: LiteralCandidate): string {
  if (candidate.kind === "string") {
    const quote = candidate.text[0] ?? '"';
    return `${quote}${candidate.placeholder}${quote}`;
  }
  return candidate.placeholder;
}

interface StringRange {
  contentStart: number;
  contentEnd: number;
}

function findFirstStringRange(lineText: string): StringRange | undefined {
  const callMatch = STEP_CALL_RE.exec(lineText);
  if (!callMatch) {return undefined;}
  const restOffset = (callMatch.index ?? 0) + (callMatch[1]?.length ?? 0) + (callMatch[2]?.length ?? 0);
  const afterParen = lineText.indexOf("(", restOffset);
  if (afterParen === -1) {return undefined;}
  let i = afterParen + 1;
  while (i < lineText.length && /\s/.test(lineText[i] ?? "")) {i += 1;}
  const quote = lineText[i];
  if (quote !== "'" && quote !== '"' && quote !== "`") {return undefined;}
  const remainder = lineText.slice(i);
  const extracted = extractFirstString(remainder);
  if (extracted === undefined) {return undefined;}
  const contentStart = i + 1;
  return { contentStart, contentEnd: contentStart + extracted.length };
}
