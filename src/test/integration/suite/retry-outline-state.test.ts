import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { OUTLINE_ID_SEPARATOR } from "../../../test-providers/constants";
import { activatedTestProvider, waitUntil } from "./fixture-host";
import { openTestRunOutput, savedTestRuns, type SavedRun } from "./native-test-results";

const OUTLINE_NAME = "Native retry state <row>";
const RETRY_ENV = "SPECWRIGHT_NATIVE_RETRY_OUTLINE";
const PASSED = 3;

suite("retrying outline state in VS Code Test Results", () => {
  test("green outline rows distinguish successful retries from a first-attempt pass", async () => {
    const provider = await activatedTestProvider();
    await vscode.commands.executeCommand("playwrightBddRunner.setFeatureBasedOrganization");
    await vscode.commands.executeCommand("playwrightBddRunner.discoverTests");
    const scenario = [...provider.testIdToScenarioMap.values()].find(
      (candidate) => candidate.isScenarioOutline && candidate.outlineName === OUTLINE_NAME
    );
    assert.ok(scenario?.isScenarioOutline);
    const feature = provider.getFeatureItem(scenario.filePath);
    assert.ok(feature);
    const outlineId = `${scenario.filePath}${OUTLINE_ID_SEPARATOR}${scenario.outlineLineNumber}:${OUTLINE_NAME}`;
    const outline = feature.children.get(outlineId);
    assert.ok(outline, `outline ${outlineId} not found in the real controller`);
    const rows: vscode.TestItem[] = [];
    outline.children.forEach((row) => rows.push(row));
    assert.equal(rows.length, 3);

    const settings = vscode.workspace.getConfiguration("playwrightBddRunner");
    const previousCommand = settings.inspect<string>("playwrightCommand")?.workspaceValue;
    const previousEnv = process.env[RETRY_ENV];
    const profile = provider.registeredRunProfiles.find((candidate) => candidate.label === "Run");
    assert.ok(profile);
    const token = new vscode.CancellationTokenSource();
    const startedAt = Date.now();
    const previousRuns = new Set(savedTestRuns().map((run) => run.id));
    try {
      process.env[RETRY_ENV] = "1";
      await settings.update("playwrightCommand", "npx playwright test", vscode.ConfigurationTarget.Workspace);
      await Promise.resolve(profile.runHandler(new vscode.TestRunRequest([outline], undefined, profile), token.token));

      let saved: SavedRun | undefined;
      await waitUntil(() => {
        saved = savedTestRuns().find((run) => !previousRuns.has(run.id)
          && run.completedAt !== undefined
          && run.completedAt >= startedAt
          && run.items?.some((item) => item.item.extId.endsWith(`\0${outline.id}`)));
        return saved !== undefined;
      }, 15_000, "the completed native Test Results record");
      assert.ok(saved?.items);
      const itemFor = (item: vscode.TestItem) => saved?.items?.find(
        (entry) => entry.item.extId.endsWith(`\0${item.id}`)
      );
      const outlineState = itemFor(outline);
      assert.equal(outlineState?.ownComputedState, PASSED, "final outline report must pass");
      for (const row of rows) {
        const state = itemFor(row);
        assert.equal(state?.tasks[0]?.state, PASSED, `${row.label} must be passed in VS Code`);
      }
      assert.equal(outlineState.computedState, PASSED, "outline must compute as passed");

      await vscode.commands.executeCommand("testing.showMostRecentOutput");
      const output = await openTestRunOutput(saved.id);
      const summaryFor = (row: string): string | undefined => output.getText().split(/\r?\n/).find(
        (line) => line.startsWith(`✔ Scenario Outline: ${OUTLINE_NAME} (Native retry state ${row})`)
      );
      const first = summaryFor("first");
      assert.ok(first, "the clean row must appear in native Test Results output");
      assert.ok(!first.includes("Passed on attempt") && !first.includes("Passed after retries"),
        "the first-attempt pass must have no retry annotation");
      for (const row of ["second", "third"]) {
        const summary = summaryFor(row);
        assert.ok(summary, `${row} must appear by name in native Test Results output`);
        assert.ok(summary.includes("Passed on attempt 2"), `${row} must explain its passing retry`);
      }
    } finally {
      token.dispose();
      await settings.update("playwrightCommand", previousCommand, vscode.ConfigurationTarget.Workspace);
      if (previousEnv === undefined) {delete process.env[RETRY_ENV];}
      else {process.env[RETRY_ENV] = previousEnv;}
    }
  });
});
