import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { scenarioGherkinSlice } from "../parsers/gherkin-slice";
import type { ParsedFeature, PlaywrightBddExtensionContext, Scenario } from "../types";
import { toWorkspaceRelative } from "../utils/workspace-path";

type OutlineScenario = Exclude<Scenario, { isScenarioOutline: false }>;

interface FeatureTarget {
  filePath: string;
  text?: string;
  cursorLine?: number;
}

interface ParsedFeatureTarget extends FeatureTarget {
  text: string;
  parsed: ParsedFeature;
}

interface PaletteScenarioTarget {
  filePath: string;
  lineNumber: number;
  scenarioName: string;
  outlineName?: string;
}

interface ScenarioScope {
  start: number;
  end: number;
  target: PaletteScenarioTarget;
  rows: OutlineScenario[];
}

function activeFeatureTarget(): FeatureTarget | undefined {
  const editor = vscode.window.activeTextEditor;
  const document = editor?.document;
  if (!editor || !document?.uri.fsPath.endsWith(".feature")) {return undefined;}
  return {
    filePath: document.uri.fsPath,
    text: document.getText(),
    cursorLine: editor.selection.active.line,
  };
}

async function pickFeatureTarget(
  context: Pick<PlaywrightBddExtensionContext, "discoveryManager">,
): Promise<FeatureTarget | undefined> {
  const files = await context.discoveryManager.discoverTestFiles();
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
  context: Pick<PlaywrightBddExtensionContext, "discoveryManager" | "featureParser">,
): Promise<ParsedFeatureTarget | undefined> {
  const target = activeFeatureTarget() ?? await pickFeatureTarget(context);
  return target ? parseFeatureTarget(target, context) : undefined;
}

function scopeEnd(lines: readonly string[], lineNumber: number): number {
  return lineNumber - 1 + scenarioGherkinSlice(lines, lineNumber).split("\n").length - 1;
}

function leadingTagStart(lines: readonly string[], start: number): number {
  let tagStart = start;
  for (let index = start - 1; index >= 0; index--) {
    const line = lines[index]?.trim() ?? "";
    if (line.startsWith("@")) {tagStart = index; continue;}
    if (line === "" && tagStart !== start) {tagStart = index; continue;}
    break;
  }
  return tagStart;
}

function scenarioScopes(target: ParsedFeatureTarget): ScenarioScope[] {
  const lines = target.text.split(/\r?\n/);
  const scopes: ScenarioScope[] = [];
  const outlines = new Map<number, OutlineScenario[]>();
  for (const scenario of target.parsed.scenarios) {
    if (!scenario.isScenarioOutline) {
      const start = scenario.lineNumber - 1;
      scopes.push({
        start: leadingTagStart(lines, start),
        end: scopeEnd(lines, scenario.lineNumber),
        target: { filePath: target.filePath, lineNumber: scenario.lineNumber, scenarioName: scenario.name },
        rows: [],
      });
      continue;
    }
    const outline = scenario as OutlineScenario;
    const key = outline.outlineLineNumber;
    outlines.set(key, [...(outlines.get(key) ?? []), outline]);
  }
  for (const [lineNumber, rows] of outlines) {
    const outlineName = rows[0]?.outlineName;
    if (!outlineName) {continue;}
    const start = lineNumber - 1;
    scopes.push({
      start: leadingTagStart(lines, start),
      end: scopeEnd(lines, lineNumber),
      target: { filePath: target.filePath, lineNumber, scenarioName: outlineName, outlineName },
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
  context: Pick<PlaywrightBddExtensionContext, "discoveryManager" | "featureParser">,
): Promise<string | undefined> {
  return (await resolveFeatureTarget(context))?.filePath;
}

export async function promptPaletteTags(): Promise<string | undefined> {
  const input = await vscode.window.showInputBox({ prompt: "Tag expression to run" });
  if (input === undefined) {return undefined;}
  const tags = input.trim();
  if (!tags) {throw new Error("Tags are required");}
  return tags;
}

export function commandArgFsPath(arg: unknown): string | undefined {
  if (typeof arg === "string") {return arg;}
  const fsPath = (arg as { fsPath?: unknown } | undefined)?.fsPath;
  return typeof fsPath === "string" ? fsPath : undefined;
}

export function outlineNameForScenario(
  parsed: ParsedFeature | undefined,
  lineNumber: number | undefined,
  scenarioName: string | undefined,
): string | undefined {
  if (!scenarioName) {return undefined;}
  const match = parsed?.scenarios.find(
    (scenario) => scenario.name === scenarioName && (lineNumber === undefined || scenario.lineNumber === lineNumber)
  );
  return match?.isScenarioOutline ? match.outlineName : undefined;
}

export async function resolvePaletteScenario(
  context: Pick<PlaywrightBddExtensionContext, "discoveryManager" | "featureParser">,
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
