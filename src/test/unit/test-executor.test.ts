import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { TestExecutor, ShellRunner, TestRunEvent, withJsonReporter } from "../../core/test-executor";
import { ExtensionConfig } from "../../core/extension-config";
import { Logger } from "../../utils/logger";
import { normalizePathKey, PlaywrightJsonParser } from "../../utils/playwright-json-parser";
import { CommandBuilder } from "../../core/command-builder";
import { BreakpointMirror } from "../../core/breakpoint-mirror";
import { PlaywrightBddExtensionContext } from "../../types";
import { BddgenDiagnosticsProvider } from "../../providers/bddgen-diagnostics-provider";
import { LIVE_REPORT_FILE_ENV } from "../../core/live-reporter-protocol";

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
): { executor: TestExecutor; events: TestRunEvent[]; commandBuilder: CommandBuilder } {
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
  const events: TestRunEvent[] = [];
  executor.onTestRunEvent((e) => events.push(e));
  return { executor, events, commandBuilder };
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
      ? await executor.runFeatureFileWithOutput(options)
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
    const { executor, events } = makeExecutor(config, recordingShell);

    await executor.runScenarioWithOutput({ filePath: "/tmp/x.feature", lineNumber: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toContain("--reporter=list,json");
    expect(events[0]?.kind).toBe("running");
  });

  it("execs the configured pre-run command before the playwright run", async () => {
    const config = makeConfig({ preRunCommand: "npm run build:fixtures", bddgenCommand: "" });
    const { executor } = makeExecutor(config, recordingShell);

    await executor.runScenarioWithOutput({ filePath: "/tmp/x.feature", lineNumber: 1 });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.command).toBe("npm run build:fixtures");
    expect(calls[1]!.command).toContain("--reporter=list,json");
  });

  it("aborts the test run and emits failure when the pre-run command exits non-zero", async () => {
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
    const { executor, events } = makeExecutor(config, failingShell, { runArtifactStore });
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
    const last = events[events.length - 1];
    expect(last?.kind).toBe("failure");
    expect(contributeShard).toHaveBeenCalledOnce();
    expect(contributeShard).toHaveBeenCalledWith(5, expect.objectContaining({
      success: false,
      details: [],
      invocation: scenario,
    }));
  });

  it("continues to playwright when the pre-run command exits zero", async () => {
    const config = makeConfig({ preRunCommand: "echo ok", bddgenCommand: "" });
    const { executor, events } = makeExecutor(config, recordingShell);

    await executor.runScenarioWithOutput({ filePath: "/tmp/x.feature", lineNumber: 1 });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.command).toBe("echo ok");
    const last = events[events.length - 1];
    expect(last?.kind === "success" || last?.kind === "failure").toBe(true);
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
    const { executor, events } = makeExecutor(makeConfig({ bddgenCommand: "npx bddgen" }), failingBddgen, {
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
    expect(events[events.length - 1]?.kind).toBe("failure");
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
      makeConfig({ bddgenCommand: "" }),
      async () => {throw new Error("spawn failed");},
      { runArtifactStore }
    );
    const scenario = { filePath: "/abs/a.feature", line: 3, name: "A", kind: "scenario" as const };

    const result = await executor.runScenarioWithOutput(
      { filePath: scenario.filePath, scenarioName: scenario.name, artifactBatch: 6 },
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
  it("emits running then success when playwright reports all passing", async () => {
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
    const { executor, events } = makeExecutor(config, shell);

    await executor.runScenarioWithOutput({ filePath: "/abs/x.feature" });

    expect(events[0]?.kind).toBe("running");
    const final = events[events.length - 1];
    expect(final?.kind).toBe("success");
    expect(final?.passed).toBe(2);
    expect(final?.failed).toBe(0);
  });

  it("emits failure with counts when at least one scenario fails", async () => {
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
    const { executor, events } = makeExecutor(config, shell);

    await executor.runScenarioWithOutput({ filePath: "/abs/x.feature" });

    const final = events[events.length - 1];
    expect(final?.kind).toBe("failure");
    expect(final?.passed).toBe(1);
    expect(final?.failed).toBe(1);
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
    const { executor, events } = makeExecutor(config, shell);

    await executor.runScenarioWithOutput({ filePath: "/abs/x.feature" });

    const final = events[events.length - 1];
    expect(final?.kind).toBe("failure");
    expect(final?.passed).toBe(0);
    expect(final?.failed).toBe(1);
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
    const { executor } = makeExecutor(makeConfig(), shell, { debug: fakeDebug.debug });

    await executor.debugScenario({ filePath: "/abs/features/a.feature", scenarioName: "Passing" });

    expect(sequence).toEqual(["shell:npx bddgen", "startDebugging"]);
  });

  it("passes only the playwright half as the debugged command", async () => {
    const okShell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });
    const fakeDebug = makeFakeDebug();
    const { executor } = makeExecutor(makeConfig(), okShell, { debug: fakeDebug.debug });

    await executor.debugScenario({ filePath: "/abs/features/a.feature", scenarioName: "Passing" });

    expect(fakeDebug.startCalls).toHaveLength(1);
    const config = fakeDebug.startCalls[0]!.config;
    const command = config["command"] as string;
    expect(command).toMatch(/^npx playwright test/);
    expect(command).not.toContain("bddgen");
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

    await executor.debugScenario({ filePath: "/abs/features/a.feature", scenarioName: "Passing" });

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

  it("mirrors feature breakpoints into the generated spec and tags the debug config", async () => {
    const fakeDebug = makeFakeDebug();
    pushFeatureBreakpoint(fakeDebug);
    const mirror = BreakpointMirror.create(fakeDebug.debug, () => mirrorSpecText);
    const { executor } = makeExecutor(makeConfig(), okShell, {
      debug: fakeDebug.debug,
      workspace: makeWorkWorkspace(),
      mirror,
    });

    await executor.debugScenario({ filePath: FEATURE_PATH, scenarioName: "Passing" });

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

    await executor.debugScenario({ filePath: FEATURE_PATH, scenarioName: "Passing" });

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

    await executor.debugScenario({ filePath: FEATURE_PATH, scenarioName: "Passing" });

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

    await executor.debugScenario({ filePath: FEATURE_PATH, scenarioName: "Passing" });

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
      .debugScenario({ filePath: FEATURE_PATH, scenarioName: "Passing", waitForSessionEnd: true })
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
        scenarioName: "Passing",
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
      scenarioName: "Passing",
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
      scenarioName: "Passing",
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
      scenarioName: "Passing",
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
      .debugScenario({ filePath: FEATURE_PATH, scenarioName: "Passing", waitForSessionEnd: true })
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
      scenarioName: "Passing",
      waitForSessionEnd: true,
    });

    expect(fakeWindow.errorMessages).toHaveLength(1);
  });

  it("sets PLAYWRIGHT_JSON_OUTPUT_NAME on the debug config when jsonReportPath is set", async () => {
    const fakeDebug = makeFakeDebug();
    const { executor } = makeExecutor(makeConfig(), okShell, { debug: fakeDebug.debug });

    await executor.debugScenario({
      filePath: "/abs/features/a.feature",
      scenarioName: "Passing",
      jsonReportPath: "/tmp/report.json",
    });

    expect(fakeDebug.startCalls).toHaveLength(1);
    expect(fakeDebug.startCalls[0]!.config["env"]).toEqual({
      PLAYWRIGHT_JSON_OUTPUT_NAME: "/tmp/report.json",
    });
  });

  it("omits env from the debug config when jsonReportPath is unset", async () => {
    const fakeDebug = makeFakeDebug();
    const { executor } = makeExecutor(makeConfig(), okShell, { debug: fakeDebug.debug });

    await executor.debugScenario({ filePath: "/abs/features/a.feature", scenarioName: "Passing" });

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
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "" }), shell, {
      debug: fakeDebug.debug,
    });

    await executor.debugScenario({ filePath: "/abs/features/a.feature", scenarioName: "Passing" });

    expect(calls).toHaveLength(0);
    expect(fakeDebug.startCalls).toHaveLength(1);
  });
});

describe("TestExecutor terminal lifecycle", () => {
  const okShell: ShellRunner = async () => ({ success: true, output: "", error: "", returnCode: 0 });

  it("creates a fresh terminal after the user closed the previous one", async () => {
    const fake = makeFakeWindow();
    const { executor } = makeExecutor(makeConfig(), okShell, { window: fake.window });

    await executor.runScenario({ filePath: "/abs/x.feature", scenarioName: "s" });
    expect(fake.terminals).toHaveLength(1);

    const first = fake.terminals[0];
    expect(first).toBeDefined();
    fake.fireClose(first as FakeTerminal);
    await executor.runScenario({ filePath: "/abs/x.feature", scenarioName: "s" });

    expect(fake.terminals).toHaveLength(2);
    expect(fake.terminals[1]?.sent.some((t) => t.includes("playwright"))).toBe(true);
  });

  it("reuses the same terminal across runs while it stays open", async () => {
    const fake = makeFakeWindow();
    const { executor } = makeExecutor(makeConfig(), okShell, { window: fake.window });

    await executor.runScenario({ filePath: "/abs/x.feature", scenarioName: "s" });
    await executor.runScenario({ filePath: "/abs/y.feature", scenarioName: "t" });

    expect(fake.terminals).toHaveLength(1);
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
    const { executor } = makeExecutor(makeConfig(), okShell, {
      debug: fakeDebug.debug,
      mirror,
    });
    executor.debugWatchdogPollMs = 25;
    executor.debugWatchdogGraceMs = 50;

    const start = Date.now();
    await executor.debugScenario({
      filePath: nodePath.join(tmpDir, "x.feature"),
      scenarioName: "s",
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
    const { executor, events } = makeExecutor(config, undefined as unknown as ShellRunner);
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
    // A cancelled run fires "cancelled" (so the status bar settles), never "failure".
    expect(events.some((e) => e.kind === "failure")).toBe(false);
    expect(events.some((e) => e.kind === "cancelled")).toBe(true);
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

    await executor.runScenarioWithOutput({ filePath: feature, scenarioName: "s" });

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

  it("reruns with name-grep when Playwright finds no tests for the spec-line target", async () => {
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
    const shell: ShellRunner = async (command) => {
      calls.push(command);
      if (command.includes("a.feature.spec.js")) {
        return { success: false, output: "Error: no tests found", error: "", returnCode: 1 };
      }
      return { success: true, output: retryReport, error: "", returnCode: 0 };
    };
    const contributeShard = vi.fn();
    const runArtifactStore = { contributeShard } as unknown as NonNullable<
      PlaywrightBddExtensionContext["runArtifactStore"]
    >;
    const { executor } = makeExecutor(makeConfig({ bddgenCommand: "" }), shell, {
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

    expect(calls).toHaveLength(2);
    // The target must use forward slashes; Playwright treats CLI file filters as regexes, so
    // Windows separators (`\b`, `\f`, ...) silently match nothing. Meaningful on win32 CI, where
    // path.relative would otherwise produce backslashes.
    expect(calls[0]).toContain(".features-gen/features/a.feature.spec.js:7");
    expect(calls[1]).toContain("--grep");
    expect(calls[1]).not.toContain("a.feature.spec.js");
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
    expect(capture.command).toContain("--grep");
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

  it("does not retry a run that never had a spec-line target", async () => {
    // No generated spec on disk → the first run already used name-grep; a "no tests found"
    // outcome must surface as-is instead of rerunning the identical command.
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
    expect(result.success).toBe(false);
  });
});
