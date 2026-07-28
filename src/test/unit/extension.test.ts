import { describe, it, expect, vi, afterEach } from "vitest";
import type * as vscode from "vscode";
import { activate, deactivate } from "../../extension";
import { PROMPTED_STATE_KEY } from "../../commands/prompt-worker-count";

interface StubMemento {
  get: ReturnType<typeof vi.fn>;
  update: ReturnType<typeof vi.fn>;
  keys: ReturnType<typeof vi.fn>;
}

interface StubContext {
  subscriptions: { dispose(): void }[];
  workspaceState: StubMemento;
  globalState: StubMemento;
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
afterEach(() => {
  deactivate();
  for (const context of contexts.splice(0)) {
    for (const subscription of context.subscriptions.splice(0)) {
      subscription.dispose();
    }
  }
});

describe("activate", () => {
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
});
