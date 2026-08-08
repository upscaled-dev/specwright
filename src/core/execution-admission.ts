import * as fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { execFileSync } from "node:child_process";

const BOOT_ID_TIMEOUT_MS = 1_500;
const MAX_ADMISSION_ENTRIES = 256;
const MAX_ADMISSION_RECORDS = 64;
const MAX_ADMISSION_RECORD_BYTES = 16_384;
const REBOOT =
  "Restart the computer to terminate any leftover Playwright or debug processes, then try again.";
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
    return Number.isInteger(candidate["pgid"]) && (candidate["pgid"] as number) > 0
      ? candidate as TerminationLease
      : undefined;
  }
  if (candidate["kind"] === "windows-tree") {
    return candidate["pid"] === undefined || (Number.isInteger(candidate["pid"]) && (candidate["pid"] as number) > 0)
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

type AdmissionRecovery = "process" | "reboot" | "repair";

export class ExecutionAdmissionBlockedError extends Error {
  public readonly lease: TerminationLease | undefined;
  public readonly recovery: string;

  constructor(blocker: TerminationLease | string, recovery?: AdmissionRecovery) {
    const lease = typeof blocker === "string" ? undefined : blocker;
    super(`Test execution remains blocked: ${lease?.failure ?? blocker}`);
    this.name = "ExecutionAdmissionBlockedError";
    this.lease = lease;
    const policy = recovery ?? (lease?.kind === "posix-group"
      ? "process"
      : !isCanonicalBootId(lease?.bootId) ? "repair" : "reboot");
    this.recovery = policy === "process"
      ? `Terminate and confirm every leftover Playwright or debug process, then try again. ` +
        `If termination cannot be confirmed, ${STORAGE_REPAIR}`
      : policy === "reboot"
        ? `${REBOOT} ${REPAIR_AFTER_REBOOT}`
        : STORAGE_REPAIR;
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
  }

  public get blocked(): boolean {
    return this.leases.size > 0 || this.localLeases.size > 0;
  }

  public async ensureAvailable(): Promise<void> {
    await this.recover();
    const lease = this.leases.values().next().value;
    if (lease !== undefined) {
      const recovery = lease.kind !== "posix-group" &&
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

  public async recover(): Promise<void> {
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
    this.leases = new Map([...persisted, ...this.localLeases]);
    for (const [id, lease] of this.leases) {
      if (!this.canClear(lease)) {continue;}
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

  private canClear(lease: TerminationLease): boolean {
    if (lease.kind === "posix-group") {return !this.groupExists(lease.pgid);}
    const currentBootId = this.bootId();
    return isCanonicalBootId(lease.bootId) &&
      currentBootId !== undefined &&
      lease.bootId !== currentBootId;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
