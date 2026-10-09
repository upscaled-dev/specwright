import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import {
  runBoundedCommand,
  TERMINATION_GRACE_MS,
  WINDOWS_TERMINATION_BUDGET_MS,
  WINDOWS_TERMINATION_WORST_CASE_MS,
  type BoundedCommandResult,
} from "../../core/bounded-command-runner";
import {
  readProcessIdentity,
  readProcessTable,
  type ProcessEntry,
} from "../../core/windows-process-tree";
import {
  ExecutionAdmission,
  ExecutionAdmissionBlockedError,
  type AdmissionRecord,
  type AdmissionStore,
} from "../../core/execution-admission";
import { Logger } from "../../utils/logger";
import { shellQuote } from "../../utils/shell";

vi.mock("node:child_process", () => ({ spawn: vi.fn(), execFile: vi.fn() }));
// The transports are stubbed; the survivor resolver they feed stays real.
vi.mock("../../core/windows-process-tree", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../core/windows-process-tree")>(),
  readProcessIdentity: vi.fn(),
  readProcessTable: vi.fn(),
}));

const ROOT = { pid: 4242, creationDate: 1_000 };
const TABLE_TIMEOUT = "PowerShell timed out after 5000ms";
const RUNNING_TREE: readonly ProcessEntry[] = [
  { pid: 4242, parentPid: 1, creationDate: 1_000 },
  { pid: 4343, parentPid: 4242, creationDate: 2_000 },
];

/** Serializes like the durable store, so a dropped undefined field shows up in the read-back. */
class JsonStore implements AdmissionStore {
  private readonly records = new Map<string, string>();

  public readAll(): Promise<readonly AdmissionRecord[]> {
    return Promise.resolve([...this.records].map(([id, value]) => ({
      id,
      value: JSON.parse(value) as unknown,
    })));
  }

  public write(record: AdmissionRecord): Promise<void> {
    this.records.set(record.id, JSON.stringify(record.value));
    return Promise.resolve();
  }

  public remove(id: string): Promise<void> {
    this.records.delete(id);
    return Promise.resolve();
  }
}

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
    vi.mocked(readProcessIdentity).mockResolvedValue(undefined);
    vi.mocked(readProcessTable).mockRejectedValue(new Error(TABLE_TIMEOUT));
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

  function warnings(): string {
    return vi.mocked(logger.warn).mock.calls.map(([message]) => message).join("\n");
  }

  /** Proof or release: the run ends as a plain cancellation and one warning carries the reason. */
  async function expectReleased(result: Promise<BoundedCommandResult>, reason: string): Promise<void> {
    const cancelled = await result;
    expect(cancelled).toMatchObject({ error: "Cancelled", returnCode: 130 });
    expect(cancelled).not.toHaveProperty("terminationFailure");
    expect(cancelled).not.toHaveProperty("terminationLease");
    const released = vi.mocked(logger.warn).mock.calls
      .filter(([message]) => message.includes("Cancellation was released"));
    expect(released).toHaveLength(1);
    expect(released[0]?.[0]).toContain(reason);
    expect(released[0]?.[0]).toContain("end them in Task Manager");
  }

  function signals(): unknown[][] {
    return vi.mocked(process.kill).mock.calls.filter(([, signal]) => signal !== 0);
  }

  /** Drive the settle window the Windows sequence waits out between kill and probe. */
  async function settleTermination(cycles = 1): Promise<void> {
    await vi.advanceTimersByTimeAsync(cycles * (TERMINATION_GRACE_MS + 1));
  }

  /** The identity and table steps run before the kill, so let them finish first. */
  async function awaitKiller(run: { killers: FakeChild[] }, index = 0): Promise<FakeChild> {
    for (let tick = 0; tick < 50 && run.killers.length <= index; tick += 1) {
      await vi.advanceTimersByTimeAsync(0);
    }
    const killer = run.killers[index];
    if (killer === undefined) {throw new Error("taskkill was never spawned");}
    return killer;
  }

  function cancelledRun(options: { killer?: FakeChild; taskkillExit?: number } = {}) {
    const child = new FakeChild();
    const killers: FakeChild[] = [];
    vi.mocked(spawn).mockImplementation((command) => {
      if (command !== "taskkill") {return child as never;}
      const killer = options.killer ?? new FakeChild();
      killers.push(killer);
      const exit = options.taskkillExit;
      if (exit !== undefined) {queueMicrotask(() => killer.emit("close", exit));}
      return killer as never;
    });
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
      killers,
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

  it("awaits successful identity-verified taskkill completion on Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockResolvedValue(ROOT);
    vi.mocked(readProcessTable).mockResolvedValueOnce(RUNNING_TREE)
      .mockResolvedValue([{ pid: 900, parentPid: 1, creationDate: 1 }]);
    const killer = new FakeChild();
    const run = cancelledRun({ killer });
    await awaitKiller(run);

    expect(run.settled()).toBe(false);
    expect(vi.mocked(spawn)).toHaveBeenCalledWith(
      "taskkill",
      ["/pid", "4242", "/T", "/F"],
      expect.anything()
    );
    killer.emit("close", 0);
    await settleTermination();

    await expect(run.result).resolves.toMatchObject({ error: "Cancelled", returnCode: 130 });
  });

  it.each([
    ["nonzero", (killer: FakeChild) => killer.emit("close", 5), "exit code 5"],
    ["error", (killer: FakeChild) => killer.emit("error", new Error("spawn EPERM")), "spawn EPERM"],
  ])("retains taskkill's %s diagnostic on an identity-verified attempt", async (_kind, fail, message) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockResolvedValue(ROOT);
    vi.mocked(readProcessTable).mockResolvedValueOnce(RUNNING_TREE)
      .mockRejectedValue(new Error(TABLE_TIMEOUT));
    const killer = new FakeChild();
    const run = cancelledRun({ killer });
    await awaitKiller(run);

    fail(killer);
    await settleTermination();
    await expectReleased(run.result, TABLE_TIMEOUT);
    expect(warnings()).toContain(message);
    expect(readProcessTable).toHaveBeenCalledTimes(2);
  });

  it("names why the spawn-time identity could not be captured in the one release warning", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockRejectedValue(new Error("PowerShell exited with code 1: Access denied"));

    const run = cancelledRun({ taskkillExit: 0 });

    await expectReleased(
      run.result,
      "the process identity is unknown (PowerShell exited with code 1: Access denied)"
    );
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(run.child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(run.killers).toHaveLength(0);
  });

  it.each([
    [{ pid: 4242, parentPid: 1, creationDate: 9_000 }],
    [{ pid: 4242, parentPid: 1, creationDate: undefined }],
    [{ pid: 900, parentPid: 1, creationDate: 1 }],
  ])("never targets a numeric root that lacks an exact fresh identity match: %s", async (...rows) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockResolvedValue(ROOT);
    vi.mocked(readProcessTable).mockResolvedValue(rows);
    const run = cancelledRun();
    await expectReleased(run.result, "no longer has its captured identity");
    expect(run.killers).toHaveLength(0);
    expect(run.child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it.each([false, true])("does not re-kill a gone or reused root while its recorded child survives (reused: %s)", async (reused) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockResolvedValue(ROOT);
    const child = { pid: 4343, parentPid: 4242, creationDate: 2_000 };
    vi.mocked(readProcessTable).mockResolvedValueOnce(RUNNING_TREE)
      .mockResolvedValue([child, ...(reused ? [{ pid: 4242, parentPid: 1, creationDate: 9_000 }] : [])]);
    const run = cancelledRun({ taskkillExit: 0 });
    await settleTermination();
    await expect(run.result).resolves.toMatchObject({
      terminationLease: { survivors: [{ pid: 4343, creationDate: 2_000 }] },
    });
    expect(run.killers).toHaveLength(1);
  });

  it("checks the root again immediately before a retry when its pid was reused after the first confirmation", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockResolvedValue(ROOT);
    vi.mocked(readProcessTable).mockResolvedValueOnce(RUNNING_TREE)
      .mockResolvedValueOnce(RUNNING_TREE)
      .mockResolvedValue([{ pid: 4242, parentPid: 1, creationDate: 9_000 },
        { pid: 4343, parentPid: 4242, creationDate: 2_000 }]);
    const run = cancelledRun({ taskkillExit: 0 });
    await settleTermination();
    await expect(run.result).resolves.toMatchObject({
      terminationLease: { survivors: [{ pid: 4343, creationDate: 2_000 }] },
    });
    expect(run.killers).toHaveLength(1);
  });

  it("retains confirmed survivors when a retry inventory becomes unreadable", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockResolvedValue(ROOT);
    vi.mocked(readProcessTable).mockResolvedValueOnce(RUNNING_TREE).mockResolvedValueOnce(RUNNING_TREE)
      .mockRejectedValue(new Error(TABLE_TIMEOUT));
    const run = cancelledRun({ taskkillExit: 0 });
    await settleTermination();
    await expect(run.result).resolves.toMatchObject({
      terminationFailure: expect.stringContaining(TABLE_TIMEOUT),
      terminationLease: { survivors: [ROOT, { pid: 4343, creationDate: 2_000 }] },
    });
    expect(run.killers).toHaveLength(1);
  });

  it("retains newly observed descendants when the final confirmation becomes unreadable", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockResolvedValue(ROOT);
    vi.mocked(readProcessTable).mockResolvedValueOnce(RUNNING_TREE).mockResolvedValueOnce(RUNNING_TREE)
      .mockResolvedValueOnce([...RUNNING_TREE, { pid: 4444, parentPid: 4343, creationDate: 3_000 }])
      .mockRejectedValue(new Error(TABLE_TIMEOUT));
    const run = cancelledRun({ taskkillExit: 0 });
    await settleTermination(2);
    await expect(run.result).resolves.toMatchObject({
      terminationLease: { survivors: [ROOT, { pid: 4343, creationDate: 2_000 },
        { pid: 4444, creationDate: 3_000 }] },
    });
    expect(run.killers).toHaveLength(2);
  });

  it("retains descendants enrolled by the first confirmation when the fresh retry probe fails", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockResolvedValue(ROOT);
    vi.mocked(readProcessTable).mockResolvedValueOnce(RUNNING_TREE)
      .mockResolvedValueOnce([...RUNNING_TREE, { pid: 4444, parentPid: 4343, creationDate: 3_000 }])
      .mockRejectedValue(new Error(TABLE_TIMEOUT));
    const run = cancelledRun({ taskkillExit: 0 });
    await settleTermination();
    await expect(run.result).resolves.toMatchObject({
      terminationFailure: expect.stringContaining("3 recorded processes"),
      terminationLease: { survivors: [ROOT, { pid: 4343, creationDate: 2_000 },
        { pid: 4444, creationDate: 3_000 }] },
    });
    expect(run.killers).toHaveLength(1);
  });

  it("releases a Windows run once every recorded identity is gone", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockResolvedValue(ROOT);
    vi.mocked(readProcessTable)
      .mockResolvedValueOnce(RUNNING_TREE)
      .mockResolvedValue([{ pid: 900, parentPid: 1, creationDate: 1 }]);

    // taskkill reports 128 ("process not found") because the tree already died on its own.
    const run = cancelledRun({ taskkillExit: 128 });
    await settleTermination();

    await expect(run.result).resolves.toMatchObject({ error: "Cancelled", returnCode: 130 });
    await expect(run.result).resolves.not.toHaveProperty("terminationLease");
    expect(run.killers).toHaveLength(1);
  });

  it("allows a fresh execution after slow Windows inventory and taskkill confirm cancellation", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockResolvedValue(ROOT);
    let probes = 0;
    vi.mocked(readProcessTable).mockImplementation(() => new Promise((resolve) => {
      const rows = probes++ === 0 ? RUNNING_TREE : [{ pid: 900, parentPid: 1, creationDate: 1 }];
      setTimeout(() => resolve(rows), 3_000);
    }));
    const killer = new FakeChild();
    const run = cancelledRun({ killer });
    await vi.advanceTimersByTimeAsync(3_000);
    await awaitKiller(run);
    setTimeout(() => killer.emit("close", 0), 3_000);

    await vi.advanceTimersByTimeAsync(6_000);
    expect(run.settled()).toBe(false);
    await vi.advanceTimersByTimeAsync(2_000);
    const cancelled = await run.result;
    expect(cancelled).toMatchObject({ error: "Cancelled", returnCode: 130 });
    expect(cancelled).not.toHaveProperty("terminationFailure");
    expect(cancelled).not.toHaveProperty("terminationLease");
    expect(killer.kill).not.toHaveBeenCalled();

    const freshChild = new FakeChild();
    vi.mocked(spawn).mockReturnValue(freshChild as never);
    const fresh = runBoundedCommand({ command: shellQuote(process.execPath), workingDir: "/ws", logger });
    freshChild.stdout.write("fresh execution completed\n");
    freshChild.emit("close", 0);
    await expect(fresh).resolves.toMatchObject({ success: true, output: "fresh execution completed\n" });
  });

  it("retries the kill and leases the identities it could not prove gone", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockResolvedValue(ROOT);
    vi.mocked(readProcessTable).mockResolvedValue(RUNNING_TREE);

    const run = cancelledRun({ taskkillExit: 0 });
    await settleTermination(2);

    await expect(run.result).resolves.toMatchObject({
      success: false,
      terminationFailure: expect.stringContaining("left 2 processes running: 4242, 4343"),
      terminationLease: {
        kind: "windows-tree",
        pid: 4242,
        root: ROOT,
        survivors: [ROOT, { pid: 4343, creationDate: 2_000 }],
        failure: expect.any(String),
      },
    });
    expect(run.killers).toHaveLength(2);
  });

  it("returns every member of a large confirmed surviving tree", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockResolvedValue(ROOT);
    vi.mocked(readProcessTable).mockResolvedValue([
      { pid: 4242, parentPid: 1, creationDate: 1_000 },
      ...Array.from({ length: 250 }, (_unused, index) => ({
        pid: 5_000 + index,
        parentPid: 4242,
        creationDate: 2_000,
      })),
    ]);

    const run = cancelledRun({ taskkillExit: 0 });
    await settleTermination(2);
    const result = await run.result;

    expect(result.terminationFailure).toContain("left 251 processes running");
    expect(result.terminationFailure).toContain("and 231 more");
    const survivors = result.terminationLease?.kind === "windows-tree" ? result.terminationLease.survivors : [];
    expect(survivors).toHaveLength(251);
    expect(survivors[0]).toEqual(ROOT);
  });

  it("releases with the reader's reason when the table fails before the kill", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockResolvedValue(ROOT);

    const run = cancelledRun({ taskkillExit: 0 });

    await expectReleased(run.result, `the Windows process table could not be read (${TABLE_TIMEOUT})`);
    expect(run.killers).toHaveLength(0);
    expect(run.child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("releases the enumerated members when the confirming table cannot be read", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockResolvedValue(ROOT);
    vi.mocked(readProcessTable).mockResolvedValueOnce(RUNNING_TREE)
      .mockRejectedValue(new Error("PowerShell exited with code 1: Access denied"));

    const run = cancelledRun({ taskkillExit: 0 });
    const released = expectReleased(run.result, "could not be read (PowerShell exited with code 1: Access denied)");
    await settleTermination();
    await released;

    expect(warnings()).toContain("2 recorded processes remain unproven: 4242, 4343");
    expect(run.killers).toHaveLength(1);
  });

  it("releases on any bookkeeping failure with the thrown reason", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockResolvedValue(ROOT);
    vi.mocked(readProcessTable).mockResolvedValue(null as never);

    const run = cancelledRun({ taskkillExit: 0 });

    await expectReleased(run.result, "Process termination could not be confirmed:");
  });

  it("treats an empty process-table answer as a failed probe", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockResolvedValue(ROOT);
    const actual = await vi.importActual<typeof import("../../core/windows-process-tree")>(
      "../../core/windows-process-tree"
    );
    vi.mocked(readProcessTable).mockImplementation(
      () => actual.readProcessTable(() => Promise.resolve(""))
    );

    const run = cancelledRun({ taskkillExit: 0 });

    await expectReleased(run.result, "could not be read (PowerShell returned no process rows)");
  });

  it("releases with the deadline text when the confirmation window elapses", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockResolvedValue(ROOT);
    vi.mocked(readProcessTable)
      .mockResolvedValueOnce(RUNNING_TREE)
      .mockReturnValue(new Promise(() => { /* the probe never answers */ }));

    const run = cancelledRun({ taskkillExit: 0 });
    const released = expectReleased(run.result, "confirmation window elapsed");
    await vi.advanceTimersByTimeAsync(WINDOWS_TERMINATION_BUDGET_MS + 1);
    await released;
  });

  it.each([
    [
      "never answers",
      () => new Promise<undefined>(() => { /* pending */ }),
      "the identity query did not answer within the confirmation window",
    ],
    [
      "finds the process already gone",
      () => Promise.resolve(undefined),
      "the process exited or had no readable creation time when its identity was queried",
    ],
  ])("uses only the owned handle when the identity query %s", async (_case, identity, reason) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockImplementation(identity);

    const run = cancelledRun({ taskkillExit: 5 });
    const released = expectReleased(run.result, `the process identity is unknown (${reason})`);
    await vi.advanceTimersByTimeAsync(WINDOWS_TERMINATION_BUDGET_MS + 1);
    await released;

    expect(run.killers).toHaveLength(0);
    expect(run.child.kill).toHaveBeenCalledWith("SIGKILL");
    expect(readProcessTable).not.toHaveBeenCalled();
  });

  it("names the cause a probe hit even when the kill outlasts the window", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(ROOT), WINDOWS_TERMINATION_BUDGET_MS - 1_000);
    }));

    const run = cancelledRun();
    // The table answers "unreadable" with time to spare; the kill that follows runs past the window.
    const released = expectReleased(run.result, "process table could not be read");
    await vi.advanceTimersByTimeAsync(WINDOWS_TERMINATION_WORST_CASE_MS);
    await released;

    expect(warnings()).not.toContain("confirmation window elapsed");
  });

  it("hands admission a lease that clears once the identities are gone", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockResolvedValue(ROOT);
    vi.mocked(readProcessTable).mockResolvedValue(RUNNING_TREE);
    const run = cancelledRun({ taskkillExit: 0 });
    await settleTermination(2);
    const lease = (await run.result).terminationLease;
    if (lease === undefined) {throw new Error("the surviving tree produced no lease");}

    let table: readonly ProcessEntry[] = RUNNING_TREE;
    const admission = new ExecutionAdmission(undefined, {
      processTable: () => Promise.resolve(table),
    });
    await admission.block(lease);

    await expect(admission.ensureAvailable()).rejects.toMatchObject({
      recovery: expect.stringContaining("End the leftover processes in Task Manager"),
    });

    table = [{ pid: 4242, parentPid: 1, creationDate: 9_999 }];
    await expect(admission.ensureAvailable()).resolves.toBeUndefined();
    expect(admission.blocked).toBe(false);
  });

  it("keeps a pid-only member blocking after the lease is persisted and read back", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockResolvedValue(ROOT);
    // Windows reports no creation instant for 4343, so the lease can only record its pid.
    vi.mocked(readProcessTable).mockResolvedValue([
      { pid: 4242, parentPid: 1, creationDate: 1_000 },
      { pid: 4343, parentPid: 4242, creationDate: undefined },
    ]);
    const run = cancelledRun({ taskkillExit: 0 });
    await settleTermination(2);
    const lease = (await run.result).terminationLease;
    if (lease === undefined) {throw new Error("the surviving tree produced no lease");}

    const store = new JsonStore();
    const bootId = () => "win32:4182";
    await new ExecutionAdmission(store, { bootId }).block(lease);

    let table: readonly ProcessEntry[] = [{ pid: 4343, parentPid: 1, creationDate: 9_999 }];
    const reopened = new ExecutionAdmission(store, {
      bootId,
      processTable: () => Promise.resolve(table),
    });

    await expect(reopened.ensureAvailable())
      .rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);

    table = [{ pid: 900, parentPid: 1, creationDate: 5 }];
    await expect(reopened.ensureAvailable()).resolves.toBeUndefined();
  });

  it("captures no Windows identity for a run that cannot be cancelled", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const child = new FakeChild();
    vi.mocked(spawn).mockReturnValue(child as never);
    const pending = runBoundedCommand({
      command: shellQuote(process.execPath),
      workingDir: "/ws",
      logger,
    });

    child.emit("close", 0);

    await expect(pending).resolves.toMatchObject({ success: true });
    expect(readProcessIdentity).not.toHaveBeenCalled();
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
