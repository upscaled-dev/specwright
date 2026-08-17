import type { ExecutionDiagnostic } from "./run-contracts";

export interface ProjectCapabilities {
  readonly workspace: boolean;
  readonly featureFiles: number;
  readonly stepDefinitions: number;
  readonly stepDefinitionPaths: readonly string[];
}

export interface ExecutionProviderCapabilities {
  readonly diagnostics: readonly ExecutionDiagnostic[];
}

export interface WorkspaceReadiness {
  readonly project: ProjectCapabilities;
  readonly executionProvider: ExecutionProviderCapabilities;
  readonly readyToRun: boolean;
  readonly summary: string;
}

/** Total, presentation-ready resolver over editor-neutral capability data. */
export function resolveWorkspaceReadiness(
  project: ProjectCapabilities,
  executionProvider: ExecutionProviderCapabilities
): WorkspaceReadiness {
  const blocking = executionProvider.diagnostics.filter(({ severity }) => severity === "error");
  const notices: string[] = [];
  if (!project.workspace) {
    notices.push("Open a workspace folder");
  } else if (project.featureFiles === 0) {
    notices.push("Add a .feature file");
  }
  if (project.stepDefinitions === 0) {
    notices.push("No step definitions matched the configured paths");
  }
  notices.push(...blocking.map(({ message }) => message));

  const readyToRun = project.workspace && project.featureFiles > 0 && blocking.length === 0;
  const summary = readyToRun
    ? `Ready to run ${project.featureFiles} feature file${project.featureFiles === 1 ? "" : "s"}. ` +
      `${project.stepDefinitions} step definition${project.stepDefinitions === 1 ? "" : "s"} found.`
    : notices.join(" ");
  return { project, executionProvider, readyToRun, summary };
}

export interface TraceabilityPanelEvidence {
  readonly explicit: boolean | undefined;
  readonly configured: boolean;
  readonly tagged: boolean;
}

/** Explicit user choice is authoritative; evidence only supplies the clean-install default. */
export function resolveTraceabilityPanelEnabled(evidence: TraceabilityPanelEvidence): boolean {
  return evidence.explicit ?? (evidence.configured || evidence.tagged);
}
