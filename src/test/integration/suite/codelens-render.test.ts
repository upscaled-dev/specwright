import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ExtensionApi } from "../../../extension";

const EXTENSION_ID = "upscaled-dev.specwright";

async function activateExtension(): Promise<void> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  if (!ext) { throw new Error(`Extension ${EXTENSION_ID} not found`); }
  const api = (await ext.activate()) as ExtensionApi;
  assert.ok(api.testProvider, "testProvider not exposed by ExtensionApi");
}

function sampleFeatureUri(): vscode.Uri {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { throw new Error("No workspace folder open in integration host"); }
  return vscode.Uri.file(path.join(workspaceRoot, "features", "sample.feature"));
}

async function getLensesForSample(): Promise<vscode.CodeLens[]> {
  const doc = await vscode.workspace.openTextDocument(sampleFeatureUri());
  let lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
    "vscode.executeCodeLensProvider",
    doc.uri
  );
  if (!lenses || lenses.length === 0) {
    await new Promise((r) => setTimeout(r, 200));
    lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
      "vscode.executeCodeLensProvider",
      doc.uri
    );
  }
  return lenses ?? [];
}

suite("CodeLens rendering on .feature files", () => {
  suiteSetup(async () => {
    await activateExtension();
  });

  test("CodeLens provider is registered and returns lenses for a .feature file", async () => {
    const lenses = await getLensesForSample();

    assert.ok(
      lenses.length > 0,
      "expected at least one CodeLens on sample.feature; got none"
    );

    const hasRun = lenses.some((l) => l.command?.title?.includes("Run") ?? false);
    assert.ok(
      hasRun,
      "expected at least one CodeLens with a title containing 'Run'"
    );
  });

  test("feature-level CodeLens includes 'Run Feature File' + tag links", async () => {
    const lenses = await getLensesForSample();

    const featureLevel = lenses.filter((l) => l.range.start.line === 0);
    assert.ok(
      featureLevel.length > 0,
      "expected at least one feature-level CodeLens (range starting on line 0)"
    );

    const hasRunFeatureFile = featureLevel.some((l) =>
      l.command?.title?.includes("Run Feature File") ?? false
    );
    assert.ok(
      hasRunFeatureFile,
      "expected a feature-level CodeLens with title containing 'Run Feature File'"
    );

    const hasTagLens = featureLevel.some((l) => l.command?.title?.includes("@") ?? false);
    assert.ok(
      hasTagLens,
      "expected at least one feature-level tag CodeLens (title containing '@')"
    );
  });

  test("respects enableCodeLens=false at runtime via ProviderRegistry", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    if (!ext) { throw new Error(`Extension ${EXTENSION_ID} not found`); }
    const api = ext.exports as ExtensionApi;

    const config = vscode.workspace.getConfiguration("playwrightBddRunner");
    await config.update("enableCodeLens", false, vscode.ConfigurationTarget.Workspace);
    try {
      const deadline = Date.now() + 1000;
      while (Date.now() < deadline && api.providerRegistry?.codeLensActive !== false) {
        await new Promise((r) => setTimeout(r, 50));
      }
      assert.equal(
        api.providerRegistry?.codeLensActive,
        false,
        "expected providerRegistry.codeLensActive to become false after config update"
      );

      const doc = await vscode.workspace.openTextDocument(sampleFeatureUri());
      const lenses = await vscode.commands.executeCommand<vscode.CodeLens[]>(
        "vscode.executeCodeLensProvider",
        doc.uri
      );
      assert.equal(
        (lenses ?? []).length,
        0,
        "expected no CodeLenses when enableCodeLens is false"
      );
    } finally {
      await config.update("enableCodeLens", undefined, vscode.ConfigurationTarget.Workspace);
      const restoreDeadline = Date.now() + 1000;
      while (
        Date.now() < restoreDeadline &&
        api.providerRegistry?.codeLensActive !== true
      ) {
        await new Promise((r) => setTimeout(r, 50));
      }
    }
  });
});
