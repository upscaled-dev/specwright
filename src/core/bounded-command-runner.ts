import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { BoundedOutputTail, EXECUTION_LIMITS, truncationNotice } from "./execution-limits";
import { errMsg, plural } from "../utils/text";
import type { Logger } from "../utils/logger";
import type { TerminationLease } from "./execution-admission";
import { playwrightCliInvocation, stopPlaywrightCli, PLAYWRIGHT_STOP_GRACE_MS } from "./playwright-cli-cancellation";
import {
  readProcessIdentity,
  readProcessTable,
  survivingMembers,
  treeMembers,
  WINDOWS_PROCESS_QUERY_TIMEOUT_MS,
  type ProcessEntry,
  type ProcessIdentity,
  type ProcessMember,
} from "./windows-process-tree";

export type CommandOutputHandler = (stream: "stdout" | "stderr", text: string) => void;

/** Flush grace after an exit, and the wait between kill escalations on cancellation. */
export const TERMINATION_GRACE_MS = 2_000;

export const WINDOWS_TASKKILL_TIMEOUT_MS = 10_000;
// A pending identity, four inventories, two kill attempts and two settle windows must fit.
// A kill started at the deadline keeps its own timeout on top of the confirmation budget.
export const WINDOWS_TERMINATION_BUDGET_MS =
  5 * WINDOWS_PROCESS_QUERY_TIMEOUT_MS +
  2 * WINDOWS_TASKKILL_TIMEOUT_MS +
  2 * TERMINATION_GRACE_MS;
/** The longest the Windows ladder can run: its confirmation budget plus that in-flight kill. */
export const WINDOWS_TERMINATION_WORST_CASE_MS =
  PLAYWRIGHT_STOP_GRACE_MS + WINDOWS_TERMINATION_BUDGET_MS + WINDOWS_TASKKILL_TIMEOUT_MS;
// How many of them a failure message names before it counts the rest.
const LISTED_MEMBERS = 20;

// Keyed by the handler function itself, so a run's owner is found from the handler alone. Every
// layer between the owner and runBoundedCommand must pass that exact function through: wrapping it
// (even in a pass-through arrow) loses the key and each command starts its own unbounded tail.
const captures = new WeakMap<CommandOutputHandler, BoundedCommandOutput>();

interface OutputCheckpoint {
  readonly stdout: number;
  readonly stderr: number;
}

/** One run-wide owner for streamed output tails, reusable across sequential commands. */
export class BoundedCommandOutput {
  private readonly stdout = new BoundedOutputTail(EXECUTION_LIMITS.outputTailBytesPerStream);
  private readonly stderr = new BoundedOutputTail(EXECUTION_LIMITS.outputTailBytesPerStream);
  private readonly totalBytes = { stdout: 0, stderr: 0 };

  public readonly onOutput: CommandOutputHandler;

  constructor(publishOutput: CommandOutputHandler) {
    this.onOutput = (stream, text) => {
      if (text === "") {return;}
      this.totalBytes[stream] += Buffer.byteLength(text);
      (stream === "stdout" ? this.stdout : this.stderr).append(text);
      try {publishOutput(stream, text);} catch { /* output consumers cannot affect execution */ }
    };
    captures.set(this.onOutput, this);
  }

  public format(): string {
    const output = this.formatStream("stdout");
    const error = this.formatStream("stderr");
    if (output === "") {return error;}
    if (error === "") {return output;}
    return `${output}${output.endsWith("\n") ? "" : "\n"}${error}`;
  }

  public formatStream(stream: "stdout" | "stderr"): string {
    return this.tail(stream).format(stream);
  }

  /** What each stream discarded, so the run's owner can report the loss on the live stream too. */
  public truncationNotices(): Array<{ stream: "stdout" | "stderr"; text: string }> {
    return (["stdout", "stderr"] as const).flatMap((stream) => {
      const text = this.tail(stream).truncationNotice(stream);
      return text === undefined ? [] : [{ stream, text }];
    });
  }

  private tail(stream: "stdout" | "stderr"): BoundedOutputTail {
    return stream === "stdout" ? this.stdout : this.stderr;
  }

  public checkpoint(): OutputCheckpoint {
    return { ...this.totalBytes };
  }

  /** Read one command's diagnostic tail from the shared run-wide retention. */
  public formatSince(
    stream: "stdout" | "stderr",
    checkpoint: OutputCheckpoint
  ): string {
    const bytes = this.totalBytes[stream] - checkpoint[stream];
    if (bytes === 0) {return "";}
    const retained = Buffer.from(this.tail(stream).retained());
    const retainedBytes = Math.min(bytes, EXECUTION_LIMITS.outputTailBytesPerStream);
    const tail = retained
      .subarray(Math.max(0, retained.length - retainedBytes))
      .toString("utf8")
      .replace(/^�+/u, "");
    if (bytes <= EXECUTION_LIMITS.outputTailBytesPerStream) {return tail;}
    return `${truncationNotice(stream, retainedBytes, bytes - retainedBytes)}\n${tail}`;
  }
}

export interface BoundedCommandResult {
  readonly success: boolean;
  readonly output: string;
  readonly error: string;
  readonly returnCode: number;
  readonly outputStreamed?: boolean;
  /** A recorded process outlived termination. Set only together with terminationLease. */
  readonly terminationFailure?: string | undefined;
  readonly terminationLease?: TerminationLease | undefined;
}

export interface BoundedCommandOptions {
  readonly command: string;
  readonly workingDir: string;
  readonly extraEnv?: NodeJS.ProcessEnv | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onOutput?: CommandOutputHandler | undefined;
  readonly logger: Logger;
  /** Explicit compatibility escape hatch for the trusted pre-run hook only. */
  readonly shell?: boolean | undefined;
}

export interface ExecutableCommand {
  readonly executable: string;
  readonly args: readonly string[];
}

function executableName(executable: string): string {
  return path.basename(executable).replace(/\.(?:cmd|exe)$/i, "").toLowerCase();
}

function packageBin(invocation: ExecutableCommand): { name: string; args: string[] } | undefined {
  const runner = executableName(invocation.executable);
  const args = [...invocation.args];
  if (runner === "npx") {
    const name = args.find((arg) => !arg.startsWith("-"));
    if (!name) {return undefined;}
    return { name, args: args.slice(args.indexOf(name) + 1) };
  }
  if (runner === "pnpm" && args[0] === "exec" && args[1]) {
    return { name: args[1], args: args.slice(2) };
  }
  if (runner === "npm" && args[0] === "exec") {
    const separator = args.indexOf("--");
    const index = separator >= 0 ? separator + 1 : 1;
    if (args[index]) {return { name: args[index], args: args.slice(index + 1) };}
  }
  if (runner === "yarn") {
    const first = args.findIndex((arg) => !arg.startsWith("-"));
    const index = args[first] === "run" ? first + 1 : first;
    if (index >= 0 && args[index]) {return { name: args[index], args: args.slice(index + 1) };}
  }
  return undefined;
}

function windowsShimTarget(shim: string, binDir: string): string | undefined {
  let body: string;
  try {body = fs.readFileSync(shim, "utf8");} catch {return undefined;}
  const match = /%(?:dp0%|~dp0)[\\/]([^"\r\n]+?\.(?:cjs|mjs|js))(?=["\s]|$)/i.exec(body);
  const relative = match?.[1];
  if (!relative || path.win32.isAbsolute(relative) || path.posix.isAbsolute(relative)) {
    return undefined;
  }
  return path.resolve(binDir, relative.replaceAll("\\", path.sep));
}

function localBinTarget(
  workingDir: string,
  name: string,
  platform: NodeJS.Platform
): string | undefined {
  let directory = path.resolve(workingDir);
  for (;;) {
    const binDir = path.join(directory, "node_modules", ".bin");
    if (platform === "win32") {
      const target = windowsShimTarget(path.join(binDir, `${name}.cmd`), binDir);
      if (target && fs.existsSync(target)) {return target;}
    } else {
      try {
        return fs.realpathSync(path.join(binDir, name));
      } catch { /* try the parent package */ }
    }
    const parent = path.dirname(directory);
    if (parent === directory) {return undefined;}
    directory = parent;
  }
}

/** Resolve package runners to an installed project bin, never a package-manager subprocess. */
export function resolveExecutableCommand(
  command: string,
  workingDir: string,
  platform: NodeJS.Platform = process.platform
): ExecutableCommand {
  const parsed = parseExecutableCommand(command);
  const requested = packageBin(parsed);
  if (!requested) {
    if (platform === "win32" && /\.(?:cmd|bat)$/i.test(parsed.executable)) {
      throw new Error(`Windows command shims are not supported: ${parsed.executable}`);
    }
    return parsed;
  }
  const target = localBinTarget(workingDir, requested.name, platform);
  if (!target) {
    throw new Error(
      `The project executable "${requested.name}" is not installed under ${workingDir}. ` +
      "Install the project dependencies before running Specwright."
    );
  }
  // In a VS Code Extension Host process.execPath is Electron, not Node. Launching a CLI through
  // that runtime leaves process.versions.electron set, which makes CLIs such as bddgen parse the
  // script path as a user argument. POSIX package bins carry their own Node shebang; Windows needs
  // the same `node` executable that the configured package runner itself requires on PATH.
  return platform === "win32"
    ? { executable: "node", args: [target, ...requested.args] }
    : { executable: target, args: requested.args };
}

/** Parse a configured command line without invoking a shell or expanding its syntax. */
export function parseExecutableCommand(command: string): ExecutableCommand {
  const args: string[] = [];
  let token = "";
  let quote: "'" | '"' | undefined;
  let escaped = false;
  let started = false;
  const push = (): void => {
    if (!started) {return;}
    args.push(token);
    token = "";
    started = false;
  };
  const source = command.trim();
  for (let index = 0; index < source.length; index += 1) {
    const character = source.charAt(index);
    if (escaped) {
      token += character;
      escaped = false;
      started = true;
      continue;
    }
    if (character === "\\" && quote !== "'") {
      const next = source[index + 1];
      const escapable = quote === '"'
        ? next !== undefined && ['"', "\\", "$", "`"].includes(next)
        : next !== undefined && (/\s/u.test(next) || ['"', "'", "\\"].includes(next));
      if (escapable) {
        escaped = true;
        started = true;
        continue;
      }
      token += character;
      started = true;
      continue;
    }
    if (quote !== undefined) {
      if (character === quote) {quote = undefined;}
      else {token += character;}
      started = true;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      started = true;
      continue;
    }
    if (/\s/u.test(character)) {
      push();
      continue;
    }
    if ("&|;<>".includes(character)) {
      throw new Error(`Shell operator '${character}' is not supported in executable commands.`);
    }
    token += character;
    started = true;
  }
  if (escaped || quote !== undefined) {throw new Error("Command has an unfinished quote or escape.");}
  push();
  const [executable, ...parsedArgs] = args;
  if (!executable) {throw new Error("Command cannot be empty");}
  const safeArgs = /(^|[\\/])npx(?:\.cmd)?$/i.test(executable) && !parsedArgs.includes("--no-install")
    ? ["--no-install", ...parsedArgs]
    : parsedArgs;
  return { executable, args: safeArgs };
}

/** Spawn one command while streaming every chunk and retaining only bounded diagnostic tails. */
export function runBoundedCommand(options: BoundedCommandOptions): Promise<BoundedCommandResult> {
  const { command, workingDir, extraEnv, signal, onOutput, logger, shell = false } = options;
  return new Promise((resolve) => {
    if (!command || command.trim() === "") {
      resolve({ success: false, output: "", error: "Command cannot be empty", returnCode: 1 });
      return;
    }
    if (signal?.aborted) {
      resolve({ success: false, output: "", error: "Cancelled", returnCode: 130 });
      return;
    }

    try {
      const invocation = shell
        ? { executable: command, args: [] as string[] }
        : resolveExecutableCommand(command, workingDir);
      const requested = shell ? undefined : packageBin(parseExecutableCommand(command));
      const cooperative = signal !== undefined && requested?.name === "playwright" && requested.args[0] === "test"
        ? playwrightCliInvocation(
          process.platform === "win32" ? invocation.args[0] : invocation.executable,
          process.platform === "win32" ? invocation.args.slice(1) : invocation.args
        )
        : undefined;
      const launched = cooperative ?? invocation;
      const child = spawn(launched.executable, launched.args, {
        cwd: workingDir,
        shell,
        // POSIX: detach so the child leads its own process group; killing that group on
        // cancellation reaches playwright + browsers. With shell:true, signalling only the
        // shell would orphan playwright. Windows uses awaited taskkill /T instead.
        ...(process.platform === "win32" ? {} : { detached: true }),
        env: { ...process.env, ...(extraEnv ?? {}) },
        stdio: cooperative ? ["pipe", "pipe", "pipe", "ipc"] : ["pipe", "pipe", "pipe"],
      });
      // Windows terminates the tree only on cancellation, and only an identity captured while the
      // process is alive lets the later survivor probe tell this tree from a reused pid. The query
      // runs beside the command and is never awaited on the run path.
      const windowsIdentity = process.platform === "win32" &&
        signal !== undefined &&
        child.pid !== undefined
        ? readProcessIdentity(child.pid).then(
          (identity): RootCapture => (identity === undefined
            ? { reason: "the process exited or had no readable creation time when its identity was queried" }
            : { identity }),
          (error: unknown): RootCapture => ({ reason: errMsg(error) })
        )
        : Promise.resolve<RootCapture>({ reason: "no identity query ran for this command" });
      const capture = onOutput === undefined ? undefined : captures.get(onOutput);
      const checkpoint = capture?.checkpoint();
      const stdout = capture === undefined
        ? new BoundedOutputTail(EXECUTION_LIMITS.outputTailBytesPerStream)
        : undefined;
      const stderr = capture === undefined
        ? new BoundedOutputTail(EXECUTION_LIMITS.outputTailBytesPerStream)
        : undefined;
      const stdoutDecoder = new StringDecoder("utf8");
      const stderrDecoder = new StringDecoder("utf8");
      let outputDelivered = false;
      let settled = false;
      let cancelled = false;
      let exitCode: number | null = null;
      let termination: Promise<void> | undefined;

      const emit = (stream: "stdout" | "stderr", text: string): void => {
        outputDelivered = publish(onOutput, stream, text) || outputDelivered;
      };
      const finishOutput = (): void => {
        child.stdout?.removeListener("data", onStdout);
        child.stderr?.removeListener("data", onStderr);
        emit("stdout", stdoutDecoder.end());
        emit("stderr", stderrDecoder.end());
        if (capture === undefined) {
          const stdoutNotice = stdout?.truncationNotice("stdout");
          const stderrNotice = stderr?.truncationNotice("stderr");
          if (stdoutNotice !== undefined) {emit("stdout", `\n${stdoutNotice}\n`);}
          if (stderrNotice !== undefined) {emit("stderr", `\n${stderrNotice}\n`);}
        }
        child.stdout?.destroy();
        child.stderr?.destroy();
      };
      const onStdout = (data: Buffer): void => {
        stdout?.append(data);
        emit("stdout", stdoutDecoder.write(data));
      };
      const onStderr = (data: Buffer): void => {
        stderr?.append(data);
        emit("stderr", stderrDecoder.write(data));
      };

      const result = (
        success: boolean,
        error: string,
        returnCode: number,
        termination?: TerminationOutcome
      ): BoundedCommandResult => ({
        success,
        output: capture !== undefined && checkpoint !== undefined
          ? capture.formatSince("stdout", checkpoint)
          : stdout?.format("stdout") ?? "",
        error,
        returnCode,
        ...(outputDelivered ? { outputStreamed: true } : {}),
        ...(termination ? {
          terminationFailure: termination.failure,
          terminationLease: termination.lease,
        } : {}),
      });
      const settle = (code: number | null, termination?: TerminationOutcome): void => {
        if (settled) {return;}
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        finishOutput();
        if (termination !== undefined) {
          resolve(result(false, termination.failure, 1, termination));
          return;
        }
        if (cancelled) {
          resolve(result(false, "Cancelled", 130));
          return;
        }
        const returnCode = code ?? 1;
        resolve(result(
          returnCode === 0,
          capture !== undefined && checkpoint !== undefined
            ? capture.formatSince("stderr", checkpoint)
            : stderr?.format("stderr") ?? "",
          returnCode
        ));
      };
      const finishAfterTermination = (): void => {
        if (termination !== undefined) {return;}
        termination = (cancelled && cooperative !== undefined
          ? stopPlaywrightCli(child).then((stopped) => (stopped
            ? undefined
            : terminateOwnedTree(child, logger, windowsIdentity)))
          : terminateOwnedTree(child, logger, windowsIdentity))
          // Bookkeeping that throws proves nothing about the tree, and a run left unsettled would
          // hold the execution slot for the rest of the session.
          .catch((error: unknown) => releaseUnproven(
            logger,
            `Process termination could not be confirmed: ${errMsg(error)}.`
          ))
          .then((outcome) => {
            if (outcome !== undefined) {
              logger.error(outcome.failure, { command, workingDir });
            }
            settle(exitCode, outcome);
          });
      };
      const onAbort = (): void => {
        cancelled = true;
        finishAfterTermination();
      };

      signal?.addEventListener("abort", onAbort);
      child.stdout?.on("data", onStdout);
      child.stderr?.on("data", onStderr);
      child.on("close", (code: number | null) => {
        exitCode = code;
        if (cancelled || process.platform !== "win32") {
          finishAfterTermination();
        } else {
          settle(code);
        }
      });
      child.on("exit", (code: number | null) => {
        exitCode = code;
        if (cancelled || process.platform !== "win32") {
          finishAfterTermination();
          return;
        }
        // On Windows `close` normally follows once inherited output handles drain. Keep the
        // existing flush bound for a non-cancelled command; cancellation takes the awaited
        // taskkill path above and cannot settle here.
        const timer = setTimeout(() => {settle(code);}, TERMINATION_GRACE_MS);
        timer.unref?.();
      });
      child.on("error", (error: Error) => {
        logger.error(`Command execution error: ${error.message}`, { command, workingDir });
        if (settled) {return;}
        if (cancelled) {
          finishAfterTermination();
          return;
        }
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        finishOutput();
        resolve(result(false, error.message, 1));
      });
      if (signal?.aborted) {onAbort();}
    } catch (error) {
      const message = errMsg(error);
      logger.error(`Failed to execute command with output: ${message}`, { command, workingDir });
      resolve({ success: false, output: "", error: message, returnCode: 1 });
    }
  });
}

function publish(
  onOutput: CommandOutputHandler | undefined,
  stream: "stdout" | "stderr",
  text: string
): boolean {
  if (text === "" || onOutput === undefined) {return false;}
  try {
    onOutput(stream, text);
    return true;
  } catch {
    return false;
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}

function processGroupExists(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

function signalProcessGroup(
  pid: number,
  signal: "SIGTERM" | "SIGKILL",
  logger: Logger
): void {
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
      logger.warn(`Failed to signal process group with ${signal}: ${errMsg(error)}`);
    }
  }
}

interface TerminationOutcome {
  readonly failure: string;
  readonly lease: TerminationLease;
}

async function terminatePosixTree(pid: number, logger: Logger): Promise<TerminationOutcome | undefined> {
  if (!processGroupExists(pid)) {return undefined;}
  signalProcessGroup(pid, "SIGTERM", logger);
  await delay(TERMINATION_GRACE_MS);
  if (!processGroupExists(pid)) {return undefined;}
  signalProcessGroup(pid, "SIGKILL", logger);
  await delay(TERMINATION_GRACE_MS);
  if (!processGroupExists(pid)) {return undefined;}
  const failure = `Process-group termination could not be confirmed within ${2 * TERMINATION_GRACE_MS}ms after SIGTERM and SIGKILL.`;
  return { failure, lease: { kind: "posix-group", pgid: pid, failure } };
}

/** Proof or release: an unproven termination frees the slot and logs why. */
function releaseUnproven(logger: Logger, reason: string): undefined {
  const monitor = process.platform === "win32" ? "Task Manager" : "your system's process monitor";
  logger.warn(`${reason} Cancellation was released without that proof. If Playwright or browser ` +
    `processes remain, end them in ${monitor}.`);
  return undefined;
}

/** taskkill's own verdict on one attempt: undefined when it reported the tree terminated. */
function runTaskkill(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    const diagnostics = new BoundedOutputTail(4096);
    let finished = false;
    const complete = (failure?: string): void => {
      if (finished) {return;}
      finished = true;
      clearTimeout(timer);
      const detail = diagnostics.retained().replaceAll(/\s+/g, " ").trim().slice(0, 200);
      resolve(failure === undefined || detail === "" ? failure : `${failure} ${detail}`);
    };
    let killer: ChildProcess;
    try {
      killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (error) {
      resolve(`Process-tree termination failed to start: ${errMsg(error)}.`);
      return;
    }
    killer.stdout?.on("data", (data: Buffer) => diagnostics.append(data));
    killer.stderr?.on("data", (data: Buffer) => diagnostics.append(data));
    const timer = setTimeout(() => {
      try {killer.kill("SIGKILL");} catch { /* the timeout failure is authoritative */ }
      complete(`Process-tree termination did not complete within ${WINDOWS_TASKKILL_TIMEOUT_MS}ms.`);
    }, WINDOWS_TASKKILL_TIMEOUT_MS);
    timer.unref?.();
    killer.once("error", (error) => {
      complete(`Process-tree termination failed: ${errMsg(error)}.`);
    });
    killer.once("close", (code) => {
      complete(code === 0
        ? undefined
        : `Process-tree termination failed with taskkill exit code ${code ?? "unknown"}.`);
    });
  });
}

function withDeadline<T>(work: Promise<T>, deadline: number): Promise<T | undefined> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {return Promise.resolve(undefined);}
  let timer: ReturnType<typeof setTimeout>;
  const timeout = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), remaining);
    timer.unref?.();
  });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

const WINDOW_ELAPSED = "Process-tree termination could not be confirmed: the " +
  `${WINDOWS_TERMINATION_BUDGET_MS}ms confirmation window elapsed.`;
/** The spawned root pinned to its creation instant, or why it could not be. */
type RootCapture = { readonly identity: ProcessIdentity } | { readonly reason: string };

function unpinned(reason: string): string {
  return `Process-tree termination could not be confirmed: the process identity is unknown (${reason}).`;
}

/** A table to confirm against, or the reason this attempt has none. Read at the moment it fails. */
type TableProbe =
  | { readonly kind: "table"; readonly rows: readonly ProcessEntry[] }
  | { readonly kind: "unconfirmed"; readonly failure: string };

async function probeTable(deadline: number): Promise<TableProbe> {
  const remaining = deadline - Date.now();
  if (remaining <= 0) {return { kind: "unconfirmed", failure: WINDOW_ELAPSED };}
  const probe = await withDeadline(readProcessTable().then(
    (rows): TableProbe => ({ kind: "table", rows }),
    (error: unknown): TableProbe => ({
      kind: "unconfirmed",
      failure: "Process-tree termination could not be confirmed: the Windows process table could " +
        `not be read (${errMsg(error)}).`,
    })
  ), deadline);
  return probe ?? { kind: "unconfirmed", failure: WINDOW_ELAPSED };
}

interface KillAttempt {
  readonly killed: string | undefined;
  readonly probe: TableProbe;
}

function rootMatches(snapshot: readonly ProcessEntry[], root: ProcessIdentity): boolean {
  return snapshot.some((row) => row.pid === root.pid && row.creationDate === root.creationDate);
}

function stopOwnedRoot(child: ChildProcess, logger: Logger): void {
  try {child.kill("SIGKILL");}
  catch (error) {logger.warn(`The owned process could not be stopped: ${errMsg(error)}.`);}
}

/** Kill the tree, let it settle the way the POSIX escalation does, then re-read the table. */
async function killAndProbe(pid: number, deadline: number): Promise<KillAttempt> {
  const killed = await runTaskkill(pid);
  await withDeadline(delay(TERMINATION_GRACE_MS), deadline);
  return { killed, probe: await probeTable(deadline) };
}

function listedPids(members: readonly ProcessMember[]): string {
  const head = members.slice(0, LISTED_MEMBERS).map((member) => member.pid).join(", ");
  const rest = members.length - Math.min(members.length, LISTED_MEMBERS);
  return rest === 0 ? head : `${head}, and ${rest} more`;
}

function survivorFailure(survivors: readonly ProcessMember[]): string {
  return `Process-tree termination left ${survivors.length} ` +
    `${plural(survivors.length, "process", "processes")} running: ${listedPids(survivors)}.`;
}

function unprovenFailure(reason: string, members: readonly ProcessMember[]): string {
  return `${reason} ${members.length} recorded ` +
    `${plural(members.length, "process", "processes")} remain unproven: ${listedPids(members)}.`;
}

/**
 * Membership is fixed from a snapshot taken before the kill, because a killed tree can no longer be
 * walked; afterwards each recorded identity is checked for itself. Only a recorded member that a
 * live table still lists after cleanup blocks the run. An unreadable first confirmation releases
 * without proof; once a survivor is confirmed, later unreadable probes retain its identity.
 * Membership is therefore only as complete as that snapshot: a process whose own parent had
 * already exited is not enrolled, because nothing links it to this run any more. Leaving that tail
 * out is the price of never enrolling a stranger's process.
 */
async function terminateWindowsTree(
  child: ChildProcess,
  identity: Promise<RootCapture>,
  logger: Logger
): Promise<TerminationOutcome | undefined> {
  const pid = child.pid;
  if (pid === undefined) {return undefined;}
  const deadline = Date.now() + WINDOWS_TERMINATION_BUDGET_MS;
  const capture = await withDeadline(identity, deadline) ??
    { reason: "the identity query did not answer within the confirmation window" };
  // Without a captured identity nothing can tell this tree from a reused pid afterwards.
  if (!("identity" in capture)) {
    stopOwnedRoot(child, logger);
    return releaseUnproven(logger, unpinned(capture.reason));
  }
  const root = capture.identity;
  const before = await probeTable(deadline);
  if (before.kind === "unconfirmed") {
    stopOwnedRoot(child, logger);
    return releaseUnproven(logger, before.failure);
  }
  if (!rootMatches(before.rows, root)) {
    stopOwnedRoot(child, logger);
    return releaseUnproven(logger, "The owned root no longer has its captured identity in the Windows process table.");
  }
  let members = treeMembers(before.rows, [root]);
  const first = await killAndProbe(pid, deadline);
  if (first.probe.kind === "unconfirmed") {
    return releaseUnproven(logger, detailed(unprovenFailure(first.probe.failure, members), first.killed));
  }
  const remaining = survivingMembers(first.probe.rows, members);
  // A confirmed-empty tree is released whatever taskkill reported: exit code 128 means it found
  // nothing left to kill, which is exactly the state the probe just proved.
  if (remaining.length === 0) {return undefined;}
  members = treeMembers(first.probe.rows, remaining);
  // A fresh retry inventory prevents taskkill from targeting a reused numeric root PID.
  const retry = await probeTable(deadline);
  if (retry.kind === "unconfirmed") {
    const failure = unprovenFailure(retry.failure, members);
    return { failure, lease: { kind: "windows-tree", pid, root, survivors: members, failure } };
  }
  const retrySurvivors = survivingMembers(retry.rows, members);
  if (retrySurvivors.length === 0) {return undefined;}
  members = treeMembers(retry.rows, retrySurvivors);
  if (!rootMatches(retry.rows, root)) {
    const failure = survivorFailure(members);
    return { failure, lease: { kind: "windows-tree", pid, root, survivors: members, failure } };
  }
  const second = await killAndProbe(pid, deadline);
  if (second.probe.kind === "unconfirmed") {
    const failure = detailed(unprovenFailure(second.probe.failure, members), second.killed);
    return { failure, lease: { kind: "windows-tree", pid, root, survivors: members, failure } };
  }
  const survivors = survivingMembers(second.probe.rows, members);
  if (survivors.length === 0) {return undefined;}
  const failure = detailed(survivorFailure(survivors), second.killed);
  return { failure, lease: { kind: "windows-tree", pid, root, survivors, failure } };
}

function detailed(failure: string, killed: string | undefined): string {
  return killed === undefined ? failure : `${failure} ${killed}`;
}

/** Terminate and confirm the complete tree owned by the spawned shell. */
function terminateOwnedTree(
  child: ChildProcess,
  logger: Logger,
  identity: Promise<RootCapture>
): Promise<TerminationOutcome | undefined> {
  if (child.pid === undefined) {return Promise.resolve(undefined);}
  return process.platform === "win32"
    ? terminateWindowsTree(child, identity, logger)
    : terminatePosixTree(child.pid, logger);
}
