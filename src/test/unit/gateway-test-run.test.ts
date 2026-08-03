import { describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { runGatewayTestRequest } from "../../test-providers/gateway-test-run";
import { LiveTestRunProgress } from "../../test-providers/live-test-run-progress";
import {
  ExecutionAlreadyRunningError,
  ExecutionFailure,
} from "../../core/execution-gateway";
import type {
  ExecutionCaseResult,
  ExecutionEvent,
  ExecutionGateway,
  RunCompletion,
  RunIntent,
} from "../../core/run-contracts";
import { PlaywrightJsonParser } from "../../utils/playwright-json-parser";
import { Logger } from "../../utils/logger";
import { FakeTestController, FakeTestItem, type FakeTestRun } from "./helpers/fake-test-controller";

const FILE_A = "/ws/a.feature";
const FILE_B = "/ws/b.feature";

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
    selection: { kind: "multi-select", scenarios: [] },
    targets: [],
    metadata: { initiatedBy: "test-explorer" },
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
    const gateway: ExecutionGateway = {
      running: false,
      execute: vi.fn((_intent: RunIntent, options?: {
        readonly onEvent?: ((event: ExecutionEvent) => void) | undefined;
      }) => {
        options?.onEvent?.({ kind: "output", stream: "stdout", text: "teardown after stop\n" });
        return Promise.resolve(completion({
          state: "cancelled",
          output: "teardown after stop\n",
        }));
      }),
    };
    const root = leaf(FILE_A, 3, "A");
    const { run, cancelled } = rig({ roots: [root], gateway });

    const testRun = await run();

    expect(testRun?.outcome.output.join("").match(/teardown after stop/g)).toHaveLength(1);
    expect(cancelled).toEqual([root.id]);
  });

  // A debug run with no readable report has no streamed output of its own: the gateway publishes
  // the runner's error as the run's output and then reports the same string as the failure.
  it("prints a failure the runner already printed only once", async () => {
    const failure = "The debug run produced no readable JSON report.";
    const gateway: ExecutionGateway = {
      running: false,
      execute: vi.fn((_intent: RunIntent, options?: {
        readonly onEvent?: ((event: ExecutionEvent) => void) | undefined;
      }) => {
        options?.onEvent?.({ kind: "output", stream: "stderr", text: failure });
        return Promise.reject(new ExecutionFailure(completion({
          state: "partial",
          output: failure,
          failure,
        })));
      }),
    };
    const { run } = rig({ roots: [leaf(FILE_A, 3, "A")], gateway });

    const testRun = await run();

    expect(testRun?.outcome.output.join("").match(/produced no readable JSON report/g))
      .toHaveLength(1);
  });

  // The gateway streams the notice like any other line, so replaying the completion on top of a
  // streamed run would print both the notice and the run's whole tail a second time.
  it("prints a streamed run's output and its truncation notice exactly once", async () => {
    const notice = "[Specwright truncated stdout: retained 8 bytes, discarded 4 bytes.]";
    const gateway: ExecutionGateway = {
      running: false,
      execute: vi.fn((_intent: RunIntent, options?: {
        readonly onEvent?: ((event: ExecutionEvent) => void) | undefined;
      }) => {
        options?.onEvent?.({ kind: "output", stream: "stdout", text: "streamed\n" });
        options?.onEvent?.({ kind: "output", stream: "stdout", text: `${notice}\n` });
        return Promise.resolve(completion({
          state: "cancelled",
          output: `${notice}\nstreamed\n`,
        }));
      }),
    };
    const { run } = rig({ roots: [leaf(FILE_A, 3, "A")], gateway });

    const testRun = await run();

    const output = testRun!.outcome.output.join("");
    expect(output.match(/streamed/g)).toHaveLength(1);
    expect(output.match(/Specwright truncated stdout/g)).toHaveLength(1);
  });

  it("summarizes a multi-root run once and never flips a root failed on a partial run", async () => {
    const roots = [leaf(FILE_A, 3, "A"), leaf(FILE_B, 7, "B")];
    const gateway: ExecutionGateway = {
      running: false,
      execute: vi.fn(() => Promise.reject(new ExecutionFailure(completion({
        state: "partial",
        results: [caseResult(FILE_A, 3, "A")],
        passed: 1,
        failure: "the worker stopped",
      })))),
    };
    const { run, summaries, applied } = rig({ roots, gateway });

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
      gateway: { running: true, execute },
    });

    await run();

    expect(controller.runs).toHaveLength(0);
    expect(execute).not.toHaveBeenCalled();
    expect(cancelled).toEqual([]);
    expect(warn).toHaveBeenCalledWith("A test run is already in progress.");
  });

  it("leaves the tree untouched when admission is lost in a race", async () => {
    const gateway: ExecutionGateway = {
      running: false,
      execute: vi.fn(() => Promise.reject(new ExecutionAlreadyRunningError())),
    };
    const { run, cancelled, applied } = rig({ roots: [leaf(FILE_A, 3, "A")], gateway });

    const testRun = await run();

    expect(cancelled).toEqual([]);
    expect(applied).toEqual([]);
    expect(testRun?.outcome.skipped).toEqual([]);
    expect(testRun?.outcome.ended).toBe(true);
  });

  it("fails the run on an unknown error instead of skipping the subtree", async () => {
    const gateway: ExecutionGateway = {
      running: false,
      execute: vi.fn(() => Promise.reject(new Error("spawn refused"))),
    };
    const root = leaf(FILE_A, 3, "A");
    const { run, cancelled } = rig({ roots: [root], gateway });

    const testRun = await run();

    expect(testRun?.outcome.failed).toEqual([{ id: root.id, message: "spawn refused" }]);
    expect(testRun?.outcome.skipped).toEqual([]);
    expect(cancelled).toEqual([]);
  });
});
