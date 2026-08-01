import * as assert from "node:assert/strict";
import * as vscode from "vscode";

const EXTENSION_ID = "upscaled-dev.specwright";

interface SmokeApi {
  testProvider?: {
    testIdToScenarioMap: ReadonlyMap<string, unknown>;
  };
}

export async function run(): Promise<void> {
  const extension = vscode.extensions.getExtension<SmokeApi>(EXTENSION_ID);
  assert.ok(extension, `Installed extension ${EXTENSION_ID} was not found`);

  const api = await extension.activate();
  assert.ok(api.testProvider, "Installed extension did not expose its test provider");

  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline && api.testProvider.testIdToScenarioMap.size === 0) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  const discoveredIds = [...api.testProvider.testIdToScenarioMap.keys()];
  assert.ok(discoveredIds.some((id) => id.includes("sample.feature:")),
    `Installed extension did not discover the fixture scenario: ${discoveredIds.join(", ")}`);
}
