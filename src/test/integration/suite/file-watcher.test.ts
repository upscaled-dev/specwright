import * as assert from "node:assert/strict";
import * as path from "node:path";
import * as vscode from "vscode";
import type { ExtensionApi } from "../../../extension";

const EXTENSION_ID = "upscaled-dev.specwright";

type TestProviderApi = NonNullable<ExtensionApi["testProvider"]>;

const encoder = new TextEncoder();

// Headless VS Code FileSystemWatcher events can be slow, and the very first event after
// activation is the slowest (it must warm up the native watcher). Allow generous propagation
// time; the Mocha per-test timeout (60s) is the real ceiling.
const WATCH_TIMEOUT_MS = 20_000;

async function getProvider(): Promise<TestProviderApi> {
  const ext = vscode.extensions.getExtension(EXTENSION_ID);
  if (!ext) { throw new Error(`Extension ${EXTENSION_ID} not found`); }
  const api = (await ext.activate()) as ExtensionApi;
  assert.ok(api.testProvider, "testProvider not exposed by ExtensionApi");
  return api.testProvider;
}

async function waitUntil(
  predicate: () => boolean,
  timeoutMs: number,
  description: string
): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (predicate()) { return; }
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

function scratchDirUri(): vscode.Uri {
  const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) { throw new Error("No workspace folder open in integration host"); }
  return vscode.Uri.file(path.join(workspaceRoot, "features", "watcher-scratch"));
}

function featureContent(scenarioName: string): Uint8Array {
  return encoder.encode(
    [
      "Feature: Watcher scratch",
      "",
      `  Scenario: ${scenarioName}`,
      "    Given I am on the test page",
      "    When I click the test button",
      "    Then I should see the test result",
      "",
    ].join("\n")
  );
}

function mapHasScenarioNamed(provider: TestProviderApi, name: string): boolean {
  for (const scenario of provider.testIdToScenarioMap.values()) {
    if (scenario.name === name) { return true; }
  }
  return false;
}

suite(".feature FileSystemWatcher reacts to create/change/delete", () => {
  let provider: TestProviderApi;
  let scratchDir: vscode.Uri;

  suiteSetup(async () => {
    provider = await getProvider();
    scratchDir = scratchDirUri();
    await vscode.workspace.fs.createDirectory(scratchDir);

    // Warm up the watcher: the first create event after activation is the flaky one (the native
    // watcher hasn't fully attached yet). Prime it with a throwaway file and wait for it to be
    // picked up before the asserted tests run, so they aren't the ones paying that cost.
    const warmUp = vscode.Uri.file(path.join(scratchDir.fsPath, "warmup.feature"));
    const warmName = `Watcher warmup ${Date.now()}`;
    await vscode.workspace.fs.writeFile(warmUp, featureContent(warmName));
    try {
      await waitUntil(
        () => mapHasScenarioNamed(provider, warmName),
        WATCH_TIMEOUT_MS,
        "watcher warm-up file to be picked up"
      );
    } catch {
      // Best-effort warm-up; the individual tests still have their own generous timeouts.
    } finally {
      try { await vscode.workspace.fs.delete(warmUp, { useTrash: false }); } catch { /* ignore */ }
    }
  });

  suiteTeardown(async () => {
    try {
      await vscode.workspace.fs.delete(scratchDir, { recursive: true, useTrash: false });
    } catch {
      // best-effort cleanup; never fail teardown
    }
  });

  test("create: new .feature file appears in the scenario map", async () => {
    const unique = `Watcher added scenario ${Date.now()}`;
    const fileUri = vscode.Uri.file(path.join(scratchDir.fsPath, "added.feature"));

    await vscode.workspace.fs.writeFile(fileUri, featureContent(unique));

    await waitUntil(
      () => mapHasScenarioNamed(provider, unique),
      WATCH_TIMEOUT_MS,
      `scenario "${unique}" to appear in testIdToScenarioMap after create`
    );

    assert.ok(
      mapHasScenarioNamed(provider, unique),
      `expected scenario "${unique}" to be present after create`
    );
  });

  test("change: modified .feature file's scenarios update", async () => {
    const initial = `Initial scenario ${Date.now()}`;
    const renamed = `Renamed scenario ${Date.now()}`;
    const fileUri = vscode.Uri.file(path.join(scratchDir.fsPath, "changed.feature"));

    await vscode.workspace.fs.writeFile(fileUri, featureContent(initial));
    await waitUntil(
      () => mapHasScenarioNamed(provider, initial),
      WATCH_TIMEOUT_MS,
      `initial scenario "${initial}" to appear before mutation`
    );

    await vscode.workspace.fs.writeFile(fileUri, featureContent(renamed));
    await waitUntil(
      () => mapHasScenarioNamed(provider, renamed) && !mapHasScenarioNamed(provider, initial),
      WATCH_TIMEOUT_MS,
      `scenario rename from "${initial}" to "${renamed}" to propagate`
    );

    assert.ok(
      mapHasScenarioNamed(provider, renamed),
      `expected renamed scenario "${renamed}" to be present after change`
    );
    assert.ok(
      !mapHasScenarioNamed(provider, initial),
      `expected old scenario "${initial}" to be gone after change`
    );
  });

  test("delete: removed .feature file's scenarios vanish", async () => {
    const unique = `Will be deleted ${Date.now()}`;
    const fileUri = vscode.Uri.file(path.join(scratchDir.fsPath, "deleted.feature"));

    await vscode.workspace.fs.writeFile(fileUri, featureContent(unique));
    await waitUntil(
      () => mapHasScenarioNamed(provider, unique),
      WATCH_TIMEOUT_MS,
      `scenario "${unique}" to appear before delete`
    );

    await vscode.workspace.fs.delete(fileUri, { useTrash: false });
    await waitUntil(
      () => !mapHasScenarioNamed(provider, unique),
      WATCH_TIMEOUT_MS,
      `scenario "${unique}" to vanish after delete`
    );

    assert.ok(
      !mapHasScenarioNamed(provider, unique),
      `expected scenario "${unique}" to be gone after delete`
    );
  });
});
