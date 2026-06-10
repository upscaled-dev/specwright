import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";

const EXTENSION_ID = "upscaled-dev.specwright";

async function activate(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  if (!ext) { throw new Error(`Extension ${EXTENSION_ID} not found`); }
  await ext.activate();
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) { return; }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

function workspaceRoot(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { throw new Error("No workspace folder open in integration host"); }
  return root;
}

suite("Go to Step Definition command", () => {
  suiteSetup(async () => { await activate(); });

  test("navigates from a Gherkin step to its step-definition file", async () => {
    const featureUri = vscode.Uri.file(path.join(workspaceRoot(), "features", "sample.feature"));
    const doc = await vscode.workspace.openTextDocument(featureUri);
    const editor = await vscode.window.showTextDocument(doc);

    const lineIdx = doc.getText().split("\n").findIndex((l) => l.includes("I am on the test page"));
    assert.ok(lineIdx >= 0, "step 'I am on the test page' not found in sample.feature");
    editor.selection = new vscode.Selection(lineIdx, 12, lineIdx, 12);

    await vscode.commands.executeCommand("playwrightBddRunner.goToStepDefinition");

    await waitUntil(
      () => vscode.window.activeTextEditor?.document.fileName.endsWith("sample.steps.ts") ?? false,
      5000,
      "active editor to switch to the step-definition file"
    );
    assert.ok(
      vscode.window.activeTextEditor?.document.fileName.endsWith("sample.steps.ts"),
      "expected to navigate to sample.steps.ts"
    );
  });
});
