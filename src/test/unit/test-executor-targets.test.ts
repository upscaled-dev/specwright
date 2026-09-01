import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { makeConfig, makeExecutor } from "./helpers/test-executor-driver";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { TestExecutor, ShellRunner } from "../../core/test-executor";
import { normalizePathKey } from "../../utils/playwright-json-parser";

interface ShellCall {
  command: string;
  workingDir: string;
  extraEnv?: NodeJS.ProcessEnv | undefined;
}


describe("TestExecutor working-directory inference (monorepo)", () => {
  let calls: ShellCall[];
  let recordingShell: ShellRunner;
  let tmpDir: string;

  beforeEach(() => {
    calls = [];
    recordingShell = async (command, workingDir, extraEnv) => {
      calls.push({ command, workingDir, ...(extraEnv ? { extraEnv } : {}) });
      return { success: true, output: "{}", error: "", returnCode: 0 };
    };
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "executor-cwd-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeWorkspace(): typeof vscode.workspace {
    return {
      ...vscode.workspace,
      workspaceFolders: [
        { name: "ws", index: 0, uri: vscode.Uri.file(tmpDir) },
      ],
    } as unknown as typeof vscode.workspace;
  }

  function write(relPath: string, content = ""): string {
    const abs = nodePath.join(tmpDir, ...relPath.split("/"));
    fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  it("runs from the package owning the nearest playwright.config, not the workspace root", async () => {
    write("packages/e2e/playwright.config.ts", "export default {};");
    const feature = write("packages/e2e/features/login.feature", "Feature: F");
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "" }), recordingShell, {
      workspace: makeWorkspace(),
    });

    await executor.runScenarioWithOutput({ filePath: feature });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.workingDir).toBe(nodePath.join(tmpDir, "packages", "e2e"));
  });

  it("falls back to the workspace folder root when no playwright.config exists", async () => {
    const feature = write("packages/e2e/features/login.feature", "Feature: F");
    const { executor } = makeExecutor(makeConfig(), recordingShell, {
      workspace: makeWorkspace(),
    });

    await executor.runScenarioWithOutput({ filePath: feature, scenarioName: "s" });

    expect(calls[0]!.workingDir).toBe(tmpDir);
  });

  it("an explicit workingDirectory setting always wins over inference", async () => {
    write("packages/e2e/playwright.config.ts", "export default {};");
    const feature = write("packages/e2e/features/login.feature", "Feature: F");
    const { executor } = makeExecutor(
      makeConfig({ workingDirectory: "packages/other" }),
      recordingShell,
      { workspace: makeWorkspace() }
    );

    await executor.runScenarioWithOutput({ filePath: feature, scenarioName: "s" });

    expect(calls[0]!.workingDir).toBe(nodePath.join(tmpDir, "packages", "other"));
  });

  it("stops the config walk at the workspace folder boundary", async () => {
    // A config placed in os.tmpdir() (above the workspace root) must not be picked up;
    // the walk stops at the workspace folder.
    const feature = write("features/login.feature", "Feature: F");
    const { executor } = makeExecutor(makeConfig(), recordingShell, {
      workspace: makeWorkspace(),
    });

    await executor.runScenarioWithOutput({ filePath: feature, scenarioName: "s" });

    expect(calls[0]!.workingDir).toBe(tmpDir);
  });
});

describe("TestExecutor exact-target generation", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "executor-retry-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeWorkspace(): typeof vscode.workspace {
    return {
      ...vscode.workspace,
      workspaceFolders: [{ name: "ws", index: 0, uri: vscode.Uri.file(tmpDir) }],
    } as unknown as typeof vscode.workspace;
  }

  function write(relPath: string, content = ""): string {
    const abs = nodePath.join(tmpDir, ...relPath.split("/"));
    fs.mkdirSync(nodePath.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
    return abs;
  }

  function writeSpec(): void {
    write(
      ".features-gen/features/a.feature.spec.js",
      `// Generated from: features/a.feature
const bddFileData = [ // bdd-data-start
  {"pwTestLine":7,"pickleLine":3,"steps":[]},
]; // bdd-data-end`
    );
  }

  it("fails closed when no generator is configured and an exact target has no generated spec", async () => {
    const feature = write("features/a.feature", "Feature: F");
    const calls: string[] = [];
    const shell: ShellRunner = async (command) => {
      calls.push(command);
      return { success: true, output: "{}", error: "", returnCode: 0 };
    };
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "" }), shell, {
      workspace: makeWorkspace(),
    });

    const result = await executor.runScenarioWithOutput({
      filePath: feature,
      lineNumber: 3,
      scenarioName: "S",
    });

    expect(calls).toEqual([]);
    expect(result.infrastructureFailure).toContain("bddgenCommand");
    expect(result.infrastructureFailure).toContain("preRunCommand");
  });

  it("does not cross-target a same-basename spec owned by another feature", async () => {
    const feature = write("features/a.feature", "Feature: F");
    write(
      ".features-gen/a.feature.spec.js",
      `// Generated from: other/a.feature
const bddFileData = [ // bdd-data-start
  {"pwTestLine":7,"pickleLine":3,"steps":[]},
]; // bdd-data-end`
    );
    const calls: string[] = [];
    const shell: ShellRunner = async (command) => {
      calls.push(command);
      return { success: true, output: "{}", error: "", returnCode: 0 };
    };
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "" }), shell, {
      workspace: makeWorkspace(),
    });

    const result = await executor.runScenarioWithOutput({
      filePath: feature,
      lineNumber: 3,
      scenarioName: "S",
    });

    expect(calls).toEqual([]);
    expect(result.infrastructureFailure).toContain(`belongs to ${nodePath.join(tmpDir, "other/a.feature")}`);
    expect(result.infrastructureFailure).toContain("No broader target was executed");
  });

  it("uses generated specs prepared by the pre-run command", async () => {
    const feature = write("features/a.feature", "Feature: F");
    const calls: string[] = [];
    const shell: ShellRunner = async (command) => {
      calls.push(command);
      if (command === "prepare specs") {writeSpec();}
      return { success: true, output: "{}", error: "", returnCode: 0 };
    };
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "", preRunCommand: "prepare specs" }), shell, {
      workspace: makeWorkspace(),
    });

    await executor.runScenarioWithOutput({
      filePath: feature,
      lineNumber: 3,
      scenarioName: "S",
    });

    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe("prepare specs");
    expect(calls[1]).toContain(".features-gen/features/a.feature.spec.js:7");
    expect(calls[1]).not.toContain("--grep");
  });

  it("runs the exact source line in every generated BDD project", async () => {
    const feature = write("features/a.feature", "Feature: F");
    const data = (line: number): string => [
      "// Generated from: features/a.feature",
      "const bddFileData = [ // bdd-data-start",
      `  {"pwTestLine":${line},"pickleLine":3,"steps":[]},`,
      "]; // bdd-data-end",
    ].join("\n");
    write(".features-gen/features/a.feature.spec.js", data(9));
    write(".features-gen/browser/a.feature.spec.js", data(13));
    const calls: string[] = [];
    const shell: ShellRunner = async (command) => {
      calls.push(command);
      return { success: true, output: "{}", error: "", returnCode: 0 };
    };
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "" }), shell, {
      workspace: makeWorkspace(),
    });

    await executor.runScenarioWithOutput({
      filePath: feature,
      lineNumber: 3,
      scenarioName: "S",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).toContain(".features-gen/features/a.feature.spec.js:9");
    expect(calls[0]).toContain(".features-gen/browser/a.feature.spec.js:13");
  });

  it("regenerates and re-resolves a drifted generated line without grepping sibling rows", async () => {
    writeSpec();
    const feature = write("features/a.feature", "Feature: F");
    const retryReport = JSON.stringify({
      suites: [{
        specs: [
          {
            title: "S",
            tests: [{ annotations: [{ type: `${feature}:3` }], results: [{ status: "passed" }] }],
          },
          {
            title: "S",
            tests: [{
              annotations: [{ type: `${nodePath.join(tmpDir, "features/other.feature")}:3` }],
              results: [{ status: "passed" }],
            }],
          },
        ],
      }],
    });
    const calls: string[] = [];
    let generations = 0;
    const shell: ShellRunner = async (command) => {
      calls.push(command);
      if (command === "npx bddgen") {
        generations += 1;
        if (generations === 2) {
          write(
            ".features-gen/features/a.feature.spec.js",
            `// Generated from: features/a.feature
const bddFileData = [ // bdd-data-start
  {"pwTestLine":11,"pickleLine":3,"steps":[]},
]; // bdd-data-end`
          );
        }
        return { success: true, output: "", error: "", returnCode: 0 };
      }
      if (command.includes("a.feature.spec.js:7")) {
        return { success: false, output: "Error: no tests found", error: "", returnCode: 1 };
      }
      return { success: true, output: retryReport, error: "", returnCode: 0 };
    };
    const contributeShard = vi.fn();
    const runArtifactStore: Parameters<TestExecutor["registerArtifactSink"]>[1] = { contributeShard };
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "npx bddgen" }), shell, {
      workspace: makeWorkspace(),
    });
    const sink = executor.registerArtifactSink(9, runArtifactStore);
    const scenario = { filePath: feature, line: 3, name: "S", kind: "scenario" as const };

    const result = await executor.runScenarioWithOutput({
      filePath: feature,
      lineNumber: 3,
      scenarioName: "S",
      artifactBatch: 9,
    }, { scenario, resultLines: [3] });
    sink.dispose();

    expect(calls).toHaveLength(4);
    // The target must use forward slashes; Playwright treats CLI file filters as regexes, so
    // Windows separators (`\b`, `\f`, ...) silently match nothing. Meaningful on win32 CI, where
    // path.relative would otherwise produce backslashes.
    expect(calls[0]).toBe("npx bddgen");
    expect(calls[1]).toContain(".features-gen/features/a.feature.spec.js:7");
    expect(calls[2]).toBe("npx bddgen");
    expect(calls[3]).toContain(".features-gen/features/a.feature.spec.js:11");
    expect(calls.filter((command) => command.includes("--grep"))).toEqual([]);
    expect(result.success).toBe(true);
    expect(contributeShard).toHaveBeenCalledOnce();
    expect(contributeShard).toHaveBeenCalledWith(9, expect.objectContaining({
      success: true,
      exitCode: 0,
      invocation: scenario,
    }));
    const capture = contributeShard.mock.calls[0]?.[1] as {
      command: string;
      details: Array<{ featurePath: string; lineNumber?: number }>;
    };
    expect(capture.command).toContain("a.feature.spec.js:11");
    expect(capture.details).toMatchObject([{
      featurePath: normalizePathKey(feature),
      lineNumber: 3,
    }]);
  });

  it("does not retry when the targeted run failed for a different reason", async () => {
    writeSpec();
    const feature = write("features/a.feature", "Feature: F");
    const calls: string[] = [];
    const shell: ShellRunner = async (command) => {
      calls.push(command);
      return { success: false, output: "1 failed", error: "", returnCode: 1 };
    };
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "" }), shell, {
      workspace: makeWorkspace(),
    });

    const result = await executor.runScenarioWithOutput({
      filePath: feature,
      lineNumber: 3,
      scenarioName: "S",
    });

    expect(calls).toHaveLength(1);
    expect(result.success).toBe(false);
  });

  it("does not invent a generation command when an exact target goes stale", async () => {
    writeSpec();
    const feature = write("features/a.feature", "Feature: F");
    const calls: string[] = [];
    const shell: ShellRunner = async (command) => {
      calls.push(command);
      return { success: false, output: "Error: no tests found", error: "", returnCode: 1 };
    };
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "" }), shell, {
      workspace: makeWorkspace(),
    });

    const result = await executor.runScenarioWithOutput({
      filePath: feature,
      lineNumber: 3,
      scenarioName: "S",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toContain("--list");
    expect(result.infrastructureFailure).toContain("bddgenCommand");
  });

  it("does not refresh an exact target after an unsafe no-tests result", async () => {
    writeSpec();
    const feature = write("features/a.feature", "Feature: F");
    const failure = "target process remained alive";
    const calls: string[] = [];
    const shell: ShellRunner = async (command) => {
      calls.push(command);
      return {
        success: false,
        output: "Error: no tests found",
        error: failure,
        returnCode: 1,
        terminationFailure: failure,
        terminationLease: {
          kind: "posix-group",
          pgid: 81,
          failure,
          systemUptime: 100,
        },
      };
    };
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "" }), shell, {
      workspace: makeWorkspace(),
    });

    const result = await executor.runScenarioWithOutput({
      filePath: feature,
      lineNumber: 3,
      scenarioName: "S",
    });

    expect(calls).toHaveLength(1);
    expect(result.admissionUnsafe).toBe(true);
  });

});
