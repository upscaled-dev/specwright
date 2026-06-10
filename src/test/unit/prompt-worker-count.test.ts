import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("node:os", () => ({
  cpus: vi.fn(() => new Array(8).fill({ model: "stub" })),
}));

import * as os from "node:os";
import * as vscode from "vscode";
import { ensureWorkerCount, resolveWorkerCount } from "../../commands/prompt-worker-count";
import type { Logger } from "../../utils/logger";

interface ConfigStub {
  maxParallelProcesses: number;
}

function configWith(n: number): ConfigStub {
  return { maxParallelProcesses: n };
}

function loggerStub(): Logger {
  return {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  } as unknown as Logger;
}

function makeMemento(initial: Record<string, unknown> = {}): vscode.Memento {
  const store = new Map<string, unknown>(Object.entries(initial));
  return {
    get: <T>(key: string, defaultValue?: T): T | undefined =>
      (store.has(key) ? (store.get(key) as T) : defaultValue),
    update: (key: string, value: unknown): Thenable<void> => {
      store.set(key, value);
      return Promise.resolve();
    },
    keys: () => Array.from(store.keys()),
  } as unknown as vscode.Memento;
}

describe("resolveWorkerCount", () => {
  beforeEach(() => {
    (os.cpus as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      new Array(8).fill({ model: "stub" })
    );
  });

  it("returns the configured value when it is a valid integer within range", () => {
    expect(resolveWorkerCount(configWith(1) as never, loggerStub())).toBe(1);
    expect(resolveWorkerCount(configWith(4) as never, loggerStub())).toBe(4);
    expect(resolveWorkerCount(configWith(16) as never, loggerStub())).toBe(16);
  });

  it("auto-adjusts when value is 0", () => {
    expect(resolveWorkerCount(configWith(0) as never, loggerStub())).toBe(6);
  });

  it("auto-adjusts when value is negative", () => {
    expect(resolveWorkerCount(configWith(-1) as never, loggerStub())).toBe(6);
  });

  it("auto-adjusts when value exceeds the maximum", () => {
    expect(resolveWorkerCount(configWith(99) as never, loggerStub())).toBe(6);
  });

  it("auto-adjusts when value is NaN", () => {
    expect(resolveWorkerCount(configWith(Number.NaN) as never, loggerStub())).toBe(6);
  });

  it("clamps auto-adjusted value to the minimum on low-core machines", () => {
    (os.cpus as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      new Array(2).fill({ model: "stub" })
    );
    expect(resolveWorkerCount(configWith(0) as never, loggerStub())).toBe(1);
  });

  it("clamps auto-adjusted value to the maximum on high-core machines", () => {
    (os.cpus as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      new Array(64).fill({ model: "stub" })
    );
    expect(resolveWorkerCount(configWith(0) as never, loggerStub())).toBe(16);
  });
});

describe("ensureWorkerCount", () => {
  const PROMPTED_KEY = "playwrightBddRunner.parallelProfilePrompted";

  beforeEach(() => {
    (os.cpus as unknown as ReturnType<typeof vi.fn>).mockReturnValue(
      new Array(8).fill({ model: "stub" })
    );
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [{ uri: { fsPath: "/ws" } }];
  });

  afterEach(() => {
    vi.restoreAllMocks();
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
  });

  it("returns resolved workers without UI when already prompted", async () => {
    const memento = makeMemento({ [PROMPTED_KEY]: true });
    const quickPick = vi.spyOn(vscode.window, "showQuickPick");
    const inputBox = vi.spyOn(vscode.window, "showInputBox");

    const result = await ensureWorkerCount(memento, configWith(4) as never, loggerStub());

    expect(result).toEqual({ workers: 4, autoAdjusted: false });
    expect(quickPick).not.toHaveBeenCalled();
    expect(inputBox).not.toHaveBeenCalled();
  });

  it("returns auto-adjusted resolution with previousInvalid when already prompted and setting is invalid", async () => {
    const memento = makeMemento({ [PROMPTED_KEY]: true });
    const result = await ensureWorkerCount(memento, configWith(99) as never, loggerStub());
    expect(result).toEqual({ workers: 6, autoAdjusted: true, previousInvalid: 99 });
  });

  it("skips the prompt when the user already set maxParallelProcesses explicitly", async () => {
    const memento = makeMemento();
    const quickPick = vi.spyOn(vscode.window, "showQuickPick");
    const update = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: <T>(_key: string, def?: T): T | undefined => def,
      update,
      inspect: (key: string) => ({ key, workspaceValue: 4 }),
    } as never);

    const result = await ensureWorkerCount(memento, configWith(4) as never, loggerStub());

    expect(result).toEqual({ workers: 4, autoAdjusted: false });
    expect(quickPick).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it("returns undefined when user dismisses the QuickPick", async () => {
    const memento = makeMemento();
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValueOnce(undefined);
    const update = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: <T>(_key: string, def?: T): T | undefined => def,
      update,
      inspect: (key: string) => ({ key }),
    } as never);

    const result = await ensureWorkerCount(memento, configWith(4) as never, loggerStub());

    expect(result).toBeUndefined();
    expect(update).not.toHaveBeenCalled();
    expect(memento.get<boolean>(PROMPTED_KEY)).toBeUndefined();
  });

  it("writes setting with Workspace target when a workspace folder is open and user picks 4", async () => {
    const memento = makeMemento();
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValueOnce({ label: "4 (default)" });
    const update = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: <T>(_key: string, def?: T): T | undefined => def,
      update,
      inspect: (key: string) => ({ key }),
    } as never);

    const result = await ensureWorkerCount(memento, configWith(2) as never, loggerStub());

    expect(result).toEqual({ workers: 4, autoAdjusted: false });
    expect(update).toHaveBeenCalledWith(
      "maxParallelProcesses",
      4,
      vscode.ConfigurationTarget.Workspace
    );
    expect(memento.get<boolean>(PROMPTED_KEY)).toBe(true);
  });

  it("uses the custom input value when user picks Custom and enters 8", async () => {
    const memento = makeMemento();
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValueOnce({ label: "Custom…" });
    vi.spyOn(vscode.window, "showInputBox").mockResolvedValueOnce("8");
    const update = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: <T>(_key: string, def?: T): T | undefined => def,
      update,
      inspect: (key: string) => ({ key }),
    } as never);

    const result = await ensureWorkerCount(memento, configWith(2) as never, loggerStub());

    expect(result).toEqual({ workers: 8, autoAdjusted: false });
    expect(update).toHaveBeenCalledWith(
      "maxParallelProcesses",
      8,
      vscode.ConfigurationTarget.Workspace
    );
    expect(memento.get<boolean>(PROMPTED_KEY)).toBe(true);
  });

  it("uses Global target when no workspace folder is open", async () => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = undefined;
    const memento = makeMemento();
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValueOnce({ label: "2" });
    const update = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: <T>(_key: string, def?: T): T | undefined => def,
      update,
      inspect: (key: string) => ({ key }),
    } as never);

    const result = await ensureWorkerCount(memento, configWith(0) as never, loggerStub());

    expect(result).toEqual({ workers: 2, autoAdjusted: false });
    expect(update).toHaveBeenCalledWith(
      "maxParallelProcesses",
      2,
      vscode.ConfigurationTarget.Global
    );
  });

  it("uses Global target when workspaceFolders is an empty array", async () => {
    (vscode.workspace as { workspaceFolders: unknown }).workspaceFolders = [];
    const memento = makeMemento();
    vi.spyOn(vscode.window, "showQuickPick").mockResolvedValueOnce({ label: "2" });
    const update = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(vscode.workspace, "getConfiguration").mockReturnValue({
      get: <T>(_key: string, def?: T): T | undefined => def,
      update,
      inspect: (key: string) => ({ key }),
    } as never);

    await ensureWorkerCount(memento, configWith(0) as never, loggerStub());

    expect(update).toHaveBeenCalledWith(
      "maxParallelProcesses",
      2,
      vscode.ConfigurationTarget.Global
    );
  });
});
