import { describe, it, expect, vi, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { activate, deactivate } from "../../extension";
import { PROMPTED_STATE_KEY } from "../../commands/prompt-worker-count";
import { Logger } from "../../utils/logger";
import { ExecutionAdmissionBlockedError } from "../../core/execution-admission";
import { SelectedExecutionGateway } from "../../core/execution-engine";
import { TraceabilitySubsystem } from "../../traceability/traceability-subsystem";
import { WorkspaceTrust } from "../../core/workspace-trust";
import { TestExecutor } from "../../core/test-executor";
import { PlaywrightBddTestProvider } from "../../test-providers/playwright-bdd-test-provider";
import { FakeTestController } from "./helpers/fake-test-controller";

const { gatewayArgs, gateways } = vi.hoisted(() => ({
  gatewayArgs: [] as unknown[][],
  gateways: [] as Array<{ execute(...args: unknown[]): Promise<unknown> }>,
}));

vi.mock("../../core/execution-gateway", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../core/execution-gateway")>();
  return {
    ...actual,
    LegacyDirectExecutionGateway: class extends actual.LegacyDirectExecutionGateway {
      constructor(...args: ConstructorParameters<typeof actual.LegacyDirectExecutionGateway>) {
        super(...args);
        gatewayArgs.push(args);
        gateways.push(this as unknown as { execute(...args: unknown[]): Promise<unknown> });
      }
    },
  };
});

interface StubMemento {
  get: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  keys: ReturnType<typeof vi.fn>;
}

interface StubContext {
  subscriptions: { dispose(): void }[];
  workspaceState: StubMemento;
  globalState: StubMemento;
  globalStorageUri: { fsPath: string };
  extensionUri: { fsPath: string };
  secrets: {
    get: ReturnType<typeof vi.fn>;
    store: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    onDidChange: ReturnType<typeof vi.fn>;
  };
}

function stubMemento(): StubMemento {
  return {
    get: vi.fn().mockReturnValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    keys: vi.fn().mockReturnValue([]),
  };
}

const contexts: StubContext[] = [];

function makeStubContext(): StubContext {
  const context: StubContext = {
    subscriptions: [],
    workspaceState: stubMemento(),
    // The Xray metadata cache keys off globalState; a realistic stub keeps activation honest.
    globalState: stubMemento(),
    globalStorageUri: { fsPath: fs.mkdtempSync(path.join(os.tmpdir(), "specwright-extension-")) },
    extensionUri: { fsPath: process.cwd() },
    secrets: {
      get: vi.fn().mockResolvedValue(undefined),
      store: vi.fn().mockResolvedValue(undefined),
      delete: vi.fn().mockResolvedValue(undefined),
      onDidChange: vi.fn().mockReturnValue({ dispose: vi.fn() }),
    },
  };
  contexts.push(context);
  return context;
}

// Activation registers host-wide singletons (the board's webview serializer among them) on the
// context's subscriptions, so an undrained context makes the next activation fail.
afterEach(async () => {
  gatewayArgs.length = 0;
  gateways.length = 0;
  vi.restoreAllMocks();
  await deactivate();
  for (const context of contexts.splice(0)) {
    for (const subscription of context.subscriptions.splice(0)) {
      subscription.dispose();
    }
    fs.rmSync(context.globalStorageUri.fsPath, { recursive: true, force: true });
  }
});

describe("activate", () => {
  it("matches the VS Code ExtensionMode numeric constants", () => {
    expect(vscode.ExtensionMode).toEqual({ Production: 1, Development: 2, Test: 3 });
  });

  it("uses workspace feature discovery instead of unconditional startup activation", () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")) as {
      activationEvents: string[];
    };
    expect(manifest.activationEvents).toEqual(["workspaceContains:**/*.feature"]);
  });

  it("does not discover tests while activation wires the provider", async () => {
    const discover = vi.spyOn(PlaywrightBddTestProvider.prototype, "discoverTests");

    await activate(makeStubContext() as unknown as vscode.ExtensionContext);

    expect(discover).not.toHaveBeenCalled();
  });

  it("records activation duration as structured logger data", async () => {
    const info = vi.spyOn(Logger.prototype, "info");
    vi.spyOn(vscode.tests, "createTestController").mockReturnValue(new FakeTestController() as never);

    await activate(makeStubContext() as unknown as vscode.ExtensionContext);

    expect(info).toHaveBeenCalledWith(
      "✅ Specwright activated",
      expect.objectContaining({ durationMs: expect.any(Number) })
    );
  });

  it("configures discovery on the legacy execution boundary", async () => {
    await activate(makeStubContext() as unknown as vscode.ExtensionContext);

    const discovery = gatewayArgs.at(-1)?.[5] as { discover?: unknown } | undefined;
    expect(discovery?.discover).toBeTypeOf("function");
  });

  it("does not hold extension activation on traceability evidence reconciliation", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {finish = resolve;});
    vi.spyOn(TraceabilitySubsystem.prototype, "applyCurrent").mockReturnValue(pending);

    await expect(activate(makeStubContext() as unknown as vscode.ExtensionContext)).resolves.toBeDefined();

    finish();
    await pending;
  });


  it("returns an ExtensionApi with a working seedParallelProfilePrompted bound to the given workspaceState", async () => {
    const context = makeStubContext();
    const api = await activate(context as unknown as vscode.ExtensionContext);

    expect(typeof api.seedParallelProfilePrompted).toBe("function");
    expect("testProvider" in api).toBe(true);
    expect("providerRegistry" in api).toBe(true);

    await api.seedParallelProfilePrompted(true);
    expect(context.workspaceState.update).toHaveBeenCalledWith(PROMPTED_STATE_KEY, true);

    await api.seedParallelProfilePrompted(false);
    expect(context.workspaceState.update).toHaveBeenLastCalledWith(PROMPTED_STATE_KEY, false);
  });

  it("keeps activation alive and execution blocked when a durable lease record is corrupt", async () => {
    const context = makeStubContext();
    const admissionDirectory = path.join(context.globalStorageUri.fsPath, "execution-admission");
    fs.mkdirSync(admissionDirectory, { recursive: true });
    fs.writeFileSync(path.join(admissionDirectory, "corrupt.json"), "not JSON");
    const logged = vi.spyOn(Logger.prototype, "error");

    const api = await activate(context as unknown as vscode.ExtensionContext);

    expect(api.providerRegistry).toBeDefined();
    expect(logged).toHaveBeenCalledWith(expect.stringContaining("Execution admission recovery failed"));
    await expect(gateways.at(-1)?.execute({
      mode: "run",
      selection: { kind: "suite" },
      targets: [],
    })).rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);
  });
});

describe("deactivate", () => {
  it("attempts every later cleanup owner after an early rejection", async () => {
    const context = makeStubContext();
    await activate(context as unknown as vscode.ExtensionContext);
    expect(context.subscriptions.find((subscription) =>
      (subscription as { id?: unknown }).id === "xray"
    )).toBeUndefined();

    const gatewayDispose = vi.spyOn(SelectedExecutionGateway.prototype, "dispose")
      .mockRejectedValueOnce(new Error("gateway cleanup failed"));
    const traceabilityShutdown = vi.spyOn(TraceabilitySubsystem.prototype, "shutdown");
    const trustDispose = vi.spyOn(WorkspaceTrust.prototype, "dispose");
    const executorDispose = vi.spyOn(TestExecutor.prototype, "dispose");
    const logged = vi.spyOn(Logger.prototype, "error");
    const loggerDispose = vi.spyOn(Logger.prototype, "dispose");

    await expect(deactivate()).resolves.toBeUndefined();

    expect(gatewayDispose).toHaveBeenCalledOnce();
    expect(traceabilityShutdown).toHaveBeenCalledOnce();
    expect(trustDispose).toHaveBeenCalledOnce();
    expect(executorDispose).toHaveBeenCalledOnce();
    expect(logged).toHaveBeenCalledWith(
      "Extension deactivation completed with cleanup failures",
      { error: expect.stringContaining("execution gateway: gateway cleanup failed") }
    );
    expect(loggerDispose).toHaveBeenCalledOnce();
  });
});
