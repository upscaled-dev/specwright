import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { StringDecoder } from "node:string_decoder";
import { BoundedOutputTail, EXECUTION_LIMITS, truncationNotice } from "./execution-limits";
import { errMsg } from "../utils/text";
import type { Logger } from "../utils/logger";
import { terminationLease, type TerminationLease } from "./execution-admission";

export type CommandOutputHandler = (stream: "stdout" | "stderr", text: string) => void;

/** Flush grace after an exit, and the wait between kill escalations on cancellation. */
export const TERMINATION_GRACE_MS = 2_000;

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
  /** The owned process tree could not be proven gone; callers must keep admission closed. */
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
      const child = spawn(invocation.executable, invocation.args, {
        cwd: workingDir,
        shell,
        // POSIX: detach so the child leads its own process group; killing that group on
        // cancellation reaches playwright + browsers. With shell:true, signalling only the
        // shell would orphan playwright. Windows uses awaited taskkill /T instead.
        ...(process.platform === "win32" ? {} : { detached: true }),
        env: { ...process.env, ...(extraEnv ?? {}) },
        stdio: ["pipe", "pipe", "pipe"],
      });
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
        termination = terminateOwnedTree(child, logger).then((outcome) => {
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
  return { failure, lease: terminationLease({ kind: "posix-group", pgid: pid, failure }) };
}

function terminateWindowsTree(pid: number): Promise<TerminationOutcome | undefined> {
  return new Promise((resolve) => {
    let finished = false;
    const complete = (failure?: string): void => {
      if (finished) {return;}
      finished = true;
      clearTimeout(timer);
      resolve(failure === undefined
        ? undefined
        : { failure, lease: terminationLease({ kind: "windows-tree", pid, failure }) });
    };
    let killer: ChildProcess;
    try {
      killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch (error) {
      const failure = `Process-tree termination failed to start: ${errMsg(error)}.`;
      resolve({ failure, lease: terminationLease({ kind: "windows-tree", pid, failure }) });
      return;
    }
    const timer = setTimeout(() => {
      try {killer.kill("SIGKILL");} catch { /* the timeout failure is authoritative */ }
      complete(`Process-tree termination did not complete within ${TERMINATION_GRACE_MS}ms.`);
    }, TERMINATION_GRACE_MS);
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

/** Terminate and confirm the complete tree owned by the spawned shell. */
function terminateOwnedTree(child: ChildProcess, logger: Logger): Promise<TerminationOutcome | undefined> {
  if (child.pid === undefined) {return Promise.resolve(undefined);}
  return process.platform === "win32"
    ? terminateWindowsTree(child.pid)
    : terminatePosixTree(child.pid, logger);
}
