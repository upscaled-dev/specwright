import { describe, expect, it, vi } from "vitest";
import {
  startExecution,
  type ExecutionServiceGateway,
  type RunCompletion,
  type RunIntent,
} from "../../core/run-contracts";

const completion: RunCompletion = {
  identity: { engine: "legacy-direct", schemaProfile: "legacy-v1" },
  state: "complete",
  results: [],
  output: "",
  passed: 0,
  failed: 0,
  durationMs: 1,
};

function gateway(): ExecutionServiceGateway {
  return {
    running: false,
    diagnose: vi.fn(() => Promise.resolve([])),
    discover: vi.fn(() => Promise.resolve({ cases: [], diagnostics: [] })),
    prepare: vi.fn((preparedIntent) => Promise.resolve({
      operationId: "operation",
      identity: completion.identity,
      intent: preparedIntent,
    })),
    run: vi.fn(() => Promise.resolve(completion)),
    debug: vi.fn(() => Promise.resolve(completion)),
    cancel: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(),
  };
}

function intent(mode: RunIntent["mode"]): RunIntent {
  return { mode, targets: [{ kind: "suite" }] };
}

describe("startExecution", () => {
  it.each(["run", "debug"] as const)("routes %s through the lifecycle method", async (mode) => {
    const service = gateway();

    await startExecution(service, intent(mode));

    expect(service[mode]).toHaveBeenCalledOnce();
    expect(service.prepare).toHaveBeenCalledOnce();
  });
});
