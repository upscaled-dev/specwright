import { describe, expect, it, vi } from "vitest";
import {
  runIntentWithObserver,
  runOutputFromCompletion,
  scenarioResultFromExecution,
} from "../../ui/execution-adapter";
import { ExecutionFailure } from "../../core/execution-gateway";
import type {
  ExecutionEvent,
  ExecutionGateway,
  RunCompletion,
  RunIntent,
} from "../../core/run-contracts";
import { PlaywrightJsonParser } from "../../utils/playwright-json-parser";
import { Logger } from "../../utils/logger";

const parser = PlaywrightJsonParser.create(Logger.create());

function completion(over: Partial<RunCompletion> = {}): RunCompletion {
  return {
    identity: { engine: "legacy-direct", schemaProfile: "legacy-v1" },
    state: "complete",
    results: [{
      scenario: { filePath: "/ws/a.feature", line: 3, name: "A", kind: "scenario" },
      outcome: "passed",
      durationMs: 4,
      attempts: 1,
      flaky: false,
    }],
    output: "runner output\n",
    passed: 1,
    failed: 0,
    durationMs: 5,
    ...over,
  };
}

function intent(): RunIntent {
  return {
    mode: "run",
    targets: [{ kind: "suite" }],
  };
}

function gatewayEmitting(events: readonly ExecutionEvent[], result: RunCompletion): ExecutionGateway {
  return {
    running: false,
    diagnose: vi.fn(() => Promise.resolve([])),
    discover: vi.fn(() => Promise.resolve({ cases: [], diagnostics: [] })),
    prepare: vi.fn((runIntent) => Promise.resolve({
      operationId: "operation",
      identity: result.identity,
      intent: runIntent,
    })),
    run: vi.fn((_prepared, options?: {
      readonly onEvent?: ((event: ExecutionEvent) => void) | undefined;
    }) => {
      for (const event of events) {options?.onEvent?.(event);}
      return Promise.resolve(result);
    }),
    debug: vi.fn(),
    cancel: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(),
  };
}

describe("runOutputFromCompletion", () => {
  // Whether a surface streamed the run is that surface's business; the completion only carries what
  // the run retained, so this result leaves the flag to the executor results that own it.
  it("leaves the streamed flag to the executor's own results", () => {
    expect(runOutputFromCompletion(completion(), parser, "/ws").outputStreamed).toBeUndefined();
  });
});

describe("runIntentWithObserver", () => {
  it("hands every output chunk to an observer that takes them, and retains it either way", async () => {
    const onOutput = vi.fn();
    const events: ExecutionEvent[] = [
      { kind: "output", stream: "stdout", text: "runner output\n" },
    ];

    const streamed = await runIntentWithObserver(
      gatewayEmitting(events, completion()), intent(), new AbortController().signal, { onOutput }, parser, "/ws"
    );
    const captured = await runIntentWithObserver(
      gatewayEmitting(events, completion()), intent(), new AbortController().signal, { onTestEnd: vi.fn() }, parser, "/ws"
    );

    expect(onOutput).toHaveBeenCalledWith("stdout", "runner output\n");
    expect(streamed.output).toBe("runner output\n");
    expect(captured.output).toBe("runner output\n");
  });

  it("forwards begin and case events to the progress observer", async () => {
    const onBegin = vi.fn();
    const onTestEnd = vi.fn();
    const result = completion();
    const events: ExecutionEvent[] = [
      { kind: "begin", total: 3 },
      { kind: "case-finished", result: result.results[0]!, completed: 1, total: 3 },
    ];

    await runIntentWithObserver(
      gatewayEmitting(events, result),
      intent(),
      new AbortController().signal,
      { onBegin, onTestEnd },
      parser,
      "/ws"
    );

    expect(onBegin).toHaveBeenCalledWith(3);
    expect(onTestEnd).toHaveBeenCalledWith(
      scenarioResultFromExecution(result.results[0]!),
      1,
      3
    );
  });

  it("projects the retained output of a failed run from its completion", async () => {
    const failed = completion({ state: "partial", failure: "the worker stopped" });
    const gateway: ExecutionGateway = {
      running: false,
      diagnose: vi.fn(() => Promise.resolve([])),
      discover: vi.fn(() => Promise.resolve({ cases: [], diagnostics: [] })),
      prepare: vi.fn((runIntent) => Promise.resolve({ operationId: "operation", identity: failed.identity, intent: runIntent })),
      run: vi.fn(() => Promise.reject(new ExecutionFailure(failed))),
      debug: vi.fn(),
      cancel: vi.fn(() => Promise.resolve()),
      dispose: vi.fn(),
    };

    const result = await runIntentWithObserver(
      gateway, intent(), new AbortController().signal, {}, parser, "/ws"
    );

    expect(result).toMatchObject({
      success: false,
      error: "the worker stopped",
      output: "runner output\n",
    });
  });
});
