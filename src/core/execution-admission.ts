import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type { Logger } from "../utils/logger";
import { plural } from "../utils/text";
import { isCanonicalBootId, systemBootId } from "./system-boot-id";
import {
  readProcessTable,
  survivingMembers,
  type ProcessEntry,
  type ProcessIdentity,
  type ProcessMember,
} from "./windows-process-tree";

const MAX_ADMISSION_ENTRIES = 256;
const MAX_ADMISSION_RECORDS = 64;
const MAX_ADMISSION_RECORD_BYTES = 16_384;
// Leave room for the failure text within the existing durable record byte limit.
const MAX_WINDOWS_MEMBERS_PER_RECORD = 200;
const END_LEFTOVER_PROCESSES =
  "End the leftover processes in Task Manager, then run again. If they cannot be ended, restart " +
  "the computer to terminate them, then try again.";
const STORAGE_REPAIR =
  "close every VS Code window, move the execution-admission directory out of this extension's " +
  "globalStorage directory as a backup, then reopen VS Code and retry.";

export type TerminationLease = (
  | {
      readonly kind: "posix-group";
      readonly pgid: number;
      readonly failure: string;
    }
  | {
      readonly kind: "windows-tree";
      readonly pid?: number | undefined;
      /** The spawned root pinned to its creation instant. Diagnostic. */
      readonly root?: ProcessIdentity | undefined;
      /**
       * The tree members a live process table still listed after the second kill, never empty.
       * The lease clears once a fresh table shows none of them.
       */
      readonly survivors: readonly ProcessMember[];
      readonly failure: string;
    }) & { readonly bootId?: string | undefined };

interface LeaseCohort {
  readonly id: string;
  readonly count: number;
  readonly index: number;
}

type StoredLease = TerminationLease & { readonly cohort?: LeaseCohort };

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
  /** Rejects with the reason the table could not be read. */
  readonly processTable?: (() => Promise<readonly ProcessEntry[]>) | undefined;
  readonly logger?: Logger | undefined;
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

function readsAsCohort(value: unknown): boolean {
  if (typeof value !== "object" || value === null) {return false;}
  const candidate = value as Record<string, unknown>;
  const count = candidate["count"];
  const index = candidate["index"];
  return typeof candidate["id"] === "string" && candidate["id"].length > 0 &&
    candidate["id"].length <= 128 && typeof count === "number" && Number.isSafeInteger(count) && count > 1 &&
    typeof index === "number" && Number.isSafeInteger(index) && index >= 0 && index < count;
}

/**
 * The lease a stored record holds, "unprovable" for a legacy shape that names nothing a probe could
 * find (a debug session, or a tree with no recorded survivors), or undefined when it is corrupt.
 */
function readLease(value: unknown): StoredLease | "unprovable" | undefined {
  if (typeof value !== "object" || value === null) {return undefined;}
  const candidate = value as Record<string, unknown>;
  if (typeof candidate["failure"] !== "string") {return undefined;}
  if (candidate["kind"] === "debug-session") {return "unprovable";}
  if (candidate["bootId"] !== undefined && !isCanonicalBootId(candidate["bootId"])) {return undefined;}
  if (candidate["cohort"] !== undefined &&
    (candidate["kind"] !== "windows-tree" || !readsAsCohort(candidate["cohort"]))) {return undefined;}
  if (candidate["kind"] === "posix-group") {
    return isPid(candidate["pgid"]) ? candidate as StoredLease : undefined;
  }
  if (
    candidate["kind"] !== "windows-tree" ||
    (candidate["pid"] !== undefined && !isPid(candidate["pid"])) ||
    !readsAsIdentity(candidate["root"])
  ) {
    return undefined;
  }
  const survivors = candidate["survivors"];
  if (survivors === undefined || survivors === "unconfirmable") {
    return candidate["cohort"] === undefined ? "unprovable" : undefined;
  }
  if (!Array.isArray(survivors) || !survivors.every(readsAsMember)) {return undefined;}
  if (survivors.length === 0) {return candidate["cohort"] === undefined ? "unprovable" : undefined;}
  return candidate as StoredLease;
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

type AdmissionRecovery = "process" | "windows-tree" | "repair";

const RECOVERY_TEXT: Record<AdmissionRecovery, string> = {
  process: "Terminate and confirm every leftover Playwright or debug process, then try again. " +
    `If termination cannot be confirmed, ${STORAGE_REPAIR}`,
  // A lease carrying the survivors a live table still listed re-probes the table on every
  // attempt, so ending those processes is enough to unblock it.
  "windows-tree": END_LEFTOVER_PROCESSES,
  repair: `To repair execution admission storage, ${STORAGE_REPAIR}`,
};

function recoveryPolicy(lease: TerminationLease | undefined): AdmissionRecovery {
  if (lease === undefined) {return "repair";}
  return lease.kind === "posix-group" ? "process" : "windows-tree";
}

export class ExecutionAdmissionBlockedError extends Error {
  public readonly lease: TerminationLease | undefined;
  public readonly recovery: string;

  constructor(blocker: TerminationLease | string) {
    const lease = typeof blocker === "string" ? undefined : blocker;
    super(`Test execution remains blocked: ${lease?.failure ?? blocker}`);
    this.name = "ExecutionAdmissionBlockedError";
    this.lease = lease;
    this.recovery = RECOVERY_TEXT[recoveryPolicy(lease)];
  }
}

type TableAnswer = { readonly rows: readonly ProcessEntry[] } | { readonly reason: string };

interface LeaseRecord {
  readonly id: string;
  readonly lease: StoredLease;
}

/** A multi-record lease remains one blocker; missing or inconsistent pieces require repair. */
function leaseGroups(leases: ReadonlyMap<string, StoredLease>): readonly LeaseRecord[][] {
  const groups = new Map<string, LeaseRecord[]>();
  for (const [id, lease] of leases) {
    const key = lease.cohort === undefined ? `record:${id}` : `cohort:${lease.cohort.id}`;
    const group = groups.get(key);
    if (group === undefined) {groups.set(key, [{ id, lease }]);}
    else {group.push({ id, lease });}
  }
  for (const group of groups.values()) {
    const first = group[0];
    if (first?.lease.cohort === undefined) {continue;}
    const cohort = first.lease.cohort;
    const indices = new Set(group.map((record) => record.lease.cohort?.index));
    if (group.length !== cohort.count || indices.size !== group.length ||
      group.some((record) => record.lease.cohort?.count !== cohort.count ||
        record.lease.bootId !== first.lease.bootId)) {
      throw new ExecutionAdmissionBlockedError(
        `record group ${cohort.id} is incomplete or inconsistent; execution remains blocked`
      );
    }
  }
  return [...groups.values()];
}

function needsBootScope(lease: TerminationLease): boolean {
  return lease.kind === "posix-group" || lease.survivors.some((member) => member.creationDate === undefined);
}

/** Durable admission lock for a process tree proven to have survived termination. */
export class ExecutionAdmission {
  private leases = new Map<string, StoredLease>();
  /** Leases written by this host, including one that persistence failed to save. */
  private readonly localLeases = new Map<string, StoredLease>();
  private readonly groupExists: (pgid: number) => boolean;
  private readonly processTable: () => Promise<readonly ProcessEntry[]>;
  private readonly logger: Logger | undefined;
  private readonly bootId: () => string | undefined;

  constructor(
    private readonly store?: AdmissionStore,
    options: ExecutionAdmissionOptions = {}
  ) {
    this.groupExists = options.processGroupExists ?? defaultProcessGroupExists;
    this.processTable = options.processTable ?? readProcessTable;
    this.logger = options.logger;
    const resolveBootId = options.bootId ?? systemBootId;
    this.bootId = () => {
      try {
        const value = resolveBootId();
        return isCanonicalBootId(value) ? value : undefined;
      } catch {return undefined;}
    };
  }

  public get blocked(): boolean {
    return this.leases.size > 0 || this.localLeases.size > 0;
  }

  public async ensureAvailable(): Promise<void> {
    await this.recover();
    const lease = this.leases.values().next().value;
    if (lease !== undefined) {throw new ExecutionAdmissionBlockedError(lease);}
  }

  public async block(lease: TerminationLease): Promise<void> {
    const weak = needsBootScope(lease);
    const bootId = weak ? this.bootId() : undefined;
    const scoped = weak ? { ...lease, bootId } : lease;
    const chunks: TerminationLease[] = [];
    if (scoped.kind === "windows-tree") {
      for (let index = 0; index < scoped.survivors.length; index += MAX_WINDOWS_MEMBERS_PER_RECORD) {
        chunks.push({ ...scoped, survivors: scoped.survivors.slice(index, index + MAX_WINDOWS_MEMBERS_PER_RECORD) });
      }
    } else {chunks.push(scoped);}
    const cohortId = chunks.length > 1 ? randomUUID() : undefined;
    const records: LeaseRecord[] = chunks.map((chunk, index) => ({ id: randomUUID(), lease: {
      ...chunk,
      ...(cohortId === undefined ? {} : { cohort: { id: cohortId, count: chunks.length, index } }),
    } }));
    for (const record of records) {
      this.leases.set(record.id, record.lease);
      this.localLeases.set(record.id, record.lease);
    }
    const durableRecords = weak && bootId === undefined ? [] : records;
    if (durableRecords.length !== records.length) {
      this.logger?.warn("Execution admission could not identify this boot; weak process identities remain blocked in this host only.");
    }
    try {
      if (this.store === undefined) {return;}
      const persisted = await this.store.readAll();
      if (persisted.length + durableRecords.length > MAX_ADMISSION_RECORDS) {
        throw new Error(`more than ${MAX_ADMISSION_RECORDS} records require repair`);
      }
      for (const record of durableRecords) {await this.store.write({ id: record.id, value: record.lease });}
    } catch (error) {
      throw new Error(`Execution admission could not persist its termination lease: ${errorMessage(error)}`);
    }
  }

  private async persistedLeases(): Promise<Map<string, StoredLease>> {
    let records: readonly AdmissionRecord[];
    try {
      records = await this.store?.readAll() ?? [];
    } catch (error) {
      throw new ExecutionAdmissionBlockedError(
        `its storage could not be read (${errorMessage(error)}); execution remains blocked`
      );
    }
    const persisted = new Map<string, StoredLease>();
    for (const record of records) {
      const lease = readLease(record.value);
      if (lease === undefined) {
        throw new ExecutionAdmissionBlockedError(
          `record ${record.id} is corrupt; execution remains blocked`
        );
      }
      if (lease !== "unprovable" && !(needsBootScope(lease) && lease.bootId === undefined)) {
        persisted.set(record.id, lease);
        continue;
      }
      this.logger?.warn(`Discarded execution admission record ${record.id}: its process identity ` +
        "cannot be scoped safely, so it no longer blocks test execution.");
      await this.store?.remove(record.id).catch((error: unknown) => {
        this.logger?.warn(`Execution admission record ${record.id} could not be removed: ${errorMessage(error)}`);
      });
    }
    return persisted;
  }

  public async recover(): Promise<void> {
    const persisted = await this.persistedLeases();
    this.leases = new Map([...persisted, ...this.localLeases]);
    const groups = leaseGroups(this.leases);
    // One table fetch answers every Windows lease; unreadable data cannot clear known survivors.
    let table: Promise<TableAnswer> | undefined;
    const processTable = (): Promise<TableAnswer> => (table ??= this.processTable().then(
      (rows) => ({ rows }),
      (error: unknown) => ({ reason: errorMessage(error) })
    ));
    let retainedTrees = 0;
    let bootRead = false;
    let bootId: string | undefined;
    try {
      for (const group of groups) {
        let clearable = true;
        try {
          for (const { lease } of group) {
            if (lease.bootId !== undefined && !bootRead) {
              bootRead = true;
              bootId = this.bootId();
            }
            const differentBoot = bootId !== undefined &&
              lease.bootId !== undefined && lease.bootId !== bootId;
            if (!(differentBoot || await this.canClear(lease, processTable))) {clearable = false;}
          }
        } catch (error) {
          throw new ExecutionAdmissionBlockedError(
            `its termination lease could not be checked (${errorMessage(error)}); execution remains blocked`
          );
        }
        if (!clearable) {
          retainedTrees += group.filter((record) => record.lease.kind === "windows-tree").length;
          continue;
        }
        try {
          for (const { id } of group) {if (persisted.has(id)) {await this.store?.remove(id);}}
          for (const { id } of group) {
            this.leases.delete(id);
            this.localLeases.delete(id);
          }
        } catch (error) {
          throw new ExecutionAdmissionBlockedError(
            `its termination lease could not be cleared (${errorMessage(error)}); execution remains blocked`
          );
        }
      }
    } finally {
      // A failed inventory must preserve every already confirmed survivor record.
      const answer = await table;
      if (answer !== undefined && "reason" in answer && retainedTrees > 0) {
        this.logger?.warn(`Retained ${retainedTrees} test execution ` +
          `${plural(retainedTrees, "block", "blocks")} because the Windows process table could not ` +
          `be read (${answer.reason}). Previously confirmed survivors remain blocked.`);
      }
    }
  }

  private async canClear(
    lease: TerminationLease,
    processTable: () => Promise<TableAnswer>
  ): Promise<boolean> {
    if (lease.kind === "posix-group") {return !this.groupExists(lease.pgid);}
    const answer = await processTable();
    return "rows" in answer && survivingMembers(answer.rows, lease.survivors).length === 0;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
