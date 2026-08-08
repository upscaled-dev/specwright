import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import {
  runBoundedCommand,
  TERMINATION_GRACE_MS,
  type BoundedCommandResult,
} from "../../core/bounded-command-runner";
import { Logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shell";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

class FakeChild extends EventEmitter {
  public readonly pid = 4242;
  public readonly stdout = new PassThrough();
  public readonly stderr = new PassThrough();
  public readonly kill = vi.fn(() => true);
}

describe("runBoundedCommand cancellation", () => {
  const logger = Logger.create();
  let groupAlive: boolean;

  beforeEach(() => {
    vi.useFakeTimers();
    groupAlive = true;
    vi.spyOn(logger, "warn").mockImplementation(() => {});
    vi.spyOn(logger, "error").mockImplementation(() => {});
    vi.spyOn(process, "kill").mockImplementation((_pid, signal) => {
      if (signal === 0 && !groupAlive) {
        const error = new Error("gone") as NodeJS.ErrnoException;
        error.code = "ESRCH";
        throw error;
      }
      return true;
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function signals(): unknown[][] {
    return vi.mocked(process.kill).mock.calls.filter(([, signal]) => signal !== 0);
  }

  function cancelledRun(killer?: FakeChild) {
    const child = new FakeChild();
    vi.mocked(spawn).mockImplementation((command) => (
      command === "taskkill" ? killer ?? new FakeChild() : child
    ) as never);
    const controller = new AbortController();
    let settled = false;
    const result = runBoundedCommand({
      command: shellQuote(process.execPath),
      workingDir: "/ws",
      logger,
      signal: controller.signal,
    });
    void result.then(() => {settled = true;});
    controller.abort();
    return {
      child,
      result: result as Promise<BoundedCommandResult>,
      settled: () => settled,
    };
  }

  it.runIf(process.platform !== "win32")(
    "waits through SIGKILL and a gone-group probe after the direct child exits",
    async () => {
      const run = cancelledRun();

      run.child.emit("exit", 130);
      await vi.advanceTimersByTimeAsync(TERMINATION_GRACE_MS + 1);

      expect(signals()).toEqual([[-4242, "SIGTERM"], [-4242, "SIGKILL"]]);
      expect(run.settled()).toBe(false);

      groupAlive = false;
      await vi.advanceTimersByTimeAsync(TERMINATION_GRACE_MS + 1);

      await expect(run.result).resolves.toMatchObject({ error: "Cancelled", returnCode: 130 });
    }
  );

  // Releasing the run while the tree is still dying lets the next one start against a process that
  // still holds the report file, the browser and the port.
  it.runIf(process.platform !== "win32")(
    "holds the run open until the TERM probe confirms the group is gone",
    async () => {
      const run = cancelledRun();

      groupAlive = false;
      await vi.advanceTimersByTimeAsync(TERMINATION_GRACE_MS + 1);

      expect(signals()).toEqual([[-4242, "SIGTERM"]]);
      await expect(run.result).resolves.toMatchObject({ error: "Cancelled", returnCode: 130 });
    }
  );

  it.runIf(process.platform !== "win32")(
    "surfaces an admission-unsafe termination failure after both bounded probes fail",
    async () => {
      const run = cancelledRun();

      await vi.advanceTimersByTimeAsync(2 * TERMINATION_GRACE_MS + 2);

      await expect(run.result).resolves.toMatchObject({
        success: false,
        returnCode: 1,
        terminationFailure: expect.stringContaining("could not be confirmed"),
      });
    }
  );

  it.runIf(process.platform !== "win32")(
    "does not treat a direct-child error as tree-exit evidence",
    async () => {
      const run = cancelledRun();

      run.child.emit("error", new Error("kill EPERM"));
      expect(run.settled()).toBe(false);
      groupAlive = false;
      await vi.advanceTimersByTimeAsync(TERMINATION_GRACE_MS + 1);

      await expect(run.result).resolves.toMatchObject({ error: "Cancelled", returnCode: 130 });
    }
  );

  it("awaits successful taskkill completion on Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const killer = new FakeChild();
    const run = cancelledRun(killer);

    expect(run.settled()).toBe(false);
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      "taskkill",
      ["/pid", "4242", "/T", "/F"],
      expect.anything()
    );
    killer.emit("close", 0);

    await expect(run.result).resolves.toMatchObject({ error: "Cancelled", returnCode: 130 });
  });

  it.each([
    ["nonzero", (killer: FakeChild) => killer.emit("close", 5), "exit code 5"],
    ["error", (killer: FakeChild) => killer.emit("error", new Error("spawn EPERM")), "spawn EPERM"],
  ])("surfaces Windows taskkill %s without confirming release", async (_kind, fail, message) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const killer = new FakeChild();
    const run = cancelledRun(killer);

    fail(killer);

    await expect(run.result).resolves.toMatchObject({
      success: false,
      terminationFailure: expect.stringContaining(message),
    });
  });

  it("keeps a spawn error outside cancellation on its own failure result", async () => {
    const child = new FakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const pending = runBoundedCommand({ command: shellQuote(process.execPath), workingDir: "/ws", logger });

    child.emit("error", new Error("spawn ENOENT"));

    await expect(pending).resolves.toMatchObject({
      success: false,
      error: "spawn ENOENT",
      returnCode: 1,
    });
  });
});
