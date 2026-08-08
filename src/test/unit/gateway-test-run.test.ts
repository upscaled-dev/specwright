import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { runGatewayTestRequest } from "../../test-providers/gateway-test-run";
import { LiveTestRunProgress } from "../../test-providers/live-test-run-progress";
import {
  ExecutionAlreadyRunningError,
  ExecutionFailure,
  LegacyDirectExecutionGateway,
} from "../../core/execution-gateway";
import { ExecutionAdmission, ExecutionAdmissionBlockedError } from "../../core/execution-admission";
import { WorkspaceTrust, WorkspaceTrustRequiredError } from "../../core/workspace-trust";
import type {
  ExecutionCaseResult,
  ExecutionDiagnostic,
  ExecutionGateway,
  ExecutionOptions,
  RunCompletion,
  RunIntent,
} from "../../core/run-contracts";
import { PlaywrightJsonParser } from "../../utils/playwright-json-parser";
import { Logger } from "../../utils/logger";
import { FeatureParser } from "../../parsers/feature-parser";
import type { TestExecutor } from "../../core/test-executor";
import { FakeTestController, FakeTestItem, type FakeTestRun } from "./helpers/fake-test-controller";

const FILE_A = "/ws/a.feature";
const FILE_B = "/ws/b.feature";
const IDENTITY = { engine: "legacy-direct", schemaProfile: "legacy.v1" } as const;
let operationId = 0;

function leaf(filePath: string, line: number, label: string): FakeTestItem {
  const item = new FakeTestItem(`${filePath}:${line}`, label, { fsPath: filePath });
  item.range = new vscode.Range(line - 1, 0, line - 1, 0);
  return item;
}

function caseResult(filePath: string, line: number, name: string): ExecutionCaseResult {
  return {
    scenario: { filePath, line, name, kind: "scenario" },
    outcome: "passed",
    durationMs: 3,
    attempts: 1,
    flaky: false,
  };
}

function completion(over: Partial<RunCompletion> = {}): RunCompletion {
  return {
    identity: IDENTITY,
    state: "complete",
    results: [],
    output: "",
    passed: 0,
    failed: 0,
    durationMs: 5,
    ...over,
  };
}

function intent(): RunIntent {
  return {
    mode: "run",
    targets: [],
  };
}

function gateway(
  execute: (intent: RunIntent, options?: ExecutionOptions) => Promise<RunCompletion>,
  options: {
    readonly running?: boolean;
    readonly diagnostics?: readonly ExecutionDiagnostic[];
  } = {}
): ExecutionGateway {
  return {
    running: options.running ?? false,
    diagnose: vi.fn(() => Promise.resolve(options.diagnostics ?? [])),
    discover: vi.fn(() => Promise.resolve({ cases: [], diagnostics: [] })),
    prepare: vi.fn(async (runIntent) => Object.freeze({
      operationId: `test-${++operationId}`,
      identity: IDENTITY,
      intent: runIntent,
    })),
    run: vi.fn((prepared, runOptions) => execute(prepared.intent, runOptions)),
    debug: vi.fn((prepared, runOptions) => execute(prepared.intent, runOptions)),
    cancel: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(),
  };
}

function rig(options: {
  readonly roots: readonly FakeTestItem[];
  readonly gateway: ExecutionGateway;
}) {
  const controller = new FakeTestController();
  const summaries: Array<{ text: string; roots: number }> = [];
  const applied: string[] = [];
  const cancelled: string[] = [];
  const request = new vscode.TestRunRequest(options.roots as unknown as vscode.TestItem[]);
  const run = async (): Promise<FakeTestRun | undefined> => {
    await runGatewayTestRequest({
      controller: controller as unknown as vscode.TestController,
      request,
      token: new vscode.CancellationTokenSource().token,
      gateway: options.gateway,
      intent: intent(),
      roots: options.roots as unknown as vscode.TestItem[],
      parser: PlaywrightJsonParser.create(Logger.create()),
      workingDir: "/ws",
      logger: Logger.create(),
      createLive: (testRun) => LiveTestRunProgress.create({
        run: testRun,
        roots: options.roots as unknown as vscode.TestItem[],
        scenarioFor: () => undefined,
      }),
      start: (root, testRun) => testRun.started(root),
      summarize: (_testRun, result, roots) => {
        summaries.push({ text: result.output, roots: roots.length });
      },
      apply: (root) => applied.push(root.id),
      cancel: (root) => cancelled.push(root.id),
    });
    return controller.runs.at(-1);
  };
  return { controller, run, summaries, applied, cancelled };
}

describe("runGatewayTestRequest", () => {
  // Text that lands while the runner tears down is streamed like any other line, so the terminal
  // shows it once and the roots still end up cancelled.
  it("shows a cancelled run's teardown output once", async () => {
    const executionGateway = gateway(vi.fn((_intent: RunIntent, options?: ExecutionOptions) => {
        options?.onEvent?.({ kind: "output", stream: "stdout", text: "teardown after stop\n" });
        return Promise.resolve(completion({
          state: "cancelled",
          output: "teardown after stop\n",
        }));
      }));
    const root = leaf(FILE_A, 3, "A");
    const { run, cancelled } = rig({ roots: [root], gateway: executionGateway });

    const testRun = await run();

    expect(testRun?.outcome.output.join("").match(/teardown after stop/g)).toHaveLength(1);
    expect(cancelled).toEqual([root.id]);
  });

  // A debug run with no readable report has no streamed output of its own: the gateway publishes
  // the runner's error as the run's output and then reports the same string as the failure.
  it("prints a failure the runner already printed only once", async () => {
    const failure = "The debug run produced no readable JSON report.";
    const executionGateway = gateway(vi.fn((_intent: RunIntent, options?: ExecutionOptions) => {
        options?.onEvent?.({ kind: "output", stream: "stderr", text: failure });
        return Promise.reject(new ExecutionFailure(completion({
          state: "partial",
          output: failure,
          failure,
        })));
      }));
    const { run } = rig({ roots: [leaf(FILE_A, 3, "A")], gateway: executionGateway });

    const testRun = await run();

    expect(testRun?.outcome.output.join("").match(/produced no readable JSON report/g))
      .toHaveLength(1);
  });

  // The gateway streams the notice like any other line, so replaying the completion on top of a
  // streamed run would print both the notice and the run's whole tail a second time.
  it("prints a streamed run's output and its truncation notice exactly once", async () => {
    const notice = "[Specwright truncated stdout: retained 8 bytes, discarded 4 bytes.]";
    const executionGateway = gateway(vi.fn((_intent: RunIntent, options?: ExecutionOptions) => {
        options?.onEvent?.({ kind: "output", stream: "stdout", text: "streamed\n" });
        options?.onEvent?.({ kind: "output", stream: "stdout", text: `${notice}\n` });
        return Promise.resolve(completion({
          state: "cancelled",
          output: `${notice}\nstreamed\n`,
        }));
      }));
    const { run } = rig({ roots: [leaf(FILE_A, 3, "A")], gateway: executionGateway });

    const testRun = await run();

    const output = testRun!.outcome.output.join("");
    expect(output.match(/streamed/g)).toHaveLength(1);
    expect(output.match(/Specwright truncated stdout/g)).toHaveLength(1);
  });

  it("summarizes a multi-root run once and never flips a root failed on a partial run", async () => {
    const roots = [leaf(FILE_A, 3, "A"), leaf(FILE_B, 7, "B")];
    const executionGateway = gateway(vi.fn(() => Promise.reject(new ExecutionFailure(completion({
        state: "partial",
        results: [caseResult(FILE_A, 3, "A")],
        passed: 1,
        failure: "the worker stopped",
      })))));
    const { run, summaries, applied } = rig({ roots, gateway: executionGateway });

    const testRun = await run();

    expect(summaries).toEqual([{ text: "", roots: 2 }]);
    expect(applied).toEqual(roots.map((root) => root.id));
    expect(testRun?.outcome.failed).toEqual([]);
    expect(testRun?.outcome.output.join("")).toContain("the worker stopped");
  });

  it("declines before opening a run when the gateway is already busy", async () => {
    const execute = vi.fn(() => Promise.resolve(completion()));
    const warn = vi.spyOn(vscode.window, "showWarningMessage");
    const { controller, run, cancelled } = rig({
      roots: [leaf(FILE_A, 3, "A")],
      gateway: gateway(execute, { running: true }),
    });

    await run();

    expect(controller.runs).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
    expect(cancelled).toEqual([]);
    expect(warn).toHaveBeenCalledWith("A test run is already in progress.");
  });

  it("leaves the tree untouched when admission is lost in a race", async () => {
    const executionGateway = gateway(vi.fn(() => Promise.reject(new ExecutionAlreadyRunningError())));
    const { run, cancelled, applied } = rig({ roots: [leaf(FILE_A, 3, "A")], gateway: executionGateway });

    const testRun = await run();

    expect(cancelled).toEqual([]);
    expect(applied).toEqual([]);
    expect(testRun?.outcome.skipped).toEqual([]);
    expect(testRun?.outcome.ended).toBe(true);
  });

  it("offers the workspace trust action when Test Explorer loses trust admission", async () => {
    const executionGateway = gateway(vi.fn(() => Promise.reject(new WorkspaceTrustRequiredError())));
    vi.spyOn(vscode.window, "showWarningMessage")
      .mockResolvedValue("Manage Workspace Trust" as never);
    const manage = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    const { run, applied, cancelled } = rig({ roots: [leaf(FILE_A, 3, "A")], gateway: executionGateway });

    const testRun = await run();

    expect(manage).toHaveBeenCalledWith("workbench.trust.manage");
    expect(applied).toEqual([]);
    expect(cancelled).toEqual([]);
    expect(testRun?.outcome.failed).toEqual([]);
    expect(testRun?.outcome.ended).toBe(true);
  });

  it("leaves the tree untouched and gives recovery guidance when a termination lease blocks it", async () => {
    const executionGateway = gateway(vi.fn(() => Promise.reject(new ExecutionAdmissionBlockedError({
        kind: "debug-session",
        failure: "the previous debug session did not terminate",
        bootId: "win32:4182",
      }))));
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const { run, cancelled, applied } = rig({ roots: [leaf(FILE_A, 3, "A")], gateway: executionGateway });

    const testRun = await run();

    expect(cancelled).toEqual([]);
    expect(applied).toEqual([]);
    expect(testRun?.outcome.failed).toEqual([]);
    expect(testRun?.outcome.skipped).toEqual([]);
    expect(testRun?.outcome.ended).toBe(true);
    expect(error).toHaveBeenCalledWith(expect.stringContaining(
      "Restart the computer to terminate any leftover Playwright or debug processes"
    ));
    expect(error).toHaveBeenCalledWith(expect.stringContaining(
      "If execution remains blocked after restarting, close every VS Code window"
    ));
    expect(error).not.toHaveBeenCalledWith(expect.stringContaining("Terminate and confirm"));
  });

  it("leaves the tree without an outcome when admission storage is unreadable", async () => {
    const executionGateway = gateway(vi.fn(() => Promise.reject(new ExecutionAdmissionBlockedError(
        "its storage could not be read; execution remains blocked"
      ))));
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const { run, cancelled, applied } = rig({ roots: [leaf(FILE_A, 3, "A")], gateway: executionGateway });

    const testRun = await run();

    expect(cancelled).toEqual([]);
    expect(applied).toEqual([]);
    expect(testRun?.outcome.failed).toEqual([]);
    expect(testRun?.outcome.skipped).toEqual([]);
    expect(testRun?.outcome.ended).toBe(true);
    const message = String(error.mock.calls[0]?.[0]);
    expect(message).toContain("Restart the computer to terminate any leftover Playwright or debug processes");
    expect(message).toContain("while every VS Code window is closed");
    expect(message).toContain(
      "move the execution-admission directory out of this extension's globalStorage directory"
    );
    expect(message.indexOf("Restart the computer")).toBeLessThan(message.indexOf("move the execution-admission"));
  });

  it("fails the run on an unknown error instead of skipping the subtree", async () => {
    const executionGateway = gateway(vi.fn(() => Promise.reject(new Error("spawn refused"))));
    const root = leaf(FILE_A, 3, "A");
    const { run, cancelled } = rig({ roots: [root], gateway: executionGateway });

    const testRun = await run();

    expect(testRun?.outcome.failed).toEqual([{ id: root.id, message: "spawn refused" }]);
    expect(testRun?.outcome.skipped).toEqual([]);
    expect(cancelled).toEqual([]);
  });

  it("does not open a run when the selected engine is unavailable", async () => {
    const execute = vi.fn(() => Promise.resolve(completion()));
    const executionGateway = gateway(execute, {
      diagnostics: [{
        severity: "error",
        code: "execution.core-client.unavailable",
        message: "Core execution is unavailable.",
        identity: { engine: "core-client", schemaProfile: "core.v1" },
      }],
    });
    const root = leaf(FILE_A, 3, "A");
    const { controller, run, applied, cancelled } = rig({ roots: [root], gateway: executionGateway });

    await run();

    expect(controller.runs).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
    expect(applied).toEqual([]);
    expect(cancelled).toEqual([]);
  });

  it("offers Manage Workspace Trust from the real legacy diagnose path before opening a run", async () => {
    const execute = vi.fn();
    const executionGateway = new LegacyDirectExecutionGateway(
      { runScenarioWithOutput: execute } as unknown as TestExecutor,
      FeatureParser.create(),
      new WorkspaceTrust(() => false)
    );
    vi.spyOn(vscode.window, "showWarningMessage")
      .mockResolvedValue("Manage Workspace Trust" as never);
    const manage = vi.spyOn(vscode.commands, "executeCommand").mockResolvedValue(undefined);
    const root = leaf(FILE_A, 3, "A");
    const { controller, run } = rig({ roots: [root], gateway: executionGateway });

    await run();

    expect(controller.runs).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
    expect(manage).toHaveBeenCalledWith("workbench.trust.manage");
  });

  it("shows admission recovery from the real legacy diagnose path before opening a run", async () => {
    const admission = new ExecutionAdmission();
    await admission.block({
      kind: "debug-session",
      failure: "the previous debug session did not terminate",
    });
    const execute = vi.fn();
    const executionGateway = new LegacyDirectExecutionGateway(
      { runScenarioWithOutput: execute } as unknown as TestExecutor,
      FeatureParser.create(),
      new WorkspaceTrust(() => true),
      admission
    );
    const error = vi.spyOn(vscode.window, "showErrorMessage");
    const root = leaf(FILE_A, 3, "A");
    const { controller, run } = rig({ roots: [root], gateway: executionGateway });

    await run();

    expect(controller.runs).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith(expect.stringContaining(
      "Restart the computer to terminate any leftover Playwright or debug processes"
    ));
  });
});
