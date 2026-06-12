import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { TestExecutor, ShellRunner, TestRunEvent } from "../../core/test-executor";
import { ExtensionConfig } from "../../core/extension-config";
import { Logger } from "../../utils/logger";
import { PlaywrightJsonParser } from "../../utils/playwright-json-parser";
import { CommandBuilder } from "../../core/command-builder";
import { BreakpointMirror } from "../../core/breakpoint-mirror";
import { PlaywrightBddExtensionContext } from "../../types";
import { BddgenDiagnosticsProvider } from "../../providers/bddgen-diagnostics-provider";

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
    ...(deps.bddgenDiagnostics ? { bddgenDiagnostics: deps.bddgenDiagnostics } : {}),
  };
  executor.setContext(context);
  const events: TestRunEvent[] = [];
  executor.onTestRunEvent((e) => events.push(e));
  return { executor, events, commandBuilder };
}

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
    const config = makeConfig({ preRunCommand: "" });
    const { executor, events } = makeExecutor(config, recordingShell);

    await executor.runScenarioWithOutput({ filePath: "/tmp/x.feature", lineNumber: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toContain("--reporter=json");
    expect(events[0]?.kind).toBe("running");
  });

  it("execs the configured pre-run command before the playwright run", async () => {
    const config = makeConfig({ preRunCommand: "npm run build:fixtures" });
    const { executor } = makeExecutor(config, recordingShell);

    await executor.runScenarioWithOutput({ filePath: "/tmp/x.feature", lineNumber: 1 });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.command).toBe("npm run build:fixtures");
    expect(calls[1]!.command).toContain("--reporter=json");
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
    const { executor, events } = makeExecutor(config, failingShell);

    const result = await executor.runScenarioWithOutput({ filePath: "/tmp/x.feature", lineNumber: 1 });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.command).toBe("false");
    expect(result.success).toBe(false);
    expect(result.error).toContain("preRunCommand");
    expect(result.error).toContain("17");
    const last = events[events.length - 1];
    expect(last?.kind).toBe("failure");
  });

  it("continues to playwright when the pre-run command exits zero", async () => {
    const config = makeConfig({ preRunCommand: "echo ok" });
    const { executor, events } = makeExecutor(config, recordingShell);

    await executor.runScenarioWithOutput({ filePath: "/tmp/x.feature", lineNumber: 1 });

    expect(calls).toHaveLength(2);
    expect(calls[0]!.command).toBe("echo ok");
    const last = events[events.length - 1];
    expect(last?.kind === "success" || last?.kind === "failure").toBe(true);
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
    const config = makeConfig();
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
    // inherits stdout/stderr and sleeps 5s — the shape of a web server or browser
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
    const { executor } = makeExecutor(makeConfig(), recordingShell, {
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
