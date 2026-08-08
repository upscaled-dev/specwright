import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { isOutlineExampleRow } from "../parsers/feature-parser";
import { scenarioScope } from "../parsers/gherkin-slice";
import type { OutlineExampleRow, ParsedFeature, PlaywrightBddExtensionContext } from "../types";
import { toWorkspaceRelative } from "../utils/workspace-path";
import { ExecutionDiagnosticError, requireExecutionAvailable } from "../core/run-contracts";

interface FeatureTarget {
  filePath: string;
  text?: string;
  cursorLine?: number;
}

interface ParsedFeatureTarget extends FeatureTarget {
  text: string;
  parsed: ParsedFeature;
}

// An outline header names the whole outline and carries no line: a declaration line has no generated
// spec line to target, so the runner greps the outline title and runs every row.
interface PaletteScenarioTarget {
  filePath: string;
  lineNumber?: number | undefined;
  scenarioName: string;
  outlineName?: string | undefined;
}

interface ScenarioScope {
  start: number;
  end: number;
  target: PaletteScenarioTarget;
  rows: OutlineExampleRow[];
}

function activeFeatureEditor(): vscode.TextEditor | undefined {
  const editor = vscode.window.activeTextEditor;
  return editor?.document.uri.fsPath.endsWith(".feature") ? editor : undefined;
}

// The run reads the file from disk, so unsaved edits would resolve a cursor against text the runner
// never sees. A refused save (read-only file, or a save participant) has to stop the run: resolving
// against the buffer would run something else than what is on screen.
async function savedForRun(document: vscode.TextDocument): Promise<boolean> {
  if (!document.isDirty || await document.save()) {return true;}
  vscode.window.showWarningMessage(
    `${path.basename(document.uri.fsPath)} could not be saved. Save it, then run again.`
  );
  return false;
}

async function pickFeatureTarget(
  context: Pick<PlaywrightBddExtensionContext, "executionGateway">,
): Promise<FeatureTarget | undefined> {
  await requireExecutionAvailable(context.executionGateway);
  const discovery = await context.executionGateway.discover();
  const files = [...new Set(discovery.cases.map(({ source }) => source.path))];
  if (files.length === 0) {
    const sourceFailure = discovery.diagnostics[0];
    if (sourceFailure) {throw new ExecutionDiagnosticError(sourceFailure);}
    vscode.window.showInformationMessage("No feature files were discovered.");
    return undefined;
  }
  const picked = await vscode.window.showQuickPick(
    files.map((filePath) => ({
      label: path.basename(filePath),
      description: toWorkspaceRelative(path.dirname(filePath)),
      filePath,
    })),
    { placeHolder: "Select a feature file" },
  );
  return picked ? { filePath: picked.filePath } : undefined;
}

async function parseFeatureTarget(
  target: FeatureTarget,
  context: Pick<PlaywrightBddExtensionContext, "featureParser">,
): Promise<ParsedFeatureTarget> {
  let text = target.text;
  if (text === undefined) {
    try {
      text = await fs.promises.readFile(target.filePath, "utf-8");
    } catch (error) {
      throw new Error(`Unable to read feature file: ${target.filePath}`, { cause: error });
    }
  }
  const parsed = context.featureParser.parseFeatureContent(text);
  if (!parsed) {throw new Error(`Unable to parse feature file: ${target.filePath}`);}
  return { ...target, text, parsed };
}

async function resolveFeatureTarget(
  context: Pick<PlaywrightBddExtensionContext, "executionGateway" | "featureParser">,
): Promise<ParsedFeatureTarget | undefined> {
  const editor = activeFeatureEditor();
  if (editor) {
    if (!(await savedForRun(editor.document))) {return undefined;}
    return parseFeatureTarget({
      filePath: editor.document.uri.fsPath,
      text: editor.document.getText(),
      cursorLine: editor.selection.active.line,
    }, context);
  }
  const picked = await pickFeatureTarget(context);
  return picked ? parseFeatureTarget(picked, context) : undefined;
}

function scenarioScopes(target: ParsedFeatureTarget): ScenarioScope[] {
  const lines = target.text.split(/\r?\n/);
  const scopes: ScenarioScope[] = [];
  const outlines = new Map<number, { outlineName: string; rows: OutlineExampleRow[] }>();
  for (const scenario of target.parsed.scenarios) {
    if (!scenario.isScenarioOutline) {
      scopes.push({
        ...scenarioScope(lines, scenario.lineNumber),
        target: { filePath: target.filePath, lineNumber: scenario.lineNumber, scenarioName: scenario.name },
        rows: [],
      });
      continue;
    }
    // An outline with no Examples rows parses to a single stub sitting on the declaration line; it
    // opens the scope but is not a row anyone can target.
    const group = outlines.get(scenario.outlineLineNumber)
      ?? { outlineName: scenario.outlineName, rows: [] };
    if (isOutlineExampleRow(scenario)) {group.rows.push(scenario);}
    outlines.set(scenario.outlineLineNumber, group);
  }
  for (const [lineNumber, { outlineName, rows }] of outlines) {
    scopes.push({
      ...scenarioScope(lines, lineNumber),
      target: { filePath: target.filePath, scenarioName: outlineName, outlineName },
      rows,
    });
  }
  return scopes;
}

function scenarioAtCursor(target: ParsedFeatureTarget): PaletteScenarioTarget | undefined {
  const cursorLine = target.cursorLine;
  if (cursorLine === undefined) {return undefined;}
  const scopes = scenarioScopes(target);
  for (const scope of scopes) {
    const row = scope.rows.find((scenario) => scenario.lineNumber - 1 === cursorLine);
    if (row) {
      return {
        filePath: target.filePath,
        lineNumber: row.lineNumber,
        scenarioName: row.name,
        outlineName: row.outlineName,
      };
    }
  }
  return scopes.find((scope) => scope.start <= cursorLine && cursorLine <= scope.end)?.target;
}

export async function resolvePaletteFeature(
  context: Pick<PlaywrightBddExtensionContext, "executionGateway" | "featureParser">,
): Promise<string | undefined> {
  return (await resolveFeatureTarget(context))?.filePath;
}

export async function promptPaletteTags(): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({
    title: "Run with a tag expression",
    prompt: "Tag expression to run",
    ignoreFocusOut: true,
    validateInput: (value) => (value.trim() === "" ? "A tag expression is required." : undefined),
  });
  return input === undefined ? undefined : input.trim();
}

export async function resolvePaletteScenario(
  context: Pick<PlaywrightBddExtensionContext, "executionGateway" | "featureParser">,
): Promise<PaletteScenarioTarget | undefined> {
  const target = await resolveFeatureTarget(context);
  if (!target) {return undefined;}
  const atCursor = scenarioAtCursor(target);
  if (atCursor) {return atCursor;}

  const picked = await vscode.window.showQuickPick(
    target.parsed.scenarios.map((scenario) => ({
      label: scenario.name,
      description: `${toWorkspaceRelative(target.filePath)}:${scenario.lineNumber}`,
      lineNumber: scenario.lineNumber,
      scenarioName: scenario.name,
      ...(scenario.isScenarioOutline ? { outlineName: scenario.outlineName } : {}),
    })),
    { placeHolder: "Select a scenario" },
  );
  return picked
    ? {
      filePath: target.filePath,
      lineNumber: picked.lineNumber,
      scenarioName: picked.scenarioName,
      ...(picked.outlineName ? { outlineName: picked.outlineName } : {}),
    }
    : undefined;
}
