import { describe, expect, it, vi } from "vitest";
import {
  CORE_SCHEMA_PROFILE,
  developmentHostEngine,
  ExecutionSelectionOwner,
  LEGACY_SCHEMA_PROFILE,
  SelectedExecutionGateway,
} from "../../core/execution-engine";
import {
  CORE_CLIENT_UNAVAILABLE,
  CoreClientUnavailableError,
  UnavailableCoreExecutionGateway,
} from "../../core/core-client";
import type {
  ExecutionDiagnostic,
  ExecutionDiscovery,
  ExecutionIdentity,
  ExecutionOptions,
  ExecutionServiceGateway,
  PreparedExecution,
  RunCompletion,
  RunIntent,
} from "../../core/run-contracts";

const intent: RunIntent = {
  mode: "run",
  targets: [{ kind: "suite" }],
};

const complete: RunCompletion = {
  identity: { engine: "legacy-direct", schemaProfile: LEGACY_SCHEMA_PROFILE },
  state: "complete",
  results: [],
  output: "",
  passed: 0,
  failed: 0,
  durationMs: 1,
};

function gateway(identity: ExecutionIdentity) {
  const implementation: ExecutionServiceGateway = {
    running: false,
    diagnose: vi.fn(() => Promise.resolve([] as readonly ExecutionDiagnostic[])),
    discover: vi.fn(() => Promise.resolve({ cases: [], diagnostics: [] } as ExecutionDiscovery)),
    prepare: vi.fn((preparedIntent: RunIntent) => Promise.resolve({
      operationId: "operation",
      identity,
      intent: preparedIntent,
    } as PreparedExecution)),
    run: vi.fn(() => Promise.resolve({ ...complete, identity })),
    debug: vi.fn(() => Promise.resolve({ ...complete, identity })),
    cancel: vi.fn(() => Promise.resolve()),
    dispose: vi.fn(),
  };
  return implementation;
}

describe("ExecutionSelectionOwner", () => {
  it("defaults to a frozen legacy-direct schema selection", () => {
    const selected = new ExecutionSelectionOwner().begin();

    expect(selected).toEqual({ engine: "legacy-direct", schemaProfile: LEGACY_SCHEMA_PROFILE });
    expect(Object.isFrozen(selected)).toBe(true);
  });

  it("accepts only trusted source slots and gives policy precedence", () => {
    const selected = new ExecutionSelectionOwner({
      administratorPolicy: () => "legacy-direct",
      userProfile: () => "core-client",
      developmentHostEnvironment: () => "core-client",
      ...({ workspace: () => "core-client" } as object),
    }).begin();

    expect(selected.engine).toBe("legacy-direct");
  });

  it("ignores environment selection outside an Extension Development Host", () => {
    expect(developmentHostEngine(false, "core-client")).toBeUndefined();
    expect(developmentHostEngine(true, "core-client")).toBe("core-client");
    expect(() => developmentHostEngine(true, "workspace-value")).toThrow(
      "Unsupported execution engine selection"
    );
  });
});

describe("SelectedExecutionGateway", () => {
  it("freezes one engine before prepare and keeps it for the run", async () => {
    let selected: "legacy-direct" | "core-client" = "legacy-direct";
    const legacy = gateway({ engine: "legacy-direct", schemaProfile: LEGACY_SCHEMA_PROFILE });
    const core = gateway({ engine: "core-client", schemaProfile: CORE_SCHEMA_PROFILE });
    vi.mocked(legacy.prepare).mockImplementation(async (preparedIntent) => {
      selected = "core-client";
      return { operationId: "operation", identity: {
        engine: "legacy-direct",
        schemaProfile: LEGACY_SCHEMA_PROFILE,
      }, intent: preparedIntent };
    });
    const router = new SelectedExecutionGateway(
      new ExecutionSelectionOwner({ userProfile: () => selected }),
      { "legacy-direct": legacy, "core-client": core }
    );

    const prepared = await router.prepare(intent);
    expect(Object.isFrozen(prepared)).toBe(true);
    expect(Object.isFrozen(prepared.identity)).toBe(true);
    expect(Object.isFrozen(prepared.intent)).toBe(true);
    expect(Object.isFrozen(prepared.intent.targets)).toBe(true);
    await router.run(prepared);
    await expect(router.run(prepared)).rejects.toThrow("already consumed");

    expect(legacy.prepare).toHaveBeenCalledOnce();
    expect(legacy.run).toHaveBeenCalledOnce();
    expect(core.prepare).not.toHaveBeenCalled();
    expect(core.run).not.toHaveBeenCalled();
  });

  it("never falls back after the selected engine accepts then loses the outcome", async () => {
    const legacy = gateway({ engine: "legacy-direct", schemaProfile: LEGACY_SCHEMA_PROFILE });
    const core = gateway({ engine: "core-client", schemaProfile: CORE_SCHEMA_PROFILE });
    vi.mocked(core.run).mockRejectedValue(new Error("outcome unknown"));
    const router = new SelectedExecutionGateway(
      new ExecutionSelectionOwner({ administratorPolicy: () => "core-client" }),
      { "legacy-direct": legacy, "core-client": core }
    );

    await expect(router.run(await router.prepare(intent))).rejects.toThrow("outcome unknown");

    expect(core.prepare).toHaveBeenCalledOnce();
    expect(core.run).toHaveBeenCalledOnce();
    expect(legacy.prepare).not.toHaveBeenCalled();
    expect(legacy.run).not.toHaveBeenCalled();
  });

  it("invalidates a prepared handle cancelled before it runs", async () => {
    const legacy = gateway({ engine: "legacy-direct", schemaProfile: LEGACY_SCHEMA_PROFILE });
    const core = gateway({ engine: "core-client", schemaProfile: CORE_SCHEMA_PROFILE });
    const router = new SelectedExecutionGateway(
      new ExecutionSelectionOwner(),
      { "legacy-direct": legacy, "core-client": core }
    );
    const prepared = await router.prepare(intent);

    await router.cancel(prepared);

    expect(legacy.cancel).toHaveBeenCalledWith(expect.objectContaining({ operationId: "operation" }));
    await expect(router.run(prepared)).rejects.toThrow("already consumed");
    expect(legacy.run).not.toHaveBeenCalled();
  });

  it("fails closed with a stable diagnostic when Core artifacts are unavailable", async () => {
    const legacy = gateway({ engine: "legacy-direct", schemaProfile: LEGACY_SCHEMA_PROFILE });
    const core = new UnavailableCoreExecutionGateway({
      engine: "core-client",
      schemaProfile: CORE_SCHEMA_PROFILE,
    });
    const router = new SelectedExecutionGateway(
      new ExecutionSelectionOwner({ developmentHostEnvironment: () => "core-client" }),
      { "legacy-direct": legacy, "core-client": core }
    );

    await expect(router.prepare(intent)).rejects.toMatchObject({
      name: "CoreClientUnavailableError",
      code: CORE_CLIENT_UNAVAILABLE,
    } satisfies Partial<CoreClientUnavailableError>);
    await expect(router.discover({ refresh: true })).rejects.toMatchObject({
      code: CORE_CLIENT_UNAVAILABLE,
    });
    await expect(router.diagnose()).resolves.toEqual([
      expect.objectContaining({ code: CORE_CLIENT_UNAVAILABLE, severity: "error" }),
    ]);
    expect(legacy.prepare).not.toHaveBeenCalled();
    expect(legacy.discover).not.toHaveBeenCalled();
    expect(legacy.run).not.toHaveBeenCalled();
  });

  it("routes debug, cancellation, and disposal to the one active engine", async () => {
    let release: (() => void) | undefined;
    let releaseDispose: (() => void) | undefined;
    const legacy = gateway({ engine: "legacy-direct", schemaProfile: LEGACY_SCHEMA_PROFILE });
    const core = gateway({ engine: "core-client", schemaProfile: CORE_SCHEMA_PROFILE });
    vi.mocked(legacy.debug).mockImplementation(
      (_prepared: PreparedExecution, _options?: ExecutionOptions) =>
        new Promise<RunCompletion>((resolve) => {release = () => resolve(complete);})
    );
    vi.mocked(legacy.cancel).mockImplementation(async () => {release?.();});
    vi.mocked(legacy.dispose).mockImplementation(
      () => new Promise<void>((resolve) => {releaseDispose = resolve;})
    );
    const router = new SelectedExecutionGateway(
      new ExecutionSelectionOwner(),
      { "legacy-direct": legacy, "core-client": core }
    );
    const prepared = await router.prepare(intent);
    const pending = router.debug(prepared);
    await vi.waitFor(() => expect(router.running).toBe(true));

    await router.cancel(prepared);
    expect(router.running).toBe(false);
    await pending;
    let disposed = false;
    const disposing = router.dispose().then(() => {disposed = true;});
    await vi.waitFor(() => expect(legacy.dispose).toHaveBeenCalledOnce());
    expect(disposed).toBe(false);
    releaseDispose?.();
    await disposing;
    await router.dispose();

    expect(legacy.debug).toHaveBeenCalledOnce();
    expect(legacy.cancel).toHaveBeenCalledOnce();
    expect(legacy.dispose).toHaveBeenCalledOnce();
    expect(core.dispose).toHaveBeenCalledOnce();
  });
});
