import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { OUTLINE_ID_SEPARATOR } from "../../../test-providers/constants";
import { activatedTestProvider, waitUntil } from "./fixture-host";

const OUTLINE_NAME = "Native retry state <row>";
const RETRY_ENV = "SPECWRIGHT_NATIVE_RETRY_OUTLINE";
const PASSED = 3;

interface SavedItem {
  readonly item: { readonly extId: string };
  readonly ownComputedState: number;
  readonly computedState: number;
  readonly tasks: ReadonlyArray<{ readonly state: number }>;
}

interface SavedRun {
  readonly completedAt?: number;
  readonly items?: readonly SavedItem[];
}

function savedRuns(): SavedRun[] {
  const storage = path.resolve(__dirname, "../../../../.vscode-test/user-data/User/workspaceStorage");
  if (!fs.existsSync(storage)) {return [];}
  const runs: SavedRun[] = [];
  for (const workspace of fs.readdirSync(storage)) {
    const directory = path.join(storage, workspace, "testResults");
    if (!fs.existsSync(directory)) {continue;}
    for (const file of fs.readdirSync(directory)) {
      if (!file.endsWith(".json")) {continue;}
      try {
        runs.push(JSON.parse(fs.readFileSync(path.join(directory, file), "utf8")) as SavedRun);
      } catch {
        // VS Code can still be writing another result while this run is settling.
      }
    }
  }
  return runs;
}

suite("retrying outline state in VS Code Test Results", () => {
  test("three rows and their outline finish passed after two timed-out first attempts", async () => {
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
    try {
      process.env[RETRY_ENV] = "1";
      await settings.update("playwrightCommand", "npx playwright test", vscode.ConfigurationTarget.Workspace);
      await Promise.resolve(profile.runHandler(new vscode.TestRunRequest([outline], undefined, profile), token.token));

      let saved: SavedRun | undefined;
      await waitUntil(() => {
        saved = savedRuns().find((run) => run.completedAt !== undefined
          && run.completedAt >= startedAt
          && run.items?.some((item) => item.item.extId.endsWith(`\0${outline.id}`)));
        return saved !== undefined;
      }, 15_000, "the completed native Test Results record");
      assert.ok(saved?.items);
      const itemFor = (item: vscode.TestItem): SavedItem | undefined => saved?.items?.find(
        (entry) => entry.item.extId.endsWith(`\0${item.id}`)
      );
      const outlineState = itemFor(outline);
      assert.equal(outlineState?.ownComputedState, PASSED, "final outline report must pass");
      for (const row of rows) {
        const state = itemFor(row);
        assert.equal(state?.tasks[0]?.state, PASSED, `${row.label} must be passed in VS Code`);
      }
      assert.equal(outlineState.computedState, PASSED, "outline must compute as passed");
    } finally {
      token.dispose();
      await settings.update("playwrightCommand", previousCommand, vscode.ConfigurationTarget.Workspace);
      if (previousEnv === undefined) {delete process.env[RETRY_ENV];}
      else {process.env[RETRY_ENV] = previousEnv;}
    }
  });
});
