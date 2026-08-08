import { describe, expect, it, vi } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ExecutionAdmission,
  ExecutionAdmissionBlockedError,
  FileAdmissionStore,
  isCanonicalBootId,
  resolveSystemBootId,
  type AdmissionRecord,
  type AdmissionStore,
  type TerminationLease,
} from "../../core/execution-admission";

const BOOT_A = "win32:41";
const BOOT_B = "win32:42";
const LINUX_BOOT = "linux:12345678-1234-1234-1234-123456789abc";
const DARWIN_BOOT = "darwin:abcdef01-2345-6789-abcd-ef0123456789";

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

const windowsLease = (kind: "windows-tree" | "debug-session"): TerminationLease => ({
  kind,
  failure: "termination unconfirmed",
  bootId: BOOT_A,
  ...(kind === "windows-tree" ? { pid: 41 } : {}),
});

describe("ExecutionAdmission", () => {
  it("survives reconstruction on the same boot", async () => {
    const store = new MemoryStore();
    await new ExecutionAdmission(store, { bootId: () => BOOT_A })
      .block(windowsLease("windows-tree"));

    const rebuilt = new ExecutionAdmission(store, { bootId: () => BOOT_A });

    await expect(rebuilt.ensureAvailable()).rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);
  });

  it("re-reads a lease written by another host after construction", async () => {
    const store = new MemoryStore();
    const waitingHost = new ExecutionAdmission(store, { bootId: () => BOOT_A });
    const writer = new ExecutionAdmission(store, { bootId: () => BOOT_A });
    await writer.block(windowsLease("debug-session"));

    await expect(waitingHost.ensureAvailable()).rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);
  });

  it("keeps independent hosts' leases in separate durable records", async () => {
    const store = new MemoryStore();
    const firstHost = new ExecutionAdmission(store);
    const secondHost = new ExecutionAdmission(store);

    await firstHost.block(windowsLease("windows-tree"));
    await secondHost.block(windowsLease("debug-session"));

    expect(store.records).toHaveLength(2);
  });

  it("clears a POSIX lease only after a negative process-group probe", async () => {
    const store = new MemoryStore();
    store.records.set("group", {
      kind: "posix-group",
      pgid: 77,
      failure: "group remained",
      bootId: LINUX_BOOT,
    } satisfies TerminationLease);
    const groupExists = vi.fn(() => false);
    const admission = new ExecutionAdmission(store, { processGroupExists: groupExists });

    await expect(admission.ensureAvailable()).resolves.toBeUndefined();
    expect(groupExists).toHaveBeenCalledWith(77);
    expect(store.records).toHaveLength(0);
  });

  it.each(["windows-tree", "debug-session"] as const)(
    "keeps a %s lease locked on the same boot",
    async (kind) => {
      const store = new MemoryStore();
      store.records.set("lease", windowsLease(kind));
      const admission = new ExecutionAdmission(store, { bootId: () => BOOT_A });

      await expect(admission.ensureAvailable()).rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);
      expect(store.records.get("lease")).toEqual(windowsLease(kind));
    }
  );

  it("does not treat legacy clock drift as a reboot when the boot identity is unchanged", async () => {
    const store = new MemoryStore();
    store.records.set("lease", {
      ...windowsLease("windows-tree"),
      systemUptime: 5,
      wallTime: 100_000,
    });
    const admission = new ExecutionAdmission(store, { bootId: () => BOOT_A });

    await expect(admission.ensureAvailable()).rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);
    expect(store.records).toHaveLength(1);
  });

  it.each(["windows-tree", "debug-session"] as const)(
    "clears a %s lease only when the boot identity changes",
    async (kind) => {
      const store = new MemoryStore();
      store.records.set("lease", windowsLease(kind));
      const admission = new ExecutionAdmission(store, { bootId: () => BOOT_B });

      await expect(admission.ensureAvailable()).resolves.toBeUndefined();
      expect(store.records).toHaveLength(0);
    }
  );

  it("keeps a Windows lease locked when the current boot identity is unavailable", async () => {
    const store = new MemoryStore();
    store.records.set("lease", windowsLease("windows-tree"));
    const admission = new ExecutionAdmission(store, { bootId: () => undefined });

    await expect(admission.ensureAvailable()).rejects.toMatchObject({
      recovery: expect.stringContaining(
        "Restart the computer to terminate any leftover Playwright or debug processes"
      ),
    });
    await expect(admission.ensureAvailable()).rejects.not.toMatchObject({
      recovery: expect.stringContaining("Terminate and confirm"),
    });
  });

  it("keeps a legacy Windows lease locked when it has no boot identity", async () => {
    const store = new MemoryStore();
    store.records.set("lease", { ...windowsLease("windows-tree"), bootId: undefined });
    const admission = new ExecutionAdmission(store, { bootId: () => BOOT_B });

    await expect(admission.ensureAvailable()).rejects.toMatchObject({
      recovery: expect.stringMatching(/Restart the computer.*while every VS Code window is closed/s),
    });
  });

  it.each([
    null,
    42,
    "boot-a",
    "solaris:12345678-1234-1234-1234-123456789abc",
    " linux:12345678-1234-1234-1234-123456789abc",
    "linux:12345678-1234-1234-1234-123456789abc ",
    "linux:12345678-1234-1234-1234-123456789ab",
    "linux:12345678-1234-1234-1234-123456789ABC",
    "darwin:abcdef01-2345-6789-abcd-ef0123456789:extra",
    "win32:0",
    "win32:04182",
    "win32:18446744073709551616",
    "win32:999999999999999999999999999999999999",
    "win32:4182 ",
  ])("treats malformed persisted boot identity %s as corruption", async (bootId) => {
    const store = new MemoryStore();
    store.records.set("lease", { ...windowsLease("windows-tree"), bootId });
    const admission = new ExecutionAdmission(store, { bootId: () => BOOT_B });

    await expect(admission.ensureAvailable()).rejects.toMatchObject({
      lease: undefined,
      message: expect.stringContaining("record lease is corrupt"),
    });
    expect(store.records).toHaveLength(1);
  });

  it.each([LINUX_BOOT, DARWIN_BOOT, BOOT_A, "win32:18446744073709551615"])(
    "accepts producer-owned persisted boot identity %s",
    async (bootId) => {
      const store = new MemoryStore();
      store.records.set("lease", { ...windowsLease("windows-tree"), bootId });

      await expect(new ExecutionAdmission(store, { bootId: () => bootId }).ensureAvailable())
        .rejects.toMatchObject({ lease: expect.objectContaining({ bootId }) });
      expect(store.records).toHaveLength(1);
    }
  );

  it("treats a malformed current boot identity as unavailable instead of a reboot", async () => {
    const store = new MemoryStore();
    store.records.set("lease", windowsLease("windows-tree"));

    await expect(new ExecutionAdmission(store, { bootId: () => "win32:overflow" }).ensureAvailable())
      .rejects.toMatchObject({
        recovery: expect.stringMatching(/Restart the computer.*while every VS Code window is closed/s),
      });
    expect(store.records).toHaveLength(1);
  });

  it("fails closed for a corrupt durable record", async () => {
    const store = new MemoryStore();
    store.records.set("corrupt", { kind: "debug-session" });

    await expect(new ExecutionAdmission(store).ensureAvailable())
      .rejects.toMatchObject({
        name: "ExecutionAdmissionBlockedError",
        message: expect.stringContaining("corrupt; execution remains blocked"),
        recovery: expect.stringContaining("globalStorage"),
      });
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
    const admission = new ExecutionAdmission(store, { bootId: () => BOOT_A });

    await expect(admission.block(windowsLease("debug-session")))
      .rejects.toThrow("could not persist");
    expect(admission.blocked).toBe(true);
    await expect(admission.ensureAvailable()).rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);
  });

  it("keeps a local lease when no durable store is configured", async () => {
    const admission = new ExecutionAdmission(undefined, { bootId: () => BOOT_A });
    await admission.block(windowsLease("debug-session"));

    await expect(admission.ensureAvailable()).rejects.toBeInstanceOf(ExecutionAdmissionBlockedError);
  });

  it("offers reboot and reversible repair for a boot-backed Windows lease", async () => {
    const store = new MemoryStore();
    store.records.set("lease", windowsLease("windows-tree"));

    await expect(new ExecutionAdmission(store, { bootId: () => BOOT_A }).ensureAvailable())
      .rejects.toMatchObject({
        recovery: expect.stringMatching(/Restart the computer.*move the execution-admission directory/),
      });
  });
});

describe("system boot identity", () => {
  const BOOT_EVENT = [
    "<Events>",
    "<Event xmlns='http://schemas.microsoft.com/win/2004/08/events/event'>",
    "<System>",
    "<Provider Name='Microsoft-Windows-Kernel-General'/>",
    "<EventID>12</EventID>",
    "<EventRecordID>4182</EventRecordID>",
    "</System>",
    "</Event>",
    "</Events>",
  ].join("");

  it("recognizes only canonical producer-owned identity shapes", () => {
    expect([LINUX_BOOT, DARWIN_BOOT, BOOT_A, "win32:18446744073709551615"]
      .every((value) => isCanonicalBootId(value))).toBe(true);
    expect(["linux:anything", "darwin: ABC", "win32:0", "win32:18446744073709551616"]
      .some((value) => isCanonicalBootId(value))).toBe(false);
  });

  it("normalizes Linux and Darwin producer UUIDs to their canonical shape", () => {
    expect(resolveSystemBootId(
      "linux",
      () => "12345678-1234-1234-1234-123456789ABC\n",
      () => undefined
    )).toBe(LINUX_BOOT);
    expect(resolveSystemBootId(
      "darwin",
      () => undefined,
      () => "ABCDEF01-2345-6789-ABCD-EF0123456789\n"
    )).toBe(DARWIN_BOOT);
  });

  it("queries the newest Windows kernel boot event without a shell or timestamp", () => {
    const run = vi.fn(() => BOOT_EVENT);

    expect(resolveSystemBootId("win32", () => undefined, run)).toBe("win32:4182");
    expect(run).toHaveBeenCalledWith("wevtutil.exe", [
      "qe",
      "System",
      "/q:*[System[Provider[@Name='Microsoft-Windows-Kernel-General'] and EventID=12]]",
      "/rd:true",
      "/f:xml",
      "/c:1",
    ]);
    expect(run.mock.calls.flat().join(" ")).not.toMatch(/time|date|powershell/i);
  });

  it.each([
    undefined,
    "<Events></Events>",
    BOOT_EVENT.replace("EventID>12", "EventID>13"),
    BOOT_EVENT.replace("Kernel-General", "Kernel-Power"),
    BOOT_EVENT.replace("4182", "0"),
    BOOT_EVENT.replace("4182", "18446744073709551616"),
    BOOT_EVENT.replace("</System>", "<EventRecordID>4183</EventRecordID></System>"),
  ])("fails closed for absent or malformed Windows boot-event output", (output) => {
    expect(resolveSystemBootId("win32", () => undefined, () => output)).toBeUndefined();
  });
});

describe("FileAdmissionStore", () => {
  it("atomically retains concurrent leases and removes only the requested record", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "admission-store-"));
    const store = new FileAdmissionStore(directory);

    await Promise.all([
      store.write({ id: "first", value: windowsLease("windows-tree") }),
      store.write({ id: "second", value: windowsLease("debug-session") }),
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
      windowsLease("windows-tree")
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
