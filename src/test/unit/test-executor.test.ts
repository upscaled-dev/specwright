import { describe, it, expect, beforeEach, vi } from "vitest";
import { makeConfig, makeExecutor } from "./helpers/test-executor-driver";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import { TestExecutor, ShellRunner } from "../../core/test-executor";
import { Logger } from "../../utils/logger";
import { PlaywrightJsonParser } from "../../utils/playwright-json-parser";
import { LIVE_REPORT_FILE_ENV } from "../../core/live-reporter-protocol";
import { EXECUTION_LIMITS } from "../../core/execution-limits";

interface ShellCall {
  command: string;
  workingDir: string;
  extraEnv?: NodeJS.ProcessEnv | undefined;
}


describe("TestExecutor temporary report lifetime", () => {
  type Mode = "normal" | "scenario";
  type Outcome = "success" | "runner failure" | "spawn failure" | "cancellation" | "parse failure";

  const cases: Array<[Mode, Outcome]> = [
    ["normal", "success"],
    ["normal", "runner failure"],
    ["normal", "spawn failure"],
    ["normal", "cancellation"],
    ["normal", "parse failure"],
    ["scenario", "success"],
    ["scenario", "runner failure"],
    ["scenario", "spawn failure"],
    ["scenario", "cancellation"],
    ["scenario", "parse failure"],
  ];

  it.each(cases)("removes the %s report directory after %s", async (mode, outcome) => {
    let jsonPath: string | undefined;
    let livePath: string | undefined;
    const controller = new AbortController();
    if (outcome === "cancellation") {
      controller.abort();
    }
    const shell: ShellRunner = async (_command, _workingDir, env) => {
      jsonPath = env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"];
      livePath = env?.[LIVE_REPORT_FILE_ENV];
      if (outcome === "spawn failure") {
        throw new Error("spawn failed");
      }
      if (jsonPath !== undefined) {
        fs.writeFileSync(jsonPath, outcome === "parse failure" ? "{broken" : JSON.stringify({ suites: [] }));
      }
      return outcome === "runner failure"
        ? { success: false, output: "", error: "runner failed", returnCode: 1 }
        : { success: true, output: "", error: "", returnCode: 0 };
    };
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "" }), shell);
    const options = { filePath: "/tmp/x.feature", signal: controller.signal, progress: {} };

    const result = mode === "normal"
      ? await executor.runPathFilterWithOutput(options.filePath, options.signal, undefined, options.progress)
      : await executor.runScenarioWithOutput(options);

    expect(jsonPath).toBeDefined();
    expect(livePath).toBeDefined();
    expect(nodePath.dirname(jsonPath!)).toBe(nodePath.dirname(livePath!));
    expect(fs.existsSync(nodePath.dirname(jsonPath!))).toBe(false);
    if (outcome === "spawn failure") {
      expect(result.error).toContain("spawn failed");
    } else if (outcome === "cancellation") {
      expect(result.error).toBe("Cancelled");
    } else if (outcome === "runner failure") {
      expect(result.error).toBe("runner failed");
    }
  });

  it("keeps a live case when an oversized report fails optional enrichment", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "oversized-live-report-"));
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
      const jsonPath = env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"];
      const livePath = env?.[LIVE_REPORT_FILE_ENV];
      if (jsonPath && livePath) {
        fs.appendFileSync(livePath, [
          JSON.stringify({
            kind: "run-begin",
            rootDir: nodePath.dirname(specPath),
            configFile: nodePath.join(root, "playwright.config.ts"),
            total: 1,
          }),
          JSON.stringify({
            kind: "test-end",
            file: specPath,
            line: 7,
            title: "Completed first",
            titlePath: ["chromium", "x.feature.spec.js", "Feature", "Completed first"],
            status: "passed",
            durationMs: 4,
            retry: 0,
            retries: 0,
            expectedStatus: "passed",
            projectName: "chromium",
            completed: 1,
            total: 1,
          }),
          "",
        ].join("\n"));
        fs.writeFileSync(jsonPath, "");
        fs.truncateSync(jsonPath, EXECUTION_LIMITS.reportBytesPerRun + 1);
      }
      return { success: false, output: "", error: "process exited 1", returnCode: 1 };
    };
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "" }), shell);

    const result = await executor.runPathFilterWithOutput(featurePath, undefined, undefined, {});

    expect(result).toMatchObject({
      success: false,
      error:
        `Playwright JSON report exceeds the ${EXECUTION_LIMITS.reportBytesPerRun}-byte limit ` +
        `(received ${EXECUTION_LIMITS.reportBytesPerRun + 1} bytes).`,
      infrastructureFailure:
        `Playwright JSON report exceeds the ${EXECUTION_LIMITS.reportBytesPerRun}-byte limit ` +
        `(received ${EXECUTION_LIMITS.reportBytesPerRun + 1} bytes).`,
      scenarioDetails: [expect.objectContaining({
        featurePath,
        lineNumber: 4,
        status: "passed",
      })],
    });
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("forwards run cancellation to an admitted report parse", async () => {
    const logger = Logger.create();
    const parser = PlaywrightJsonParser.create(logger);
    const controller = new AbortController();
    let parsedWith: AbortSignal | undefined;
    let admitParse: (() => void) | undefined;
    const parseAdmitted = new Promise<void>((resolve) => {admitParse = resolve;});
    vi.spyOn(parser, "inspectFromFileAsync").mockImplementation(async (_path, signal) => {
      parsedWith = signal;
      admitParse?.();
      return await new Promise((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      });
    });
    const shell: ShellRunner = async (_command, _workingDir, env) => {
      fs.writeFileSync(env?.["PLAYWRIGHT_JSON_OUTPUT_NAME"] ?? "", "{}");
      return { success: true, output: "", error: "", returnCode: 0 };
    };
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "" }), shell, {
      playwrightJsonParser: parser,
    });

    const running = executor.runPathFilterWithOutput("/tmp/x.feature", controller.signal);
    await parseAdmitted;
    controller.abort(new Error("stop parsing"));

    await expect(running).resolves.toMatchObject({ success: false, error: "Cancelled" });
    expect(parsedWith).toBe(controller.signal);
  });
});

describe("TestExecutor preRunCommand", () => {
  let calls: ShellCall[];
  let recordingShell: ShellRunner;

  beforeEach(() => {
    calls = [];
    recordingShell = async (command, workingDir, extraEnv) => {
      calls.push({ command, workingDir, ...(extraEnv ? { extraEnv } : {}) });
      return { success: true, output: "{}", error: "", returnCode: 0 };
    };
  });

  it("does not exec a pre-run command when the setting is empty", async () => {
    // bddgen disabled so this stays focused on pre-run sequencing (bddgen-first is covered separately).
    const config = makeConfig({ preRunCommand: "", bddgenCommand: "" });
    const { executor } = makeExecutor(config, recordingShell);

    await executor.runScenarioWithOutput({ filePath: "/tmp/x.feature", lineNumber: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toContain("--reporter=list,json");
  });

  it("execs the configured pre-run command before the playwright run", async () => {
    const config = makeConfig({ preRunCommand: "npm run build:fixtures", bddgenCommand: "" });
    const { executor } = makeExecutor(config, recordingShell);

    await executor.runScenarioWithOutput({ filePath: "/tmp/x.feature", lineNumber: 1 });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.command).toBe("npm run build:fixtures");
    expect(calls[1]!.command).toContain("--reporter=list,json");
  });

  it("aborts the test run when the pre-run command exits non-zero", async () => {
    const config = makeConfig({ preRunCommand: "false" });
    const failingShell: ShellRunner = async (command, workingDir, extraEnv) => {
      calls.push({ command, workingDir, ...(extraEnv ? { extraEnv } : {}) });
      if (command === "false") {
        return { success: false, output: "", error: "boom", returnCode: 17 };
      }
      return { success: true, output: "{}", error: "", returnCode: 0 };
    };
    const contributeShard = vi.fn();
    const runArtifactStore: Parameters<TestExecutor["registerArtifactSink"]>[1] = { contributeShard };
    const { executor } = makeExecutor(config, failingShell);
    const sink = executor.registerArtifactSink(5, runArtifactStore);
    const scenario = { filePath: "/tmp/x.feature", line: 1, name: "S", kind: "scenario" as const };

    const result = await executor.runScenarioWithOutput(
      { filePath: "/tmp/x.feature", lineNumber: 1, artifactBatch: 5 },
      { scenario, resultLines: [1] }
    );
    sink.dispose();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("false");
    expect(result.success).toBe(false);
    expect(result.error).toContain("preRunCommand");
    expect(result.error).toContain("17");
    expect(contributeShard).toHaveBeenCalledOnce();
    expect(contributeShard).toHaveBeenCalledWith(5, expect.objectContaining({
      success: false,
      details: [],
      invocation: scenario,
    }));
  });

  it("continues to playwright when the pre-run command exits zero", async () => {
    const config = makeConfig({ preRunCommand: "echo ok", bddgenCommand: "" });
    const { executor } = makeExecutor(config, recordingShell);

    await executor.runScenarioWithOutput({ filePath: "/tmp/x.feature", lineNumber: 1 });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.command).toBe("echo ok");
    expect(calls[1]!.command).toContain("--reporter=list,json");
  });
});

describe("TestExecutor runScenarioWithOutput bddgen-first", () => {
  let calls: Array<{ command: string }>;
  let recordingShell: ShellRunner;

  beforeEach(() => {
    calls = [];
    recordingShell = async (command) => {
      calls.push({ command });
      return { success: true, output: "{}", error: "", returnCode: 0 };
    };
  });

  it("runs bddgen as its own step before playwright, so the spec line map is fresh", async () => {
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "npx bddgen" }), recordingShell);

    await executor.runScenarioWithOutput({ filePath: "/tmp/x.feature", lineNumber: 5 });

    // Two separate shell calls (not one `bddgen && playwright` chain): bddgen, then playwright.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.command).toBe("npx bddgen");
    expect(calls[1]!.command).not.toContain("bddgen");
    expect(calls[1]!.command).toContain("--reporter=list,json");
  });

  it("aborts before playwright and reports failure when bddgen fails", async () => {
    const failingBddgen: ShellRunner = async (command) => {
      calls.push({ command });
      if (command === "npx bddgen") {
        return { success: false, output: "Missing step definitions", error: "", returnCode: 1 };
      }
      return { success: true, output: "{}", error: "", returnCode: 0 };
    };
    const contributeShard = vi.fn();
    const runArtifactStore: Parameters<TestExecutor["registerArtifactSink"]>[1] = { contributeShard };
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "npx bddgen" }), failingBddgen);
    const sink = executor.registerArtifactSink(7, runArtifactStore);
    const target = {
      scenario: { filePath: "/tmp/x.feature", line: 5, name: "S", kind: "scenario" as const },
      resultLines: [5],
    };

    const result = await executor.runScenarioWithOutput(
      { filePath: "/tmp/x.feature", lineNumber: 5, artifactBatch: 7 },
      target
    );
    sink.dispose();

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("npx bddgen");
    expect(result.success).toBe(false);
    expect(result.error).toContain("bddgen failed");
    expect(contributeShard).toHaveBeenCalledOnce();
    expect(contributeShard).toHaveBeenCalledWith(7, expect.objectContaining({
      success: false,
      details: [],
      invocation: target.scenario,
    }));
  });

  it("skips code generation when the run does not need an exact generated target", async () => {
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "" }), recordingShell);

    await executor.runScenarioWithOutput({ filePath: "/tmp/x.feature", lineNumber: 5 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toContain("--reporter=list,json");
  });

  it("does not widen a tagged scenario when no generator has produced an exact line map", async () => {
    const expression = "@smoke and not (@wip or @slow)";
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "" }), recordingShell);

    const result = await executor.runScenarioWithOutput({
      filePath: "/tmp/x.feature",
      lineNumber: 5,
      scenarioName: "A",
      tags: expression,
    });

    expect(calls).toHaveLength(0);
    expect(result.infrastructureFailure).toContain("No broader target was executed");
  });

  // The parse-miss shape: a stale ref keeps its name but loses its line. A name grep for it would
  // search the whole suite, so the run must refuse instead.
  it("fails a plain scenario with no resolvable line instead of a suite-wide name grep", async () => {
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "" }), recordingShell);

    const result = await executor.runScenarioWithOutput({
      filePath: "/tmp/x.feature",
      lineNumber: 0,
      scenarioName: "A",
    });

    expect(calls).toHaveLength(0);
    expect(result.infrastructureFailure).toContain("No broader target was executed");
  });

  it("keeps a whole-outline run on its title grep, scoped to its own generated spec", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "delegated-outline-"));
    const featurePath = nodePath.join(root, "x.feature");
    const specPath = nodePath.join(root, ".features-gen", "x.feature.spec.js");
    const calls: ShellCall[] = [];
    fs.mkdirSync(nodePath.dirname(specPath), { recursive: true });
    fs.writeFileSync(specPath, "// Generated from: x.feature");
    const shell: ShellRunner = async (command, workingDir) => {
      calls.push({ command, workingDir });
      return { success: true, output: "{}", error: "", returnCode: 0 };
    };
    const { executor } = makeExecutor(
      makeConfig({ bddgenCommand: "", workingDirectory: root }),
      shell
    );

    await executor.runScenarioWithOutput({
      filePath: featurePath,
      outlineName: "Divide",
    });

    expect(calls).toHaveLength(1);
    // Every row of THIS outline runs, and only in this feature's spec: the positional filter pins
    // the grep to the generated file, so a same-titled outline elsewhere cannot join.
    expect(calls[0]!.command).toContain("--grep");
    expect(calls[0]!.command).toContain(".features-gen");
    expect(calls[0]!.command).toContain("(?=[./]");
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("refuses a whole-outline run whose feature cannot map to a generated spec", async () => {
    const { executor } = makeExecutor(
      makeConfig({ bddgenCommand: "", workingDirectory: "/tmp/elsewhere" }),
      recordingShell
    );

    const result = await executor.runScenarioWithOutput({
      filePath: "/tmp/x.feature",
      outlineName: "Divide",
    });

    expect(calls).toHaveLength(0);
    expect(result.infrastructureFailure).toContain("No broader target was executed");
  });

  it("uses the missing-generation diagnosis when bddgen produces no whole-outline spec", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "outline-empty-bddgen-"));
    const featurePath = nodePath.join(root, "features/a.feature");
    const shell: ShellRunner = async () => ({
      success: true,
      output: "",
      error: "",
      returnCode: 0,
    });
    const { executor } = makeExecutor(
      makeConfig({ bddgenCommand: "npx bddgen", workingDirectory: root }),
      shell
    );

    const result = await executor.runScenarioWithOutput({
      filePath: featurePath,
      outlineName: "Divide",
    });

    expect(result.infrastructureFailure).toContain(`Could not find generated specs for ${featurePath} after bddgen`);
    expect(result.infrastructureFailure).toContain("featuresGenDir");
    expect(result.infrastructureFailure).toContain("No broader target was executed");
    fs.rmSync(root, { recursive: true, force: true });
  });
});
