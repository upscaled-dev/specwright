import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ExecutionAdmission,
  ExecutionAdmissionBlockedError,
  FileAdmissionStore,
  type AdmissionRecord,
  type AdmissionStore,
  type TerminationLease,
} from "../../core/execution-admission";
import { readProcessTable, type ProcessMember } from "../../core/windows-process-tree";
import { Logger } from "../../utils/logger";

const BOOT_A = "win32:4182";
const BOOT_B = "win32:4183";
vi.mock("../../core/system-boot-id", async (importOriginal) => ({
  ...await importOriginal<typeof import("../../core/system-boot-id")>(),
  systemBootId: () => "win32:4182",
}));

class MemoryStore implements AdmissionStore {
  public readonly records = new Map<string, unknown>();

  public async readAll(): Promise<readonly AdmissionRecord[]> {
    return [...this.records].map(([id, value]) => ({ id, value }));
  }

  public async write(record: AdmissionRecord): Promise<void> {
    this.records.set(record.id, record.value);
  }

  public async remove(id: string): Promise<void> {
    this.records.delete(id);
  }
}

const ROOT = { pid: 4242, creationDate: 1_000 };

const identifiedLease = (survivors: readonly ProcessMember[] = [ROOT]): TerminationLease => ({
  kind: "windows-tree",
  pid: ROOT.pid,
  root: ROOT,
  survivors,
  failure: "termination unconfirmed",
});

const groupLease: TerminationLease = { kind: "posix-group", pgid: 77, failure: "group remained", bootId: BOOT_A };

const runningTree = [
  { pid: 4242, parentPid: 1, creationDate: 1_000 },
  { pid: 4343, parentPid: 4242, creationDate: 2_000 },
];
const otherProcesses = [{ pid: 900, parentPid: 1, creationDate: 5 }];

function quietLogger(): Logger {
  const logger = Logger.create();
  vi.spyOn(logger, "warn").mockImplementation(() => {});
  return logger;
}

describe("ExecutionAdmission", () => {
  it("survives reconstruction while its tree is still running", async () => {
    const store = new MemoryStore();
    const processTable = () => Promise.resolve(runningTree);
    await new ExecutionAdmission(store, { processTable }).block(identifiedLease());

    const rebuilt = new ExecutionAdmission(store, { processTable });

    await expect(rebuilt.ensureAvailable()).rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);
  });

  it("re-reads a lease written by another host after construction", async () => {
    const store = new MemoryStore();
    const waitingHost = new ExecutionAdmission(store, { processGroupExists: () => true });
    const writer = new ExecutionAdmission(store);
    await writer.block(groupLease);

    await expect(waitingHost.ensureAvailable()).rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);
  });

  it("keeps independent hosts' leases in separate durable records", async () => {
    const store = new MemoryStore();
    const firstHost = new ExecutionAdmission(store);
    const secondHost = new ExecutionAdmission(store);

    await firstHost.block(identifiedLease());
    await secondHost.block(groupLease);

    expect(store.records).toHaveLength(2);
  });

  it("clears a POSIX lease only after a negative process-group probe", async () => {
    const store = new MemoryStore();
    store.records.set("group", groupLease);
    const groupExists = vi.fn(() => false);
    const admission = new ExecutionAdmission(store, { processGroupExists: groupExists });

    await expect(admission.ensureAvailable()).resolves.toBeUndefined();
    expect(groupExists).toHaveBeenCalledWith(77);
    expect(store.records).toHaveLength(0);
  });

  it("keeps a POSIX lease while its process group is alive", async () => {
    const store = new MemoryStore();
    store.records.set("group", groupLease);
    const admission = new ExecutionAdmission(store, { processGroupExists: () => true });

    await expect(admission.ensureAvailable()).rejects.toMatchObject({
      recovery: expect.stringContaining("Terminate and confirm"),
    });
    expect(store.records).toHaveLength(1);
  });

  it("clears an identified Windows lease once the survivor probe finds nothing left", async () => {
    const store = new MemoryStore();
    store.records.set("lease", identifiedLease());
    const processTable = vi.fn(() => Promise.resolve(otherProcesses));

    const admission = new ExecutionAdmission(store, { processTable });

    await expect(admission.ensureAvailable()).resolves.toBeUndefined();
    expect(store.records).toHaveLength(0);
  });

  it("keeps an identified Windows lease while its tree is still running", async () => {
    const store = new MemoryStore();
    store.records.set("lease", identifiedLease());
    const admission = new ExecutionAdmission(store, {
      processTable: () => Promise.resolve(runningTree),
    });

    await expect(admission.ensureAvailable()).rejects.toMatchObject({
      recovery: expect.stringContaining("End the leftover processes in Task Manager"),
    });
    expect(store.records).toHaveLength(1);
  });

  it.each([
    ["rejects", () => Promise.reject(new Error("PowerShell timed out after 5000ms")), "timed out after 5000ms"],
    // PowerShell answers an unusable CIM query with an empty table.
    ["answers with no rows", () => readProcessTable(() => Promise.resolve("")), "no process rows"],
  ])("retains an identified Windows lease with a warning when the process table %s", async (
    _reason,
    processTable,
    reason
  ) => {
    const store = new MemoryStore();
    store.records.set("lease", identifiedLease());
    const logger = quietLogger();
    const admission = new ExecutionAdmission(store, { processTable, logger });

    await expect(admission.ensureAvailable()).rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);
    expect(store.records).toHaveLength(1);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(reason));
  });

  it("reads the process table once for every identified lease in one pass", async () => {
    const store = new MemoryStore();
    store.records.set("first", identifiedLease());
    store.records.set("second", identifiedLease([{ pid: 4444, creationDate: 3_000 }]));
    const processTable = vi.fn(() => Promise.resolve(otherProcesses));

    const admission = new ExecutionAdmission(store, { processTable });

    await expect(admission.ensureAvailable()).resolves.toBeUndefined();
    expect(processTable).toHaveBeenCalledTimes(1);
    expect(store.records).toHaveLength(0);
  });

  it("blocks until the last recorded member exits, not merely the root", async () => {
    const store = new MemoryStore();
    store.records.set("lease", identifiedLease([ROOT, { pid: 4343, creationDate: 2_000 }]));
    // The root is already gone; the descendant it spawned is what still holds the port.
    let table = [{ pid: 4343, parentPid: 1, creationDate: 2_000 }];
    const admission = new ExecutionAdmission(store, {
      processTable: () => Promise.resolve(table),
    });

    await expect(admission.ensureAvailable()).rejects.toMatchObject({
      recovery: expect.stringContaining("End the leftover processes in Task Manager"),
    });
    expect(store.records).toHaveLength(1);

    table = otherProcesses;
    await expect(admission.ensureAvailable()).resolves.toBeUndefined();
    expect(store.records).toHaveLength(0);
  });

  it("keeps a member with no recorded creation instant blocked while its pid runs", async () => {
    const store = new MemoryStore();
    store.records.set("lease", { ...identifiedLease([{ pid: 4343 }]), bootId: BOOT_A });
    let table = runningTree;
    const admission = new ExecutionAdmission(store, {
      processTable: () => Promise.resolve(table),
    });

    await expect(admission.ensureAvailable()).rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);

    table = otherProcesses;
    await expect(admission.ensureAvailable()).resolves.toBeUndefined();
  });

  it.each([
    ["a tree recorded as unconfirmable", { ...identifiedLease(), survivors: "unconfirmable" }],
    ["a tree with no survivors field", { kind: "windows-tree", pid: 41, failure: "unconfirmed" }],
    ["a tree with an empty survivor list", identifiedLease([])],
    ["a debug session", { kind: "debug-session", failure: "unconfirmed", bootId: "win32:41" }],
    ["a boot-stamped legacy record", { kind: "debug-session", failure: "x", systemUptime: 5 }],
  ])("discards %s with a warning instead of blocking or reporting corruption", async (_case, value) => {
    const store = new MemoryStore();
    store.records.set("legacy", value);
    const processTable = vi.fn(() => Promise.resolve(runningTree));
    const logger = quietLogger();

    await expect(new ExecutionAdmission(store, { processTable, logger }).ensureAvailable())
      .resolves.toBeUndefined();
    expect(store.records).toHaveLength(0);
    expect(processTable).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Discarded execution admission record legacy"));
  });

  it("logs one warning naming every block an unreadable table retained", async () => {
    const store = new MemoryStore();
    store.records.set("first", identifiedLease());
    store.records.set("second", identifiedLease([{ pid: 4444, creationDate: 3_000 }]));
    const logger = quietLogger();
    const admission = new ExecutionAdmission(store, {
      processTable: () => Promise.reject(new Error("PowerShell timed out after 5000ms")),
      logger,
    });

    await expect(admission.ensureAvailable()).rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);
    expect(store.records).toHaveLength(2);
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(
      "Retained 2 test execution blocks because the Windows process table could not be read " +
      "(PowerShell timed out after 5000ms)"
    ));
  });

  it("never attempts removal when the survivor table cannot be read", async () => {
    const store = new MemoryStore();
    store.records.set("first", identifiedLease());
    store.records.set("second", identifiedLease([{ pid: 4444, creationDate: 3_000 }]));
    const remove = store.remove.bind(store);
    vi.spyOn(store, "remove").mockImplementation((id) => (id === "second"
      ? Promise.reject(new Error("EPERM: operation not permitted"))
      : remove(id)));
    const logger = quietLogger();
    const admission = new ExecutionAdmission(store, {
      processTable: () => Promise.reject(new Error("PowerShell timed out after 5000ms")),
      logger,
    });

    await expect(admission.ensureAvailable()).rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);
    expect([...store.records.keys()]).toEqual(["first", "second"]);
    expect(store.remove).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining(
      "Retained 2 test execution blocks because the Windows process table could not be read"
    ));
  });

  it("admits the run with one warning when a discarded legacy record cannot be removed", async () => {
    const store = new MemoryStore();
    store.records.set("legacy", { kind: "debug-session", failure: "unconfirmed" });
    vi.spyOn(store, "remove").mockRejectedValue(new Error("EPERM: operation not permitted"));
    const logger = quietLogger();

    await expect(new ExecutionAdmission(store, { logger }).ensureAvailable()).resolves.toBeUndefined();
    const removal = vi.mocked(logger.warn).mock.calls.filter(([message]) => message.includes("could not be removed"));
    expect(removal).toEqual([[
      "Execution admission record legacy could not be removed: EPERM: operation not permitted",
    ]]);
  });

  const LEGACY_FIELDS = { bootId: "win32:4182", systemUptime: 5_000, wallTime: 1_780_000_000_000 };

  it("probes a v0.7.1 windows-tree record and clears it once its survivors are gone", async () => {
    const store = new MemoryStore();
    store.records.set("legacy", {
      kind: "windows-tree",
      pid: ROOT.pid,
      root: ROOT,
      survivors: [ROOT, { pid: 4343, creationDate: 2_000 }],
      failure: "Process-tree termination left 2 processes running: 4242, 4343.",
      ...LEGACY_FIELDS,
    });
    let table = runningTree;
    const admission = new ExecutionAdmission(store, { processTable: () => Promise.resolve(table) });

    await expect(admission.ensureAvailable()).rejects.toMatchObject({
      recovery: expect.stringContaining("End the leftover processes in Task Manager"),
    });
    expect(store.records).toHaveLength(1);

    table = otherProcesses;
    await expect(admission.ensureAvailable()).resolves.toBeUndefined();
    expect(store.records).toHaveLength(0);
  });

  it("discards a v0.7.1 unconfirmable windows-tree record with a warning", async () => {
    const store = new MemoryStore();
    store.records.set("legacy", {
      kind: "windows-tree",
      pid: ROOT.pid,
      root: ROOT,
      survivors: "unconfirmable",
      failure: "Process-tree termination could not be confirmed.",
      ...LEGACY_FIELDS,
    });
    const processTable = vi.fn(() => Promise.resolve(runningTree));
    const logger = quietLogger();

    await expect(new ExecutionAdmission(store, { processTable, logger }).ensureAvailable())
      .resolves.toBeUndefined();
    expect(store.records).toHaveLength(0);
    expect(processTable).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("Discarded execution admission record legacy"));
  });

  it("still checks a provable lease stored beside a discarded legacy record", async () => {
    const store = new MemoryStore();
    store.records.set("legacy", { kind: "debug-session", failure: "unconfirmed" });
    store.records.set("lease", identifiedLease());

    await expect(new ExecutionAdmission(store, {
      processTable: () => Promise.resolve(runningTree),
      logger: quietLogger(),
    }).ensureAvailable()).rejects.toMatchObject({ lease: identifiedLease() });
    expect([...store.records.keys()]).toEqual(["lease"]);
  });

  it("keeps a POSIX lease blocked when its probe throws", async () => {
    const store = new MemoryStore();
    store.records.set("group", groupLease);
    const admission = new ExecutionAdmission(store, {
      processGroupExists: () => {throw new Error("probe failed");},
    });

    await expect(admission.ensureAvailable()).rejects.toMatchObject({
      message: expect.stringContaining("could not be checked"),
    });
    expect(store.records).toHaveLength(1);
  });

  it.each([
    { root: { pid: 0, creationDate: 1_000 } },
    { root: { pid: 4242 } },
    { root: 4242 },
    { root: null },
    { survivors: [{ pid: 0, creationDate: 1_000 }] },
    { survivors: [{ pid: 4242, creationDate: "1000" }] },
    { survivors: [{ creationDate: 1_000 }] },
    { survivors: ["4242"] },
    { survivors: "unknown" },
    { survivors: 4242 },
  ])("treats a malformed persisted process identity %s as corruption", async (fields) => {
    const store = new MemoryStore();
    store.records.set("lease", { ...identifiedLease(), ...fields });

    await expect(new ExecutionAdmission(store).ensureAvailable())
      .rejects.toMatchObject({ message: expect.stringContaining("record lease is corrupt") });
    expect(store.records).toHaveLength(1);
  });

  it.each([
    ["an unknown kind", { kind: "reboot-lock", failure: "x" }],
    ["a record without failure text", { kind: "debug-session" }],
  ])("fails closed for a corrupt durable record with %s", async (_case, value) => {
    const store = new MemoryStore();
    store.records.set("corrupt", value);

    await expect(new ExecutionAdmission(store).ensureAvailable())
      .rejects.toMatchObject({
        name: "ExecutionAdmissionBlockedError",
        message: expect.stringContaining("corrupt; execution remains blocked"),
        recovery: expect.stringContaining("globalStorage"),
      });
    expect(store.records).toHaveLength(1);
  });

  it("offers only the storage move, never a restart, for a corrupt record", async () => {
    const store = new MemoryStore();
    store.records.set("corrupt", { kind: "reboot-lock", failure: "x" });

    const error = await new ExecutionAdmission(store).ensureAvailable().catch((caught: unknown) => caught);

    expect(error).toMatchObject({
      recovery: expect.stringMatching(/close every VS Code window, move the execution-admission directory/),
    });
    expect((error as ExecutionAdmissionBlockedError).recovery).not.toMatch(/restart/i);
  });

  it("fails closed when the durable store cannot be read", async () => {
    const store: AdmissionStore = {
      readAll: () => Promise.reject(new Error("disk unavailable")),
      write: () => Promise.resolve(),
      remove: () => Promise.resolve(),
    };

    await expect(new ExecutionAdmission(store).ensureAvailable())
      .rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);
  });

  it("keeps the current instance blocked when persistence fails", async () => {
    const store: AdmissionStore = {
      readAll: () => Promise.resolve([]),
      write: () => Promise.reject(new Error("disk full")),
      remove: () => Promise.resolve(),
    };
    const admission = new ExecutionAdmission(store, { processGroupExists: () => true });

    await expect(admission.block(groupLease)).rejects.toThrow("could not persist");
    expect(admission.blocked).toBe(true);
    await expect(admission.ensureAvailable()).rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);
  });

  it("keeps a local lease when no durable store is configured", async () => {
    const admission = new ExecutionAdmission(undefined, {
      processTable: () => Promise.resolve(runningTree),
    });
    await admission.block(identifiedLease());

    await expect(admission.ensureAvailable()).rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);
  });

  it("persists every survivor in bounded records and keeps the tail blocked", async () => {
    const store = new MemoryStore();
    const survivors = Array.from({ length: 201 }, (_, index) => ({ pid: 5_000 + index, creationDate: 2_000 }));
    let table = [{ pid: 5_200, parentPid: 1, creationDate: 2_000 }];
    const bootId = vi.fn(() => BOOT_A);
    const writer = new ExecutionAdmission(store, { bootId });
    await writer.block(identifiedLease(survivors));
    expect(bootId).not.toHaveBeenCalled();
    const records = [...store.records.values()] as Array<Extract<TerminationLease, { kind: "windows-tree" }>>;
    expect(records.map((record) => record.survivors.length)).toEqual([200, 1]);
    expect(records.flatMap((record) => record.survivors)).toEqual(survivors);
    const reopened = new ExecutionAdmission(store, { processTable: () => Promise.resolve(table) });
    await expect(reopened.ensureAvailable()).rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);
    expect(store.records).toHaveLength(2);
    await expect(reopened.ensureAvailable()).rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);
    expect(store.records).toHaveLength(2);
    table = otherProcesses;
    await expect(reopened.ensureAvailable()).resolves.toBeUndefined();
    expect(store.records).toHaveLength(0);
  });

  it("registers the tail locally before a partial persistence failure", async () => {
    const store = new MemoryStore();
    const write = store.write.bind(store);
    let writes = 0;
    vi.spyOn(store, "write").mockImplementation((record) => ++writes === 2
      ? Promise.reject(new Error("disk full")) : write(record));
    const survivors = Array.from({ length: 201 }, (_, index) => ({ pid: 5_000 + index, creationDate: 2_000 }));
    const admission = new ExecutionAdmission(store, {
      processTable: () => Promise.resolve([{ pid: 5_200, parentPid: 1, creationDate: 2_000 }]),
    });
    await expect(admission.block(identifiedLease(survivors))).rejects.toThrow("could not persist");
    await expect(admission.ensureAvailable()).rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);
    const processTable = vi.fn(() => Promise.resolve([{ pid: 5_200, parentPid: 1, creationDate: 2_000 }]));
    await expect(new ExecutionAdmission(store, { processTable }).ensureAvailable()).rejects.toMatchObject({
      message: expect.stringContaining("record group"), recovery: expect.stringContaining("repair"),
    });
    expect(processTable).not.toHaveBeenCalled();
  });

  it("fails closed after an interrupted deletion leaves only part of a cohort", async () => {
    const store = new MemoryStore();
    const survivors = Array.from({ length: 201 }, (_, index) => ({ pid: 5_000 + index, creationDate: 2_000 }));
    await new ExecutionAdmission(store).block(identifiedLease(survivors));
    const remove = store.remove.bind(store);
    let removes = 0;
    vi.spyOn(store, "remove").mockImplementation((id) => ++removes === 2
      ? Promise.reject(new Error("interrupted deletion")) : remove(id));
    await expect(new ExecutionAdmission(store, { processTable: () => Promise.resolve(otherProcesses) }).ensureAvailable())
      .rejects.toThrow("could not be cleared");
    await expect(new ExecutionAdmission(store).ensureAvailable()).rejects.toThrow("incomplete or inconsistent");
  });

  it("clears a complete mixed-identity cohort on a verified reboot without querying an unreadable table", async () => {
    const store = new MemoryStore();
    const survivors: ProcessMember[] = Array.from({ length: 200 }, (_, index) => ({ pid: 5_000 + index, creationDate: 2_000 }));
    survivors.push({ pid: 5_200 });
    await new ExecutionAdmission(store, { bootId: () => BOOT_A }).block(identifiedLease(survivors));
    const processTable = vi.fn(() => Promise.reject(new Error("inventory unavailable")));
    await expect(new ExecutionAdmission(store, { bootId: () => BOOT_B, processTable }).ensureAvailable())
      .resolves.toBeUndefined();
    expect(processTable).not.toHaveBeenCalled();
    expect(store.records).toHaveLength(0);
  });

  it("keeps a whole mixed-identity cohort local when its boot cannot be identified", async () => {
    const store = new MemoryStore();
    const survivors: ProcessMember[] = Array.from({ length: 200 }, (_, index) => ({ pid: 5_000 + index, creationDate: 2_000 }));
    survivors.push({ pid: 5_200 });
    const admission = new ExecutionAdmission(store, { bootId: () => undefined,
      processTable: () => Promise.resolve([{ pid: 5_200, parentPid: 1, creationDate: 3_000 }]) });
    await admission.block(identifiedLease(survivors));
    expect(store.records).toHaveLength(0);
    await expect(admission.ensureAvailable()).rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);
  });

  it.each([
    [{ id: "group", count: 2, index: 0 }, { id: "group", count: 2, index: 0 }],
    [{ id: "group", count: 2, index: 0 }, { id: "group", count: 3, index: 1 }],
  ])("rejects duplicate or inconsistent cohort metadata: %s", async (first, second) => {
    const store = new MemoryStore();
    store.records.set("first", { ...identifiedLease(), cohort: first });
    store.records.set("second", { ...identifiedLease(), cohort: second });
    await expect(new ExecutionAdmission(store).ensureAvailable()).rejects.toThrow("incomplete or inconsistent");
  });

  it("rejects a cohort whose records disagree about their boot scope", async () => {
    const store = new MemoryStore();
    store.records.set("first", { ...identifiedLease(), bootId: BOOT_A,
      cohort: { id: "group", count: 2, index: 0 } });
    store.records.set("second", { ...identifiedLease([{ pid: 4343 }]), bootId: BOOT_B,
      cohort: { id: "group", count: 2, index: 1 } });
    await expect(new ExecutionAdmission(store).ensureAvailable()).rejects.toThrow("incomplete or inconsistent");
  });

  it.each([
    null, { id: "", count: 2, index: 0 }, { id: "group", count: 1, index: 0 },
    { id: "group", count: 2, index: -1 }, { id: "group", count: 2, index: 2 },
    { id: "group", count: 2, index: "0" },
  ])("rejects malformed cohort metadata: %s", async (cohort) => {
    const store = new MemoryStore();
    store.records.set("lease", { ...identifiedLease(), cohort });
    await expect(new ExecutionAdmission(store).ensureAvailable()).rejects.toThrow("corrupt");
  });

  it("keeps all local identities when new chunks exceed the durable record capacity", async () => {
    const store = new MemoryStore();
    for (let index = 0; index < 64; index += 1) {store.records.set(String(index), identifiedLease());}
    const write = vi.spyOn(store, "write");
    const survivors = Array.from({ length: 201 }, (_, index) => ({ pid: 5_000 + index, creationDate: 2_000 }));
    const admission = new ExecutionAdmission(store, {
      processTable: () => Promise.resolve([{ pid: 5_200, parentPid: 1, creationDate: 2_000 }]),
    });
    await expect(admission.block(identifiedLease(survivors))).rejects.toThrow("more than 64 records");
    expect(write).not.toHaveBeenCalled();
    await expect(admission.ensureAvailable()).rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);
  });

  it.each([groupLease, { ...identifiedLease([{ pid: 4343 }]), bootId: BOOT_A }])(
    "clears a weak durable identity after a verified different boot without probing its reused pid", async (lease) => {
      const store = new MemoryStore();
      store.records.set("lease", lease);
      const processTable = vi.fn(() => Promise.resolve(runningTree));
      const processGroupExists = vi.fn(() => true);
      const admission = new ExecutionAdmission(store, { bootId: () => BOOT_B, processTable, processGroupExists });
      await expect(admission.ensureAvailable()).resolves.toBeUndefined();
      expect(processTable).not.toHaveBeenCalled();
      expect(processGroupExists).not.toHaveBeenCalled();
      expect(store.records).toHaveLength(0);
    }
  );

  it.each([
    { kind: "posix-group", pgid: 77, failure: "legacy group" },
    identifiedLease([{ pid: 4343 }]),
  ])("discards an unscoped weak durable identity without probing another boot's pid", async (lease) => {
    const store = new MemoryStore();
    store.records.set("weak", lease);
    const processTable = vi.fn(() => Promise.resolve(runningTree));
    const processGroupExists = vi.fn(() => true);
    const logger = quietLogger();
    await expect(new ExecutionAdmission(store, { processTable, processGroupExists, logger }).ensureAvailable())
      .resolves.toBeUndefined();
    expect(processTable).not.toHaveBeenCalled();
    expect(processGroupExists).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("cannot be scoped safely"));
  });

  it("keeps an unknown-boot weak blocker locally without persisting an unscoped identity", async () => {
    const store = new MemoryStore();
    const logger = quietLogger();
    const admission = new ExecutionAdmission(store, {
      bootId: () => undefined, processGroupExists: () => true, logger,
    });
    await admission.block({ kind: "posix-group", pgid: 77, failure: "known group" });
    expect(store.records).toHaveLength(0);
    await expect(admission.ensureAvailable()).rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("this host only"));
  });
});

describe("FileAdmissionStore", () => {
  it("atomically retains concurrent leases and removes only the requested record", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "admission-store-"));
    const store = new FileAdmissionStore(directory);

    await Promise.all([
      store.write({ id: "first", value: identifiedLease() }),
      store.write({ id: "second", value: groupLease }),
    ]);

    expect((await store.readAll()).map((record) => record.id).sort()).toEqual(["first", "second"]);
    await store.remove("first");
    expect((await store.readAll()).map((record) => record.id)).toEqual(["second"]);
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("fails closed when a durable record contains malformed JSON", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "admission-store-"));
    fs.writeFileSync(path.join(directory, "broken.json"), "not json");
    const store = new FileAdmissionStore(directory);

    await expect(new ExecutionAdmission(store).ensureAvailable())
      .rejects.toMatchObject({
        name: "ExecutionAdmissionBlockedError",
        recovery: expect.stringContaining("execution-admission directory"),
      });
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("fails closed when a crash leaves an orphan temporary lease", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "admission-store-"));
    fs.writeFileSync(path.join(directory, "lease.json.interrupted.tmp"), JSON.stringify(
      identifiedLease()
    ));
    const store = new FileAdmissionStore(directory);

    await expect(new ExecutionAdmission(store).ensureAvailable())
      .rejects.toMatchObject({
        name: "ExecutionAdmissionBlockedError",
        message: expect.stringContaining("orphan temporary record"),
        recovery: expect.stringContaining("as a backup"),
      });
    fs.rmSync(directory, { recursive: true, force: true });
  });

  it("bounds durable record count and record bytes", async () => {
    const crowded = fs.mkdtempSync(path.join(os.tmpdir(), "admission-store-"));
    for (let index = 0; index < 65; index += 1) {
      fs.writeFileSync(path.join(crowded, `${index}.json`), "{}");
    }
    await expect(new ExecutionAdmission(new FileAdmissionStore(crowded)).ensureAvailable())
      .rejects.toThrow("more than 64 records");
    fs.rmSync(crowded, { recursive: true, force: true });

    const oversized = fs.mkdtempSync(path.join(os.tmpdir(), "admission-store-"));
    fs.writeFileSync(path.join(oversized, "large.json"), "x".repeat(20_000));
    await expect(new ExecutionAdmission(new FileAdmissionStore(oversized)).ensureAvailable())
      .rejects.toThrow("record exceeds 16384 bytes");
    fs.rmSync(oversized, { recursive: true, force: true });
  });

  it("bounds all admission-directory entries, including unrelated files", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "admission-store-"));
    for (let index = 0; index < 257; index += 1) {
      fs.writeFileSync(path.join(directory, `${index}.ignored`), "");
    }

    await expect(new ExecutionAdmission(new FileAdmissionStore(directory)).ensureAvailable())
      .rejects.toThrow("more than 256 directory entries");
    fs.rmSync(directory, { recursive: true, force: true });
  });
});
