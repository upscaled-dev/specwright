import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vscode from "vscode";
import type { ExtensionApi } from "../../../extension";

const EXTENSION_ID = "upscaled-dev.specwright";

type TestProviderApi = NonNullable<ExtensionApi["testProvider"]>;

async function getProvider(): Promise<TestProviderApi> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  if (!ext) { throw new Error(`Extension ${EXTENSION_ID} not found`); }
  const api = (await ext.activate()) as ExtensionApi;
  assert.ok(api.testProvider, "testProvider not exposed by ExtensionApi");
  return api.testProvider;
}

async function waitUntil(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) { return; }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

interface TargetScenario { id: string; filePath: string; lineNumber: number; }

function findScenario(provider: TestProviderApi, name: string): TargetScenario | undefined {
  for (const [id, scenario] of provider.testIdToScenarioMap) {
    if (scenario.name === name) {
      return { id, filePath: scenario.filePath, lineNumber: scenario.lineNumber };
    }
  }
  return undefined;
}

/** A canned Playwright JSON report for one scenario, with a source annotation so the parser maps
 * it back to the .feature line without needing a generated spec on disk. */
function cannedReport(target: TargetScenario, status: "passed" | "failed"): string {
  return JSON.stringify({
    suites: [{
      title: "Fixture feature",
      specs: [{
        title: "Plain scenario",
        file: "features/sample.feature.spec.js",
        tests: [{
          annotations: [{ type: `${target.filePath}:${target.lineNumber}` }],
          results: [{
            status,
            duration: 5,
            ...(status === "failed" ? { error: { message: "boom", stack: "Error: boom\n    at steps.ts:1:1" } } : {}),
            steps: [{ title: "Given I am on the test page", duration: 2 }],
          }],
        }],
      }],
    }],
  });
}

suite("Run → Test Explorer status (real VS Code, canned shell)", () => {
  let provider: TestProviderApi;
  let target: TargetScenario;

  suiteSetup(async () => {
    provider = await getProvider();
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
  });

  async function runScenarioWithCannedResult(status: "passed" | "failed"): Promise<void> {
    provider.overrideShellRunner(async (_cmd, _dir, env) => {
      const reportPath = env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"];
      if (reportPath) { fs.writeFileSync(reportPath, cannedReport(target, status)); }
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
