import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const BOOT_ID_TIMEOUT_MS = 1_500;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const WINDOWS_RECORD_MAX = "18446744073709551615";
type BootIdCommand = (command: string, args: readonly string[]) => string | undefined;
type BootIdFileReader = (filePath: string) => string | undefined;

function commandOutput(command: string, args: readonly string[]): string | undefined {
  try {
    const value = execFileSync(command, args, { encoding: "utf8", timeout: BOOT_ID_TIMEOUT_MS,
      windowsHide: true, stdio: ["ignore", "pipe", "ignore"], maxBuffer: 4_096 }).trim();
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

/** True only for canonical boot identities, never uptime or wall-clock estimates. */
export function isCanonicalBootId(value: unknown): value is string {
  if (typeof value !== "string") {return false;}
  const [platform, identity, ...rest] = value.split(":");
  if (identity === undefined || rest.length > 0) {return false;}
  if (platform === "linux" || platform === "darwin") {return UUID.test(identity);}
  return platform === "win32" && /^[1-9]\d*$/.test(identity) &&
    (identity.length < WINDOWS_RECORD_MAX.length ||
      (identity.length === WINDOWS_RECORD_MAX.length && identity <= WINDOWS_RECORD_MAX));
}

/** Resolve the OS boot session without comparing wall-clock samples. */
export function resolveSystemBootId(platform: NodeJS.Platform,
  readFile: BootIdFileReader = fileContent, runCommand: BootIdCommand = commandOutput): string | undefined {
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
    const recordId = windowsBootEventId(runCommand("wevtutil.exe", ["qe", "System",
      "/q:*[System[Provider[@Name='Microsoft-Windows-Kernel-General'] and EventID=12]]",
      "/rd:true", "/f:xml", "/c:1"]));
    const candidate = recordId === undefined ? undefined : `win32:${recordId}`;
    return isCanonicalBootId(candidate) ? candidate : undefined;
  }
  return undefined;
}

let cachedBootId: string | undefined;
let bootIdRead = false;

export function systemBootId(): string | undefined {
  if (!bootIdRead) {
    bootIdRead = true;
    cachedBootId = resolveSystemBootId(process.platform);
  }
  return cachedBootId;
}
