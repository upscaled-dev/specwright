import * as vscode from "vscode";
import { KeyGrammar } from "./contracts";
import { computeLinkEdit, computeUnlinkEdit } from "./link-scenario";
import type { ScenarioRef } from "./scenario-ref";
import type { WorkspaceTrust } from "../core/workspace-trust";

// What a tag write can answer: the caller's success label, the file already saying it, or a refusal.
export type TagWrite<Written extends string> = Written | "unchanged" | "rejected";

// The shared write spine. `build` answers undefined when the file already says what the caller asked
// for. A refused applyEdit or save (a conflicting dirty buffer, a read-only file) answers "rejected"
// instead of the success label, so no caller reports a tag that never reached disk.
async function writeTagEdit<Written extends string>(
  scenario: ScenarioRef,
  written: Written,
  build: (doc: vscode.TextDocument, uri: vscode.Uri) => vscode.WorkspaceEdit | undefined,
  workspaceTrust: WorkspaceTrust
): Promise<TagWrite<Written>> {
  const uri = vscode.Uri.file(scenario.filePath);
  const doc = await vscode.workspace.openTextDocument(uri);
  const wsEdit = build(doc, uri);
  if (!wsEdit) {
    return "unchanged";
  }
  workspaceTrust.require();
  if (!(await vscode.workspace.applyEdit(wsEdit))) {
    return "rejected";
  }
  // save() also answers false for a document that is no longer dirty (autosave, or an external save
  // between the edit and here), which is a written file rather than a refusal.
  if (!doc.isDirty) {
    return written;
  }
  workspaceTrust.require();
  return (await doc.save()) ? written : "rejected";
}

// The idempotent `@TEST_<key>` insert, shared by linking an existing test and authoring a new one.
export function applyTagInsert(
  scenario: ScenarioRef,
  key: string,
  grammar: KeyGrammar,
  workspaceTrust: WorkspaceTrust
): Promise<TagWrite<"inserted">> {
  return writeTagEdit(scenario, "inserted", (doc, uri) => {
    const edit = computeLinkEdit(doc.getText().split("\n"), scenario.line, key, grammar);
    if (edit.kind === "unchanged") {
      return undefined;
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
    return wsEdit;
  }, workspaceTrust);
}

// The removal twin of applyTagInsert: drops the `@TEST_<key>` tag from the scenario's tag lines as
// an undoable, git-visible WorkspaceEdit. A lone tag takes its whole line and terminator with it.
export function applyTagRemove(
  scenario: ScenarioRef,
  key: string,
  grammar: KeyGrammar,
  workspaceTrust: WorkspaceTrust
): Promise<TagWrite<"removed">> {
  return writeTagEdit(scenario, "removed", (doc, uri) => {
    const edit = computeUnlinkEdit(doc.getText().split("\n"), scenario.line, key, grammar);
    if (edit.kind === "unchanged") {
      return undefined;
    }
    const wsEdit = new vscode.WorkspaceEdit();
    if (edit.kind === "deleteLine") {
      wsEdit.delete(uri, doc.lineAt(edit.line).rangeIncludingLineBreak);
    } else {
      const lineLength = doc.lineAt(edit.line).text.length;
      wsEdit.replace(uri, new vscode.Range(edit.line, 0, edit.line, lineLength), edit.text);
    }
    return wsEdit;
  }, workspaceTrust);
}
