import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { ExtensionApi } from "../../../extension";

const FIND_COMMAND = "playwrightBddRunner.traceability.find";
const TRACEABILITY_FOCUS_COMMAND = "playwrightBddRunner.traceability.focus";
const EXTENSION_ID = "upscaled-dev.specwright";

suite("Traceability webview find bridge", () => {
  test("commits a populated in-memory projection before acknowledging filter focus", async () => {
    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} must be installed`);
    const api = (await extension.activate()) as ExtensionApi;
    const traceabilityView = api.traceabilityView;
    const traceabilitySubsystem = api.traceabilitySubsystem;
    assert.ok(traceabilityView, "traceabilityView test API must be available");
    assert.ok(traceabilitySubsystem, "traceabilitySubsystem test API must be available");

    const commands = await vscode.commands.getCommands(true);

    for (const command of [FIND_COMMAND, TRACEABILITY_FOCUS_COMMAND]) {
      assert.ok(commands.includes(command), `${command} must be registered by this VS Code host`);
    }

    const config = vscode.workspace.getConfiguration("playwrightBddRunner");
    const priorPanelSetting = config.inspect<boolean>("traceability.enablePanel")?.workspaceValue;
    const priorProvider = config.inspect<string>("traceability.provider")?.workspaceValue;
    try {
      await config.update("traceability.provider", "in-memory", vscode.ConfigurationTarget.Workspace);
      await config.update("traceability.enablePanel", true, vscode.ConfigurationTarget.Workspace);
      await traceabilitySubsystem.applyCurrent();
      assert.equal(traceabilitySubsystem.traceabilityPanelActive, true, "Traceability panel must be active before revealing its view");

      await waitFor(
        () => traceabilityView.currentProjection.state === "ready"
          && traceabilityView.currentProjection.total > 1
          && traceabilityView.currentProjection.labels.includes("Plain scenario"),
        "a populated projection containing the fixture Plain scenario"
      );

      await vscode.commands.executeCommand(TRACEABILITY_FOCUS_COMMAND);
      await waitForSignal(
        () => traceabilityView.clientReady,
        traceabilityView.onDidReceiveClientSignal,
        "Traceability client ready"
      );

      const before = traceabilityView.acknowledgedFocusCount;
      await vscode.commands.executeCommand(FIND_COMMAND);
      await waitForSignal(
        () => traceabilityView.acknowledgedFocusCount > before,
        traceabilityView.onDidReceiveClientSignal,
        "Traceability filter focus acknowledgement"
      );
    } finally {
      await config.update("traceability.provider", priorProvider, vscode.ConfigurationTarget.Workspace);
      await config.update("traceability.enablePanel", priorPanelSetting, vscode.ConfigurationTarget.Workspace);
      await traceabilitySubsystem.applyCurrent();
    }
  });
});

function waitFor(accepted: () => boolean, label: string): Promise<void> {
  if (accepted()) { return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + 10_000;
    const timer = setInterval(() => {
      if (accepted()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() >= deadline) {
        clearInterval(timer);
        reject(new Error(`${label} was not observed within 10 seconds.`));
      }
    }, 50);
  });
}

function waitForSignal(
  accepted: () => boolean,
  event: vscode.Event<"ready" | "focused">,
  label: string
): Promise<void> {
  if (accepted()) { return Promise.resolve(); }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      subscription.dispose();
      reject(new Error(`${label} was not observed within 10 seconds.`));
    }, 10_000);
    const subscription = event(() => {
      if (!accepted()) { return; }
      clearTimeout(timer);
      subscription.dispose();
      resolve();
    });
  });
}
