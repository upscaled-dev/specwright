import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { ExtensionApi } from "../../../extension";

const EXTENSION_ID = "upscaled-dev.specwright";

suite('"Run in Parallel" profile wiring', () => {
  let api: ExtensionApi;
  let parallelProfile: vscode.TestRunProfile;

  suiteSetup(async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    if (!ext) { throw new Error(`Extension ${EXTENSION_ID} not found`); }
    api = (await ext.activate()) as ExtensionApi;
    assert.ok(api.testProvider, "testProvider not exposed by ExtensionApi");
    assert.ok(
      typeof api.seedParallelProfilePrompted === "function",
      "ExtensionApi.seedParallelProfilePrompted is required for this test"
    );

    await api.seedParallelProfilePrompted(true);
    await vscode.workspace
      .getConfiguration("playwrightBddRunner")
      .update("parallelExecution", false, vscode.ConfigurationTarget.Workspace);

    const profile = api.testProvider.registeredRunProfiles.find(
      (p) => p.label === "Run in Parallel"
    );
    assert.ok(profile, '"Run in Parallel" profile not registered');
    parallelProfile = profile;
  });

  test("invocation flips lastForcedWorkers to 7 (the maxParallelProcesses fixture)", async () => {
    assert.ok(api.testProvider);
    const request = new vscode.TestRunRequest([], undefined, parallelProfile);
    const token = new vscode.CancellationTokenSource().token;

    await Promise.resolve(parallelProfile.runHandler(request, token));

    assert.strictEqual(
      api.testProvider.commandBuilder.lastForcedWorkers,
      7,
      "parallel profile should record 7 workers (from fixture maxParallelProcesses)"
    );
    assert.strictEqual(
      api.testProvider.commandBuilder.isForceParallel(),
      false,
      "isForceParallel should be cleared by the handler's finally block"
    );
  });

  test("second invocation does not hang on a re-prompt", async () => {
    assert.ok(api.testProvider);
    const request = new vscode.TestRunRequest([], undefined, parallelProfile);
    const token = new vscode.CancellationTokenSource().token;

    await Promise.resolve(parallelProfile.runHandler(request, token));

    assert.strictEqual(api.testProvider.commandBuilder.lastForcedWorkers, 7);
    assert.strictEqual(api.testProvider.commandBuilder.isForceParallel(), false);
  });
});
