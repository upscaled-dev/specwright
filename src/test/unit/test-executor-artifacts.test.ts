import { describe, it, expect, vi } from "vitest";
import { makeConfig, makeExecutor } from "./helpers/test-executor-driver";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { TestExecutor, ShellRunner } from "../../core/test-executor";
import { normalizePathKey } from "../../utils/playwright-json-parser";
import { BddgenDiagnosticsProvider } from "../../providers/bddgen-diagnostics-provider";
import { LIVE_REPORT_FILE_ENV } from "../../core/live-reporter-protocol";



describe("TestExecutor traceability artifact scope", () => {
  it("filters the artifact to the selected Examples block without filtering the run result", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "artifact-outline-"));
    const filePath = nodePath.join(root, "features/calc.feature");
    const specPath = nodePath.join(root, ".features-gen/features/calc.feature.spec.js");
    fs.mkdirSync(nodePath.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, "// Generated from: features/calc.feature");
    const selectedFile = "features/calc.feature";
    const report = JSON.stringify({
      suites: [{
        title: "Calculator",
        suites: [{
          title: "Divide",
          specs: [9, 14, 15].map((line, index) => ({
            title: `Example #${index + 1}`,
            tests: [{
              annotations: [{ type: `${selectedFile}:${line}` }],
              results: [{ status: "passed" }],
            }],
          })).concat([{
            title: "Example #foreign",
            tests: [{
              annotations: [{ type: "features/other.feature:14" }],
              results: [{ status: "passed" }],
            }],
          }]),
        }],
      }],
    });
    const contributeShard = vi.fn();
    const runArtifactStore: Parameters<TestExecutor["registerArtifactSink"]>[1] = { contributeShard };
    const { executor } = makeExecutor(
      makeConfig({ bddgenCommand: "", workingDirectory: root }),
      async () => ({ success: true, output: report, error: "", returnCode: 0 })
    );
    const sink = executor.registerArtifactSink(4, runArtifactStore);
    const block = {
      filePath,
      line: 12,
      name: "Divide · edge cases",
      kind: "examplesBlock" as const,
      outlineName: "Divide",
      examplesBlockName: "edge cases",
    };

    const result = await executor.runScenarioWithOutput(
      { filePath, outlineName: "Divide", artifactBatch: 4 },
      { scenario: block, resultLines: [14, 15] }
    );
    sink.dispose();

    expect(result.scenarioDetails?.map((detail) => detail.lineNumber)).toEqual([9, 14, 15, 14]);
    expect(contributeShard).toHaveBeenCalledOnce();
    const capture = contributeShard.mock.calls[0]?.[1] as {
      details: Array<{ featurePath: string; lineNumber?: number }>;
      invocation: unknown;
    };
    expect(capture.details.map((detail) => detail.lineNumber)).toEqual([14, 15]);
    expect(capture.details.map((detail) => detail.featurePath)).toEqual([
      normalizePathKey(filePath),
      normalizePathKey(filePath),
    ]);
    expect(capture.invocation).toEqual(block);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("contributes one failed shard when the Playwright process cannot spawn", async () => {
    const contributeShard = vi.fn();
    const runArtifactStore: Parameters<TestExecutor["registerArtifactSink"]>[1] = { contributeShard };
    const { executor } = makeExecutor(
      makeConfig({ bddgenCommand: "", workingDirectory: "/abs" }),
      async () => {throw new Error("spawn failed");}
    );
    const sink = executor.registerArtifactSink(6, runArtifactStore);
    const scenario = { filePath: "/abs/a.feature", line: 3, name: "A", kind: "scenario" as const };

    // A no-selection run reaches the spawn without requiring a generated spec.
    const result = await executor.runScenarioWithOutput(
      { filePath: scenario.filePath, artifactBatch: 6 },
      { scenario, resultLines: [3] }
    );
    sink.dispose();

    expect(result.success).toBe(false);
    expect(result.error).toContain("spawn failed");
    expect(contributeShard).toHaveBeenCalledOnce();
    expect(contributeShard).toHaveBeenCalledWith(6, expect.objectContaining({
      success: false,
      details: [],
      invocation: scenario,
    }));
  });
});

describe("TestExecutor run events", () => {
  it("recovers the failed project when a global-error report contains only the passing project", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "multi-project-live-report-"));
    const featurePath = nodePath.join(root, "features", "x.feature");
    const specPath = nodePath.join(root, ".features-gen", "x.feature.spec.js");
    fs.mkdirSync(nodePath.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, [
      `// Generated from: ${featurePath}`,
      "const bddFileData = [ // bdd-data-start",
      '  {"pwTestLine":7,"pickleLine":4,"steps":[]},',
      "]; // bdd-data-end",
    ].join("\n"));
    const shell: ShellRunner = async (_command, _workingDir, env) => {
      const livePath = env?.[LIVE_REPORT_FILE_ENV];
      const reportPath = env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"];
      if (!livePath || !reportPath) {throw new Error("report paths missing");}
      const record = (projectName: string, status: "passed" | "failed", retry: number) => ({
        kind: "test-end",
        file: specPath,
        line: 7,
        title: "Scenario A",
        titlePath: [projectName, "x.feature.spec.js", "Feature", "Scenario A"],
        status,
        durationMs: 4,
        retry,
        retries: projectName === "chromium" ? 1 : 0,
        expectedStatus: "passed",
        projectName,
        completed: 1,
        total: 2,
      });
      fs.appendFileSync(livePath, [
        JSON.stringify({
          kind: "run-begin",
          rootDir: nodePath.dirname(specPath),
          configFile: nodePath.join(root, "playwright.config.ts"),
          total: 2,
        }),
        JSON.stringify(record("chromium", "failed", 0)),
        JSON.stringify(record("chromium", "passed", 1)),
        JSON.stringify(record("firefox", "failed", 0)),
        "",
      ].join("\n"));
      fs.writeFileSync(reportPath, JSON.stringify({
        config: {
          rootDir: nodePath.dirname(specPath),
          configFile: nodePath.join(root, "playwright.config.ts"),
        },
        errors: [{ message: "worker teardown failed" }],
        suites: [{
          specs: [{
            title: "Scenario A",
            file: nodePath.basename(specPath),
            line: 7,
            tests: [{ projectName: "chromium", results: [{ status: "passed" }] }],
          }],
        }],
      }));
      return { success: false, output: "", error: "process exited 1", returnCode: 1 };
    };
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "" }), shell);

    const result = await executor.runPathFilterWithOutput(featurePath, undefined, undefined, {});

    expect(result.infrastructureFailure).toBe(
      "Playwright reported a global error: worker teardown failed"
    );
    expect(result.scenarioDetails).toEqual(expect.arrayContaining([
      expect.objectContaining({ projectName: "chromium", status: "passed" }),
      expect.objectContaining({ projectName: "firefox", status: "failed" }),
    ]));
    expect(result.scenarioResults?.[`${normalizePathKey(featurePath)}:4`]).toBe("failed");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("marks a nonempty report partial when Playwright reports a global error", async () => {
    const report = JSON.stringify({
      errors: [{ message: "worker teardown failed" }],
      suites: [{
        specs: [{
          title: "Completed first",
          tests: [{ results: [{ status: "passed" }] }],
        }],
      }],
    });
    const { executor } = makeExecutor(
      makeConfig({ bddgenCommand: "" }),
      async () => ({ success: false, output: report, error: "process exited 1", returnCode: 1 })
    );

    const result = await executor.runSuiteWithOutput();

    expect(result.scenarioDetails).toHaveLength(1);
    expect(result.infrastructureFailure).toContain("worker teardown failed");
    expect(result.success).toBe(false);
  });

  it("keeps a complete assertion-failure report out of the infrastructure channel", async () => {
    const report = JSON.stringify({
      suites: [{
        specs: [{
          title: "Assertion failed",
          tests: [{ results: [{ status: "failed", error: { message: "expected 1 to be 2" } }] }],
        }],
      }],
    });
    const { executor } = makeExecutor(
      makeConfig({ bddgenCommand: "" }),
      async () => ({ success: false, output: report, error: "1 failed", returnCode: 1 })
    );

    const result = await executor.runSuiteWithOutput();

    expect(result.scenarioDetails).toMatchObject([{ status: "failed" }]);
    expect(result.infrastructureFailure).toBeUndefined();
    expect(result.success).toBe(false);
  });

  it("marks a failed process partial when its complete report contains only completed passes", async () => {
    const report = JSON.stringify({
      suites: [{
        specs: [{
          title: "Completed first",
          tests: [{ results: [{ status: "passed" }] }],
        }],
      }],
    });
    const { executor } = makeExecutor(
      makeConfig({ bddgenCommand: "" }),
      async () => ({ success: false, output: report, error: "reporter crashed", returnCode: 1 })
    );

    const result = await executor.runSuiteWithOutput();

    expect(result.scenarioDetails).toHaveLength(1);
    expect(result.infrastructureFailure).toBe("reporter crashed");
  });

  it("reports success with every scenario counted when playwright reports all passing", async () => {
    const config = makeConfig();
    const shell: ShellRunner = async () => ({
      success: true,
      output: JSON.stringify({
        suites: [{
          specs: [{
            title: "scenario A",
            file: "/abs/x.feature",
            tests: [{ results: [{ status: "passed" }] }],
          }, {
            title: "scenario B",
            file: "/abs/x.feature",
            tests: [{ results: [{ status: "passed" }] }],
          }],
        }],
      }),
      error: "",
      returnCode: 0,
    });
    const { executor } = makeExecutor(config, shell);

    const result = await executor.runScenarioWithOutput({ filePath: "/abs/x.feature" });

    expect(result.success).toBe(true);
    expect(result.scenarioDetails).toHaveLength(2);
    expect(new Set(Object.values(result.scenarioResults ?? {}))).toEqual(new Set(["passed"]));
  });

  it("reports failure when at least one scenario fails", async () => {
    // bddgen disabled so the single mocked failing result maps to the playwright run, not bddgen.
    const config = makeConfig({ bddgenCommand: "" });
    const shell: ShellRunner = async () => ({
      success: false,
      output: JSON.stringify({
        suites: [{
          specs: [{
            title: "scenario A",
            file: "/abs/x.feature",
            tests: [{ results: [{ status: "passed" }] }],
          }, {
            title: "scenario B",
            file: "/abs/x.feature",
            tests: [{ results: [{ status: "failed" }] }],
          }],
        }],
      }),
      error: "",
      returnCode: 1,
    });
    const { executor } = makeExecutor(config, shell);

    const result = await executor.runScenarioWithOutput({ filePath: "/abs/x.feature" });

    expect(result.success).toBe(false);
    expect(result.scenarioDetails).toHaveLength(2);
    expect(new Set(Object.values(result.scenarioResults ?? {}))).toEqual(
      new Set(["passed", "failed"])
    );
  });

  it("counts a scenario as failed under any project even when its passing project is reported first", async () => {
    // Multi-project run: chromium passed (listed first), firefox failed. Worst status must win, so
    // the one scenario is counted failed regardless of report order, not passed (first-wins bug).
    const config = makeConfig({ bddgenCommand: "" });
    const shell: ShellRunner = async () => ({
      success: false,
      output: JSON.stringify({
        suites: [{
          specs: [{
            title: "scenario A",
            file: "/abs/x.feature",
            tests: [
              { results: [{ status: "passed" }] },
              { results: [{ status: "failed" }] },
            ],
          }],
        }],
      }),
      error: "",
      returnCode: 1,
    });
    const { executor } = makeExecutor(config, shell);

    const result = await executor.runScenarioWithOutput({ filePath: "/abs/x.feature" });

    expect(result.success).toBe(false);
    // Worst status wins across projects: no key anywhere may read "passed".
    expect(new Set(Object.values(result.scenarioResults ?? {}))).toEqual(new Set(["failed"]));
  });
});

describe("TestExecutor bddgen diagnostics from the playwright result", () => {
  function makeSpy(): { publish: ReturnType<typeof vi.fn>; clear: ReturnType<typeof vi.fn> } {
    return { publish: vi.fn(), clear: vi.fn() };
  }

  it("publishes bddgen diagnostics when the playwright run fails with bddgen-style errors", async () => {
    // Even without a separately configured bddgen command, generator-style errors surfaced by
    // Playwright must reach the Problems panel via publish.
    const spy = makeSpy();
    const shell: ShellRunner = async () => ({
      success: false,
      output: "Missing step definitions in features/login.feature:3:1",
      error: "",
      returnCode: 1,
    });
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "" }), shell, {
      bddgenDiagnostics: spy as unknown as BddgenDiagnosticsProvider,
    });

    await executor.runScenarioWithOutput({ filePath: "/abs/features/login.feature", lineNumber: 3 });

    expect(spy.publish).toHaveBeenCalledTimes(1);
    expect(spy.publish).toHaveBeenCalledWith(
      expect.stringContaining("Missing step definitions"),
      expect.any(String)
    );
    expect(spy.clear).not.toHaveBeenCalled();
  });

  it("clears bddgen diagnostics when the playwright run succeeds", async () => {
    const spy = makeSpy();
    const shell: ShellRunner = async () => ({ success: true, output: "{}", error: "", returnCode: 0 });
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "" }), shell, {
      bddgenDiagnostics: spy as unknown as BddgenDiagnosticsProvider,
    });

    await executor.runScenarioWithOutput({ filePath: "/abs/features/login.feature", lineNumber: 3 });

    expect(spy.clear).toHaveBeenCalledTimes(1);
    expect(spy.publish).not.toHaveBeenCalled();
  });
});
