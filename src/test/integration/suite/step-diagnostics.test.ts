import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ExtensionApi } from "../../../extension";

const EXTENSION_ID = "upscaled-dev.specwright";

async function activateExtension(): Promise<ExtensionApi> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  if (!ext) { throw new Error(`Extension ${EXTENSION_ID} not found`); }
  return (await ext.activate()) as ExtensionApi;
}

function unmatchedFixtureUri(): vscode.Uri {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { throw new Error("No workspace folder open in integration host"); }
  return vscode.Uri.file(path.join(workspaceRoot, "features", "unmatched.feature"));
}

async function waitForDiagnostics(uri: vscode.Uri, expectedMin: number, timeoutMs = 3000): Promise<vscode.Diagnostic[]> {
  const deadline = Date.now() + timeoutMs;
  let last: vscode.Diagnostic[] = [];
  while (Date.now() < deadline) {
    last = vscode.languages.getDiagnostics(uri);
    if (last.length >= expectedMin) {return last;}
    await new Promise((r) => setTimeout(r, 100));
  }
  return last;
}

suite("Step diagnostics on .feature files", () => {
  suiteSetup(async () => {
    await activateExtension();
  });

  test("emits a diagnostic for each unmatched step in a feature file", async () => {
    const uri = unmatchedFixtureUri();
    await vscode.workspace.openTextDocument(uri);

    const diagnostics = await waitForDiagnostics(uri, 3);
    assert.ok(
      diagnostics.length >= 3,
      `expected at least 3 unmatched-step diagnostics; got ${diagnostics.length}`
    );

    const ours = diagnostics.filter((d) => d.source === "Playwright-BDD");
    assert.ok(ours.length >= 3, `expected diagnostics with source 'Playwright-BDD'; got ${ours.length}`);
    assert.ok(
      ours.every((d) => d.code === "unmatched-step"),
      "expected every Playwright-BDD diagnostic to have code 'unmatched-step'"
    );
  });

  test("provides a 'Create step definition' code action for an unmatched step", async () => {
    const uri = unmatchedFixtureUri();
    await vscode.workspace.openTextDocument(uri);
    await waitForDiagnostics(uri, 1);

    const diagnostics = vscode.languages.getDiagnostics(uri).filter((d) => d.source === "Playwright-BDD");
    assert.ok(diagnostics.length > 0, "no Playwright-BDD diagnostics found before requesting code actions");
    const target = diagnostics[0]!;

    const actions = await vscode.commands.executeCommand<vscode.CodeAction[]>(
      "vscode.executeCodeActionProvider",
      uri,
      target.range
    );
    assert.ok(actions && actions.length > 0, "expected at least one code action at the diagnostic range");
    const ours = actions.filter(
      (a) => a.command?.command === "playwrightBddRunner.generateStepDefinitionForStep"
    );
    assert.ok(
      ours.length > 0,
      "expected at least one code action with command 'playwrightBddRunner.generateStepDefinitionForStep'"
    );
    assert.ok(
      ours[0]!.title.startsWith("Create step definition for:"),
      `unexpected action title: ${ours[0]!.title}`
    );
  });

  test("respects enableStepDiagnostics=false at runtime", async () => {
    const api = await activateExtension();
    const config = vscode.workspace.getConfiguration("playwrightBddRunner");
    await config.update("enableStepDiagnostics", false, vscode.ConfigurationTarget.Workspace);
    try {
      const deadline = Date.now() + 1500;
      while (Date.now() < deadline && api.providerRegistry?.diagnosticsActive !== false) {
        await new Promise((r) => setTimeout(r, 50));
      }

      const uri = unmatchedFixtureUri();
      await vscode.workspace.openTextDocument(uri);
      await new Promise((r) => setTimeout(r, 500));
      const diagnostics = vscode.languages.getDiagnostics(uri).filter((d) => d.source === "Playwright-BDD");
      assert.equal(diagnostics.length, 0, "expected no Playwright-BDD diagnostics when enableStepDiagnostics is false");
    } finally {
      await config.update("enableStepDiagnostics", undefined, vscode.ConfigurationTarget.Workspace);
    }
  });
});
