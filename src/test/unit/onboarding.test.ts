import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import {
  resolveTraceabilityPanelEnabled,
  resolveWorkspaceReadiness,
} from "../../core/onboarding";
import type { ExecutionDiagnostic, ExecutionGateway, ExecutionIdentity } from "../../core/run-contracts";
import { OnboardingCommands } from "../../commands/onboarding-commands";

const legacy: ExecutionIdentity = { engine: "legacy-direct", schemaProfile: "legacy-v1" };
const core: ExecutionIdentity = { engine: "core-client", schemaProfile: "core-preview-v1" };

function diagnostic(
  identity: ExecutionIdentity,
  severity: ExecutionDiagnostic["severity"],
  message: string
): ExecutionDiagnostic {
  return { code: `${identity.engine}.${severity}`, identity, severity, message };
}

describe("resolveWorkspaceReadiness", () => {
  const project = {
    workspace: true,
    featureFiles: 2,
    stepDefinitions: 3,
    stepDefinitionPaths: ["steps/**/*.ts"],
  };

  it("reports a ready project without assuming an execution-provider implementation", () => {
    const legacyReady = resolveWorkspaceReadiness(project, { diagnostics: [] });
    const coreReady = resolveWorkspaceReadiness(project, {
      diagnostics: [diagnostic(core, "info", "Core service connected")],
    });

    expect(legacyReady.readyToRun).toBe(true);
    expect(coreReady.readyToRun).toBe(true);
    expect(coreReady.executionProvider.diagnostics[0]?.identity).toEqual(core);
    expect(legacyReady.summary).not.toMatch(/playwright-bdd/i);
  });

  it("keeps project and provider problems in their own capability groups", () => {
    const readiness = resolveWorkspaceReadiness(
      { ...project, featureFiles: 0, stepDefinitions: 0 },
      { diagnostics: [diagnostic(legacy, "error", "Execution provider unavailable")] }
    );

    expect(readiness.readyToRun).toBe(false);
    expect(readiness.project.featureFiles).toBe(0);
    expect(readiness.executionProvider.diagnostics).toHaveLength(1);
    expect(readiness.summary).toContain("Add a .feature file");
    expect(readiness.summary).toContain("Execution provider unavailable");
  });
});

describe("resolveTraceabilityPanelEnabled", () => {
  it("makes every explicit value authoritative over evidence", () => {
    expect(resolveTraceabilityPanelEnabled({ explicit: false, configured: true, tagged: true }))
      .toBe(false);
    expect(resolveTraceabilityPanelEnabled({ explicit: true, configured: false, tagged: false }))
      .toBe(true);
  });

  it("uses existing configuration or tags only when no preference exists", () => {
    expect(resolveTraceabilityPanelEnabled({ explicit: undefined, configured: true, tagged: false }))
      .toBe(true);
    expect(resolveTraceabilityPanelEnabled({ explicit: undefined, configured: false, tagged: true }))
      .toBe(true);
    expect(resolveTraceabilityPanelEnabled({ explicit: undefined, configured: false, tagged: false }))
      .toBe(false);
  });
});

describe("OnboardingCommands diagnosis recovery", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refreshes discovery before focusing Testing after a ready diagnosis", async () => {
    vi.spyOn(vscode.window, "showInformationMessage").mockResolvedValue("Open Testing" as never);
    const execute = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    const gateway = {
      diagnose: () => Promise.resolve([]),
    } as unknown as ExecutionGateway;
    const commands = new OnboardingCommands(gateway, () => ({
      projectCapabilities: () => Promise.resolve({
        workspace: true,
        featureFiles: 1,
        stepDefinitions: 2,
        stepDefinitionPaths: ["steps/**/*.ts"],
      }),
    }));

    await commands.diagnoseWorkspace();

    expect(execute.mock.calls.map((call) => call[0])).toEqual([
      "playwrightBddRunner.discoverTests",
      "workbench.view.testing.focus",
    ]);
  });
});
