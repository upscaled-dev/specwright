import { describe, it, expect, vi } from "vitest";
import { makeConfig, makeExecutor } from "./helpers/test-executor-driver";
import * as fs from "node:fs";
import * as os from "node:os";
import * as nodePath from "node:path";
import * as vscode from "vscode";
import { TestExecutor, RunOutputResult, ShellRunner } from "../../core/test-executor";
import { Logger } from "../../utils/logger";
import { PlaywrightJsonParser } from "../../utils/playwright-json-parser";
import { BreakpointMirror } from "../../core/breakpoint-mirror";


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
  start?: () => Promise<boolean>,
  stop?: () => Promise<void>
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
      if (stop) {return stop();}
      for (const listener of terminateListeners) {listener(session);}
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
    expect(config["runtimeExecutable"]).toBe("npx");
    const command = (config["runtimeArgs"] as string[]).join(" ");
    expect(command).toMatch(/^--no-install playwright test/);
    expect(command).not.toContain("bddgen");
    // The whole-outline debug greps its title, pinned to this feature's generated spec.
    expect(command).toContain(".features-gen");
    expect(config["runtimeArgs"]).toContain("--grep");
    expect(config["runtimeArgs"]).toContain("Passing");
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

  it("fails closed when bddgen succeeds without generating a spec", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "debug-empty-bddgen-"));
    const feature = nodePath.join(root, "features/a.feature");
    const fakeDebug = makeFakeDebug();
    const fakeWindow = makeFakeWindow();
    const { executor } = makeExecutor(
      makeConfig({ workingDirectory: root }),
      okShell,
      { debug: fakeDebug.debug, window: fakeWindow.window }
    );

    await executor.debugScenario({ filePath: feature, outlineName: "Passing" });

    expect(fakeDebug.startCalls).toHaveLength(0);
    expect(fakeWindow.errorMessages[0]).toContain("featuresGenDir");
    fs.rmSync(root, { recursive: true, force: true });
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

    const command = (fakeDebug.startCalls[0]!.config["runtimeArgs"] as string[]).join(" ");
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
    const root = { id: "root", configuration: { [BreakpointMirror.SESSION_KEY]: id } };
    fakeDebug.fireStart(root);
    fakeDebug.fireTerminate(root);
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
    expect(release).toHaveBeenCalledTimes(0);
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
    fakeDebug.fireStart(root);
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

  it("refuses debug before dispatch when no generator is configured and the spec is missing", async () => {
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

    expect(calls).toEqual([]);
    expect(fakeDebug.startCalls).toHaveLength(0);
  });

  it("runs the pre-run generator before resolving a debug target", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "debug-pre-run-"));
    const feature = nodePath.join(root, "features/a.feature");
    const spec = nodePath.join(root, ".features-gen/features/a.feature.spec.js");
    const calls: string[] = [];
    const shell: ShellRunner = async (command) => {
      calls.push(command);
      if (command === "prepare specs") {
        fs.mkdirSync(nodePath.dirname(spec), { recursive: true });
        fs.writeFileSync(spec, "// Generated from: features/a.feature");
      }
      return { success: true, output: "", error: "", returnCode: 0 };
    };
    const fakeDebug = makeFakeDebug();
    const { executor } = makeExecutor(
      makeConfig({ bddgenCommand: "", preRunCommand: "prepare specs", workingDirectory: root }),
      shell,
      { debug: fakeDebug.debug }
    );

    await executor.debugScenario({ filePath: feature, outlineName: "Passing" });

    expect(calls).toEqual(["prepare specs"]);
    expect(fakeDebug.startCalls).toHaveLength(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("debugs exact targets from every generated project", async () => {
    const root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "debug-projects-"));
    const feature = nodePath.join(root, "features/a.feature");
    for (const relative of ["features/a.feature.spec.js", "browser/a.feature.spec.js"]) {
      const spec = nodePath.join(root, ".features-gen", relative);
      fs.mkdirSync(nodePath.dirname(spec), { recursive: true });
      fs.writeFileSync(spec, `// Generated from: features/a.feature
const bddFileData = [ // bdd-data-start
  {"pwTestLine":7,"pickleLine":3},
]; // bdd-data-end`);
    }
    const fakeDebug = makeFakeDebug();
    const { executor } = makeExecutor(
      makeConfig({ bddgenCommand: "", workingDirectory: root }),
      okShell,
      { debug: fakeDebug.debug }
    );

    await executor.debugScenario({ filePath: feature, scenarioName: "Passing", lineNumber: 3 });

    expect(fakeDebug.startCalls).toHaveLength(1);
    const command = (fakeDebug.startCalls[0]!.config["runtimeArgs"] as string[]).join(" ");
    expect(command).toContain("features/a.feature.spec.js:7");
    expect(command).toContain("browser/a.feature.spec.js:7");
    fs.rmSync(root, { recursive: true, force: true });
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

  async function naturalStopResult(
    stop: () => Promise<void>
  ): Promise<Awaited<ReturnType<TestExecutor["debugScenarioWithOutput"]>>> {
    const fakeDebug = makeFakeDebug(undefined, async () => {
      const config = fakeDebug.startCalls.at(-1)!.config;
      const root = { id: "root", configuration: config };
      const child = { id: "child", configuration: { type: "pwa-node" }, parentSession: root };
      setTimeout(() => {
        fakeDebug.fireStart(root);
        fakeDebug.fireStart(child);
        fakeDebug.fireTerminate(child);
      }, 0);
      return true;
    }, stop);
    const mirror = BreakpointMirror.create(fakeDebug.debug, () => undefined);
    const { executor } = makeExecutor(
      makeConfig({ workingDirectory: "/abs" }),
      okShell,
      { debug: fakeDebug.debug, mirror }
    );
    return executor.debugScenarioWithOutput({
      filePath: "/abs/features/a.feature",
      outlineName: "A",
    });
  }

  it("returns unsafe partial evidence when natural debug teardown rejects", async () => {
    const result = await naturalStopResult(() => Promise.reject(new Error("debug host busy")));

    expect(result).toMatchObject({
      success: false,
      admissionUnsafe: true,
      terminationLease: { kind: "debug-session" },
    });
    expect(result.infrastructureFailure).toContain("debug host busy");
  });

  it("preserves an unsafe bddgen termination as debug infrastructure failure", async () => {
    const failure = "bddgen process group remained alive";
    const shell: ShellRunner = async () => ({
      success: false,
      output: "",
      error: failure,
      returnCode: 1,
      terminationFailure: failure,
      terminationLease: {
        kind: "posix-group",
        pgid: 42,
        failure,
        systemUptime: 100,
      },
    });
    const { executor } = makeExecutor(
      makeConfig({ workingDirectory: "/abs" }),
      shell
    );

    const result = await executor.debugScenarioWithOutput({
      filePath: "/abs/features/a.feature",
      outlineName: "A",
    });

    expect(result).toMatchObject({
      success: false,
      infrastructureFailure: failure,
      admissionUnsafe: true,
      terminationLease: { kind: "posix-group", pgid: 42 },
    });
  });

  it("marks debug admission unsafe when no tracked root can be stopped", async () => {
    const fakeDebug: FakeDebug = makeFakeDebug(undefined, async () => {
      const config = fakeDebug.startCalls.at(-1)!.config;
      const reportPath = (config["env"] as Record<string, string>)["PLAYWRIGHT_JSON_OUTPUT_NAME"]!;
      fs.writeFileSync(reportPath, "{}");
      return true;
    });
    const mirror = BreakpointMirror.create(fakeDebug.debug, () => undefined);
    const { executor } = makeExecutor(
      makeConfig({ workingDirectory: "/abs" }),
      okShell,
      { debug: fakeDebug.debug, mirror }
    );
    executor.debugWatchdogPollMs = 5;
    executor.debugWatchdogGraceMs = 5;

    const result = await executor.debugScenarioWithOutput({
      filePath: "/abs/features/a.feature",
      outlineName: "A",
    });

    expect(result).toMatchObject({
      success: false,
      admissionUnsafe: true,
      terminationLease: { kind: "debug-session" },
    });
    expect(result.infrastructureFailure).toContain("no tracked root session");
  });

  it("stops report polling after an aborted debug run has no tracked root", async () => {
    const controller = new AbortController();
    const fakeDebug = makeFakeDebug(undefined, async () => {
      controller.abort();
      return true;
    });
    const mirror = BreakpointMirror.create(fakeDebug.debug, () => undefined);
    const { executor } = makeExecutor(
      makeConfig({ workingDirectory: "/abs" }),
      okShell,
      { debug: fakeDebug.debug, mirror }
    );
    executor.debugWatchdogPollMs = 5;
    executor.debugWatchdogGraceMs = 5;
    const access = vi.spyOn(fs.promises, "access");

    const result = await executor.debugScenarioWithOutput({
      filePath: "/abs/features/a.feature",
      outlineName: "A",
      signal: controller.signal,
    });
    const callsAtReturn = access.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(result).toMatchObject({
      success: false,
      admissionUnsafe: true,
      terminationLease: { kind: "debug-session" },
    });
    expect(result.infrastructureFailure).toContain("no tracked root session");
    expect(callsAtReturn).toBeGreaterThan(0);
    expect(access).toHaveBeenCalledTimes(callsAtReturn);
    expect(fakeDebug.stopCalls).toEqual([]);
    access.mockRestore();
  });

  it("keeps parsed debug results when cancellation lands before result assembly", async () => {
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
      fakeDebug.fireTerminate({ id: "root", configuration: config });
      return true;
    });
    const mirror = BreakpointMirror.create(fakeDebug.debug, () => undefined);
    const parser = PlaywrightJsonParser.create(Logger.create());
    const inspect = parser.inspectFromFileAsync.bind(parser);
    const parsed = vi.spyOn(parser, "inspectFromFileAsync").mockImplementation(async (reportPath, signal) => {
      const evidence = await inspect(reportPath, signal);
      controller.abort();
      return evidence;
    });
    const { executor } = makeExecutor(makeConfig({ workingDirectory: "/abs" }), okShell, {
      debug: fakeDebug.debug,
      mirror,
      playwrightJsonParser: parser,
    });

    const result = await executor.debugScenarioWithOutput({
      filePath: "/abs/features/a.feature",
      outlineName: "Passing scenario",
      signal: controller.signal,
    });

    expect(result.error).toBe("Cancelled");
    expect(result.scenarioDetails).toEqual([
      expect.objectContaining({ scenarioName: "Passing scenario", status: "passed" }),
    ]);
    expect(parsed).toHaveBeenCalledOnce();
    expect(parsed.mock.calls[0]?.[1]).toBe(controller.signal);
  }, 10_000);

  it("does not start a replacement parse when debug cancellation stops an admitted parse", async () => {
    const controller = new AbortController();
    const fakeDebug: FakeDebug = makeFakeDebug(undefined, async () => {
      const config = fakeDebug.startCalls.at(-1)!.config;
      const reportPath = (config["env"] as Record<string, string>)["PLAYWRIGHT_JSON_OUTPUT_NAME"]!;
      fs.writeFileSync(reportPath, "{}");
      const root = { id: "root", configuration: config };
      fakeDebug.fireStart(root);
      fakeDebug.fireTerminate(root);
      return true;
    });
    const parser = PlaywrightJsonParser.create(Logger.create());
    let admitParse: (() => void) | undefined;
    const parseAdmitted = new Promise<void>((resolve) => {admitParse = resolve;});
    const inspect = vi.spyOn(parser, "inspectFromFileAsync").mockImplementation(
      async (_reportPath, signal) => {
        admitParse?.();
        return await new Promise((_resolve, reject) => {
          signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      }
    );
    const mirror = BreakpointMirror.create(fakeDebug.debug, () => undefined);
    const { executor } = makeExecutor(makeConfig({ workingDirectory: "/abs" }), okShell, {
      debug: fakeDebug.debug,
      mirror,
      playwrightJsonParser: parser,
    });

    const running = executor.debugScenarioWithOutput({
      filePath: "/abs/features/a.feature",
      outlineName: "Passing scenario",
      signal: controller.signal,
    });
    await parseAdmitted;
    controller.abort(new Error("stop parsing"));
    const result = await running;

    expect(result).toMatchObject({ success: false, error: "Cancelled" });
    expect(inspect).toHaveBeenCalledOnce();
    expect(inspect.mock.calls[0]?.[1]).toBe(controller.signal);
  });

  it("does not inspect a debug report when cancellation is already requested", async () => {
    const controller = new AbortController();
    controller.abort();
    const fakeDebug = makeFakeDebug();
    const parser = PlaywrightJsonParser.create(Logger.create());
    const inspect = vi.spyOn(parser, "inspectFromFileAsync");
    const { executor } = makeExecutor(makeConfig({ workingDirectory: "/abs" }), okShell, {
      debug: fakeDebug.debug,
      playwrightJsonParser: parser,
    });

    const result = await executor.debugScenarioWithOutput({
      filePath: "/abs/features/a.feature",
      outlineName: "Passing scenario",
      signal: controller.signal,
    });

    expect(result).toMatchObject({ success: false, error: "Cancelled" });
    expect(fakeDebug.startCalls).toHaveLength(0);
    expect(inspect).not.toHaveBeenCalled();
  });

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
    const generatedSpec = nodePath.join(tmpDir, ".features-gen/x.feature.spec.js");
    fs.mkdirSync(nodePath.dirname(generatedSpec), { recursive: true });
    fs.writeFileSync(generatedSpec, "// generated");

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
  // The child must outlive every termination path, so settling before it can only mean the tree was
  // killed rather than waited out.
  const CHILD_LIFETIME_MS = 30_000;
  // Above the Windows termination ladder's worst case and far below CHILD_LIFETIME_MS. The ladder's
  // WINDOWS_TERMINATION_BUDGET_MS is private to bounded-command-runner.ts, so this cannot be
  // derived: keep it above that budget plus the TERMINATION_GRACE_MS an in-flight kill adds to it.
  const SETTLE_BUDGET_MS = 20_000;
  // Every message the Windows ladder emits when it cannot clear the tree: the confirmation window
  // elapsing, an unreadable process table, a taskkill failure, and survivors ("left N processes
  // running"). It deliberately excludes unconfirmedTermination's "Process termination" catch-all,
  // which production reaches only from a thrown defect, and the POSIX process-group message, which
  // belongs to the strict branch.
  const UNCONFIRMED_TERMINATION = /^Process-tree termination /;
  // A node process that keeps its event loop alive, the shape of a `playwright test` run that must
  // be killed when the user hits Stop. Exercised through the REAL spawn runner (no injected shell)
  // via the pre-run hook, so spawnCommand's abort/kill path is what's under test.
  const longLived = `node -e "setTimeout(()=>{},${CHILD_LIFETIME_MS})"`;
  // The same child as a script file, announcing its own pid beside itself so the kill can be checked
  // against the process rather than against the executor's verdict. Computing the pid path from
  // __dirname keeps it out of both the shell command line and JS string escapes.
  const ANNOUNCE_SCRIPT = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'fs.writeFileSync(path.join(__dirname, "child.pid"), process.pid + "\\n");',
    `setTimeout(() => {}, ${CHILD_LIFETIME_MS});`,
  ].join("\n");

  const readAnnouncedPid = (pidPath: string): number => {
    const written = fs.readFileSync(pidPath, "utf8");
    // The terminator marks a complete write; a torn read would name the wrong process.
    if (!written.endsWith("\n")) { throw new Error(`pid file is incomplete: ${written}`); }
    return Number(written.trim());
  };
  const stillRunning = (pid: number): boolean => {
    try {
      process.kill(pid, 0);
      return true;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  };

  it("kills the spawned tree and settles as Cancelled when the signal aborts mid-run", async () => {
    const tmpDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "cancel-tree-"));
    const controller = new AbortController();
    let pending: Promise<RunOutputResult> | undefined;
    try {
      const script = nodePath.join(tmpDir, "announce.js");
      fs.writeFileSync(script, ANNOUNCE_SCRIPT);
      const config = makeConfig({ preRunCommand: `node "${script}"` });
      const { executor } = makeExecutor(config, undefined as unknown as ShellRunner);

      pending = executor.runScenarioWithOutput({
        filePath: "/tmp/x.feature",
        signal: controller.signal,
      });
      // Hit Stop only once the child has proven it is running, so the abort always lands mid-run.
      const childPid = await vi.waitFor(
        () => readAnnouncedPid(nodePath.join(tmpDir, "child.pid")),
        { timeout: 15_000, interval: 50 }
      );
      const abortedAt = Date.now();
      controller.abort();
      const result = await pending;
      const settleMs = Date.now() - abortedAt;

      expect(result.success).toBe(false);
      // A Windows ladder that cannot confirm the kill inside its budget fails closed by design, and
      // a slow runner reaches that legitimately. Either verdict is accepted, neither half-applied.
      if (process.platform === "win32" && result.error !== "Cancelled") {
        expect(result.error).toMatch(UNCONFIRMED_TERMINATION);
        expect(result.infrastructureFailure).toBe(result.error);
        expect(result.admissionUnsafe).toBe(true);
        expect(result.terminationLease).toBeDefined();
      } else {
        expect(result.error).toBe("Cancelled");
        expect(result.infrastructureFailure).toBeUndefined();
        expect(result.admissionUnsafe).toBeUndefined();
        expect(result.terminationLease).toBeUndefined();
      }
      expect(settleMs).toBeLessThan(SETTLE_BUDGET_MS);
      // Unconditional under either verdict: only the bookkeeping is allowed to be inconclusive, the
      // announced process still has to be gone.
      await vi.waitFor(() => expect(stillRunning(childPid)).toBe(false), { timeout: 5_000, interval: 50 });
    } finally {
      // Aborting twice is a no-op, so a failed assertion still takes the child down with it.
      controller.abort();
      await pending?.catch(() => undefined);
      // The directory holds a file written by a process we force-kill; Windows can hold its handles
      // briefly after the kill, so retry the removal.
      fs.rmSync(tmpDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 50_000);

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
