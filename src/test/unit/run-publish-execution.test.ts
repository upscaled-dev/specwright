import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { runPublishBatch } from "../../commands/run-publish-execution";
import type {
  ExecutionGateway,
  ExecutionOptions,
  RunCompletion,
  RunIntent,
} from "../../core/run-contracts";
import type { ScenarioRef } from "../../traceability/scenario-ref";
import { executionClientContext } from "../../ui/execution-client-context";

const A: ScenarioRef = {
  filePath: "/ws/a.feature",
  line: 3,
  name: "A",
  kind: "scenario",
};
const IDENTITY = { engine: "legacy-direct", schemaProfile: "legacy.v1" } as const;

function gateway(
  execute: (intent: RunIntent, options?: ExecutionOptions) => Promise<RunCompletion>
): ExecutionGateway {
  return {
    running: false,
    diagnose: vi.fn(() => Promise.resolve([])),
    discover: vi.fn(() => Promise.resolve({ cases: [], diagnostics: [] })),
    prepare: vi.fn(async (intent) => ({ operationId: "test-1", identity: IDENTITY, intent })),
    run: vi.fn((prepared, options) => execute(prepared.intent, options)),
    debug: vi.fn((prepared, options) => execute(prepared.intent, options)),
    cancel: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(),
  };
}

describe("runPublishBatch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("carries project scope, decisions, targets, and initiator into one gateway run", async () => {
    const execute = vi.fn(async () => ({
      identity: IDENTITY,
      state: "complete",
      results: [],
      passed: 0,
      failed: 0,
      durationMs: 1,
      artifactId: "run-1",
      output: "",
    } as const));
    const executionGateway = gateway(execute);
    let progressOptions: vscode.ProgressOptions | undefined;
    vi.spyOn(vscode.window, "withProgress").mockImplementation((options, task) => {
      progressOptions = options;
      return Promise.resolve(task(
        { report: () => undefined },
        {
          isCancellationRequested: false,
          onCancellationRequested: () => ({ dispose: () => undefined }),
        } as vscode.CancellationToken
      ));
    });
    const selection = { kind: "all-mapped" as const, project: "CALC" };
    const decisions = [{
      scenario: A,
      state: "unmapped" as const,
      outcome: "local-only" as const,
    }];

    await expect(runPublishBatch(
      executionGateway,
      selection,
      [{ kind: "scenario", ref: A }],
      decisions,
      "coverage-board",
      [A]
    )).resolves.toBe("run-1");

    expect(progressOptions?.title).toBe(
      "Running batch locally scoped to CALC (board project scope)…"
    );
    const preparedIntent = vi.mocked(executionGateway.prepare).mock.calls[0]![0];
    expect(preparedIntent).toEqual({
      mode: "run",
      targets: [{ kind: "scenario", scenario: A }],
    });
    expect(executionClientContext(preparedIntent)).toEqual({
      selection,
      decisions,
      initiatedBy: "coverage-board",
      artifactOwnership: [A],
    });
    expect(execute).toHaveBeenCalledWith(
      preparedIntent,
      expect.objectContaining({ signal: expect.any(AbortSignal) })
    );
  });

  it("passes a pre-cancelled progress token to the gateway as an aborted signal", async () => {
    const execute = vi.fn(async (_intent: RunIntent, options?: ExecutionOptions) => {
      expect(options?.signal?.aborted).toBe(true);
      return {
        identity: IDENTITY,
        state: "cancelled" as const,
        results: [],
        passed: 0,
        failed: 0,
        durationMs: 1,
        output: "",
      };
    });
    vi.spyOn(vscode.window, "withProgress").mockImplementation((_options, task) =>
      Promise.resolve(task(
        { report: () => undefined },
        {
          isCancellationRequested: true,
          onCancellationRequested: () => ({ dispose: () => undefined }),
        } as vscode.CancellationToken
      ))
    );

    await runPublishBatch(
      gateway(execute),
      { kind: "scenario", scenario: A },
      [{ kind: "scenario", ref: A }],
      [],
      "traceability-tree",
      []
    );

    expect(execute).toHaveBeenCalledOnce();
  });

  it("delivers accumulated gateway output to the shared command output sink", async () => {
    const execute = vi.fn(async (_intent: RunIntent, options?: ExecutionOptions) => {
      options?.onEvent?.({ kind: "output", stream: "stdout", text: "runner output\n" });
      return {
        identity: IDENTITY,
        state: "complete" as const,
        results: [],
        passed: 0,
        failed: 0,
        durationMs: 1,
        output: "runner output\n",
        artifactId: "run-output",
      };
    });
    const outputSink = vi.fn();

    await runPublishBatch(
      gateway(execute),
      { kind: "scenario", scenario: A },
      [{ kind: "scenario", ref: A }],
      [],
      "traceability-tree",
      [],
      outputSink
    );

    expect(outputSink).toHaveBeenCalledOnce();
    expect(outputSink).toHaveBeenCalledWith("runner output\n", undefined);
  });
});
