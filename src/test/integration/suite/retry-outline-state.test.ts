import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import { OUTLINE_ID_SEPARATOR } from "../../../test-providers/constants";
import { isOutlineExampleRow } from "../../../parsers/feature-parser";
import { activatedTestProvider, waitUntil } from "./fixture-host";
import { openTestRunOutput, savedTestRuns, type SavedRun } from "./native-test-results";

const OUTLINE_NAME = "Native retry state <row>";
const RETRY_ENV = "SPECWRIGHT_NATIVE_RETRY_OUTLINE";
const PASSED = 3;

async function retryOutline() {
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
  return { provider, outline, rows };
}

suite("retrying outline state in VS Code Test Results", () => {
  test("green outline rows distinguish successful retries from a first-attempt pass", async () => {
    const { provider, outline, rows } = await retryOutline();

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

  test("Debug completes the selected first row through the native debugger without running siblings", async () => {
    const { provider, rows } = await retryOutline();
    const name = "Native retry state first";
    const selected = rows.find((row) => {
      const scenario = provider.testIdToScenarioMap.get(row.id);
      return scenario !== undefined && isOutlineExampleRow(scenario) && scenario.substitutedName === name;
    });
    assert.ok(selected, "the named first row must be in the native controller");
    const profile = provider.registeredRunProfiles.find((candidate) => candidate.label === "Debug");
    assert.ok(profile);
    const settings = vscode.workspace.getConfiguration("playwrightBddRunner");
    const previousCommand = settings.inspect<string>("playwrightCommand")?.workspaceValue;
    const previousEnv = process.env[RETRY_ENV];
    const previousRuns = new Set(savedTestRuns().map((run) => run.id));
    const token = new vscode.CancellationTokenSource();
    let session: vscode.DebugSession | undefined;
    const terminated = new Set<string>();
    const startedListener = vscode.debug.onDidStartDebugSession((started) => {
      if (started.name === "Debug Playwright-BDD Scenario") {session = started;}
    });
    const endedListener = vscode.debug.onDidTerminateDebugSession((ended) => terminated.add(ended.id));
    try {
      process.env[RETRY_ENV] = "1";
      await settings.update("playwrightCommand", "npx playwright test", vscode.ConfigurationTarget.Workspace);
      await Promise.resolve(profile.runHandler(new vscode.TestRunRequest([selected], undefined, profile), token.token));
      await waitUntil(() => session !== undefined && terminated.has(session.id),
        15_000, "the actual native Debug session completing");
      let saved: SavedRun | undefined;
      await waitUntil(() => {
        saved = savedTestRuns().find((run) => !previousRuns.has(run.id) && run.completedAt !== undefined
          && run.items?.some((item) => item.item.extId.endsWith(`\0${selected.id}`)));
        return saved !== undefined;
      }, 15_000, "the completed native Debug Test Results record");
      assert.ok(saved?.items);
      const stateFor = (row: vscode.TestItem) => saved?.items?.find(
        (item) => item.item.extId.endsWith(`\0${row.id}`)
      );
      assert.equal(stateFor(selected)?.tasks[0]?.state, PASSED, "the named Debug row must finish green");
      for (const sibling of rows.filter((row) => row !== selected)) {
        const state = stateFor(sibling);
        assert.ok(state === undefined || state.tasks.every((task) => task.state === 0),
          `${sibling.label} must not run in the selected-row Debug request`);
      }
      await vscode.commands.executeCommand("testing.showMostRecentOutput");
      const output = (await openTestRunOutput(saved.id)).getText();
      const summary = output.split(/\r?\n/).find(
        (line) => line.startsWith(`✔ Scenario Outline: ${OUTLINE_NAME} (${name})`)
      );
      assert.ok(summary && !summary.includes("Passed on attempt"), "the named Debug row must have a clean passing summary");
      assert.ok(!output.includes("Native retry state second") && !output.includes("Native retry state third"),
        "native Debug output must contain no sibling execution");
    } finally {
      token.cancel();
      token.dispose();
      startedListener.dispose();
      endedListener.dispose();
      await settings.update("playwrightCommand", previousCommand, vscode.ConfigurationTarget.Workspace);
      if (previousEnv === undefined) {delete process.env[RETRY_ENV];}
      else {process.env[RETRY_ENV] = previousEnv;}
    }
  });
});
