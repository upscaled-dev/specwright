import { describe, it, expect, beforeEach } from "vitest";
import * as vscode from "vscode";
import { TestExecutor, ShellRunner, TestRunEvent } from "../../core/test-executor";
import { ExtensionConfig } from "../../core/extension-config";
import { Logger } from "../../utils/logger";
import { PlaywrightJsonParser } from "../../utils/playwright-json-parser";
import { CommandBuilder } from "../../core/command-builder";
import { PlaywrightBddExtensionContext } from "../../types";
import { BddgenDiagnosticsProvider } from "../../providers/bddgen-diagnostics-provider";

interface ShellCall {
  command: string;
  workingDir: string;
  extraEnv?: NodeJS.ProcessEnv | undefined;
}

function makeConfig(
  values: { preRunCommand?: string; workingDirectory?: string } = {}
): ExtensionConfig {
  const stub = {
    get: <T>(key: string, defaultValue?: T): T | undefined => {
      if (key === "preRunCommand") {
        return (values.preRunCommand ?? "") as unknown as T;
      }
      if (key === "workingDirectory") {
        return (values.workingDirectory ?? "") as unknown as T;
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
  fireClose(terminal: FakeTerminal): void;
  window: typeof vscode.window;
}

function makeFakeWindow(): FakeWindow {
  const terminals: FakeTerminal[] = [];
  const closeListeners: Array<(t: unknown) => void> = [];
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
    showErrorMessage: (): Promise<unknown> => Promise.resolve(undefined),
  } as unknown as typeof vscode.window;
  return {
    terminals,
    closeListeners,
    fireClose(terminal: FakeTerminal): void {
      for (const l of closeListeners) { l(terminal); }
    },
    window,
  };
}

interface ExecutorDeps {
  workspace?: typeof vscode.workspace;
  window?: typeof vscode.window;
  debug?: typeof vscode.debug;
  bddgenDiagnostics?: BddgenDiagnosticsProvider;
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
    shellRunner
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
