import { describe, expect, it, vi } from "vitest";
import { LegacyDirectExecutionGateway } from "../../core/execution-gateway";
import { FeatureParser } from "../../parsers/feature-parser";
import type { TestExecutor } from "../../core/test-executor";
import type { RunIntent } from "../../core/run-contracts";
import { LegacyExecutionDiscovery, type LegacyDiscoveryPort } from "../../core/legacy-discovery";
import type { TestDiscoveryManager } from "../../core/test-discovery-manager";
import { trustedWorkspace } from "./helpers/test-workspace-trust";

const intent: RunIntent = {
  mode: "run",
  targets: [{ kind: "suite" }],
};

function createGateway(
  executor: Partial<TestExecutor>,
  discovery: LegacyDiscoveryPort["discover"] = vi.fn(() => Promise.resolve({ cases: [], diagnostics: [] }))
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
  it("requires an explicit discovery port before scanning", () => {
    const gateway = new LegacyDirectExecutionGateway({} as TestExecutor, FeatureParser.create(), trustedWorkspace());
    expect(() => gateway.discover()).toThrow("Legacy execution discovery is not configured.");
  });

  it("projects a parsed Rule and named Examples block into discovery metadata", async () => {
    const parser = FeatureParser.create();
    const parsed = parser.parseFeatureContent([
      "Feature: Checkout", "Rule: Payments", "@smoke", "Scenario Outline: Pay with <method>",
      "  Given <method>", "  Examples: cash methods", "    | method |", "    | coins |",
    ].join("\n"));
    vi.spyOn(parser, "parseFeatureFile").mockReturnValue(parsed);
    const discoverTestFiles = vi.fn().mockResolvedValue(["/ws/pay.feature"]);
    const discovery = new LegacyExecutionDiscovery({ discoverTestFiles } as unknown as TestDiscoveryManager, parser);
    const gateway = createGateway({}, discovery.discover.bind(discovery));
    const result = await gateway.discover({ refresh: true });
    expect(discoverTestFiles).toHaveBeenCalledWith({ forceRefresh: true });
    expect(result.cases).toEqual([expect.objectContaining({
      source: { path: "/ws/pay.feature", line: 8 }, tags: ["@smoke"],
      suites: [{ name: "Checkout", source: { path: "/ws/pay.feature", line: 1 } }, { name: "Payments" }],
      parameterized: { groupName: "Pay with <method>", groupLine: 4, blockLine: 6, blockName: "cash methods", substitutedName: "Pay with coins" },
    })]);
  });

  it("keeps an outline without example rows discoverable without inventing a block", async () => {
    const parser = FeatureParser.create();
    const parsed = parser.parseFeatureContent("Feature: Checkout\n  Scenario Outline: Pay with <method>\n    Given a <method> payment");
    vi.spyOn(parser, "parseFeatureFile").mockReturnValue(parsed);
    const files = { discoverTestFiles: vi.fn().mockResolvedValue(["/ws/pay.feature"]) };
    const discovery = new LegacyExecutionDiscovery(files as unknown as TestDiscoveryManager, parser);
    const result = await createGateway({}, discovery.discover.bind(discovery)).discover();
    expect(result.cases).toHaveLength(1);
    expect(result.cases[0]).toMatchObject({ name: "Pay with <method>", parameterized: { groupName: "Pay with <method>", groupLine: 2 } });
    expect(result.cases[0]!.parameterized).not.toHaveProperty("blockLine");
  });

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
