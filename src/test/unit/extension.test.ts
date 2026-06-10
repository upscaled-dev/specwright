import { describe, it, expect, vi, afterEach } from "vitest";
import type * as vscode from "vscode";
import { activate, deactivate } from "../../extension";
import { PROMPTED_STATE_KEY } from "../../commands/prompt-worker-count";

interface StubContext {
  subscriptions: { dispose(): void }[];
  workspaceState: {
    get: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
}

function makeStubContext(): StubContext {
  return {
    subscriptions: [],
    workspaceState: {
      get: vi.fn().mockReturnValue(undefined),
      update: vi.fn().mockResolvedValue(undefined),
    },
  };
}

afterEach(() => {
  deactivate();
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
