import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";
import {
  readProcessTable,
  survivingMembers,
  type ProcessEntry,
  type ProcessIdentity,
  type ProcessMember,
} from "./windows-process-tree";

const BOOT_ID_TIMEOUT_MS = 1_500;
const MAX_ADMISSION_ENTRIES = 256;
const MAX_ADMISSION_RECORDS = 64;
const MAX_ADMISSION_RECORD_BYTES = 16_384;
const REBOOT =
  "Restart the computer to terminate any leftover Playwright or debug processes, then try again.";
const END_LEFTOVER_PROCESSES =
  "End the leftover processes in Task Manager, then run again. If they cannot be ended, restart " +
  "the computer to terminate them, then try again.";
const STORAGE_REPAIR =
  "Restart the computer to terminate any leftover Playwright or debug processes. Then, while " +
  "every VS Code window is closed, move the execution-admission directory out of this extension's " +
  "globalStorage directory as a backup before reopening VS Code and retrying.";
const REPAIR_AFTER_REBOOT =
  "If execution remains blocked after restarting, close every VS Code window, move the " +
  "execution-admission directory out of this extension's globalStorage directory as a backup, " +
  "then reopen VS Code and retry.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WINDOWS_RECORD_MAX = "18446744073709551615";

type BootIdCommand = (command: string, args: readonly string[]) => string | undefined;
type BootIdFileReader = (filePath: string) => string | undefined;

export type TerminationLease =
  | {
      readonly kind: "posix-group";
      readonly pgid: number;
      readonly failure: string;
      readonly bootId?: string | undefined;
      readonly systemUptime?: number | undefined;
      readonly wallTime?: number | undefined;
    }
  | {
      readonly kind: "windows-tree";
      readonly pid?: number | undefined;
      /** The spawned root pinned to its creation instant. Diagnostic. */
      readonly root?: ProcessIdentity | undefined;
      /**
       * The tree members that were never proven gone. The lease clears once a fresh process table
       * shows none of them. "unconfirmable" records a tree that could not be enumerated or was too
       * large to record, which only a reboot clears, as does an absent field on a legacy record.
       */
      readonly survivors?: readonly ProcessMember[] | "unconfirmable" | undefined;
      readonly failure: string;
      readonly bootId?: string | undefined;
      readonly systemUptime?: number | undefined;
      readonly wallTime?: number | undefined;
    }
  | {
      readonly kind: "debug-session";
      readonly failure: string;
      readonly bootId?: string | undefined;
      readonly systemUptime?: number | undefined;
      readonly wallTime?: number | undefined;
    };

export type TerminationLeaseInput =
  | Omit<Extract<TerminationLease, { kind: "posix-group" }>, "bootId" | "systemUptime" | "wallTime">
  | Omit<Extract<TerminationLease, { kind: "windows-tree" }>, "bootId" | "systemUptime" | "wallTime">
  | Omit<Extract<TerminationLease, { kind: "debug-session" }>, "bootId" | "systemUptime" | "wallTime">;

export interface AdmissionRecord {
  readonly id: string;
  readonly value: unknown;
}

export interface AdmissionStore {
  readAll(): Promise<readonly AdmissionRecord[]>;
  write(record: AdmissionRecord): Promise<void>;
  remove(id: string): Promise<void>;
}

export interface ExecutionAdmissionOptions {
  readonly bootId?: (() => string | undefined) | undefined;
  readonly processGroupExists?: ((pgid: number) => boolean) | undefined;
  readonly processTable?: (() => Promise<readonly ProcessEntry[] | undefined>) | undefined;
}

function commandOutput(command: string, args: readonly string[]): string | undefined {
  try {
    const value = execFileSync(command, args, {
      encoding: "utf8",
      timeout: BOOT_ID_TIMEOUT_MS,
      windowsHide: true,
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 4_096,
    }).trim();
    return value === "" ? undefined : value;
  } catch {return undefined;}
}

function fileContent(filePath: string): string | undefined {
  try {return readFileSync(filePath, "utf8");}
  catch {return undefined;}
}

function windowsBootEventId(output: string | undefined): string | undefined {
  if (output === undefined) {return undefined;}
  const events = output.match(/<Event\b[\s\S]*?<\/Event>/g);
  if (events?.length !== 1) {return undefined;}
  const event = events[0];
  if (!/<Provider\s+[^>]*Name=(['"])Microsoft-Windows-Kernel-General\1[^>]*\/>/.test(event)) {
    return undefined;
  }
  if (!/<EventID(?:\s+[^>]*)?>\s*12\s*<\/EventID>/.test(event)) {return undefined;}
  const records = [...event.matchAll(/<EventRecordID>\s*([1-9]\d*)\s*<\/EventRecordID>/g)];
  return records.length === 1 ? records[0]?.[1] : undefined;
}

/** True only for the exact canonical boot identities produced by this module. */
export function isCanonicalBootId(value: unknown): value is string {
  if (typeof value !== "string") {return false;}
  const [platform, identity, ...rest] = value.split(":");
  if (identity === undefined || rest.length > 0) {return false;}
  if (platform === "linux" || platform === "darwin") {return UUID.test(identity);}
  return platform === "win32" &&
    /^[1-9]\d*$/.test(identity) &&
    (identity.length < WINDOWS_RECORD_MAX.length ||
      (identity.length === WINDOWS_RECORD_MAX.length && identity <= WINDOWS_RECORD_MAX));
}

/** Resolve the current OS boot session without comparing wall-clock samples. */
export function resolveSystemBootId(
  platform: NodeJS.Platform,
  readFile: BootIdFileReader = fileContent,
  runCommand: BootIdCommand = commandOutput
): string | undefined {
  if (platform === "linux") {
    const value = readFile("/proc/sys/kernel/random/boot_id")?.trim();
    const candidate = value === undefined ? undefined : `linux:${value.toLowerCase()}`;
    return isCanonicalBootId(candidate) ? candidate : undefined;
  }
  if (platform === "darwin") {
    const value = runCommand("/usr/sbin/sysctl", ["-n", "kern.bootsessionuuid"]);
    const candidate = value === undefined ? undefined : `darwin:${value.trim().toLowerCase()}`;
    return isCanonicalBootId(candidate) ? candidate : undefined;
  }
  if (platform === "win32") {
    const recordId = windowsBootEventId(runCommand("wevtutil.exe", [
      "qe",
      "System",
      "/q:*[System[Provider[@Name='Microsoft-Windows-Kernel-General'] and EventID=12]]",
      "/rd:true",
      "/f:xml",
      "/c:1",
    ]));
    const candidate = recordId === undefined ? undefined : `win32:${recordId}`;
    return isCanonicalBootId(candidate) ? candidate : undefined;
  }
  return undefined;
}

let cachedBootId: string | undefined;
let bootIdRead = false;

function systemBootId(): string | undefined {
  if (bootIdRead) {return cachedBootId;}
  bootIdRead = true;
  cachedBootId = resolveSystemBootId(process.platform);
  return cachedBootId;
}

export function terminationLease(lease: TerminationLeaseInput): TerminationLease {
  const bootId = systemBootId();
  return {
    ...lease,
    ...(bootId === undefined ? {} : { bootId }),
  } as TerminationLease;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function isPid(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) > 0;
}

function readsAsIdentity(value: unknown): boolean {
  if (value === undefined) {return true;}
  if (typeof value !== "object" || value === null) {return false;}
  const candidate = value as Record<string, unknown>;
  return isPid(candidate["pid"]) && isFiniteNonNegative(candidate["creationDate"]);
}

function readsAsMember(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {return false;}
  const candidate = value as Record<string, unknown>;
  const creationDate = candidate["creationDate"];
  return isPid(candidate["pid"]) &&
    (creationDate === undefined || isFiniteNonNegative(creationDate));
}

function readsAsSurvivors(value: unknown): boolean {
  return value === undefined ||
    value === "unconfirmable" ||
    (Array.isArray(value) && value.every(readsAsMember));
}

/** The identities a fresh process table can prove gone; only such a lease clears without a reboot. */
function clearableIdentities(lease: TerminationLease): readonly ProcessMember[] | undefined {
  return lease.kind === "windows-tree" && Array.isArray(lease.survivors)
    ? lease.survivors
    : undefined;
}

function readLease(value: unknown): TerminationLease | undefined {
  if (typeof value !== "object" || value === null) {return undefined;}
  const candidate = value as Record<string, unknown>;
  if (
    typeof candidate["failure"] !== "string" ||
    (candidate["bootId"] !== undefined && !isCanonicalBootId(candidate["bootId"])) ||
    (candidate["systemUptime"] !== undefined && !isFiniteNonNegative(candidate["systemUptime"])) ||
    (candidate["wallTime"] !== undefined && !isFiniteNonNegative(candidate["wallTime"]))
  ) {
    return undefined;
  }
  if (candidate["kind"] === "posix-group") {
    return isPid(candidate["pgid"]) ? candidate as TerminationLease : undefined;
  }
  if (candidate["kind"] === "windows-tree") {
    return (candidate["pid"] === undefined || isPid(candidate["pid"])) &&
      readsAsIdentity(candidate["root"]) &&
      readsAsSurvivors(candidate["survivors"])
      ? candidate as TerminationLease
      : undefined;
  }
  return candidate["kind"] === "debug-session" ? candidate as TerminationLease : undefined;
}

function defaultProcessGroupExists(pgid: number): boolean {
  try {
    process.kill(-pgid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** One durable file per lease, so independent extension hosts never overwrite each other. */
export class FileAdmissionStore implements AdmissionStore {
  public static create(globalStoragePath: string): FileAdmissionStore {
    return new FileAdmissionStore(path.join(globalStoragePath, "execution-admission"));
  }

  constructor(private readonly directory: string) {}

  public async readAll(): Promise<readonly AdmissionRecord[]> {
    const names: string[] = [];
    let entries = 0;
    try {
      const directory = await fs.opendir(this.directory);
      for await (const entry of directory) {
        entries += 1;
        if (entries > MAX_ADMISSION_ENTRIES) {
          throw new Error(`more than ${MAX_ADMISSION_ENTRIES} directory entries require repair`);
        }
        if (entry.name.endsWith(".tmp")) {
          throw new Error(`orphan temporary record ${entry.name} requires repair`);
        }
        if (!entry.name.endsWith(".json")) {continue;}
        names.push(entry.name);
        if (names.length > MAX_ADMISSION_RECORDS) {
          throw new Error(`more than ${MAX_ADMISSION_RECORDS} records require repair`);
        }
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {return [];}
      throw new Error(`Execution admission store could not be read: ${errorMessage(error)}`);
    }
    const records: AdmissionRecord[] = [];
    for (const name of names) {
      const id = name.slice(0, -5);
      try {
        records.push({ id, value: JSON.parse(await this.readRecord(name)) });
      } catch (error) {
        throw new Error(`Execution admission record ${id} could not be read: ${errorMessage(error)}`);
      }
    }
    return records;
  }

  public async write(record: AdmissionRecord): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    const target = this.file(record.id);
    const temporary = `${target}.${randomUUID()}.tmp`;
    try {
      const serialized = JSON.stringify(record.value);
      if (Buffer.byteLength(serialized) > MAX_ADMISSION_RECORD_BYTES) {
        throw new Error(`record exceeds ${MAX_ADMISSION_RECORD_BYTES} bytes`);
      }
      await fs.writeFile(temporary, serialized, "utf8");
      await fs.rename(temporary, target);
    } catch (error) {
      await fs.unlink(temporary).catch(() => {});
      throw new Error(`Execution admission record ${record.id} could not be persisted: ${errorMessage(error)}`);
    }
  }

  public async remove(id: string): Promise<void> {
    try {
      await fs.unlink(this.file(id));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw new Error(`Execution admission record ${id} could not be removed: ${errorMessage(error)}`);
      }
    }
  }

  private file(id: string): string {
    return path.join(this.directory, `${id}.json`);
  }

  private async readRecord(name: string): Promise<string> {
    const file = await fs.open(path.join(this.directory, name), "r");
    try {
      const buffer = Buffer.alloc(MAX_ADMISSION_RECORD_BYTES + 1);
      let total = 0;
      while (total < buffer.length) {
        const { bytesRead } = await file.read(buffer, total, buffer.length - total, total);
        if (bytesRead === 0) {break;}
        total += bytesRead;
      }
      if (total > MAX_ADMISSION_RECORD_BYTES) {
        throw new Error(`record exceeds ${MAX_ADMISSION_RECORD_BYTES} bytes`);
      }
      return buffer.toString("utf8", 0, total);
    } finally {
      await file.close();
    }
  }
}

type AdmissionRecovery = "process" | "windows-tree" | "reboot" | "repair";

const RECOVERY_TEXT: Record<AdmissionRecovery, string> = {
  process: "Terminate and confirm every leftover Playwright or debug process, then try again. " +
    `If termination cannot be confirmed, ${STORAGE_REPAIR}`,
  // A lease that carries the identities it could not prove gone re-probes the process table on
  // every attempt, so ending those processes is enough to unblock it.
  "windows-tree": END_LEFTOVER_PROCESSES,
  reboot: `${REBOOT} ${REPAIR_AFTER_REBOOT}`,
  repair: STORAGE_REPAIR,
};

function recoveryPolicy(lease: TerminationLease | undefined): AdmissionRecovery {
  if (lease === undefined) {return "repair";}
  if (lease.kind === "posix-group") {return "process";}
  if (clearableIdentities(lease) !== undefined) {return "windows-tree";}
  return isCanonicalBootId(lease.bootId) ? "reboot" : "repair";
}

export class ExecutionAdmissionBlockedError extends Error {
  public readonly lease: TerminationLease | undefined;
  public readonly recovery: string;

  constructor(blocker: TerminationLease | string, recovery?: AdmissionRecovery) {
    const lease = typeof blocker === "string" ? undefined : blocker;
    super(`Test execution remains blocked: ${lease?.failure ?? blocker}`);
    this.name = "ExecutionAdmissionBlockedError";
    this.lease = lease;
    this.recovery = RECOVERY_TEXT[recovery ?? recoveryPolicy(lease)];
  }
}

interface LeaseRecord {
  readonly id: string;
  readonly lease: TerminationLease;
}

/** Durable admission lock for a process or debug session whose termination is unconfirmed. */
export class ExecutionAdmission {
  private leases = new Map<string, TerminationLease>();
  /** Leases written by this host, including one that persistence failed to save. */
  private readonly localLeases = new Map<string, TerminationLease>();
  private readonly bootId: () => string | undefined;
  private readonly groupExists: (pgid: number) => boolean;
  private readonly processTable: () => Promise<readonly ProcessEntry[] | undefined>;

  constructor(
    private readonly store?: AdmissionStore,
    options: ExecutionAdmissionOptions = {}
  ) {
    const bootId = options.bootId ?? systemBootId;
    this.bootId = () => {
      const value = bootId();
      return isCanonicalBootId(value) ? value : undefined;
    };
    this.groupExists = options.processGroupExists ?? defaultProcessGroupExists;
    this.processTable = options.processTable ?? readProcessTable;
  }

  public get blocked(): boolean {
    return this.leases.size > 0 || this.localLeases.size > 0;
  }

  public async ensureAvailable(): Promise<void> {
    await this.recover();
    const lease = this.leases.values().next().value;
    if (lease !== undefined) {
      // A lease carrying identities keeps its own guidance: the probe clears it whatever the boot
      // identity does. Only a lease with nothing to probe falls back to the storage repair.
      const recovery = lease.kind !== "posix-group" &&
        clearableIdentities(lease) === undefined &&
        (!isCanonicalBootId(lease.bootId) || this.bootId() === undefined)
        ? "repair"
        : undefined;
      throw new ExecutionAdmissionBlockedError(lease, recovery);
    }
  }

  public async block(lease: TerminationLease): Promise<void> {
    const record: LeaseRecord = { id: randomUUID(), lease };
    this.leases.set(record.id, record.lease);
    this.localLeases.set(record.id, record.lease);
    try {
      await this.store?.write({ id: record.id, value: record.lease });
    } catch (error) {
      throw new Error(`Execution admission could not persist its termination lease: ${errorMessage(error)}`);
    }
  }

  private async persistedLeases(): Promise<Map<string, TerminationLease>> {
    let records: readonly AdmissionRecord[];
    try {
      records = await this.store?.readAll() ?? [];
    } catch (error) {
      throw new ExecutionAdmissionBlockedError(
        `its storage could not be read (${errorMessage(error)}); execution remains blocked`
      );
    }
    const persisted = new Map<string, TerminationLease>();
    for (const record of records) {
      const lease = readLease(record.value);
      if (lease === undefined) {
        throw new ExecutionAdmissionBlockedError(
          `record ${record.id} is corrupt; execution remains blocked`
        );
      }
      persisted.set(record.id, lease);
    }
    return persisted;
  }

  public async recover(): Promise<void> {
    const persisted = await this.persistedLeases();
    this.leases = new Map([...persisted, ...this.localLeases]);
    // One table fetch answers every windows-tree lease in this pass.
    let snapshot: { readonly rows: readonly ProcessEntry[] | undefined } | undefined;
    const processTable = async (): Promise<readonly ProcessEntry[] | undefined> => {
      snapshot ??= { rows: await this.processTable() };
      return snapshot.rows;
    };
    for (const [id, lease] of this.leases) {
      let clearable: boolean;
      try {
        clearable = await this.canClear(lease, processTable);
      } catch (error) {
        // The probe failed, not the storage, so the guidance stays with the leftover processes.
        throw new ExecutionAdmissionBlockedError(
          `its termination lease could not be checked (${errorMessage(error)}); execution remains blocked`,
          clearableIdentities(lease) === undefined ? undefined : "windows-tree"
        );
      }
      if (!clearable) {continue;}
      try {
        if (persisted.has(id)) {await this.store?.remove(id);}
        this.leases.delete(id);
        this.localLeases.delete(id);
      } catch (error) {
        throw new ExecutionAdmissionBlockedError(
          `its termination lease could not be cleared (${errorMessage(error)}); execution remains blocked`
        );
      }
    }
  }

  private async canClear(
    lease: TerminationLease,
    processTable: () => Promise<readonly ProcessEntry[] | undefined>
  ): Promise<boolean> {
    if (lease.kind === "posix-group") {return !this.groupExists(lease.pgid);}
    const currentBootId = this.bootId();
    const rebooted = isCanonicalBootId(lease.bootId) &&
      currentBootId !== undefined &&
      lease.bootId !== currentBootId;
    const identities = clearableIdentities(lease);
    if (rebooted || identities === undefined) {return rebooted;}
    // An unreadable table leaves the identities unproven, which keeps the lease.
    const rows = await processTable();
    return rows !== undefined && survivingMembers(rows, identities).length === 0;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
