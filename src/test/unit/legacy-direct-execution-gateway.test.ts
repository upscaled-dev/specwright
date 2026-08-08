import { describe, expect, it, vi } from "vitest";
import { LegacyDirectExecutionGateway } from "../../core/execution-gateway";
import type { FeatureParser } from "../../parsers/feature-parser";
import type { TestExecutor } from "../../core/test-executor";
import type { RunIntent } from "../../core/run-contracts";
import { trustedWorkspace } from "./helpers/test-workspace-trust";

const intent: RunIntent = {
  mode: "run",
  targets: [{ kind: "suite" }],
};

function createGateway(
  executor: Partial<TestExecutor>,
  discovery = vi.fn(() => Promise.resolve({ cases: [], diagnostics: [] }))
): LegacyDirectExecutionGateway {
  return new LegacyDirectExecutionGateway(
    executor as TestExecutor,
    { parseFeatureFile: vi.fn() } as unknown as FeatureParser,
    trustedWorkspace(),
    undefined,
    undefined,
    { discover: discovery }
  );
}

describe("LegacyDirectExecutionGateway lifecycle", () => {
  it("projects discovery and preparation without runner-specific fields", async () => {
    const gateway = createGateway({}, vi.fn(() => Promise.resolve({
      cases: [{
        id: "a",
        name: "A",
        source: { path: "/ws/a.feature", line: 3 },
        suites: [],
        tags: [],
      }],
      diagnostics: [],
    })));

    await expect(gateway.discover()).resolves.toEqual({
      cases: [expect.objectContaining({ source: { path: "/ws/a.feature", line: 3 } })],
      diagnostics: [],
    });
    const prepared = await gateway.prepare(intent);
    expect(prepared.identity).toEqual({ engine: "legacy-direct", schemaProfile: "legacy-v1" });
    expect(prepared.operationId).toMatch(/^[0-9a-f-]{36}$/);
    expect(Object.isFrozen(prepared)).toBe(true);
  });

  it("cancellation waits for the active lifecycle to finish", async () => {
    let terminated = false;
    const runSuiteWithOutput = vi.fn((signal?: AbortSignal) => new Promise<{
      success: boolean;
      output: string;
      error: string;
      duration: number;
    }>((resolve) => {
      signal?.addEventListener("abort", () => {
        queueMicrotask(() => {
          terminated = true;
          resolve({ success: false, output: "", error: "Cancelled", duration: 1 });
        });
      }, { once: true });
    }));
    const gateway = createGateway({
      runSuiteWithOutput: runSuiteWithOutput as TestExecutor["runSuiteWithOutput"],
      setForceParallel: vi.fn(),
    });
    const pending = gateway.run(await gateway.prepare(intent));
    await vi.waitFor(() => expect(runSuiteWithOutput).toHaveBeenCalledOnce());

    const cancellation = gateway.cancel();
    expect(terminated).toBe(false);
    await cancellation;

    await expect(pending).resolves.toMatchObject({ state: "cancelled" });
    expect(terminated).toBe(true);
    await gateway.dispose();
    await gateway.dispose();
  });
});
