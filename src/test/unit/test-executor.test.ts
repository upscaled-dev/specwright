import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { TestExecutor, ShellRunner, withJsonReporter } from "../../core/test-executor";
import { ExtensionConfig } from "../../core/extension-config";
import { Logger } from "../../utils/logger";
import { normalizePathKey, PlaywrightJsonParser } from "../../utils/playwright-json-parser";
import { CommandBuilder } from "../../core/command-builder";
import { BreakpointMirror } from "../../core/breakpoint-mirror";
import { PlaywrightBddExtensionContext } from "../../types";
import { BddgenDiagnosticsProvider } from "../../providers/bddgen-diagnostics-provider";
import { LIVE_REPORT_FILE_ENV } from "../../core/live-reporter-protocol";
import { EXECUTION_LIMITS } from "../../core/execution-limits";

interface ShellCall {
  command: string;
  workingDir: string;
  extraEnv?: NodeJS.ProcessEnv | undefined;
}

function makeConfig(
  values: { preRunCommand?: string; workingDirectory?: string; bddgenCommand?: string } = {}
): ExtensionConfig {
  const stub = {
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      if (key === "preRunCommand") {
        return (values.preRunCommand ?? "") as unknown as T;
      }
      if (key === "workingDirectory") {
        return (values.workingDirectory ?? "") as unknown as T;
      }
      if (key === "bddgenCommand" && values.bddgenCommand !== undefined) {
        return values.bddgenCommand as unknown as T;
      }
      return defaultValue;
    },
    update: (): Promise<void> => Promise.resolve(),
  } as unknown as vscode.WorkspaceConfiguration;
  return ExtensionConfig.create(stub, false);
}

interface FakeTerminal {
  sent: string[];
  disposed: boolean;
  show(): void;
  sendText(text: string): void;
  dispose(): void;
}

interface FakeWindow {
  terminals: FakeTerminal[];
  closeListeners: Array<(t: unknown) => void>;
  errorMessages: string[];
  fireClose(terminal: FakeTerminal): void;
  window: typeof vscode.window;
}

function makeFakeWindow(): FakeWindow {
  const terminals: FakeTerminal[] = [];
  const closeListeners: Array<(t: unknown) => void> = [];
  const errorMessages: string[] = [];
  const window = {
    createTerminal: (): FakeTerminal => {
      const terminal: FakeTerminal = {
        sent: [],
        disposed: false,
        show(): void { /* no-op */ },
        sendText(text: string): void { this.sent.push(text); },
        dispose(): void { this.disposed = true; },
      };
      terminals.push(terminal);
      return terminal;
    },
    onDidCloseTerminal: (listener: (t: unknown) => void) => {
      closeListeners.push(listener);
      return { dispose: () => { /* no-op */ } };
    },
    showInformationMessage: (): Promise<unknown> => Promise.resolve(undefined),
    showWarningMessage: (): Promise<unknown> => Promise.resolve(undefined),
    showErrorMessage: (message: string): Promise<unknown> => {
      errorMessages.push(message);
      return Promise.resolve(undefined);
    },
  } as unknown as typeof vscode.window;
  return {
    terminals,
    closeListeners,
    errorMessages,
    fireClose(terminal: FakeTerminal): void {
      for (const l of closeListeners) { l(terminal); }
    },
    window,
  };
}

interface FakeDebug {
  startCalls: Array<{ folder: unknown; config: Record<string, unknown> }>;
  stopCalls: unknown[];
  breakpoints: unknown[];
  fireStart(session: unknown): void;
  fireTerminate(session: unknown): void;
  debug: typeof vscode.debug;
}

function makeFakeDebug(
  onStart?: () => void,
  start?: () => Promise<boolean>
): FakeDebug {
  const startCalls: Array<{ folder: unknown; config: Record<string, unknown> }> = [];
  const stopCalls: unknown[] = [];
  const breakpoints: unknown[] = [];
  const startListeners: Array<(session: unknown) => void> = [];
  const terminateListeners: Array<(session: unknown) => void> = [];
  const debug = {
    breakpoints,
    addBreakpoints: (bps: readonly unknown[]): void => {
      breakpoints.push(...bps);
    },
    removeBreakpoints: (bps: readonly unknown[]): void => {
      for (const bp of bps) {
        const i = breakpoints.indexOf(bp);
        if (i > -1) { breakpoints.splice(i, 1); }
      }
    },
    onDidStartDebugSession: (listener: (session: unknown) => void) => {
      startListeners.push(listener);
      return { dispose: () => { /* no-op */ } };
    },
    onDidTerminateDebugSession: (listener: (session: unknown) => void) => {
      terminateListeners.push(listener);
      return { dispose: () => { /* no-op */ } };
    },
    onDidChangeBreakpoints: () => ({ dispose: () => { /* no-op */ } }),
    startDebugging: (folder: unknown, config: Record<string, unknown>): Promise<boolean> => {
      onStart?.();
      startCalls.push({ folder, config });
      return start ? start() : Promise.resolve(true);
    },
    stopDebugging: (session: unknown): Promise<void> => {
      stopCalls.push(session);
      return Promise.resolve();
    },
  } as unknown as typeof vscode.debug;
  return {
    startCalls,
    stopCalls,
    breakpoints,
    fireStart(session: unknown): void {
      for (const l of startListeners) { l(session); }
    },
    fireTerminate(session: unknown): void {
      for (const l of terminateListeners) { l(session); }
    },
    debug,
  };
}

interface ExecutorDeps {
  workspace?: typeof vscode.workspace;
  window?: typeof vscode.window;
  debug?: typeof vscode.debug;
  bddgenDiagnostics?: BddgenDiagnosticsProvider;
  mirror?: BreakpointMirror;
  runArtifactStore?: NonNullable<PlaywrightBddExtensionContext["runArtifactStore"]>;
}

function makeExecutor(
  config: ExtensionConfig,
  shellRunner: ShellRunner,
  deps: ExecutorDeps = {}
): { executor: TestExecutor; commandBuilder: CommandBuilder } {
  const logger = Logger.create();
  const executor = TestExecutor.create(
    deps.workspace ?? vscode.workspace,
    deps.window ?? vscode.window,
    deps.debug ?? vscode.debug,
    config,
    logger,
    PlaywrightJsonParser.create(logger),
    shellRunner,
    deps.mirror
  );
  const commandBuilder = CommandBuilder.create(config, logger);
  const context: PlaywrightBddExtensionContext = {
    logger,
    config,
    testExecutor: executor,
    executionGateway: { execute: vi.fn() } as unknown as PlaywrightBddExtensionContext["executionGateway"],
    discoveryManager: {} as PlaywrightBddExtensionContext["discoveryManager"],
    organizationManager: {} as PlaywrightBddExtensionContext["organizationManager"],
    featureParser: {} as PlaywrightBddExtensionContext["featureParser"],
    playwrightJsonParser: PlaywrightJsonParser.create(logger),
    commandBuilder,
    traceabilityAdapter: {} as PlaywrightBddExtensionContext["traceabilityAdapter"],
    ...(deps.bddgenDiagnostics ? { bddgenDiagnostics: deps.bddgenDiagnostics } : {}),
    ...(deps.runArtifactStore ? { runArtifactStore: deps.runArtifactStore } : {}),
  };
  executor.setContext(context);
  return { executor, commandBuilder };
}

describe("withJsonReporter", () => {
  it("adds json to the configured reporter list without replacing it", () => {
    expect(withJsonReporter("npx playwright test --reporter=list"))
      .toBe("npx playwright test --reporter=list,json");
    expect(withJsonReporter("npx playwright test --reporter=line,html"))
      .toBe("npx playwright test --reporter=line,html,json");
  });

  it("adds a reporter flag only when the command has none", () => {
    expect(withJsonReporter("npx playwright test"))
      .toBe("npx playwright test --reporter=json");
    expect(withJsonReporter("npx playwright test --reporter=list,json"))
      .toBe("npx playwright test --reporter=list,json");
  });
});

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
    const runArtifactStore = { contributeShard } as unknown as NonNullable<
      PlaywrightBddExtensionContext["runArtifactStore"]
    >;
    const { executor } = makeExecutor(config, failingShell, { runArtifactStore });
    const scenario = { filePath: "/tmp/x.feature", line: 1, name: "S", kind: "scenario" as const };

    const result = await executor.runScenarioWithOutput(
      { filePath: "/tmp/x.feature", lineNumber: 1, artifactBatch: 5 },
      { scenario, resultLines: [1] }
    );

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
    const runArtifactStore = { contributeShard } as unknown as NonNullable<
      PlaywrightBddExtensionContext["runArtifactStore"]
    >;
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "npx bddgen" }), failingBddgen, {
      runArtifactStore,
    });
    const target = {
      scenario: { filePath: "/tmp/x.feature", line: 5, name: "S", kind: "scenario" as const },
      resultLines: [5],
    };

    const result = await executor.runScenarioWithOutput(
      { filePath: "/tmp/x.feature", lineNumber: 5, artifactBatch: 7 },
      target
    );

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

  it("skips the separate bddgen step when bddgenCommand is empty (defineBddProject auto-gen)", async () => {
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "" }), recordingShell);

    await executor.runScenarioWithOutput({ filePath: "/tmp/x.feature", lineNumber: 5 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toContain("--reporter=list,json");
  });

  it("does not widen a tagged scenario when delegated generation has no exact line map", async () => {
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
    const { executor } = makeExecutor(
      makeConfig({ bddgenCommand: "", workingDirectory: "/tmp" }),
      recordingShell
    );

    await executor.runScenarioWithOutput({
      filePath: "/tmp/x.feature",
      outlineName: "Divide",
    });

    expect(calls).toHaveLength(1);
    // Every row of THIS outline runs, and only in this feature's spec: the positional filter pins
    // the grep to the generated file, so a same-titled outline elsewhere cannot join.
    expect(calls[0]!.command).toContain("--grep");
    expect(calls[0]!.command).toContain(".features-gen");
    expect(calls[0]!.command).toContain("(?=[./]");
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
});

describe("TestExecutor traceability artifact scope", () => {
  it("filters the artifact to the selected Examples block without filtering the run result", async () => {
    const filePath = nodePath.join(process.cwd(), "features/calc.feature");
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
    const runArtifactStore = { contributeShard } as unknown as NonNullable<
      PlaywrightBddExtensionContext["runArtifactStore"]
    >;
    const { executor } = makeExecutor(
      makeConfig({ bddgenCommand: "" }),
      async () => ({ success: true, output: report, error: "", returnCode: 0 }),
      { runArtifactStore }
    );
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
  });

  it("contributes one failed shard when the Playwright process cannot spawn", async () => {
    const contributeShard = vi.fn();
    const runArtifactStore = { contributeShard } as unknown as NonNullable<
      PlaywrightBddExtensionContext["runArtifactStore"]
    >;
    const { executor } = makeExecutor(
      makeConfig({ bddgenCommand: "", workingDirectory: "/abs" }),
      async () => {throw new Error("spawn failed");},
      { runArtifactStore }
    );
    const scenario = { filePath: "/abs/a.feature", line: 3, name: "A", kind: "scenario" as const };

    // Outline-titled options reach the spawn without an exact spec line; a line-less plain
    // scenario now refuses to run before spawning anything.
    const result = await executor.runScenarioWithOutput(
      { filePath: scenario.filePath, outlineName: scenario.name, artifactBatch: 6 },
      { scenario, resultLines: [3] }
    );

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
    expect(result.scenarioResults?.[`${featurePath}:4`]).toBe("failed");
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
    // With bddgenCommand empty, bddgen runs inside `playwright test` (defineBddProject auto-gen), so
    // its errors surface on the playwright result, which must reach the Problems panel via publish.
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

describe("TestExecutor debugScenario", () => {
  it("runs bddgen via the shell runner before starting the debug session", async () => {
    const sequence: string[] = [];
    const shell: ShellRunner = async (command) => {
      sequence.push(`shell:${command}`);
      return { success: true, output: "", error: "", returnCode: 0 };
    };
    const fakeDebug = makeFakeDebug(() => sequence.push("startDebugging"));
    const { executor } = makeExecutor(
      makeConfig({ workingDirectory: "/abs" }),
      shell,
      { debug: fakeDebug.debug }
    );

    await executor.debugScenario({ filePath: "/abs/features/a.feature", outlineName: "Passing" });

    expect(sequence).toEqual(["shell:npx bddgen", "startDebugging"]);
  });

  it("passes only the playwright half as the debugged command", async () => {
    const okShell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const fakeDebug = makeFakeDebug();
    const { executor } = makeExecutor(
      makeConfig({ workingDirectory: "/abs" }),
      okShell,
      { debug: fakeDebug.debug }
    );

    await executor.debugScenario({ filePath: "/abs/features/a.feature", outlineName: "Passing" });

    expect(fakeDebug.startCalls).toHaveLength(1);
    const config = fakeDebug.startCalls[0]!.config;
    const command = config["command"] as string;
    expect(command).toMatch(/^npx playwright test/);
    expect(command).not.toContain("bddgen");
    // The whole-outline debug greps its title, pinned to this feature's generated spec.
    expect(command).toContain(".features-gen");
    expect(command).toContain('--grep "Passing"');
    // The session key is stamped even when nothing mirrors, so session-end tracking always works.
    expect(typeof config[BreakpointMirror.SESSION_KEY]).toBe("string");
  });

  it("does not start debugging and shows an error when bddgen fails", async () => {
    const failingShell: ShellRunner = async () => ({
      success: false,
      output: "",
      error: "Parse error in feature file",
      returnCode: 1,
    });
    const fakeDebug = makeFakeDebug();
    const fakeWindow = makeFakeWindow();
    const { executor } = makeExecutor(makeConfig(), failingShell, {
      debug: fakeDebug.debug,
      window: fakeWindow.window,
    });

    await executor.debugScenario({ filePath: "/abs/features/a.feature", outlineName: "Passing" });

    expect(fakeDebug.startCalls).toHaveLength(0);
    expect(fakeWindow.errorMessages).toHaveLength(1);
    expect(fakeWindow.errorMessages[0]).toContain("Parse error in feature file");
  });

  const FEATURE_PATH = "/work/features/background.feature";
  const mirrorSpecText = `const bddFileData = [ // bdd-data-start
  {"pwTestLine":11,"pickleLine":8,"steps":[{"pwStepLine":7,"gherkinStepLine":5},{"pwStepLine":12,"gherkinStepLine":9}]},
]; // bdd-data-end`;
  const okShell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });

  function makeWorkWorkspace(): typeof vscode.workspace {
    return {
      ...vscode.workspace,
      workspaceFolders: [{ uri: { fsPath: "/work" } }],
    } as unknown as typeof vscode.workspace;
  }

  function pushFeatureBreakpoint(fakeDebug: FakeDebug): void {
    // 0-based line 8 = gherkin line 9 → pwStepLine 12 → spec line 11
    fakeDebug.breakpoints.push(
      new vscode.SourceBreakpoint(
        new vscode.Location(vscode.Uri.file(FEATURE_PATH), new vscode.Position(8, 0))
      )
    );
  }

  function specBreakpointLines(fakeDebug: FakeDebug): number[] {
    return fakeDebug.breakpoints
      .filter(
        (bp): bp is vscode.SourceBreakpoint =>
          bp instanceof vscode.SourceBreakpoint && bp.location.uri.fsPath.endsWith(".spec.js")
      )
      .map((bp) => bp.location.range.start.line);
  }

  it("refuses to debug a plain scenario with no resolvable line instead of a name grep", async () => {
    const fakeDebug = makeFakeDebug();
    const fakeWindow = makeFakeWindow();
    const { executor } = makeExecutor(
      makeConfig({ workingDirectory: "/abs" }),
      okShell,
      { debug: fakeDebug.debug, window: fakeWindow.window }
    );

    await executor.debugScenario({ filePath: "/abs/features/a.feature", scenarioName: "Ghost" });

    expect(fakeDebug.startCalls).toHaveLength(0);
    expect(fakeWindow.errorMessages[0]).toContain("No broader target was launched");
  });

  it("pins a whole-feature debug to its generated spec, never a basename grep", async () => {
    const fakeDebug = makeFakeDebug();
    const { executor } = makeExecutor(
      makeConfig({ workingDirectory: "/abs" }),
      okShell,
      { debug: fakeDebug.debug }
    );

    await executor.debugScenario({ filePath: "/abs/features/a.feature" });

    const command = fakeDebug.startCalls[0]!.config["command"] as string;
    expect(command).toContain(".features-gen");
    expect(command).not.toContain("--grep");
  });

  it("mirrors feature breakpoints into the generated spec and tags the debug config", async () => {
    const fakeDebug = makeFakeDebug();
    pushFeatureBreakpoint(fakeDebug);
    const mirror = BreakpointMirror.create(fakeDebug.debug, () => mirrorSpecText);
    const { executor } = makeExecutor(makeConfig(), okShell, {
      debug: fakeDebug.debug,
      workspace: makeWorkWorkspace(),
      mirror,
    });

    await executor.debugScenario({ filePath: FEATURE_PATH, outlineName: "Passing" });

    expect(specBreakpointLines(fakeDebug)).toEqual([11]);
    expect(fakeDebug.startCalls).toHaveLength(1);
    const config = fakeDebug.startCalls[0]!.config;
    expect(typeof config[BreakpointMirror.SESSION_KEY]).toBe("string");
  });

  it("releases the mirrored breakpoints when startDebugging rejects", async () => {
    const fakeDebug = makeFakeDebug(undefined, () => Promise.reject(new Error("no js-debug")));
    pushFeatureBreakpoint(fakeDebug);
    const mirror = BreakpointMirror.create(fakeDebug.debug, () => mirrorSpecText);
    const fakeWindow = makeFakeWindow();
    const { executor } = makeExecutor(makeConfig(), okShell, {
      debug: fakeDebug.debug,
      workspace: makeWorkWorkspace(),
      window: fakeWindow.window,
      mirror,
    });

    await executor.debugScenario({ filePath: FEATURE_PATH, outlineName: "Passing" });

    expect(fakeWindow.errorMessages[0]).toContain("no js-debug");
    expect(specBreakpointLines(fakeDebug)).toEqual([]);
    expect(fakeDebug.breakpoints).toHaveLength(1);
  });

  it("releases the mirrored breakpoints when VS Code declines to start the session", async () => {
    const fakeDebug = makeFakeDebug(undefined, () => Promise.resolve(false));
    pushFeatureBreakpoint(fakeDebug);
    const mirror = BreakpointMirror.create(fakeDebug.debug, () => mirrorSpecText);
    const fakeWindow = makeFakeWindow();
    const { executor } = makeExecutor(makeConfig(), okShell, {
      debug: fakeDebug.debug,
      workspace: makeWorkWorkspace(),
      window: fakeWindow.window,
      mirror,
    });

    await executor.debugScenario({ filePath: FEATURE_PATH, outlineName: "Passing" });

    expect(fakeWindow.errorMessages).toHaveLength(1);
    expect(specBreakpointLines(fakeDebug)).toEqual([]);
  });

  it("resolves after start when waitForSessionEnd is not set", async () => {
    const fakeDebug = makeFakeDebug();
    const mirror = BreakpointMirror.create(fakeDebug.debug, () => mirrorSpecText);
    const { executor } = makeExecutor(makeConfig(), okShell, {
      debug: fakeDebug.debug,
      workspace: makeWorkWorkspace(),
      mirror,
    });

    await executor.debugScenario({ filePath: FEATURE_PATH, outlineName: "Passing" });

    expect(fakeDebug.startCalls).toHaveLength(1);
  });

  it("waits for the mirror release before resolving when waitForSessionEnd is set", async () => {
    const fakeDebug = makeFakeDebug();
    const mirror = BreakpointMirror.create(fakeDebug.debug, () => mirrorSpecText);
    const { executor } = makeExecutor(makeConfig(), okShell, {
      debug: fakeDebug.debug,
      workspace: makeWorkWorkspace(),
      mirror,
    });

    let resolved = false;
    const pending = executor
      .debugScenario({ filePath: FEATURE_PATH, outlineName: "Passing", waitForSessionEnd: true })
      .then(() => { resolved = true; });

    await new Promise((r) => setTimeout(r, 0));
    expect(fakeDebug.startCalls).toHaveLength(1);
    expect(resolved).toBe(false);

    const id = fakeDebug.startCalls[0]!.config[BreakpointMirror.SESSION_KEY];
    fakeDebug.fireTerminate({ configuration: { [BreakpointMirror.SESSION_KEY]: id } });
    await pending;
    expect(resolved).toBe(true);
  });

  // spawnCommand resolves this shape once the signal aborts, so a cancel reaches the caller as a
  // non-zero exit rather than a rejection.
  const cancelAwareShell: ShellRunner = async (_command, _workingDir, _extraEnv, signal) =>
    signal?.aborted
      ? { success: false, output: "", error: "Cancelled", returnCode: 130 }
      : { success: true, output: "", error: "", returnCode: 0 };

  it("stops the live session when the run signal aborts while waiting", async () => {
    const fakeDebug = makeFakeDebug();
    const mirror = BreakpointMirror.create(fakeDebug.debug, () => mirrorSpecText);
    const forceStop = vi.spyOn(mirror, "forceStop");
    const { executor } = makeExecutor(makeConfig(), okShell, {
      debug: fakeDebug.debug,
      workspace: makeWorkWorkspace(),
      mirror,
    });
    const controller = new AbortController();

    let resolved = false;
    const pending = executor
      .debugScenario({
        filePath: FEATURE_PATH,
        outlineName: "Passing",
        waitForSessionEnd: true,
        signal: controller.signal,
      })
      .then(() => { resolved = true; });

    await new Promise((r) => setTimeout(r, 0));
    expect(resolved).toBe(false);
    const id = fakeDebug.startCalls[0]!.config[BreakpointMirror.SESSION_KEY];
    const root = { id: "root", configuration: { [BreakpointMirror.SESSION_KEY]: id } };
    fakeDebug.fireStart(root);

    controller.abort();
    await pending;

    expect(forceStop).toHaveBeenCalledWith(id);
    expect(fakeDebug.stopCalls).toEqual([root]);
    expect(resolved).toBe(true);
  });

  it("stops the live session when the run signal aborts while the session is launching", async () => {
    const controller = new AbortController();
    const fakeDebug: FakeDebug = makeFakeDebug(undefined, () => {
      const cfg = fakeDebug.startCalls.at(-1)!.config;
      fakeDebug.fireStart({ id: "root", configuration: cfg });
      controller.abort();
      return Promise.resolve(true);
    });
    const mirror = BreakpointMirror.create(fakeDebug.debug, () => mirrorSpecText);
    const { executor } = makeExecutor(makeConfig(), okShell, {
      debug: fakeDebug.debug,
      workspace: makeWorkWorkspace(),
      mirror,
    });

    await executor.debugScenario({
      filePath: FEATURE_PATH,
      outlineName: "Passing",
      waitForSessionEnd: true,
      signal: controller.signal,
    });

    expect(fakeDebug.stopCalls).toHaveLength(1);
  });

  it("never starts a session when the run signal is already aborted", async () => {
    const fakeDebug = makeFakeDebug();
    pushFeatureBreakpoint(fakeDebug);
    const mirror = BreakpointMirror.create(fakeDebug.debug, () => mirrorSpecText);
    const fakeWindow = makeFakeWindow();
    const { executor } = makeExecutor(makeConfig(), cancelAwareShell, {
      debug: fakeDebug.debug,
      workspace: makeWorkWorkspace(),
      window: fakeWindow.window,
      mirror,
    });
    const controller = new AbortController();
    controller.abort();

    await executor.debugScenario({
      filePath: FEATURE_PATH,
      outlineName: "Passing",
      waitForSessionEnd: true,
      signal: controller.signal,
    });

    expect(fakeDebug.startCalls).toHaveLength(0);
    expect(fakeWindow.errorMessages).toHaveLength(0);
  });

  it("releases the mirrored breakpoints when the signal is already aborted and bddgen is disabled", async () => {
    // With no bddgen step the cancel is only seen after the breakpoints were mirrored, so this is
    // the one already-aborted path that can leak them into the generated spec.
    const fakeDebug = makeFakeDebug();
    pushFeatureBreakpoint(fakeDebug);
    const mirror = BreakpointMirror.create(fakeDebug.debug, () => mirrorSpecText);
    const release = vi.spyOn(mirror, "release");
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "" }), okShell, {
      debug: fakeDebug.debug,
      workspace: makeWorkWorkspace(),
      mirror,
    });
    const controller = new AbortController();
    controller.abort();

    await executor.debugScenario({
      filePath: FEATURE_PATH,
      outlineName: "Passing",
      waitForSessionEnd: true,
      signal: controller.signal,
    });

    expect(fakeDebug.startCalls).toHaveLength(0);
    expect(release).toHaveBeenCalledTimes(1);
    expect(specBreakpointLines(fakeDebug)).toEqual([]);
  });

  it("resolves a waitForSessionEnd debug when the last child session terminates", async () => {
    const fakeDebug = makeFakeDebug();
    const mirror = BreakpointMirror.create(fakeDebug.debug, () => mirrorSpecText);
    const { executor } = makeExecutor(makeConfig(), okShell, {
      debug: fakeDebug.debug,
      workspace: makeWorkWorkspace(),
      mirror,
    });

    let resolved = false;
    const pending = executor
      .debugScenario({ filePath: FEATURE_PATH, outlineName: "Passing", waitForSessionEnd: true })
      .then(() => { resolved = true; });

    await new Promise((r) => setTimeout(r, 0));
    const id = fakeDebug.startCalls[0]!.config[BreakpointMirror.SESSION_KEY];
    const root = { id: "root", configuration: { [BreakpointMirror.SESSION_KEY]: id } };
    const child = { id: "child", configuration: { type: "pwa-node" }, parentSession: root };
    fakeDebug.fireStart(child);
    fakeDebug.fireTerminate(child);

    await pending;
    expect(resolved).toBe(true);
    expect(fakeDebug.stopCalls).toEqual([root]);
  });

  it("does not hang a waitForSessionEnd debug when the launch fails", async () => {
    const fakeDebug = makeFakeDebug(undefined, () => Promise.resolve(false));
    const mirror = BreakpointMirror.create(fakeDebug.debug, () => mirrorSpecText);
    const fakeWindow = makeFakeWindow();
    const { executor } = makeExecutor(makeConfig(), okShell, {
      debug: fakeDebug.debug,
      workspace: makeWorkWorkspace(),
      window: fakeWindow.window,
      mirror,
    });

    await executor.debugScenario({
      filePath: FEATURE_PATH,
      outlineName: "Passing",
      waitForSessionEnd: true,
    });

    expect(fakeWindow.errorMessages).toHaveLength(1);
  });

  it("sets PLAYWRIGHT_JSON_OUTPUT_NAME on the debug config when jsonReportPath is set", async () => {
    const fakeDebug = makeFakeDebug();
    const { executor } = makeExecutor(
      makeConfig({ workingDirectory: "/abs" }),
      okShell,
      { debug: fakeDebug.debug }
    );

    await executor.debugScenario({
      filePath: "/abs/features/a.feature",
      outlineName: "Passing",
      jsonReportPath: "/tmp/report.json",
    });

    expect(fakeDebug.startCalls).toHaveLength(1);
    expect(fakeDebug.startCalls[0]!.config["env"]).toEqual({
      PLAYWRIGHT_JSON_OUTPUT_NAME: "/tmp/report.json",
    });
  });

  it("omits env from the debug config when jsonReportPath is unset", async () => {
    const fakeDebug = makeFakeDebug();
    const { executor } = makeExecutor(
      makeConfig({ workingDirectory: "/abs" }),
      okShell,
      { debug: fakeDebug.debug }
    );

    await executor.debugScenario({ filePath: "/abs/features/a.feature", outlineName: "Passing" });

    expect(fakeDebug.startCalls).toHaveLength(1);
    expect(fakeDebug.startCalls[0]!.config["env"]).toBeUndefined();
  });

  it("skips the shell call and goes straight to debugging when bddgenCommand is empty", async () => {
    const calls: string[] = [];
    const shell: ShellRunner = async (command) => {
      calls.push(command);
      return { success: true, output: "", error: "", returnCode: 0 };
    };
    const fakeDebug = makeFakeDebug();
    const { executor } = makeExecutor(
      makeConfig({ bddgenCommand: "", workingDirectory: "/abs" }),
      shell,
      { debug: fakeDebug.debug }
    );

    await executor.debugScenario({ filePath: "/abs/features/a.feature", outlineName: "Passing" });

    expect(calls).toHaveLength(0);
    expect(fakeDebug.startCalls).toHaveLength(1);
  });
});

describe("TestExecutor spawn settles when a grandchild holds the stdio pipes", () => {
  it("resolves shortly after the command exits even if an inherited-stdio child lives on", async () => {
    // The pre-run command exits (code 1) after 200ms but first spawns a child that
    // inherits stdout/stderr and sleeps 5s, the shape of a web server or browser
    // process outliving `playwright test`. Waiting on `close` would hang ~5s; the
    // exit+grace path must settle in ~2s.
    const orphanCommand =
      "node -e \"const cp=require('child_process');" +
      "cp.spawn(process.execPath,['-e','setTimeout(()=>{},5000)'],{stdio:'inherit'});" +
      "setTimeout(()=>process.exit(1),200)\"";
    const config = makeConfig({ preRunCommand: orphanCommand });
    // No injected shell runner: exercise the real spawn-based runner.
    const { executor } = makeExecutor(config, undefined as unknown as ShellRunner);

    const start = Date.now();
    const result = await executor.runScenarioWithOutput({ filePath: "/tmp/x.feature" });
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(result.error).toContain("preRunCommand");
    expect(elapsed).toBeLessThan(4500);
  }, 10_000);
});

describe("TestExecutor debugScenarioWithOutput cancellation", () => {
  const okShell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });

  it("reports the results the stopped debug session already wrote", async () => {
    const controller = new AbortController();
    const fakeDebug: FakeDebug = makeFakeDebug(undefined, async () => {
      const config = fakeDebug.startCalls.at(-1)!.config;
      const reportPath = (config["env"] as Record<string, string>)["PLAYWRIGHT_JSON_OUTPUT_NAME"]!;
      // Playwright writes the report when the tests finish; the stop lands during teardown.
      fs.writeFileSync(reportPath, JSON.stringify({
        suites: [{
          specs: [{
            title: "Passing scenario",
            file: "features/a.feature.spec.js",
            line: 6,
            tests: [{ results: [{ status: "passed", duration: 4, steps: [] }] }],
          }],
        }],
      }));
      fakeDebug.fireStart({ id: "root", configuration: config });
      controller.abort();
      fakeDebug.fireTerminate({ id: "root", configuration: config });
      return true;
    });
    const mirror = BreakpointMirror.create(fakeDebug.debug, () => undefined);
    const { executor } = makeExecutor(makeConfig({ workingDirectory: "/abs" }), okShell, { debug: fakeDebug.debug, mirror });

    const result = await executor.debugScenarioWithOutput({
      filePath: "/abs/features/a.feature",
      outlineName: "Passing scenario",
      signal: controller.signal,
    });

    expect(result.error).toBe("Cancelled");
    expect(result.scenarioDetails).toEqual([
      expect.objectContaining({ scenarioName: "Passing scenario", status: "passed" }),
    ]);
  }, 10_000);

  it("stays evidence-free when the stopped debug session wrote no report", async () => {
    const controller = new AbortController();
    const fakeDebug: FakeDebug = makeFakeDebug(undefined, async () => {
      const config = fakeDebug.startCalls.at(-1)!.config;
      fakeDebug.fireStart({ id: "root", configuration: config });
      controller.abort();
      fakeDebug.fireTerminate({ id: "root", configuration: config });
      return true;
    });
    const mirror = BreakpointMirror.create(fakeDebug.debug, () => undefined);
    const { executor } = makeExecutor(makeConfig({ workingDirectory: "/abs" }), okShell, { debug: fakeDebug.debug, mirror });

    const result = await executor.debugScenarioWithOutput({
      filePath: "/abs/features/a.feature",
      outlineName: "Passing scenario",
      signal: controller.signal,
    });

    expect(result.error).toBe("Cancelled");
    expect(result.scenarioDetails).toBeUndefined();
  }, 10_000);
});

describe("TestExecutor debug watchdog (pnpm session teardown wedge)", () => {
  const okShell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });

  it("settles the debug run via the JSON report watchdog when no child session ever attaches", async () => {
    const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "debug-watchdog-"));
    const reportPath = nodePath.join(tmpDir, "report.json");
    // Report already written = tests finished; the session chain just never tears down.
    fs.writeFileSync(reportPath, "{}");

    // Root session starts (carrying the mirror key) but NO child ever attaches,
    // so last-child-terminated teardown can never fire.
    const fakeDebug: FakeDebug = makeFakeDebug(undefined, async () => {
      // Runs after construction completes, so the self-reference is safe.
      const cfg = fakeDebug.startCalls.at(-1)!.config;
      fakeDebug.fireStart({ id: "root-1", configuration: cfg });
      return true;
    });
    const mirror = BreakpointMirror.create(fakeDebug.debug, () => undefined);
    const { executor } = makeExecutor(makeConfig({ workingDirectory: tmpDir }), okShell, {
      debug: fakeDebug.debug,
      mirror,
    });
    executor.debugWatchdogPollMs = 25;
    executor.debugWatchdogGraceMs = 50;

    const start = Date.now();
    await executor.debugScenario({
      filePath: nodePath.join(tmpDir, "x.feature"),
      outlineName: "s",
      waitForSessionEnd: true,
      jsonReportPath: reportPath,
    });
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(3000);
    expect(fakeDebug.stopCalls).toHaveLength(1);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }, 10_000);
});

describe("TestExecutor cancellation", () => {
  // A node process that keeps its event loop alive for 10s, the shape of a `playwright test` run
  // that must be killed when the user hits Stop. Exercised through the REAL spawn runner (no
  // injected shell) via the pre-run hook, so spawnCommand's abort/kill path is what's under test.
  const longLived = 'node -e "setTimeout(()=>{},10000)"';

  it("kills the spawned tree and settles as Cancelled when the signal aborts mid-run", async () => {
    const config = makeConfig({ preRunCommand: longLived });
    const { executor } = makeExecutor(config, undefined as unknown as ShellRunner);
    const controller = new AbortController();

    const start = Date.now();
    const pending = executor.runScenarioWithOutput({
      filePath: "/tmp/x.feature",
      signal: controller.signal,
    });
    // Let the child spawn, then hit Stop.
    await new Promise((r) => setTimeout(r, 300));
    controller.abort();
    const result = await pending;
    const elapsed = Date.now() - start;

    expect(result.success).toBe(false);
    expect(result.error).toBe("Cancelled");
    // Would hang ~10s if the process weren't killed; the kill+grace settles it fast.
    expect(elapsed).toBeLessThan(4000);
  }, 15_000);

  it("resolves immediately with Cancelled when the signal is already aborted", async () => {
    const config = makeConfig({ preRunCommand: longLived });
    const { executor } = makeExecutor(config, undefined as unknown as ShellRunner);
    const controller = new AbortController();
    controller.abort();

    const start = Date.now();
    const result = await executor.runScenarioWithOutput({
      filePath: "/tmp/x.feature",
      signal: controller.signal,
    });
    const elapsed = Date.now() - start;

    expect(result.error).toBe("Cancelled");
    expect(elapsed).toBeLessThan(1000);
  }, 15_000);

  it("preserves an unconfirmed termination marker on cancellation", async () => {
    const controller = new AbortController();
    const failure = "Process-tree termination failed with taskkill exit code 5.";
    const shell: ShellRunner = async () => {
      controller.abort();
      return {
        success: false,
        output: "",
        error: failure,
        returnCode: 1,
        terminationFailure: failure,
      };
    };
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "" }), shell);

    const result = await executor.runScenarioWithOutput({
      filePath: "/tmp/x.feature",
      signal: controller.signal,
    });

    expect(result).toMatchObject({
      success: false,
      infrastructureFailure: failure,
      admissionUnsafe: true,
    });
  });
});

describe("TestExecutor missing-binary hint", () => {
  it("appends an actionable hint when the playwright run fails with exit 127 / command not found", async () => {
    const config = makeConfig({ bddgenCommand: "" });
    const shell: ShellRunner = async () => ({
      success: false,
      output: "",
      error: "sh: npx: command not found",
      returnCode: 127,
    });
    const { executor } = makeExecutor(config, shell);

    const result = await executor.runScenarioWithOutput({ filePath: "/abs/x.feature" });

    expect(result.error).toContain('The command "npx" was not found');
    expect(result.error).toContain("playwrightBddRunner.playwrightCommand");
    // The original shell noise is preserved above the hint.
    expect(result.error).toContain("command not found");
  });

  it("names the attempted binary from the bddgen step and surfaces it through the bddgen failure", async () => {
    const shell: ShellRunner = async (command) =>
      command.includes("bddgen")
        ? {
            success: false,
            output: "",
            error: "'npx' is not recognized as an internal or external command",
            returnCode: 1,
          }
        : { success: true, output: "{}", error: "", returnCode: 0 };
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "npx bddgen" }), shell);

    const result = await executor.runScenarioWithOutput({ filePath: "/abs/x.feature" });

    expect(result.error).toContain("bddgen failed");
    expect(result.error).toContain('The command "npx" was not found');
  });

  it("does not append the hint to an ordinary test failure", async () => {
    const config = makeConfig({ bddgenCommand: "" });
    const shell: ShellRunner = async () => ({
      success: false,
      output: JSON.stringify({
        suites: [{ specs: [{ title: "s", file: "/abs/x.feature", tests: [{ results: [{ status: "failed" }] }] }] }],
      }),
      error: "1 failed",
      returnCode: 1,
    });
    const { executor } = makeExecutor(config, shell);

    const result = await executor.runScenarioWithOutput({ filePath: "/abs/x.feature" });

    expect(result.error).not.toContain("was not found");
  });
});

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

    await executor.runScenarioWithOutput({ filePath: feature, outlineName: "s" });

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

describe("TestExecutor spec-line target no-tests retry", () => {
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
      `const bddFileData = [ // bdd-data-start
  {"pwTestLine":7,"pickleLine":3,"steps":[]},
]; // bdd-data-end`
    );
  }

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
            `const bddFileData = [ // bdd-data-start
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
    const runArtifactStore = { contributeShard } as unknown as NonNullable<
      PlaywrightBddExtensionContext["runArtifactStore"]
    >;
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "npx bddgen" }), shell, {
      workspace: makeWorkspace(),
      runArtifactStore,
    });
    const scenario = { filePath: feature, line: 3, name: "S", kind: "scenario" as const };

    const result = await executor.runScenarioWithOutput({
      filePath: feature,
      lineNumber: 3,
      scenarioName: "S",
      artifactBatch: 9,
    }, { scenario, resultLines: [3] });

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

  it("returns an explicit exact-target failure instead of widening when no line map exists", async () => {
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

    expect(calls).toHaveLength(0);
    expect(result.success).toBe(false);
    expect(result.infrastructureFailure).toContain("No broader target was executed");
  });
});
