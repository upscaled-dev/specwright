import * as assert from "node:assert/strict";
import * as vscode from "vscode";
import type { ExtensionApi } from "../../../extension";
import type { ExtensionConfig } from "../../../core/extension-config";
import type { TestDiscoveryManager } from "../../../core/test-discovery-manager";
import { FeatureParser } from "../../../parsers/feature-parser";
import { TraceabilityAdapterRegistry } from "../../../traceability/adapter-registry";
import { currentAdapterVersions } from "../../../traceability/adapter-contract";
import type { ConnectionCapability, TraceabilityAdapter } from "../../../traceability/contracts";
import { RunResultStore } from "../../../traceability/run-result-store";
import { TraceabilitySubsystem } from "../../../traceability/traceability-subsystem";
import { Logger } from "../../../utils/logger";
import { PlaywrightJsonParser } from "../../../utils/playwright-json-parser";

const EXTENSION_ID = "upscaled-dev.specwright";
const WATCH_TIMEOUT_MS = 20_000;
const QUIET_WINDOW_MS = 600;
const encoder = new TextEncoder();

async function waitUntil(
  predicate: () => boolean,
  description: string,
  timeoutMs = WATCH_TIMEOUT_MS
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) {return;}
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error(`Timed out after ${timeoutMs}ms waiting for: ${description}`);
}

async function writeUntil(
  file: vscode.Uri,
  content: (revision: number) => Uint8Array,
  predicate: () => boolean,
  description: string
): Promise<void> {
  const deadline = Date.now() + WATCH_TIMEOUT_MS;
  let revision = 1;
  while (Date.now() < deadline) {
    await vscode.workspace.fs.writeFile(file, content(revision));
    const settleDeadline = Date.now() + 250;
    while (Date.now() < settleDeadline) {
      if (predicate()) {return;}
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    revision += 1;
  }
  throw new Error(`Timed out after ${WATCH_TIMEOUT_MS}ms waiting for: ${description}`);
}

async function assertQuietWindow(assertion: () => void, description: string): Promise<void> {
  const deadline = Date.now() + QUIET_WINDOW_MS;
  while (Date.now() < deadline) {
    try {
      assertion();
    } catch (error) {
      throw new Error(description, { cause: error });
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  try {
    assertion();
  } catch (error) {
    throw new Error(description, { cause: error });
  }
}

async function attemptCleanup(
  label: string,
  action: () => void | Thenable<void>,
  failures: Error[]
): Promise<void> {
  try {
    await action();
  } catch (error) {
    failures.push(new Error(`${label} failed`, { cause: error }));
  }
}

async function deleteIfPresent(uri: vscode.Uri): Promise<void> {
  try {
    await vscode.workspace.fs.delete(uri, { recursive: true, useTrash: false });
  } catch (error) {
    if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") {return;}
    throw error;
  }
}

async function assertFileNotFound(uri: vscode.Uri): Promise<void> {
  let failure: unknown;
  try {
    await vscode.workspace.fs.stat(uri);
  } catch (error) {
    failure = error;
  }
  assert.ok(failure instanceof vscode.FileSystemError, "expected VS Code FileSystemError");
  assert.equal(failure.code, "FileNotFound");
}

function feature(tagged: boolean, revision: number): Uint8Array {
  return encoder.encode([
    "Feature: Traceability evidence lifecycle",
    "",
    ...(tagged ? ["@TEST_APP-1"] : []),
    `Scenario: real watcher revision ${revision}`,
    "  Given a bounded integration fixture",
    "",
  ].join("\n"));
}

function memento(): vscode.Memento {
  const values = new Map<string, unknown>();
  return {
    keys: () => [...values.keys()],
    get: <T>(key: string, fallback?: T): T | undefined =>
      (values.has(key) ? values.get(key) : fallback) as T | undefined,
    update: (key: string, value: unknown) => {
      if (value === undefined) {values.delete(key);} else {values.set(key, value);}
      return Promise.resolve();
    },
  };
}

suite("Traceability evidence watcher lifecycle", () => {
  test("real file events activate, retire, restore, and recover the implicit panel", async () => {
    const workspaceRoot = vscode.workspace.workspaceFolders?.[0]?.uri;
    assert.ok(workspaceRoot, "integration host must have a workspace folder");

    const extension = vscode.extensions.getExtension(EXTENSION_ID);
    assert.ok(extension, `extension ${EXTENSION_ID} not found`);
    const api = (await extension.activate()) as ExtensionApi;
    const hostTraceability = api.traceabilitySubsystem;
    assert.ok(hostTraceability, "traceabilitySubsystem not exposed by ExtensionApi");
    await hostTraceability.applyCurrent();
    const hostConfig = vscode.workspace.getConfiguration("playwrightBddRunner");
    const priorPanelSetting = hostConfig.inspect<boolean>("traceability.enablePanel")?.workspaceValue;
    const priorPanelActive = hostTraceability.traceabilityPanelActive;
    const scratch = vscode.Uri.joinPath(
      workspaceRoot,
      "features",
      `traceability-evidence-${Date.now()}`
    );
    const featureFile = vscode.Uri.joinPath(scratch, "lifecycle.feature");

    let subsystem: TraceabilitySubsystem | undefined;
    let runResults: RunResultStore | undefined;
    let connectionEvents: vscode.EventEmitter<void> | undefined;
    let isolatedActivity: (() => {
      evidenceScans: number;
      connectionProbes: number;
      connectionVerifications: number;
    }) | undefined;
    let testFailed = false;
    let testFailure: unknown;
    try {
      await hostConfig.update(
        "traceability.enablePanel",
        false,
        vscode.ConfigurationTarget.Workspace
      );
      await hostTraceability.applyCurrent();
      await waitUntil(
        () => hostTraceability.traceabilityPanelActive === false,
        "the activated extension traceability panel to be disabled"
      );
      await new Promise((resolve) => setTimeout(resolve, 250));

      await vscode.workspace.fs.createDirectory(scratch);
      await vscode.workspace.fs.writeFile(featureFile, feature(false, 0));

      let provider = "initial";
      const testPattern = "**/*.feature";
      const config = {
        get enableTraceabilityPanel(): boolean {return false;},
        get traceabilityPanelPreference(): boolean | undefined {return undefined;},
        get hasExplicitXrayConfiguration(): boolean {return false;},
        get traceabilityProvider(): string {return provider;},
        get testFilePattern(): string {return testPattern;},
        get traceabilityTestTagPrefix(): string {return "TEST_";},
        get traceabilityReqTagPrefix(): string {return "REQ_";},
        get xrayApiRegion(): string {return "global";},
        get xrayDefaultProjectKey(): string {return "";},
        addChangeListener(): vscode.Disposable {return { dispose: () => undefined };},
      } as unknown as ExtensionConfig;

      let discoveryRuns = 0;
      const discovery = {
        discoverTestFiles: async (): Promise<string[]> => {
          discoveryRuns += 1;
          try {
            await vscode.workspace.fs.stat(featureFile);
            return [featureFile.fsPath];
          } catch {
            return [];
          }
        },
        dispose: (): void => undefined,
      } as unknown as TestDiscoveryManager;

      let evidenceScans = 0;
      const hasEvidence = async (): Promise<boolean> => {
        evidenceScans += 1;
        try {
          const content = new TextDecoder().decode(await vscode.workspace.fs.readFile(featureFile));
          return /@TEST_/i.test(content);
        } catch {
          return false;
        }
      };

      connectionEvents = new vscode.EventEmitter<void>();
      let connectionProbes = 0;
      let connectionVerifications = 0;
      isolatedActivity = () => ({
        evidenceScans,
        connectionProbes,
        connectionVerifications,
      });
      const connection: ConnectionCapability = {
        onDidChange: connectionEvents.event,
        label: "bounded fake",
        isConnected: async () => {connectionProbes += 1; return true;},
        verify: async () => {
          connectionVerifications += 1;
          return { status: "ok", message: "bounded fake connected" };
        },
      };

      let failReplacementInitialization = true;
      const adapter = (id: string): TraceabilityAdapter => ({
        id,
        label: id,
        keyGrammar: {
          testPrefix: "TEST_",
          reqPrefix: "REQ_",
          keyShape: /^[A-Z]+-\d+$/,
          canonicalizeKey: (key) => key.toUpperCase(),
        },
        browseUrl: () => undefined,
        connection,
        initialize: async (signal) => {
          if (id !== "replacement" || !failReplacementInitialization) {return;}
          failReplacementInitialization = false;
          await new Promise<void>((resolve) => {
            signal.addEventListener("abort", () => resolve(), { once: true });
          });
        },
        dispose: async () => undefined,
      });
      const registry = new TraceabilityAdapterRegistry({
        initializeTimeoutMs: 100,
        disposeTimeoutMs: 100,
      });
      for (const id of ["initial", "replacement"]) {
        registry.register({
          id,
          ...currentAdapterVersions("connection"),
          create: () => adapter(id),
        });
      }

      const logger = {
        debug: (): void => undefined,
        info: (): void => undefined,
        warn: (): void => undefined,
        error: (): void => undefined,
      } as unknown as Logger;
      runResults = new RunResultStore();
      subsystem = new TraceabilitySubsystem(
        config,
        registry,
        FeatureParser.create(logger),
        discovery,
        PlaywrightJsonParser.create(logger),
        runResults,
        logger,
        memento(),
        hasEvidence
      );
      subsystem.rebuildDebounceMs = 25;

      await subsystem.applyCurrent();
      assert.equal(subsystem.traceabilityPanelActive, false);
      assert.equal(evidenceScans, 1);

      await writeUntil(
        featureFile,
        (revision) => feature(false, revision),
        () => evidenceScans > 1,
        "the isolated native watcher to warm up"
      );
      await writeUntil(
        featureFile,
        (revision) => feature(true, revision),
        () => subsystem?.traceabilityPanelActive === true,
        "the first traceability tag event to activate the isolated panel"
      );
      await waitUntil(
        () => discoveryRuns > 0 && connectionVerifications > 0,
        "the activated model and bounded connection probe to settle"
      );

      const scansAfterActivation = evidenceScans;
      const probesAfterActivation = connectionProbes;
      const verificationsAfterActivation = connectionVerifications;
      const expectedQuietActivity = {
        evidenceScans: scansAfterActivation,
        connectionProbes: probesAfterActivation,
        connectionVerifications: verificationsAfterActivation,
      };
      for (const revision of [100, 101]) {
        const priorDiscoveryRuns = discoveryRuns;
        await vscode.workspace.fs.writeFile(featureFile, feature(true, revision));
        await waitUntil(
          () => discoveryRuns > priorDiscoveryRuns,
          `model watcher rebuild for tagged save ${revision}`
        );
        await assertQuietWindow(() => {
          assert.deepEqual(
            isolatedActivity?.(),
            expectedQuietActivity,
            `tagged save ${revision} triggered delayed evidence or connection work`
          );
        }, `tagged save ${revision} to remain model-only`);
      }

      provider = "replacement";
      await subsystem.applyCurrent();
      assert.equal(subsystem.traceabilityPanelActive, false);
      assert.equal(failReplacementInitialization, false);

      const scansAfterFailedReplacement = evidenceScans;
      await writeUntil(
        featureFile,
        (revision) => feature(true, revision + 200),
        () => subsystem?.traceabilityPanelActive === true,
        "restored evidence monitoring to recover adapter activation"
      );
      assert.ok(evidenceScans > scansAfterFailedReplacement);
      assert.equal(subsystem.getActiveAdapter()?.id, "replacement");
    } catch (error) {
      testFailed = true;
      testFailure = error;
    }

    const cleanupFailures: Error[] = [];
    await attemptCleanup(
      "isolated traceability subsystem shutdown",
      () => subsystem?.shutdown() ?? Promise.resolve(),
      cleanupFailures
    );
    await attemptCleanup(
      "connection event disposal",
      () => connectionEvents?.dispose(),
      cleanupFailures
    );
    await attemptCleanup(
      "run-result store disposal",
      () => runResults?.dispose(),
      cleanupFailures
    );
    await attemptCleanup(
      "scratch directory deletion",
      () => deleteIfPresent(scratch),
      cleanupFailures
    );
    await attemptCleanup(
      "host traceability setting restoration",
      () => hostConfig.update(
        "traceability.enablePanel",
        priorPanelSetting,
        vscode.ConfigurationTarget.Workspace
      ),
      cleanupFailures
    );
    await attemptCleanup(
      "host traceability reconciliation",
      () => hostTraceability.applyCurrent(),
      cleanupFailures
    );
    await attemptCleanup(
      "host traceability panel restoration",
      () => waitUntil(
        () => hostTraceability.traceabilityPanelActive === priorPanelActive,
        `the activated extension traceability panel to return to ${String(priorPanelActive)}`,
        5_000
      ),
      cleanupFailures
    );
    await attemptCleanup(
      "post-cleanup quiet window",
      async () => {
        await assertFileNotFound(scratch);
        const settledActivity = isolatedActivity?.();
        await assertQuietWindow(() => {
          assert.equal(hostTraceability.traceabilityPanelActive, priorPanelActive);
          assert.deepEqual(isolatedActivity?.(), settledActivity);
        }, "cleanup state to remain isolated from later tests");
        await assertFileNotFound(scratch);
      },
      cleanupFailures
    );

    const failures = [
      ...(testFailed ? [testFailure] : []),
      ...cleanupFailures,
    ];
    if (failures.length === 1) {
      throw failures[0];
    }
    if (failures.length > 1) {
      throw new AggregateError(failures, "Traceability evidence lifecycle test and cleanup failed");
    }
  });
});
