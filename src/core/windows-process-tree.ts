import { execFile, type ExecFileException } from "node:child_process";

/** One row of the Windows process table. */
export interface ProcessEntry {
  readonly pid: number;
  readonly parentPid: number;
  /** Epoch milliseconds, or undefined when Windows reports no creation time (Idle and System). */
  readonly creationDate: number | undefined;
}

/** A process pinned to the instant it started, so a reused pid is a different process. */
export interface ProcessIdentity {
  readonly pid: number;
  readonly creationDate: number;
}

/**
 * A recorded member of an owned tree. Windows reports no creation instant for a few processes, and
 * an unreadable instant is not proof of a different process, so such a member matches on pid alone
 * and can only ever be over-inclusive.
 */
export interface ProcessMember {
  readonly pid: number;
  readonly creationDate?: number | undefined;
}

/** PowerShell stdout for `script`; rejects with an Error that names why the query failed. */
export type ProcessTableReader = (script: string) => Promise<string>;

export const WINDOWS_PROCESS_QUERY_TIMEOUT_MS = 5_000;
// Three fields per process; a megabyte holds several thousand rows, and a table larger than that
// is not one this probe can reason about anyway.
const QUERY_MAX_BYTES = 1024 * 1024;
const STDERR_EXCERPT_CHARS = 200;
const QUERY = "$ErrorActionPreference = 'Stop'; Get-CimInstance Win32_Process";
// Windows PowerShell can expand DateTime properties into nested JSON. Normalize the instant in
// the producer so every inventory and identity probe receives the same UTC string.
const SELECTION = "-Property ProcessId,ParentProcessId,CreationDate | " +
  "Select-Object ProcessId,ParentProcessId,@{Name='CreationDate';Expression={" +
  "if ($null -ne $_.CreationDate) { $_.CreationDate.ToUniversalTime().ToString('o', " +
  "[System.Globalization.CultureInfo]::InvariantCulture) }}} | ConvertTo-Json -Compress";
const TABLE_QUERY = `${QUERY} ${SELECTION}`;

const DMTF = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})\.(\d{6})([+-])(\d{3})$/;
const DOTNET_DATE = /^\/Date\((-?\d+)(?:[+-]\d{4})?\)\/$/;
const ISO = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?$/;

function powerShellFailure(error: ExecFileException, stderr: string): string {
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return `PowerShell output exceeded ${QUERY_MAX_BYTES} bytes`;
  }
  if (error.killed) {return `PowerShell timed out after ${WINDOWS_PROCESS_QUERY_TIMEOUT_MS}ms`;}
  if (typeof error.code === "number") {
    const excerpt = stderr.replaceAll(/\s+/g, " ").trim().slice(0, STDERR_EXCERPT_CHARS);
    return `PowerShell exited with code ${error.code}${excerpt === "" ? "" : `: ${excerpt}`}`;
  }
  return `PowerShell could not start: ${error.message}`;
}

function runPowerShell(script: string): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", script],
      {
        encoding: "utf8",
        timeout: WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
        maxBuffer: QUERY_MAX_BYTES,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (error === null) {resolve(stdout);}
        else {reject(new Error(powerShellFailure(error, stderr)));}
      }
    );
  });
}

// Normalize production timestamps before JSON serialization; retain the known string formats
// for readers supplying an older snapshot. An unrecognized shape is a failed probe, never a guess.
function parseCreationDate(value: unknown): number | undefined {
  if (typeof value !== "string") {return undefined;}
  const dmtf = DMTF.exec(value);
  if (dmtf) {
    const [, year, month, day, hour, minute, second, microsecond, sign, offset] = dmtf;
    const utc = Date.UTC(
      Number(year),
      Number(month) - 1,
      Number(day),
      Number(hour),
      Number(minute),
      Number(second),
      Math.floor(Number(microsecond) / 1000)
    );
    const shift = Number(offset) * 60_000 * (sign === "-" ? -1 : 1);
    return Number.isFinite(utc) ? utc - shift : undefined;
  }
  const epoch = DOTNET_DATE.exec(value);
  if (epoch) {return Number(epoch[1]);}
  if (!ISO.test(value)) {return undefined;}
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readPid(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function readEntry(row: unknown): ProcessEntry | undefined {
  if (typeof row !== "object" || row === null) {return undefined;}
  const record = row as Record<string, unknown>;
  const pid = readPid(record["ProcessId"]);
  const parentPid = readPid(record["ParentProcessId"]);
  if (pid === undefined || parentPid === undefined) {return undefined;}
  const created = record["CreationDate"];
  if (created === null || created === undefined) {return { pid, parentPid, creationDate: undefined };}
  const creationDate = parseCreationDate(created);
  return creationDate === undefined ? undefined : { pid, parentPid, creationDate };
}

const UNREADABLE_ROWS = "PowerShell output could not be read as process rows";

function parseProcessRows(output: string): readonly ProcessEntry[] {
  const text = output.trim();
  // An answer with no rows: what that means is the caller's to decide.
  if (text === "" || text === "null") {return [];}
  let parsed: unknown;
  try {parsed = JSON.parse(text);} catch {throw new Error(UNREADABLE_ROWS);}
  if (parsed === null) {return [];}
  const entries: ProcessEntry[] = [];
  for (const row of Array.isArray(parsed) ? parsed : [parsed]) {
    const entry = readEntry(row);
    if (entry === undefined) {throw new Error(UNREADABLE_ROWS);}
    entries.push(entry);
  }
  return entries;
}

/** The live Windows process table. Rejects with the reason it could not be read or understood. */
export async function readProcessTable(
  read: ProcessTableReader = runPowerShell
): Promise<readonly ProcessEntry[]> {
  const rows = parseProcessRows(await read(TABLE_QUERY));
  // A live table always lists System and Idle. PowerShell exits 0 with empty output when the CIM
  // query itself fails, so no rows is a failed probe, never an empty machine.
  if (rows.length === 0) {throw new Error("PowerShell returned no process rows");}
  return rows;
}

/** The identity of one live process, or undefined when it already exited. Rejects when unreadable. */
export async function readProcessIdentity(
  pid: number,
  read: ProcessTableReader = runPowerShell
): Promise<ProcessIdentity | undefined> {
  const rows = parseProcessRows(await read(`${QUERY} -Filter "ProcessId=${pid}" ${SELECTION}`));
  const creationDate = rows.find((entry) => entry.pid === pid)?.creationDate;
  return creationDate === undefined ? undefined : { pid, creationDate };
}

/** True when a table row cannot be told apart from the recorded member. */
function isMember(row: ProcessEntry, member: ProcessMember): boolean {
  return row.creationDate === undefined ||
    member.creationDate === undefined ||
    row.creationDate === member.creationDate;
}

function byPid(snapshot: readonly ProcessEntry[]): Map<number, ProcessEntry> {
  return new Map(snapshot.map((entry) => [entry.pid, entry]));
}

/**
 * Every member of the trees rooted at `roots`, as `snapshot` shows them, the roots included whether
 * or not the snapshot still lists them. A process joins only when its parent chain reaches a root
 * whose row still matches the recorded identity and no link started before its parent, so a reused
 * pid never drags a stranger's subtree in. A row with no creation instant joins on pid alone and
 * keeps its own subtree, which over-includes rather than losing a branch.
 */
export function treeMembers(
  snapshot: readonly ProcessEntry[],
  roots: readonly ProcessMember[]
): readonly ProcessMember[] {
  const rows = byPid(snapshot);
  const children = new Map<number, ProcessEntry[]>();
  for (const entry of snapshot) {
    if (entry.pid === entry.parentPid) {continue;}
    const siblings = children.get(entry.parentPid);
    if (siblings === undefined) {children.set(entry.parentPid, [entry]);}
    else {siblings.push(entry);}
  }
  const members = [...roots];
  const seen = new Set(members.map((member) => member.pid));
  // The walk visits the members it appends, which is the breadth-first descent through the tree.
  for (const parent of members) {
    const row = rows.get(parent.pid);
    if (row === undefined || !isMember(row, parent)) {continue;}
    for (const child of children.get(parent.pid) ?? []) {
      const startedBefore = child.creationDate !== undefined &&
        parent.creationDate !== undefined &&
        child.creationDate < parent.creationDate;
      if (seen.has(child.pid) || startedBefore) {continue;}
      seen.add(child.pid);
      members.push({ pid: child.pid, creationDate: child.creationDate });
    }
  }
  return members;
}

/** The recorded members `snapshot` still shows running, matched by identity. */
export function survivingMembers(
  snapshot: readonly ProcessEntry[],
  members: readonly ProcessMember[]
): readonly ProcessMember[] {
  const rows = byPid(snapshot);
  return members.filter((member) => {
    const row = rows.get(member.pid);
    return row !== undefined && isMember(row, member);
  });
}
