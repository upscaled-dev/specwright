import { afterEach, describe, expect, it, vi } from "vitest";
import * as vscode from "vscode";
import { runPublishBatch } from "../../commands/run-publish-execution";
import type { ExecutionGateway } from "../../core/run-contracts";
import type { ScenarioRef } from "../../traceability/scenario-ref";

const A: ScenarioRef = {
  filePath: "/ws/a.feature",
  line: 3,
  name: "A",
  kind: "scenario",
};

describe("runPublishBatch", () => {
  afterEach(() => vi.restoreAllMocks());

  it("carries project scope, decisions, targets, and initiator into one gateway run", async () => {
    const execute = vi.fn<ExecutionGateway["execute"]>().mockResolvedValue({
      state: "complete",
      results: [],
      passed: 0,
      failed: 0,
      durationMs: 1,
      artifactId: "run-1",
      output: "",
    });
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
      { execute, running: false },
      selection,
      [{ kind: "scenario", ref: A }],
      decisions,
      "coverage-board"
    )).resolves.toBe("run-1");

    expect(progressOptions?.title).toBe(
      "Running batch locally scoped to CALC (board project scope)…"
    );
    expect(execute).toHaveBeenCalledWith({
      mode: "run",
      selection,
      targets: [{ kind: "scenario", scenario: A }],
      decisions,
      metadata: { initiatedBy: "coverage-board" },
    }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
  });

  it("passes a pre-cancelled progress token to the gateway as an aborted signal", async () => {
    const execute = vi.fn<ExecutionGateway["execute"]>(async (_intent, options) => {
      expect(options?.signal?.aborted).toBe(true);
      return {
        state: "cancelled",
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
      { execute, running: false },
      { kind: "scenario", scenario: A },
      [{ kind: "scenario", ref: A }],
      [],
      "traceability-tree"
    );

    expect(execute).toHaveBeenCalledOnce();
  });

  it("delivers accumulated gateway output to the shared command output sink", async () => {
    const execute = vi.fn<ExecutionGateway["execute"]>(async (_intent, options) => {
      options?.onEvent?.({ kind: "output", stream: "stdout", text: "runner output\n" });
      return {
        state: "complete",
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
      { execute, running: false },
      { kind: "scenario", scenario: A },
      [{ kind: "scenario", ref: A }],
      [],
      "traceability-tree",
      outputSink
    );

    expect(outputSink).toHaveBeenCalledOnce();
    expect(outputSink).toHaveBeenCalledWith("runner output\n", undefined);
  });
});
