import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";

const EXTENSION_ID = "upscaled-dev.specwright";

suite("Gherkin language contribution", () => {
  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    if (!ext) { throw new Error(`Extension ${EXTENSION_ID} not found`); }
    await ext.activate();
  });

  test(".feature files are detected as the 'gherkin' language", async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!workspaceRoot) { throw new Error("No workspace folder open in integration host"); }
    const uri = vscode.Uri.file(path.join(workspaceRoot, "features", "sample.feature"));

    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc);

    assert.equal(
      doc.languageId,
      "gherkin",
      `expected sample.feature to be detected as 'gherkin'; got '${doc.languageId}'`
    );
  });
});
