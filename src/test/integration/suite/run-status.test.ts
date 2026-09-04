import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vscode from "vscode";
import {
  activatedTestProvider,
  cannedReport,
  findScenario,
  waitUntil,
  type TargetScenario,
  type TestProviderApi,
} from "./fixture-host";
import {
  materializeGeneratedSpecForBddgen,
  removeGeneratedSpecs,
  SAMPLE_EXACT_TARGET,
} from "./generated-spec-fixture";

function workspaceRoot(): string {
  const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!root) {throw new Error("No workspace folder open in integration host");}
  return root;
}

suite("Run → Test Explorer status (real VS Code, canned shell)", () => {
  let provider: TestProviderApi;
  let target: TargetScenario;

  suiteSetup(async () => {
    removeGeneratedSpecs(workspaceRoot());
    provider = await activatedTestProvider();
    await waitUntil(
      () => findScenario(provider, "Plain scenario") !== undefined,
      10_000,
      "the fixture's 'Plain scenario' to be discovered"
    );
    const found = findScenario(provider, "Plain scenario");
    assert.ok(found, "'Plain scenario' not found in the discovered tree");
    target = found;
  });

  teardown(() => {
    provider.restoreShellRunner();
    removeGeneratedSpecs(workspaceRoot());
  });

  async function runScenarioWithCannedResult(status: "passed" | "failed"): Promise<void> {
    provider.overrideShellRunner(async (command, workingDir, env) => {
      if (materializeGeneratedSpecForBddgen(command, workingDir)) {
        return { success: true, output: "", error: "", returnCode: 0 };
      }
      assert.ok(command.includes(SAMPLE_EXACT_TARGET), `expected exact target, got: ${command}`);
      const reportPath = env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"];
      if (reportPath) {
        fs.writeFileSync(reportPath, cannedReport(target, {
          featureTitle: "Fixture feature",
          specFile: "features/sample.feature.spec.js",
          status,
        }));
      }
      return { success: status === "passed", output: "", error: "", returnCode: status === "passed" ? 0 : 1 };
    });
    await vscode.commands.executeCommand(
      "playwrightBddRunner.runScenario",
      target.filePath,
      target.lineNumber,
      "Plain scenario"
    );
  }

  test("a passing report marks the scenario item passed", async () => {
    await runScenarioWithCannedResult("passed");
    assert.equal(
      provider.getItemStatus(target.id),
      "passed",
      `expected ${target.id} to be passed after a passing run`
    );
  });

  test("a failing report marks the scenario item failed", async () => {
    await runScenarioWithCannedResult("failed");
    assert.equal(
      provider.getItemStatus(target.id),
      "failed",
      `expected ${target.id} to be failed after a failing run`
    );
  });
});
