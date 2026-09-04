import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as vscode from "vscode";
import type { ExtensionApi } from "../../../extension";
import type { RunArtifact } from "../../../traceability/contracts";
import { runnableRuns } from "../../../traceability/publish-flow";
import {
  activateExtension,
  cannedReport,
  findScenario,
  waitUntil,
  type TestProviderApi,
} from "./fixture-host";

const MAPPED_SCENARIO = "Sealed run scenario";
// The in-memory adapter's grammar canonicalizes the fixture's `@TC-7` tag to this key.
const MAPPED_TEST_KEY = "7";
const SEAL_TIMEOUT_MS = 30_000;
const READY_TIMEOUT_MS = 20_000;

type ArtifactCatalog = NonNullable<ExtensionApi["runArtifacts"]>;

// Every artifact the drive sealed, read once both the run and the catalog change have settled.
async function sealedRuns(
  catalog: ArtifactCatalog,
  drive: () => Thenable<unknown>
): Promise<RunArtifact[]> {
  const known = new Set(catalog.list().map((artifact) => artifact.id));
  const fresh = (): RunArtifact[] => catalog.list().filter((artifact) => !known.has(artifact.id));
  let timer!: ReturnType<typeof setTimeout>;
  let subscription!: vscode.Disposable;
  const sealed = new Promise<void>((resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`No run artifact was sealed within ${SEAL_TIMEOUT_MS}ms`)),
      SEAL_TIMEOUT_MS
    );
    subscription = catalog.onDidChange(() => {
      if (fresh().length > 0) {resolve();}
    });
  });
  const driven = Promise.resolve(drive());
  // Promise.all reports only the first failure, so both are observed here: an unobserved rejection
  // would surface later against whichever suite is running by then.
  sealed.catch(() => undefined);
  driven.catch(() => undefined);
  try {
    await Promise.all([sealed, driven]);
    return fresh();
  } finally {
    clearTimeout(timer);
    subscription.dispose();
  }
}

function assertPublishable(catalog: ArtifactCatalog, sealed: readonly RunArtifact[]): void {
  assert.equal(sealed.length, 1, `expected the drive to seal one run, got ${sealed.length}`);
  const artifact = sealed[0];
  assert.ok(artifact);
  const keys = artifact.results.map((result) => result.testKey ?? "unmapped");
  const carried = keys.join(", ") || "no results";
  assert.equal(artifact.state, "complete", `sealed run ${artifact.id} is ${artifact.state}`);
  assert.ok(
    keys.includes(MAPPED_TEST_KEY),
    `the sealed run carries no result mapped to ${MAPPED_TEST_KEY} (keys: ${carried})`
  );
  assert.ok(
    runnableRuns(catalog.list()).some((run) => run.id === artifact.id),
    `the sealed run is not one the publish flow would offer (keys: ${carried})`
  );
}

suite("A run seals a publishable artifact", () => {
  let api: ExtensionApi | undefined;
  let provider: TestProviderApi | undefined;
  let catalog: ArtifactCatalog | undefined;
  let priorPanelSetting: boolean | undefined;
  let priorProvider: string | undefined;

  suiteSetup(async () => {
    const activated = await activateExtension();
    api = activated;
    assert.ok(activated.testProvider, "testProvider not exposed by ExtensionApi");
    assert.ok(activated.runArtifacts, "runArtifacts not exposed by ExtensionApi");
    assert.ok(activated.traceabilitySubsystem, "traceabilitySubsystem not exposed by ExtensionApi");
    assert.ok(activated.traceabilityView, "traceabilityView not exposed by ExtensionApi");
    provider = activated.testProvider;
    catalog = activated.runArtifacts;

    const discovered = activated.testProvider;
    await waitUntil(
      () => findScenario(discovered, MAPPED_SCENARIO) !== undefined,
      READY_TIMEOUT_MS,
      `the fixture's '${MAPPED_SCENARIO}' to be discovered`
    );
    const target = findScenario(discovered, MAPPED_SCENARIO);
    assert.ok(target, `'${MAPPED_SCENARIO}' not found in the discovered tree`);

    const config = vscode.workspace.getConfiguration("playwrightBddRunner");
    priorPanelSetting = config.inspect<boolean>("traceability.enablePanel")?.workspaceValue;
    priorProvider = config.inspect<string>("traceability.provider")?.workspaceValue;
    await config.update("traceability.provider", "in-memory", vscode.ConfigurationTarget.Workspace);
    await config.update("traceability.enablePanel", true, vscode.ConfigurationTarget.Workspace);
    await activated.traceabilitySubsystem.applyCurrent();

    const view = activated.traceabilityView;
    await waitUntil(
      () => view.currentProjection.state === "ready"
        && view.currentProjection.labels.includes(MAPPED_TEST_KEY)
        && view.currentProjection.labels.includes(MAPPED_SCENARIO),
      READY_TIMEOUT_MS,
      `the traceability model to map ${MAPPED_SCENARIO} to ${MAPPED_TEST_KEY}`
    );

    discovered.overrideShellRunner(async (_command, _workingDir, env) => {
      const reportPath = env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"];
      if (reportPath) {
        fs.writeFileSync(reportPath, cannedReport(target, {
          featureTitle: "Mapped fixture feature",
          specFile: "features/mapped.feature.spec.js",
          status: "passed",
        }));
      }
      return { success: true, output: "", error: "", returnCode: 0 };
    });
  });

  // Tolerant of a partial setup: the settings restores run even when activation never got that far.
  suiteTeardown(async () => {
    provider?.restoreShellRunner();
    const config = vscode.workspace.getConfiguration("playwrightBddRunner");
    await config.update("traceability.provider", priorProvider, vscode.ConfigurationTarget.Workspace);
    await config.update("traceability.enablePanel", priorPanelSetting, vscode.ConfigurationTarget.Workspace);
    await api?.traceabilitySubsystem?.applyCurrent();
  });

  test("the Run profile seals a run the publish flow would offer", async () => {
    assert.ok(provider && catalog, "suite setup did not complete");
    const profile = provider.registeredRunProfiles.find((candidate) => candidate.label === "Run");
    assert.ok(profile, '"Run" profile not registered');
    const request = new vscode.TestRunRequest(undefined, undefined, profile);
    const token = new vscode.CancellationTokenSource().token;

    const sealed = await sealedRuns(catalog, () => Promise.resolve(profile.runHandler(request, token)));

    assertPublishable(catalog, sealed);
  });

  test("the Run All Tests command seals a run the publish flow would offer", async () => {
    assert.ok(catalog, "suite setup did not complete");

    const sealed = await sealedRuns(
      catalog,
      () => vscode.commands.executeCommand("playwrightBddRunner.runAllTests")
    );

    assertPublishable(catalog, sealed);
  });
});
