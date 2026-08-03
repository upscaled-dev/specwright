import { describe, expect, it, vi } from "vitest";
import {
  ExecutionAlreadyRunningError,
  ExecutionFailure,
  ExtensionExecutionGateway,
} from "../../core/execution-gateway";
import type {
  ExecutionCaseResult,
  ExecutionEvent,
  RunCompletion,
  RunIntent,
} from "../../core/run-contracts";
import type { RunProgressObserver } from "../../core/run-progress";
import type { TestExecutor, RunOutputResult } from "../../core/test-executor";
import type { FeatureParser } from "../../parsers/feature-parser";
import type { RunArtifactStore } from "../../traceability/run-artifact-store";
import type { ScenarioRef } from "../../traceability/scenario-ref";
import type { ScenarioResult } from "../../utils/playwright-json-parser";
import { EXECUTION_LIMITS } from "../../core/execution-limits";
import { runBoundedCommand } from "../../core/bounded-command-runner";
import { Logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shell";

const A = { filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" as const };
const B = { filePath: "/ws/b.feature", line: 7, name: "B", kind: "scenario" as const };

function detail(
  name: string,
  status: ScenarioResult["status"] = "passed"
): ScenarioResult {
  return {
    featurePath: `/ws/${name.toLowerCase()}.feature`,
    lineNumber: name === "A" ? 3 : 7,
    scenarioName: name,
    status,
    durationMs: 4,
  };
}

function output(
  details: ScenarioResult[],
  success = true,
  error?: string,
  infrastructureFailure?: string
): RunOutputResult {
  return {
    success,
    output: "",
    ...(error ? { error } : {}),
    ...(infrastructureFailure ? { infrastructureFailure } : {}),
    duration: 4,
    scenarioDetails: details,
  };
}

function intent(): RunIntent {
  return {
    mode: "run",
    selection: { kind: "multi-select", scenarios: [A, B] },
    targets: [
      { kind: "scenario", scenario: A },
      { kind: "scenario", scenario: B },
    ],
    metadata: { initiatedBy: "test-explorer" },
  };
}

function loggerStub() {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function nodeCommand(script: string): string {
  return `${shellQuote(process.execPath)} -e ${shellQuote(script)}`;
}

function rig(
  runScenario: ReturnType<typeof vi.fn> = vi.fn(() => Promise.resolve(output([detail("A")]))),
  mapped: readonly ScenarioRef[] = []
) {
  const executor = {
    runScenarioWithOutput: runScenario,
    runPathFilterWithOutput: vi.fn(() => Promise.resolve(output([]))),
    runAllTestsWithTagsOutput: vi.fn(),
    runSuiteWithOutput: vi.fn(() => Promise.resolve(output([]))),
    debugScenarioWithOutput: vi.fn(),
    setForceParallel: vi.fn(),
  } as unknown as TestExecutor;
  const store = {
    beginBatch: vi.fn(() => 11),
    sealBatch: vi.fn((_handle: number, state: "complete" | "partial" | "cancelled") => ({
      id: `artifact-${state}`,
      state,
    })),
  } as unknown as RunArtifactStore;
  const parser = {
    parseFeatureFile: vi.fn(() => ({ scenarios: [] })),
  } as unknown as FeatureParser;
  const logger = loggerStub();
  return {
    gateway: new ExtensionExecutionGateway(executor, store, parser, logger, () => mapped),
    executor,
    store,
    parser,
    logger,
  };
}

describe("ExtensionExecutionGateway", () => {
  it("dispatches targets sequentially and emits one ordered terminal event", async () => {
    let running = false;
    const calls: string[] = [];
    const run = vi.fn(async (options: { filePath: string }, _target: unknown) => {
      expect(running).toBe(false);
      running = true;
      calls.push(options.filePath);
      await Promise.resolve();
      running = false;
      return output([detail(options.filePath.includes("a.feature") ? "A" : "B")]);
    });
    const { gateway, store } = rig(run);
    const events: ExecutionEvent[] = [];

    const completion = await gateway.execute(intent(), { onEvent: (event) => events.push(event) });

    expect(calls).toEqual(["/ws/a.feature", "/ws/b.feature"]);
    expect(completion).toMatchObject({ state: "complete", passed: 2, failed: 0 });
    expect(completion.artifactId).toBe("artifact-complete");
    expect(events[0]?.kind).toBe("started");
    expect(events.at(-1)?.kind).toBe("finished");
    expect(events.filter((event) => event.kind === "finished")).toHaveLength(1);
    expect(store.sealBatch).toHaveBeenCalledWith(11, "complete");
  });

  it("dispatches a scenarios target as exact refs instead of a global title grep", async () => {
    const run = vi.fn((options: { filePath: string }) => Promise.resolve(output([
      detail(options.filePath.includes("a.feature") ? "A" : "B"),
    ])));
    const { gateway } = rig(run);

    const completion = await gateway.execute({
      ...intent(),
      targets: [{ kind: "scenarios", scenarios: [A, B] }],
    });

    expect(completion).toMatchObject({ state: "complete", passed: 2 });
    expect(run).toHaveBeenCalledTimes(2);
  });

  it("lets cancellation dominate a killed-process failure and skips later targets", async () => {
    const abort = new AbortController();
    const run = vi.fn(async () => {
      abort.abort();
      return output([], false, "process exited 1");
    });
    const { gateway, store } = rig(run);

    const completion = await gateway.execute(intent(), { signal: abort.signal });

    expect(completion.state).toBe("cancelled");
    expect(run).toHaveBeenCalledTimes(1);
    expect(store.sealBatch).toHaveBeenCalledWith(11, "cancelled");
  });

  it("seals partial, emits finished, then rejects on infrastructure failure", async () => {
    const run = vi.fn()
      .mockResolvedValueOnce(output([detail("A")]))
      .mockResolvedValueOnce(output([], false, "report missing"));
    const { gateway, store } = rig(run);
    const events: ExecutionEvent[] = [];

    await expect(gateway.execute(intent(), { onEvent: (event) => events.push(event) }))
      .rejects.toMatchObject({
        completion: { state: "partial", passed: 1, failed: 0, failure: "report missing" },
      });
    expect(store.sealBatch).toHaveBeenCalledWith(11, "partial");
    expect(events.filter((event) => event.kind === "finished")).toHaveLength(1);
    expect(events.at(-1)?.kind).toBe("finished");
  });

  it("keeps assertion failures complete when a report is available", async () => {
    const { gateway, store } = rig(vi.fn()
      .mockResolvedValueOnce(output([detail("A", "failed")], false))
      .mockResolvedValueOnce(output([detail("B")])));

    const completion = await gateway.execute(intent());

    expect(completion).toMatchObject({ state: "complete", passed: 1, failed: 1 });
    expect(store.sealBatch).toHaveBeenCalledWith(11, "complete");
  });

  it("seals partial when a nonempty report carries an infrastructure failure", async () => {
    const { gateway, store } = rig(vi.fn(() => Promise.resolve(output(
      [detail("A")],
      false,
      "worker stopped",
      "Playwright reported a global error: worker stopped"
    ))));

    await expect(gateway.execute({
      ...intent(),
      targets: [{ kind: "scenario", scenario: A }],
    })).rejects.toMatchObject({
      completion: {
        state: "partial",
        passed: 1,
        failure: "Playwright reported a global error: worker stopped",
      },
    });
    expect(store.sealBatch).toHaveBeenCalledWith(11, "partial");
  });

  it("keeps the run outcome and logs when the sealed artifact disagrees", async () => {
    const { gateway, store, logger } = rig();
    vi.mocked(store.sealBatch).mockReturnValueOnce({
      id: "artifact-partial",
      state: "partial",
    } as never);
    const events: ExecutionEvent[] = [];

    const completion = await gateway.execute(
      { ...intent(), targets: [{ kind: "scenario", scenario: A }] },
      { onEvent: (event) => events.push(event) }
    );

    expect(completion).toMatchObject({ state: "complete", artifactId: "artifact-partial" });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("disagrees"), {
      run: "complete",
      artifact: "partial",
    });
    const finished = events.at(-1);
    expect(finished?.kind === "finished" && finished.completion.state).toBe("complete");
  });

  it("reports the same terminal state with and without an artifact store", async () => {
    const withStore = await rig().gateway.execute({
      ...intent(),
      targets: [{ kind: "scenario", scenario: A }],
    });
    const { executor, parser, logger } = rig();
    const storeless = new ExtensionExecutionGateway(executor, undefined, parser, logger, () => []);

    const withoutStore = await storeless.execute({
      ...intent(),
      targets: [{ kind: "scenario", scenario: A }],
    });

    expect(withoutStore.state).toBe(withStore.state);
    expect(withoutStore.failure).toBe(withStore.failure);
  });

  it("preserves successful zero-result behavior when no artifact store exists", async () => {
    const { executor, parser, logger } = rig();
    const gateway = new ExtensionExecutionGateway(executor, undefined, parser, logger, () => []);

    await expect(gateway.execute({
      mode: "run",
      selection: { kind: "suite" },
      targets: [{ kind: "suite" }],
    })).resolves.toMatchObject({ state: "complete", results: [] });
  });

  it("admits only one active run", async () => {
    let release: (() => void) | undefined;
    const parked = new Promise<void>((resolve) => {release = resolve;});
    const { gateway } = rig(vi.fn(async () => {
      await parked;
      return output([detail("A")]);
    }));
    const first = gateway.execute({ ...intent(), targets: [{ kind: "scenario", scenario: A }] });

    await expect(gateway.execute(intent())).rejects.toBeInstanceOf(ExecutionAlreadyRunningError);
    release?.();
    await first;
  });

  it("keeps admission closed after an unconfirmed process-tree termination", async () => {
    const failure = "Process-group termination could not be confirmed.";
    const { gateway } = rig(vi.fn(() => Promise.resolve({
      ...output([], false, failure, failure),
      admissionUnsafe: true,
    })));

    await expect(gateway.execute({
      ...intent(),
      targets: [{ kind: "scenario", scenario: A }],
    })).rejects.toMatchObject({ completion: { state: "partial", failure } });

    expect(gateway.running).toBe(true);
    await expect(gateway.execute(intent())).rejects.toBeInstanceOf(ExecutionAlreadyRunningError);
  });

  it("seals a pre-launch cancellation without dispatching", async () => {
    const abort = new AbortController();
    abort.abort();
    const { gateway, executor, store } = rig();

    const completion = await gateway.execute(intent(), { signal: abort.signal });

    expect(completion.state).toBe("cancelled");
    expect(executor.runScenarioWithOutput).not.toHaveBeenCalled();
    expect(store.sealBatch).toHaveBeenCalledWith(11, "cancelled");
  });

  it("cancels between sequential targets after retaining the completed case", async () => {
    const abort = new AbortController();
    const run = vi.fn(() => Promise.resolve(output([detail("A")])));
    const { gateway, store } = rig(run);

    const completion = await gateway.execute(intent(), {
      signal: abort.signal,
      onEvent: (event) => {
        if (event.kind === "case-finished") {abort.abort();}
      },
    });

    expect(completion).toMatchObject({ state: "cancelled", passed: 1 });
    expect(run).toHaveBeenCalledOnce();
    expect(store.sealBatch).toHaveBeenCalledWith(11, "cancelled");
  });

  it("lets an abort racing a failed target dominate before sealing", async () => {
    const abort = new AbortController();
    let release: ((result: RunOutputResult) => void) | undefined;
    const run = vi.fn(() => new Promise<RunOutputResult>((resolve) => {release = resolve;}));
    const { gateway, store } = rig(run);
    const pending = gateway.execute(intent(), { signal: abort.signal });

    abort.abort();
    release?.(output([detail("A")], false, "worker failed", "worker failed"));
    const completion = await pending;

    expect(completion.state).toBe("cancelled");
    expect(store.sealBatch).toHaveBeenCalledWith(11, "cancelled");
  });

  it("ignores late live events after finished", async () => {
    let late: (() => void) | undefined;
    const run = vi.fn(async (options: unknown) => {
      const progress = (options as { progress: { onTestEnd?: (...args: unknown[]) => void } }).progress;
      late = () => progress.onTestEnd?.(detail("A"), 1, 1);
      return output([detail("A")]);
    });
    const { gateway } = rig(run);
    const events: ExecutionEvent[] = [];
    await gateway.execute(
      { ...intent(), targets: [{ kind: "scenario", scenario: A }] },
      { onEvent: (event) => events.push(event) }
    );
    const count = events.length;

    late?.();

    expect(events).toHaveLength(count);
    expect(events.filter((event) => event.kind === "finished")).toHaveLength(1);
  });

  it("rejects invalid worker counts before opening an artifact", async () => {
    const { gateway, store } = rig();
    await expect(gateway.execute({ ...intent(), maxWorkers: 17 })).rejects.toThrow(/maxWorkers/);
    expect(store.beginBatch).not.toHaveBeenCalled();
  });

  it("exposes the partial completion on infrastructure errors", async () => {
    const { gateway } = rig(vi.fn(() => Promise.reject(new Error("launch failed"))));
    try {
      await gateway.execute({ ...intent(), targets: [{ kind: "scenario", scenario: A }] });
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(ExecutionFailure);
      expect((error as ExecutionFailure).completion.failure).toBe("launch failed");
    }
  });

  it("dispatches a tagged scenario as one intersected scenario run", async () => {
    const { gateway, executor, store } = rig();
    const runIntent: RunIntent = {
      mode: "run",
      selection: { kind: "scenario", scenario: A, tagExpression: "@smoke" },
      targets: [{ kind: "scenario", scenario: A, tagExpression: "@smoke" }],
    };
    await gateway.execute(runIntent);

    expect(executor.runScenarioWithOutput).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: A.filePath, tags: "@smoke" }),
      expect.anything()
    );
    expect(executor.runAllTestsWithTagsOutput).not.toHaveBeenCalled();
    expect(store.beginBatch).toHaveBeenCalledWith(runIntent.selection, []);
  });

  it("dispatches a tagged feature as one intersected path run", async () => {
    const { gateway, executor, store } = rig();
    const runIntent: RunIntent = {
      mode: "run",
      selection: { kind: "feature", filePath: A.filePath, tagExpression: "@smoke" },
      targets: [{ kind: "path", path: A.filePath, tagExpression: "@smoke" }],
    };
    await gateway.execute(runIntent);

    expect(executor.runPathFilterWithOutput).toHaveBeenCalledWith(
      A.filePath,
      undefined,
      11,
      expect.anything(),
      "@smoke",
      undefined
    );
    expect(executor.runAllTestsWithTagsOutput).not.toHaveBeenCalled();
    expect(store.beginBatch).toHaveBeenCalledWith(runIntent.selection, []);
  });

  it("records a tag-expression selection while dispatching the same expression", async () => {
    const { gateway, executor, store } = rig();
    vi.mocked(executor.runAllTestsWithTagsOutput).mockResolvedValue(output([]));
    const runIntent: RunIntent = {
      mode: "run",
      selection: { kind: "tag-expression", expression: "@smoke and not @wip" },
      targets: [{ kind: "tag-expression", expression: "@smoke and not @wip" }],
    };

    await gateway.execute(runIntent);

    expect(executor.runAllTestsWithTagsOutput).toHaveBeenCalledWith(
      "@smoke and not @wip",
      undefined,
      11,
      expect.anything()
    );
    expect(store.beginBatch).toHaveBeenCalledWith(runIntent.selection, []);
  });

  it("accumulates streamed output into the completion without dropping its event", async () => {
    const run = vi.fn(async (options: unknown) => {
      const progress = (options as { progress: { onOutput?: (stream: "stdout", text: string) => void } }).progress;
      progress.onOutput?.("stdout", "runner output\n");
      return { ...output([detail("A")]), output: "runner output\n", outputStreamed: true };
    });
    const { gateway } = rig(run);
    const events: ExecutionEvent[] = [];

    const completion = await gateway.execute(
      { ...intent(), targets: [{ kind: "scenario", scenario: A }] },
      { onEvent: (event) => events.push(event) }
    );

    expect(completion.output).toBe("runner output\n");
    expect(events).toContainEqual({ kind: "output", stream: "stdout", text: "runner output\n" });
  });

  it("bounds retained stdout and stderr when a noisy run is cancelled", async () => {
    const abort = new AbortController();
    const bytes = EXECUTION_LIMITS.outputTailBytesPerStream + 4096;
    const run = vi.fn(async (options: unknown) => {
      const progress = (options as {
        progress: { onOutput?: (stream: "stdout" | "stderr", text: string) => void };
      }).progress;
      progress.onOutput?.("stdout", "o".repeat(bytes));
      progress.onOutput?.("stderr", "e".repeat(bytes));
      abort.abort();
      return { ...output([], false, "Cancelled"), outputStreamed: true };
    });
    const { gateway } = rig(run);
    const streamed = { stdout: 0, stderr: 0 };

    const completion = await gateway.execute(
      { ...intent(), targets: [{ kind: "scenario", scenario: A }] },
      {
        signal: abort.signal,
        onEvent: (event) => {
          // The trailing notice is counted by its own test; this one is about the chunks.
          if (event.kind === "output" && !event.text.startsWith("[Specwright truncated")) {
            streamed[event.stream] += event.text.length;
          }
        },
      }
    );

    expect(completion.state).toBe("cancelled");
    expect(streamed).toEqual({ stdout: bytes, stderr: bytes });
    expect(completion.output).toContain(
      `[Specwright truncated stdout: retained ${EXECUTION_LIMITS.outputTailBytesPerStream} bytes, ` +
      "discarded 4096 bytes.]"
    );
    expect(completion.output).toContain(
      `[Specwright truncated stderr: retained ${EXECUTION_LIMITS.outputTailBytesPerStream} bytes, ` +
      "discarded 4096 bytes.]"
    );
    expect(Buffer.byteLength(completion.output)).toBeLessThanOrEqual(
      (2 * EXECUTION_LIMITS.outputTailBytesPerStream) + 240
    );
  });

  // Every entry point renders either the stream or the completion, never both, so the notice has to
  // travel on the stream as well or a streaming surface would never learn what it lost.
  it("streams one truncation notice per stream as the run's last output", async () => {
    const bytes = EXECUTION_LIMITS.outputTailBytesPerStream + 4096;
    const run = vi.fn(async (options: unknown) => {
      const progress = (options as {
        progress: { onOutput?: (stream: "stdout" | "stderr", text: string) => void };
      }).progress;
      progress.onOutput?.("stdout", "o".repeat(bytes));
      progress.onOutput?.("stderr", "e".repeat(bytes));
      return { ...output([detail("A")]), outputStreamed: true };
    });
    const { gateway } = rig(run);
    const events: ExecutionEvent[] = [];

    const completion = await gateway.execute(
      { ...intent(), targets: [{ kind: "scenario", scenario: A }] },
      { onEvent: (event) => events.push(event) }
    );

    const notices = events.filter(
      (event) => event.kind === "output" && event.text.startsWith("[Specwright truncated")
    );
    expect(notices).toEqual([
      {
        kind: "output",
        stream: "stdout",
        text: `[Specwright truncated stdout: retained ${EXECUTION_LIMITS.outputTailBytesPerStream} ` +
          "bytes, discarded 4096 bytes.]\n",
      },
      {
        kind: "output",
        stream: "stderr",
        text: `[Specwright truncated stderr: retained ${EXECUTION_LIMITS.outputTailBytesPerStream} ` +
          "bytes, discarded 4096 bytes.]\n",
      },
    ]);
    expect(events.at(-1)?.kind).toBe("finished");
    // And the completion still carries them for a surface that never streamed.
    expect(completion.output).toContain("[Specwright truncated stdout:");
  });

  it("emits no truncation notice for a run that kept every byte", async () => {
    const run = vi.fn(async (options: unknown) => {
      const progress = (options as {
        progress: { onOutput?: (stream: "stdout" | "stderr", text: string) => void };
      }).progress;
      progress.onOutput?.("stdout", "short\n");
      return { ...output([detail("A")]), outputStreamed: true };
    });
    const { gateway } = rig(run);
    const events: ExecutionEvent[] = [];

    await gateway.execute(
      { ...intent(), targets: [{ kind: "scenario", scenario: A }] },
      { onEvent: (event) => events.push(event) }
    );

    expect(events.filter((event) => event.kind === "output")).toEqual([
      { kind: "output", stream: "stdout", text: "short\n" },
    ]);
  });

  it.each([
    ["complete", "", undefined],
    ["partial", "process.exitCode=7", undefined],
    ["cancelled", "setInterval(() => {}, 1000)", 100],
  ] as const)(
    "uses one real runner-owned output tail for a %s run",
    async (expectedState, ending, abortDelay) => {
      const bytes = EXECUTION_LIMITS.outputTailBytesPerStream + 4096;
      const command = nodeCommand(
        `process.stdout.write("o".repeat(${bytes})+"stdout-tail");` +
        `process.stderr.write("e".repeat(${bytes})+"stderr-tail");${ending}`
      );
      const executor = {
        runSuiteWithOutput: async (
          signal: AbortSignal | undefined,
          _artifactBatch: number | undefined,
          progress: { onOutput?: (stream: "stdout" | "stderr", text: string) => void }
        ): Promise<RunOutputResult> => {
          const result = await runBoundedCommand({
            command,
            workingDir: process.cwd(),
            logger: Logger.create(),
            ...(signal ? { signal } : {}),
            ...(progress.onOutput ? { onOutput: progress.onOutput } : {}),
          });
          return {
            success: result.success,
            output: result.output,
            error: result.error,
            duration: 1,
            ...(result.outputStreamed ? { outputStreamed: true } : {}),
          };
        },
        setForceParallel: vi.fn(),
      } as unknown as TestExecutor;
      const parser = { parseFeatureFile: vi.fn() } as unknown as FeatureParser;
      const gateway = new ExtensionExecutionGateway(executor, undefined, parser, loggerStub(), () => []);
      const abort = new AbortController();
      const pending = gateway.execute({
        mode: "run",
        selection: { kind: "suite" },
        targets: [{ kind: "suite" }],
      }, { signal: abort.signal });
      if (abortDelay !== undefined) {setTimeout(() => abort.abort(), abortDelay);}

      let completion;
      try {
        completion = await pending;
      } catch (error) {
        if (!(error instanceof ExecutionFailure)) {throw error;}
        completion = error.completion;
      }

      expect(completion.state).toBe(expectedState);
      expect(completion.output.match(/\[Specwright truncated stdout:/g)).toHaveLength(1);
      expect(completion.output.match(/\[Specwright truncated stderr:/g)).toHaveLength(1);
      expect(completion.output).toContain("stdout-tail");
      expect(completion.output).toContain("stderr-tail");
      expect(Buffer.byteLength(completion.output)).toBeLessThanOrEqual(
        (2 * EXECUTION_LIMITS.outputTailBytesPerStream) + 240
      );
    },
    10_000
  );

  it("captures all reported rows for a declaration-line outline intent", async () => {
    const outline = {
      filePath: A.filePath,
      line: 4,
      name: "Divide",
      kind: "outline" as const,
      outlineName: "Divide",
    };
    const rows = [9, 10].map((lineNumber, index) => ({
      filePath: A.filePath,
      name: `Example #${index + 1}`,
      line: lineNumber,
      lineNumber,
      range: {} as never,
      steps: [],
      isScenarioOutline: true as const,
      outlineLineNumber: 4,
      outlineName: "Divide",
      examplesBlockLineNumber: 7,
    }));
    const details = rows.map((row) => ({
      featurePath: row.filePath,
      lineNumber: row.lineNumber,
      scenarioName: row.name,
      outlineName: row.outlineName,
      status: "passed" as const,
    }));
    const { gateway, executor, parser, store } = rig(vi.fn(() => Promise.resolve(output(details))));
    vi.mocked(parser.parseFeatureFile).mockReturnValue({ scenarios: rows } as never);

    const completion = await gateway.execute({
      mode: "run",
      selection: { kind: "scenario", scenario: outline },
      targets: [{ kind: "scenario", scenario: outline }],
    });

    expect(completion.results).toHaveLength(2);
    expect(executor.runScenarioWithOutput).toHaveBeenCalledTimes(2);
    expect(vi.mocked(executor.runScenarioWithOutput).mock.calls.map(([options, target]) => ({
      line: (options as { lineNumber?: number }).lineNumber,
      target,
    }))).toEqual([
      { line: 9, target: { scenario: outline, resultLines: [9] } },
      { line: 10, target: { scenario: outline, resultLines: [10] } },
    ]);
    expect(store.beginBatch).toHaveBeenCalledWith(
      { kind: "scenario", scenario: outline },
      []
    );
  });

  it("scopes capture with the mapped set the tracker knows, not the run's own targets", async () => {
    const outline = {
      filePath: A.filePath,
      line: 4,
      name: "Divide",
      kind: "outline" as const,
      outlineName: "Divide",
    };
    const splitBlock = {
      filePath: A.filePath,
      line: 7,
      name: "Divide edge cases",
      kind: "examplesBlock" as const,
    };
    const rows = [9, 10].map((lineNumber) => ({
      filePath: A.filePath,
      name: `Example #${lineNumber}`,
      line: lineNumber,
      lineNumber,
      range: {} as never,
      steps: [],
      isScenarioOutline: true as const,
      outlineLineNumber: 4,
      outlineName: "Divide",
      examplesBlockLineNumber: lineNumber === 9 ? 7 : 8,
    }));
    // The split block is mapped to its own key but is not part of this run.
    const { gateway, executor, parser } = rig(vi.fn(() => Promise.resolve(output([]))), [splitBlock]);
    vi.mocked(parser.parseFeatureFile).mockReturnValue({ scenarios: rows } as never);

    await gateway.execute({
      mode: "run",
      selection: { kind: "scenario", scenario: outline },
      targets: [{ kind: "scenario", scenario: outline }],
    });

    expect(executor.runScenarioWithOutput).toHaveBeenCalledWith(
      expect.objectContaining({ lineNumber: 10 }),
      { scenario: outline, resultLines: [10] }
    );
  });

  it("reads the mapped set once for the whole run", async () => {
    const mapped = vi.fn(() => []);
    const { executor, parser, logger } = rig();
    const gateway = new ExtensionExecutionGateway(executor, undefined, parser, logger, mapped);

    await gateway.execute(intent());

    expect(mapped).toHaveBeenCalledTimes(1);
  });

  // Admission is taken before the run's dependencies are read. A throwing one must not leave the
  // slot held, or every later run in the session is refused.
  it("releases the execution slot when a dependency throws before any target is dispatched", async () => {
    const { executor, parser, logger } = rig();
    const gateway = new ExtensionExecutionGateway(executor, undefined, parser, logger, () => {
      throw new Error("snapshot unavailable");
    });

    await expect(gateway.execute(intent())).rejects.toThrow("snapshot unavailable");

    expect(gateway.running).toBe(false);
    // The next run reaches the same failure, rather than being refused as a second concurrent run.
    await expect(gateway.execute(intent())).rejects.toThrow("snapshot unavailable");
  });

  it("runs each Examples-block row by its exact generated-test source line", async () => {
    const block = {
      filePath: A.filePath,
      line: 7,
      name: "Divide edge cases",
      kind: "examplesBlock" as const,
      outlineName: "Divide",
    };
    const rows = [9, 10].map((lineNumber) => ({
      filePath: A.filePath,
      name: `Example #${lineNumber}`,
      line: lineNumber,
      lineNumber,
      range: {} as never,
      steps: [],
      isScenarioOutline: true as const,
      outlineLineNumber: 4,
      outlineName: "Divide",
      examplesBlockLineNumber: 7,
    }));
    const { gateway, executor, parser } = rig(vi.fn(() => Promise.resolve(output([]))));
    vi.mocked(parser.parseFeatureFile).mockReturnValue({ scenarios: rows } as never);

    await gateway.execute({
      mode: "run",
      selection: { kind: "scenario", scenario: block },
      targets: [{ kind: "scenario", scenario: block }],
    });

    expect(vi.mocked(executor.runScenarioWithOutput).mock.calls.map(([options, target]) => ({
      line: (options as { lineNumber?: number }).lineNumber,
      target,
    }))).toEqual([
      { line: 9, target: { scenario: block, resultLines: [9] } },
      { line: 10, target: { scenario: block, resultLines: [10] } },
    ]);
  });

  it("finishes immutable and releases admission when artifact sealing fails", async () => {
    const { gateway, store, logger } = rig();
    vi.mocked(store.sealBatch).mockImplementationOnce(() => {
      throw new Error("storage unavailable");
    });
    const events: ExecutionEvent[] = [];

    const completion = await gateway.execute(
      { ...intent(), targets: [{ kind: "scenario", scenario: A }] },
      { onEvent: (event) => events.push(event) }
    );

    expect(completion).toMatchObject({ state: "complete", passed: 1 });
    expect(completion.artifactId).toBeUndefined();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("storage unavailable"));
    const finished = events.find((event) => event.kind === "finished");
    expect(finished?.kind === "finished" && Object.isFrozen(finished.completion)).toBe(true);
    expect(finished?.kind === "finished" && Object.isFrozen(finished.completion.results)).toBe(true);
    await expect(gateway.execute({ ...intent(), targets: [] })).resolves.toMatchObject({
      state: "complete",
    });
  });

  it("keeps recording and projecting cases that land after an abort", async () => {
    const abort = new AbortController();
    const run = vi.fn(async (options: unknown) => {
      const progress = (options as {
        progress: {
          onTestEnd?: (detail: ScenarioResult, completed: number, total: number) => void;
          onOutput?: (stream: "stdout" | "stderr", text: string) => void;
        };
      }).progress;
      abort.abort();
      progress.onTestEnd?.(detail("A"), 1, 2);
      progress.onOutput?.("stdout", "teardown after stop\n");
      return { success: false, output: "", error: "Cancelled", duration: 1, outputStreamed: true };
    });
    const { gateway } = rig(run);
    const events: ExecutionEvent[] = [];

    const completion = await gateway.execute(
      { ...intent(), targets: [{ kind: "scenario", scenario: A }] },
      { signal: abort.signal, onEvent: (event) => events.push(event) }
    );

    expect(completion.state).toBe("cancelled");
    expect(completion.results.map((result) => result.scenario.name)).toEqual(["A"]);
    expect(completion.passed).toBe(1);
    expect(completion.output).toContain("teardown after stop");
    expect(events).toContainEqual({
      kind: "output",
      stream: "stdout",
      text: "teardown after stop\n",
    });
  });

  it("forwards the runner's own case total as one begin event", async () => {
    const run = vi.fn(async (options: unknown) => {
      const progress = (options as { progress: { onBegin?: (total: number) => void } }).progress;
      progress.onBegin?.(7);
      return output([detail("A")]);
    });
    const { gateway } = rig(run);
    const events: ExecutionEvent[] = [];

    await gateway.execute(
      { ...intent(), targets: [{ kind: "scenario", scenario: A }] },
      { onEvent: (event) => events.push(event) }
    );

    expect(events).toContainEqual({ kind: "begin", total: 7 });
  });

  it("aggregates a few hundred cases with work linear in the case count", async () => {
    const cases = 400;
    // Every read of a landed case is counted: re-walking the accumulated set per case would make
    // the total grow with the square of the case count.
    let reads = 0;
    const details: ScenarioResult[] = Array.from({ length: cases }, (_, index) => ({
      featurePath: "/ws/scale.feature",
      lineNumber: index + 1,
      get scenarioName() {
        reads += 1;
        return `S${index}`;
      },
      status: "passed" as const,
      durationMs: 1,
      projectName: index % 2 === 0 ? "chromium" : "firefox",
    }));
    const run = vi.fn(async (options: unknown) => {
      const progress = (options as {
        progress: { onTestEnd?: (detail: ScenarioResult, completed: number, total: number) => void };
      }).progress;
      details.forEach((entry, index) => progress.onTestEnd?.(entry, index + 1, cases));
      return output(details);
    });
    const { gateway } = rig(run);
    const emitted: ExecutionCaseResult[] = [];

    const completion = await gateway.execute(
      { ...intent(), targets: [{ kind: "scenario", scenario: A }] },
      {
        onEvent: (event) => {
          if (event.kind === "case-finished") {emitted.push(event.result);}
        },
      }
    );

    expect(completion.results).toHaveLength(cases);
    expect(completion.passed).toBe(cases);
    expect(emitted).toHaveLength(cases);
    // One derivation while the case lands and one when the final report repeats it. Folding the
    // accumulated set again per case, on the event path or to answer the completion, squares this.
    expect(reads).toBe(2 * cases);
    expect(new Set(completion.results).size).toBe(cases);
  });

  describe("per-run detail budget", () => {
    type RunOptions = { readonly filePath: string; readonly progress: RunProgressObserver };

    // Step detail sized as a share of the run's cap. What is under test is which cases keep their
    // steps, so the sizes carry wide margins and no assertion depends on an exact byte count.
    function stepped(
      name: string,
      capShare: number,
      status: ScenarioResult["status"] = "passed"
    ): ScenarioResult {
      return {
        featurePath: `/ws/${name.toLowerCase()}.feature`,
        lineNumber: 3,
        scenarioName: name,
        status,
        durationMs: 4,
        steps: [{
          title: "s".repeat(Math.floor(EXECUTION_LIMITS.liveDetailBytesPerRun * capShare)),
          status: "passed",
        }],
      };
    }

    function resultFor(completion: RunCompletion, name: string): ExecutionCaseResult | undefined {
      return completion.results.find((result) => result.scenario.name === name);
    }

    it("keeps detail accounting stable when the report repeats one case", async () => {
      const repeated = stepped("Repeated", 0.25);
      const later = stepped("Later", 0.6);
      const overflow = stepped("Overflow", 0.25);
      const { gateway } = rig(vi.fn(async (options: RunOptions) => {
        if (options.filePath !== A.filePath) {return output([later, overflow]);}
        options.progress.onTestEnd?.(repeated, 1, 1);
        return output(Array.from({ length: 12 }, () => repeated));
      }));

      const completion = await gateway.execute(intent());

      expect(resultFor(completion, "Repeated")?.steps).toHaveLength(1);
      // Room for this one only if every replaced copy gave back exactly what it charged.
      expect(resultFor(completion, "Later")?.steps).toHaveLength(1);
      // And no more room than that: giving back more than was charged would admit this one.
      expect(resultFor(completion, "Overflow")?.steps).toBeUndefined();
    });

    it("drops the steps of a case past the cap and leaves the retained ones alone", async () => {
      const first = stepped("First", 0.7);
      const second = { ...stepped("Second", 0.7, "failed"), errorMessage: "expected true" };
      const { gateway } = rig(vi.fn(async (options: RunOptions) =>
        options.filePath === A.filePath ? output([first]) : output([second], false)));

      const completion = await gateway.execute(intent());

      expect(resultFor(completion, "First")?.steps).toHaveLength(1);
      expect(resultFor(completion, "Second")).toMatchObject({
        outcome: "failed",
        durationMs: 4,
        errorMessage: "expected true",
      });
      expect(resultFor(completion, "Second")?.steps).toBeUndefined();
      expect(completion).toMatchObject({ state: "complete", passed: 1, failed: 1 });
    });

    it("admits a live-charged bundle without paying twice, at the full configured cap", async () => {
      const streamed = stepped("Streamed", 0.6);
      const overflow = stepped("Overflow", 0.5);
      const { gateway } = rig(vi.fn(async (options: RunOptions) => {
        if (options.filePath !== A.filePath) {return output([overflow]);}
        // The live session pays for the bundle first, keyed by the result object it forwards,
        // exactly as live-run-session does; the accumulator then retains the same object.
        options.progress.detailBudget?.take(
          Buffer.byteLength(JSON.stringify(streamed.steps)),
          streamed
        );
        options.progress.onTestEnd?.(streamed, 1, 1);
        return output([streamed]);
      }));

      const completion = await gateway.execute(intent());

      // Double-charging the shared bundle would put 1.2 caps of charge on a 1.0 cap and drop these.
      expect(resultFor(completion, "Streamed")?.steps).toHaveLength(1);
      // The live charge itself still counts: there is no room left for an unrelated 0.5-cap case.
      expect(resultFor(completion, "Overflow")?.steps).toBeUndefined();
    });

    it("admits a live-charged stack-only bundle without paying for the stack twice", async () => {
      const stackOnly: ScenarioResult = {
        featurePath: "/ws/a.feature",
        lineNumber: 3,
        scenarioName: "StackOnly",
        status: "failed",
        durationMs: 4,
        errorMessage: "boom",
        errorStack: "s".repeat(Math.floor(EXECUTION_LIMITS.liveDetailBytesPerRun * 0.6)),
      };
      const { gateway } = rig(vi.fn(async (options: RunOptions) => {
        if (options.filePath !== A.filePath) {return output([]);}
        options.progress.detailBudget?.take(
          Buffer.byteLength(stackOnly.errorStack ?? ""),
          stackOnly
        );
        options.progress.onTestEnd?.(stackOnly, 1, 1);
        return output([stackOnly], false);
      }));

      const completion = await gateway.execute(intent());

      // A doubled stack charge would put 1.2 caps on a 1.0 cap and drop the stack.
      expect(resultFor(completion, "StackOnly")?.errorStack).toBeDefined();
    });

    it("keeps the steps of a replacement that only fits once the replaced copy is released", async () => {
      const heavy = stepped("Heavy", 0.6);
      const { gateway } = rig(vi.fn(async (options: RunOptions) => {
        if (options.filePath !== A.filePath) {return output([]);}
        options.progress.onTestEnd?.(heavy, 1, 1);
        // The report repeats the case the live stream already delivered.
        return output([heavy]);
      }));

      const completion = await gateway.execute(intent());

      expect(resultFor(completion, "Heavy")?.steps).toHaveLength(1);
    });

    it("charges the error stack to the same budget, favoring it over steps past the cap", async () => {
      const stack = "at step (a.feature:3)\n".repeat(64);
      const heavy = {
        ...stepped("Heavy", 0.95, "failed"),
        errorMessage: "expected true",
        errorStack: "s".repeat(Math.floor(EXECUTION_LIMITS.liveDetailBytesPerRun * 0.1)),
      };
      const light = { ...detail("B", "failed"), errorMessage: "expected true", errorStack: stack };
      const { gateway } = rig(vi.fn(async (options: RunOptions) =>
        (options.filePath === A.filePath ? output([heavy], false) : output([light], false))));

      const completion = await gateway.execute(intent());

      expect(resultFor(completion, "Heavy")).toMatchObject({ errorMessage: "expected true" });
      // The whole bundle does not fit, so the bulky steps are dropped and the small, high-value
      // stack keeps riding; the identity and the message always survive.
      expect(resultFor(completion, "Heavy")?.steps).toBeUndefined();
      expect(resultFor(completion, "Heavy")?.errorStack).toBeDefined();
      expect(resultFor(completion, "B")?.errorStack).toBe(stack);
    });

    it("drops an error stack that does not fit even on its own", async () => {
      const first = stepped("First", 0.7);
      const failing = {
        ...detail("B", "failed"),
        errorMessage: "boom",
        errorStack: "s".repeat(Math.floor(EXECUTION_LIMITS.liveDetailBytesPerRun * 0.6)),
      };
      const { gateway } = rig(vi.fn(async (options: RunOptions) =>
        (options.filePath === A.filePath ? output([first]) : output([failing], false))));

      const completion = await gateway.execute(intent());

      expect(resultFor(completion, "First")?.steps).toHaveLength(1);
      expect(resultFor(completion, "B")).toMatchObject({ errorMessage: "boom" });
      expect(resultFor(completion, "B")?.errorStack).toBeUndefined();
    });

    it("gives nothing back when a case whose steps were refused is replaced", async () => {
      const held = stepped("Held", 0.7);
      const refused = stepped("Refused", 0.5);
      const afterRefusal = stepped("AfterRefusal", 0.4);
      const small = stepped("Small", 0.1);
      const { gateway } = rig(vi.fn(async (options: RunOptions) =>
        options.filePath === A.filePath
          ? output([held, refused, refused])
          : output([afterRefusal, small])));

      const completion = await gateway.execute(intent());

      expect(resultFor(completion, "Held")?.steps).toHaveLength(1);
      expect(resultFor(completion, "Refused")?.steps).toBeUndefined();
      // Replacing the refused case must not hand back a share it never took.
      expect(resultFor(completion, "AfterRefusal")?.steps).toBeUndefined();
      // The budget still admits what genuinely fits.
      expect(resultFor(completion, "Small")?.steps).toHaveLength(1);
    });
  });
});
