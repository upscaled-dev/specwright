import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ExtensionApi } from "../../../extension";
import {
  materializeGeneratedSpecForBddgen,
  removeGeneratedSpecs,
  SAMPLE_EXACT_TARGET,
} from "./generated-spec-fixture";

const EXTENSION_ID = "upscaled-dev.specwright";

type TestProviderApi = NonNullable<ExtensionApi["testProvider"]>;

async function getProvider(): Promise<TestProviderApi> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  if (!ext) { throw new Error(`Extension ${EXTENSION_ID} not found`); }
  const api = (await ext.activate()) as ExtensionApi;
  assert.ok(api.testProvider, "testProvider not exposed by ExtensionApi");
  return api.testProvider;
}

function workspaceRoot(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) { throw new Error("No workspace folder open in integration host"); }
  return root;
}

suite("Palette run target resolution (no command arguments)", () => {
  let provider: TestProviderApi;

  suiteSetup(async () => {
    removeGeneratedSpecs(workspaceRoot());
    provider = await getProvider();
  });

  teardown(() => {
    provider.restoreShellRunner();
    removeGeneratedSpecs(workspaceRoot());
  });

  test("runs the scenario under the cursor of the active feature editor", async () => {
    const featureUri = vscode.Uri.file(path.join(workspaceRoot(), "features", "sample.feature"));
    const doc = await vscode.workspace.openTextDocument(featureUri);
    const editor = await vscode.window.showTextDocument(doc);

    const stepLine = doc.getText().split("\n")
      .findIndex((line) => line.includes("When I click the test button"));
    assert.ok(stepLine >= 0, "step 'When I click the test button' not found in sample.feature");
    editor.selection = new vscode.Selection(stepLine, 0, stepLine, 0);

    const commands: string[] = [];
    provider.overrideShellRunner(async (command, _dir, env) => {
      commands.push(command);
      if (materializeGeneratedSpecForBddgen(command, workspaceRoot())) {
        return { success: true, output: "", error: "", returnCode: 0 };
      }
      assert.ok(command.includes(SAMPLE_EXACT_TARGET), `expected exact target, got: ${command}`);
      const reportPath = env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"];
      if (reportPath) { fs.writeFileSync(reportPath, JSON.stringify({ suites: [] })); }
      return { success: true, output: "", error: "", returnCode: 0 };
    });

    await vscode.commands.executeCommand("playwrightBddRunner.runScenario");

    // The exact-target contract runs one generated test by spec line, never a name grep, so the
    // evidence of targeting 'Plain scenario' is its generated test at sample.feature.spec.js:6.
    assert.ok(
      commands.some((command) => command.includes(SAMPLE_EXACT_TARGET)),
      `expected a run targeting the generated test of 'Plain scenario', got: ${commands.join(" | ")}`
    );
  });
});
