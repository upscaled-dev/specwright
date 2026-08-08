import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { PRIVILEGED_COMMANDS } from "../../commands/command-manager";

interface Manifest {
  capabilities: {
    untrustedWorkspaces: {
      supported: string;
      restrictedConfigurations: string[];
    };
  };
  contributes: {
    commands: Array<{ command: string; enablement?: string }>;
    viewsWelcome: Array<{ when?: string; contents: string }>;
  };
}

describe("workspace trust manifest", () => {
  const manifest = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, "../../../package.json"), "utf8")
  ) as Manifest;

  it("declares limited support and restricts repository-controlled execution settings", () => {
    expect(manifest.capabilities.untrustedWorkspaces.supported).toBe("limited");
    expect(manifest.capabilities.untrustedWorkspaces.restrictedConfigurations).toEqual([
      "playwrightBddRunner.playwrightCommand",
      "playwrightBddRunner.bddgenCommand",
      "playwrightBddRunner.preRunCommand",
      "playwrightBddRunner.featuresGenDir",
      "playwrightBddRunner.workingDirectory",
      "playwrightBddRunner.testFilePattern",
      "playwrightBddRunner.parallelExecution",
      "playwrightBddRunner.maxParallelProcesses",
      "playwrightBddRunner.reporter",
      "playwrightBddRunner.useConfigReporters",
      "playwrightBddRunner.tags",
      "playwrightBddRunner.dryRun",
      "playwrightBddRunner.stepDefinitionPaths",
      "playwrightBddRunner.stepDefinitionExcludePaths",
      "playwrightBddRunner.traceability.provider",
      "playwrightBddRunner.traceability.testTagPrefix",
      "playwrightBddRunner.traceability.reqTagPrefix",
      "playwrightBddRunner.xray.siteUrl",
      "playwrightBddRunner.xray.apiRegion",
      "playwrightBddRunner.xray.syncProjectKeys",
      "playwrightBddRunner.xray.defaultProjectKey",
      "playwrightBddRunner.xray.executionIssueType",
      "playwrightBddRunner.xray.reportGlob",
      "playwrightBddRunner.xray.attachTo",
    ]);
  });

  it("disables privileged contributed commands and explains how to grant trust", () => {
    const manifestPrivileged = manifest.contributes.commands
      .filter(({ enablement }) => enablement === "isWorkspaceTrusted")
      .map(({ command }) => command);
    expect(new Set(manifestPrivileged)).toEqual(PRIVILEGED_COMMANDS);
    const restricted = manifest.contributes.viewsWelcome.find(({ when }) => when === "!isWorkspaceTrusted");
    expect(restricted?.contents).toContain("command:workbench.trust.manage");
  });
});
