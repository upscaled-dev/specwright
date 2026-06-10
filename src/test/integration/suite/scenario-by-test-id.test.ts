import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { ExtensionApi } from "../../../extension";
import { OUTLINE_ID_SEPARATOR } from "../../../test-providers/constants";

const EXTENSION_ID = "upscaled-dev.specwright";

type TestProviderApi = NonNullable<ExtensionApi["testProvider"]>;

const STRATEGY_COMMANDS = {
  hierarchical: "playwrightBddRunner.setFeatureBasedOrganization",
  tag: "playwrightBddRunner.setTagBasedOrganization",
  file: "playwrightBddRunner.setFileBasedOrganization",
  "scenario-type": "playwrightBddRunner.setScenarioTypeOrganization",
  flat: "playwrightBddRunner.setFlatOrganization",
} as const;

type StrategyKey = keyof typeof STRATEGY_COMMANDS;

async function getProvider(): Promise<TestProviderApi> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  if (!ext) { throw new Error(`Extension ${EXTENSION_ID} not found`); }
  const api = (await ext.activate()) as ExtensionApi;
  assert.ok(api.testProvider, "testProvider not exposed by ExtensionApi");
  return api.testProvider;
}

async function waitForMapPopulated(provider: TestProviderApi, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (provider.testIdToScenarioMap.size > 0) { return; }
    await new Promise((r) => setTimeout(r, 50));
  }
}

suite("scenarioByTestId map across organization strategies", () => {
  teardown(async () => {
    await vscode.commands.executeCommand(STRATEGY_COMMANDS.hierarchical);
  });

  for (const key of Object.keys(STRATEGY_COMMANDS) as StrategyKey[]) {
    test(`populates entries under '${key}' strategy`, async () => {
      const provider = await getProvider();
      const command = STRATEGY_COMMANDS[key];
      await vscode.commands.executeCommand(command);
      await waitForMapPopulated(provider);

      const map = provider.testIdToScenarioMap;
      assert.ok(map.size > 0, `scenarioByTestId should be populated for ${key}`);

      const firstPlain = Array.from(map.entries())
        .find(([, scenario]) => !scenario.isScenarioOutline);
      assert.ok(
        firstPlain,
        `Strategy "${key}" produced no plain scenarios — createScenarioTestItem likely not called for non-outlines.`
      );
      assert.match(
        firstPlain[0],
        /\.feature:\d+$/,
        `Plain-scenario test ID "${firstPlain[0]}" does not match expected "<path>.feature:<line>" shape.`
      );

      const outlineEntries = [...map.entries()].filter(([id, s]) =>
        s.isScenarioOutline && id.includes(OUTLINE_ID_SEPARATOR)
      );
      if (key === "hierarchical") {
        assert.ok(
          outlineEntries.length > 0,
          "hierarchical strategy should register outline-row test IDs"
        );
        const outlineEntry = outlineEntries[0];
        assert.ok(outlineEntry);
        const [, scenario] = outlineEntry;
        assert.ok(scenario.isScenarioOutline, "expected outline variant");
        assert.equal(
          scenario.outlineName,
          "Test scenario outline",
          "outline-row lookup should return scenario with expected outlineName"
        );
      } else {
        const hasOutlineRow = [...map.values()].some((s) => s.isScenarioOutline);
        assert.ok(hasOutlineRow, `expected at least one outline-row scenario under ${key}`);
      }
    });
  }
});
