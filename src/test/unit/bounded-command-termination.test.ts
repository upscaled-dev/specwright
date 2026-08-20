import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import {
  runBoundedCommand,
  TERMINATION_GRACE_MS,
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
const RUNNING_TREE: readonly ProcessEntry[] = [
  { pid: 4242, parentPid: 1, creationDate: 1_000 },
  { pid: 4343, parentPid: 4242, creationDate: 2_000 },
];
// The budget the runner keeps for the whole confirm-and-retry sequence.
const WINDOWS_TERMINATION_BUDGET_MS = 8_000;
const BOOT = "win32:41";

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
    vi.mocked(readProcessTable).mockResolvedValue(undefined);
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

  it("awaits successful taskkill completion on Windows", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
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

    await expect(run.result).resolves.toMatchObject({ error: "Cancelled", returnCode: 130 });
  });

  it.each([
    ["nonzero", (killer: FakeChild) => killer.emit("close", 5), "exit code 5"],
    ["error", (killer: FakeChild) => killer.emit("error", new Error("spawn EPERM")), "spawn EPERM"],
  ])("surfaces Windows taskkill %s without confirming release", async (_kind, fail, message) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const killer = new FakeChild();
    const run = cancelledRun({ killer });
    await awaitKiller(run);

    fail(killer);

    await expect(run.result).resolves.toMatchObject({
      success: false,
      terminationFailure: expect.stringContaining(message),
      // No captured identity, so nothing but a reboot can prove this tree gone later.
      terminationLease: { kind: "windows-tree", pid: 4242, failure: expect.any(String) },
    });
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

  it("records a tree too large to carry as unconfirmable", async () => {
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
    expect(result.terminationLease).toMatchObject({ survivors: "unconfirmable" });
  });

  it("cannot enumerate the tree when the table fails before the kill", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockResolvedValue(ROOT);

    const run = cancelledRun({ taskkillExit: 0 });

    await expect(run.result).resolves.toMatchObject({
      success: false,
      terminationFailure: expect.stringContaining("process table could not be read"),
      terminationLease: { kind: "windows-tree", root: ROOT, survivors: "unconfirmable" },
    });
    expect(run.killers).toHaveLength(1);
  });

  it("leases the enumerated members when the confirming table cannot be read", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockResolvedValue(ROOT);
    vi.mocked(readProcessTable).mockResolvedValueOnce(RUNNING_TREE).mockResolvedValue(undefined);

    const run = cancelledRun({ taskkillExit: 0 });
    await settleTermination();

    await expect(run.result).resolves.toMatchObject({
      terminationFailure: expect.stringContaining("process table could not be read"),
      terminationLease: { survivors: [ROOT, { pid: 4343, creationDate: 2_000 }] },
    });
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

    await expect(run.result).resolves.toMatchObject({
      terminationFailure: expect.stringContaining("process table could not be read"),
      terminationLease: { survivors: "unconfirmable" },
    });
  });

  it("leases with the deadline text when the confirmation window elapses", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockResolvedValue(ROOT);
    vi.mocked(readProcessTable)
      .mockResolvedValueOnce(RUNNING_TREE)
      .mockReturnValue(new Promise(() => { /* the probe never answers */ }));

    const run = cancelledRun({ taskkillExit: 0 });
    await vi.advanceTimersByTimeAsync(WINDOWS_TERMINATION_BUDGET_MS + 1);

    await expect(run.result).resolves.toMatchObject({
      terminationFailure: expect.stringContaining("confirmation window elapsed"),
      terminationLease: { survivors: [ROOT, { pid: 4343, creationDate: 2_000 }] },
    });
  });

  it.each([
    ["never answers", () => new Promise<undefined>(() => { /* pending */ })],
    ["finds the process already gone", () => Promise.resolve(undefined)],
  ])("falls back to a reboot-only lease when the identity query %s", async (_case, identity) => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockImplementation(identity);

    const run = cancelledRun({ taskkillExit: 5 });
    await vi.advanceTimersByTimeAsync(WINDOWS_TERMINATION_BUDGET_MS + 1);
    const lease = (await run.result).terminationLease;

    expect(lease).toMatchObject({ kind: "windows-tree", pid: 4242 });
    expect(lease).not.toHaveProperty("root");
    expect(lease).not.toHaveProperty("survivors");
    expect(readProcessTable).not.toHaveBeenCalled();
  });

  it("names the cause a probe hit even when the kill outlasts the window", async () => {
    vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    vi.mocked(readProcessIdentity).mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve(ROOT), WINDOWS_TERMINATION_BUDGET_MS - 1_000);
    }));

    const run = cancelledRun();
    // The table answers "unreadable" with time to spare; the kill that follows runs past the window.
    await vi.advanceTimersByTimeAsync(WINDOWS_TERMINATION_BUDGET_MS + TERMINATION_GRACE_MS);
    const failure = (await run.result).terminationFailure;

    expect(failure).toContain("process table could not be read");
    expect(failure).not.toContain("confirmation window elapsed");
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
      bootId: () => BOOT,
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
    await new ExecutionAdmission(store, { bootId: () => BOOT }).block(lease);

    let table: readonly ProcessEntry[] = [{ pid: 4343, parentPid: 1, creationDate: 9_999 }];
    const reopened = new ExecutionAdmission(store, {
      bootId: () => BOOT,
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
