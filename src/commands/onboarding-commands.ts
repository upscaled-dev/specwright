import * as vscode from "vscode";
import type { ExecutionGateway } from "../core/run-contracts";
import {
  resolveWorkspaceReadiness,
  type ProjectCapabilities,
} from "../core/onboarding";
import { configurationTarget } from "../core/extension-config";

const CONFIG_NAMESPACE = "playwrightBddRunner";
const TRACEABILITY_PANEL_SETTING = "traceability.enablePanel";

export interface ProjectCapabilitySource {
  projectCapabilities(): Promise<ProjectCapabilities>;
}

export class OnboardingCommands {
  constructor(
    private readonly executionGateway: ExecutionGateway,
    private readonly projectCapabilities: () => ProjectCapabilitySource | undefined
  ) {}

  public async diagnoseWorkspace(): Promise<void> {
    const source = this.projectCapabilities();
    if (!source) {
      throw new Error("Workspace diagnosis is unavailable: provider registry not wired.");
    }
    const [project, diagnostics] = await Promise.all([
      source.projectCapabilities(),
      this.executionGateway.diagnose(),
    ]);
    const readiness = resolveWorkspaceReadiness(project, { diagnostics });
    const action = readiness.readyToRun
      ? await vscode.window.showInformationMessage(readiness.summary, "Open Testing")
      : await vscode.window.showWarningMessage(
          readiness.summary,
          "Open Testing",
          "Configure Step Paths"
        );
    if (action === "Open Testing") {
      await vscode.commands.executeCommand("playwrightBddRunner.discoverTests");
      await this.openTesting();
    } else if (action === "Configure Step Paths") {
      await this.configureStepPaths();
    }
  }

  public async openTesting(): Promise<void> {
    await vscode.commands.executeCommand("workbench.view.testing.focus");
  }

  public async openSteps(): Promise<void> {
    await vscode.commands.executeCommand("playwrightBddRunner.stepsExplorer.focus");
  }

  public async configureStepPaths(): Promise<void> {
    await vscode.commands.executeCommand(
      "workbench.action.openSettings",
      "playwrightBddRunner.stepDefinitionPaths"
    );
  }

  public async enableTraceability(announce = true): Promise<void> {
    const config = vscode.workspace.getConfiguration(CONFIG_NAMESPACE);
    await config.update(
      TRACEABILITY_PANEL_SETTING,
      true,
      configurationTarget(config, TRACEABILITY_PANEL_SETTING)
    );
    if (announce) {
      await vscode.window.showInformationMessage("Xray Traceability enabled.");
    }
  }
}
