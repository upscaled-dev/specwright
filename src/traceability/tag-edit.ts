import * as vscode from "vscode";
import { KeyGrammar } from "./contracts";
import { computeLinkEdit, computeUnlinkEdit } from "./link-scenario";
import { ScenarioRef } from "./traceability-model";

// The idempotent `@TEST_<key>` insert, shared by linking an existing test and authoring a new one.
export async function applyTagInsert(
  scenario: ScenarioRef,
  key: string,
  grammar: KeyGrammar
): Promise<"inserted" | "unchanged"> {
  const uri = vscode.Uri.file(scenario.filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const lines = doc.getText().split("\n");
  const edit = computeLinkEdit(lines, scenario.line, key, grammar);
  if (edit.kind === "unchanged") {
    return "unchanged";
  }
  const wsEdit = new vscode.WorkspaceEdit();
  if (edit.kind === "insertLine") {
    const eol = doc.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n";
    wsEdit.insert(uri, new vscode.Position(edit.line, 0), `${edit.text}${eol}`);
  } else {
    // Range from the document's own line length (EOL-excluded), never the "\n"-split string, so a
    // CRLF line's trailing "\r" is never dragged into the replacement.
    const lineLength = doc.lineAt(edit.line).text.length;
    wsEdit.replace(uri, new vscode.Range(edit.line, 0, edit.line, lineLength), edit.text);
  }
  await vscode.workspace.applyEdit(wsEdit);
  await doc.save();
  return "inserted";
}

// The removal twin of applyTagInsert: drops the `@TEST_<key>` tag from the scenario's tag lines as
// an undoable, git-visible WorkspaceEdit. A lone tag takes its whole line and terminator with it.
export async function applyTagRemove(
  scenario: ScenarioRef,
  key: string,
  grammar: KeyGrammar
): Promise<"removed" | "unchanged"> {
  const uri = vscode.Uri.file(scenario.filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const edit = computeUnlinkEdit(doc.getText().split("\n"), scenario.line, key, grammar);
  if (edit.kind === "unchanged") {
    return "unchanged";
  }
  const wsEdit = new vscode.WorkspaceEdit();
  if (edit.kind === "deleteLine") {
    wsEdit.delete(uri, doc.lineAt(edit.line).rangeIncludingLineBreak);
  } else {
    const lineLength = doc.lineAt(edit.line).text.length;
    wsEdit.replace(uri, new vscode.Range(edit.line, 0, edit.line, lineLength), edit.text);
  }
  await vscode.workspace.applyEdit(wsEdit);
  await doc.save();
  return "removed";
}
