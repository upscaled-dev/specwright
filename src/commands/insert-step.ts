import * as vscode from "vscode";
import { humanizeRegexSource, patternToSnippet } from "../providers/pattern-humanizer";
import { toWorkspaceRelative } from "../utils/workspace-path";

export interface InsertStepSource {
  pattern: string;
  isRegex: boolean;
  keyword?: "Given" | "When" | "Then" | "Step" | undefined;
  filePath: string;
}

export interface InsertStepItem extends vscode.QuickPickItem {
  snippet: string;
}

/**
 * Wrap bare `${n:string}` placeholders in double quotes so the inserted step matches the
 * `{string}` parameter (which requires quotes), while leaving placeholders that the humanized
 * pattern already quotes (regex-derived `"{string}"` / `'{string}'`) untouched.
 */
export function quoteStringPlaceholders(snippet: string): string {
  return snippet.replaceAll(
    /(["'])?\$\{(\d+):string\}(["'])?/g,
    (match: string, pre: string | undefined, index: string, post: string | undefined): string => {
      if (pre !== undefined || post !== undefined) {return match;}
      return `"\${${index}:string}"`;
    },
  );
}

export function buildStepSnippet(pattern: string, isRegex: boolean): string {
  return quoteStringPlaceholders(patternToSnippet(humanizeRegexSource(pattern, isRegex).label));
}

export function buildInsertStepItems(
  defs: readonly InsertStepSource[],
  sourceRelOf: (filePath: string) => string,
): InsertStepItem[] {
  return defs
    .map((def) => ({
      label: humanizeRegexSource(def.pattern, def.isRegex).label,
      description: `${def.keyword ?? "Step"} · ${sourceRelOf(def.filePath)}`,
      snippet: buildStepSnippet(def.pattern, def.isRegex),
    }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

export async function runInsertStep(
  getDefs: () => Promise<readonly InsertStepSource[]>,
  preselected?: { pattern: string; isRegex: boolean },
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const doc = editor?.document;
  if (!editor || !doc || (doc.languageId !== "gherkin" && !doc.fileName.endsWith(".feature"))) {
    vscode.window.showInformationMessage(
      "Insert Step needs an active .feature editor — open one and try again.",
    );
    return;
  }

  let snippet: string | undefined;
  if (preselected) {
    snippet = buildStepSnippet(preselected.pattern, preselected.isRegex);
  } else {
    const items = buildInsertStepItems(await getDefs(), toWorkspaceRelative);
    if (items.length === 0) {
      vscode.window.showInformationMessage(
        "No step definitions found — check playwrightBddRunner.stepDefinitionPaths.",
      );
      return;
    }
    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Search step definitions to insert",
      matchOnDescription: true,
    });
    snippet = picked?.snippet;
  }
  if (snippet === undefined) {return;}
  await editor.insertSnippet(new vscode.SnippetString(snippet));
}
