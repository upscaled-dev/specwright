import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { ExtensionApi } from "../../../extension";

const EXTENSION_ID = "upscaled-dev.specwright";

suite("Registered run profiles", () => {
  test("exactly 3 profiles with expected labels, kinds and isDefault flags", async () => {
    const ext = vscode.extensions.getExtension(EXTENSION_ID);
    if (!ext) { throw new Error(`Extension ${EXTENSION_ID} not found`); }
    const api = (await ext.activate()) as ExtensionApi;
    assert.ok(api.testProvider, "testProvider not exposed by ExtensionApi");

    const profiles = api.testProvider.registeredRunProfiles;
    assert.equal(profiles.length, 3, "should register exactly 3 run profiles");

    const labels = profiles.map((p) => p.label);
    assert.deepEqual(labels, ["Run", "Debug", "Run in Parallel"]);

    const kinds = profiles.map((p) => p.kind);
    assert.deepEqual(kinds, [
      vscode.TestRunProfileKind.Run,
      vscode.TestRunProfileKind.Debug,
      vscode.TestRunProfileKind.Run,
    ]);

    const isDefault = profiles.map((p) => p.isDefault);
    assert.deepEqual(isDefault, [true, true, false]);
  });
});
