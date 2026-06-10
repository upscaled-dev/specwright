import * as vscode from "vscode";
import {
  AmbiguousStepInfo,
  StepDiagnosticsProvider,
  UnmatchedStepInfo,
} from "./step-diagnostics-provider";
import { toWorkspaceRelative } from "../utils/workspace-path";

const MAX_TITLE_LEN = 60;
const GENERATE_COMMAND = "playwrightBddRunner.generateStepDefinitionForStep";

export class StepCodeActionProvider implements vscode.CodeActionProvider {
  public static readonly providedCodeActionKinds = [vscode.CodeActionKind.QuickFix];

  private readonly diagnosticsProvider: StepDiagnosticsProvider;

  constructor(diagnosticsProvider: StepDiagnosticsProvider) {
    this.diagnosticsProvider = diagnosticsProvider;
  }

  public provideCodeActions(
    document: vscode.TextDocument,
    range: vscode.Range | vscode.Selection,
    context: vscode.CodeActionContext
  ): vscode.CodeAction[] {
    const ours = context.diagnostics.filter(isOurDiagnostic);
    if (ours.length === 0) {return [];}

    const cursorLine = range.start.line;
    const unmatchedOnCursorLineCount = ours.filter(
      (d) =>
        d.code === StepDiagnosticsProvider.DIAGNOSTIC_CODE &&
        d.range.start.line === cursorLine
    ).length;
    const isSingleUnmatchedOnCursor = unmatchedOnCursorLineCount === 1;

    const actions: vscode.CodeAction[] = [];
    for (const diagnostic of ours) {
      if (diagnostic.code === StepDiagnosticsProvider.DIAGNOSTIC_CODE) {
        const info = this.diagnosticsProvider.getUnmatchedStepInfo(document.uri, diagnostic);
        if (!info) {continue;}
        const preferred =
          isSingleUnmatchedOnCursor && diagnostic.range.start.line === cursorLine;
        actions.push(buildUnmatchedAction(document.uri, diagnostic, info, preferred));
        continue;
      }
      const ambig = this.diagnosticsProvider.getAmbiguousStepInfo(document.uri, diagnostic);
      if (!ambig) {continue;}
      for (const action of buildAmbiguousActions(diagnostic, ambig)) {
        actions.push(action);
      }
    }
    return actions;
  }
}

function isOurDiagnostic(d: vscode.Diagnostic): boolean {
  if (d.source !== StepDiagnosticsProvider.DIAGNOSTIC_SOURCE) {return false;}
  return (
    d.code === StepDiagnosticsProvider.DIAGNOSTIC_CODE ||
    d.code === StepDiagnosticsProvider.AMBIGUOUS_DIAGNOSTIC_CODE
  );
}

function buildUnmatchedAction(
  uri: vscode.Uri,
  diagnostic: vscode.Diagnostic,
  info: UnmatchedStepInfo,
  preferred: boolean
): vscode.CodeAction {
  const action = new vscode.CodeAction(
    `Create step definition for: ${truncate(info.text, MAX_TITLE_LEN)}`,
    vscode.CodeActionKind.QuickFix
  );
  action.diagnostics = [diagnostic];
  action.command = {
    command: GENERATE_COMMAND,
    title: action.title,
    arguments: [uri, info],
  };
  if (preferred) {action.isPreferred = true;}
  return action;
}

function buildAmbiguousActions(
  diagnostic: vscode.Diagnostic,
  info: AmbiguousStepInfo
): vscode.CodeAction[] {
  const actions: vscode.CodeAction[] = [];
  for (let i = 0; i < info.matches.length; i++) {
    const match = info.matches[i];
    if (!match) {continue;}
    const action = new vscode.CodeAction(
      `Go to definition ${i + 1}: ${toWorkspaceRelative(match.filePath)}:${match.line + 1}`,
      vscode.CodeActionKind.QuickFix
    );
    action.diagnostics = [diagnostic];
    action.command = {
      command: "vscode.open",
      title: "Go to definition",
      arguments: [
        vscode.Uri.file(match.filePath),
        { selection: new vscode.Range(match.line, 0, match.line, 0) },
      ],
    };
    actions.push(action);
  }
  return actions;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) {return text;}
  return `${text.slice(0, max - 1)}…`;
}

