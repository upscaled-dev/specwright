import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { BoundedOutputTail, EXECUTION_LIMITS, truncationNotice } from "./execution-limits";
import { errMsg } from "../utils/text";
import type { Logger } from "../utils/logger";

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
}

export interface BoundedCommandOptions {
  readonly command: string;
  readonly workingDir: string;
  readonly extraEnv?: NodeJS.ProcessEnv | undefined;
  readonly signal?: AbortSignal | undefined;
  readonly onOutput?: CommandOutputHandler | undefined;
  readonly logger: Logger;
}

/** Spawn one command while streaming every chunk and retaining only bounded diagnostic tails. */
export function runBoundedCommand(options: BoundedCommandOptions): Promise<BoundedCommandResult> {
  const { command, workingDir, extraEnv, signal, onOutput, logger } = options;
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
      const child = spawn(command, {
        cwd: workingDir,
        shell: true,
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
        terminationFailure?: string
      ): BoundedCommandResult => ({
        success,
        output: capture !== undefined && checkpoint !== undefined
          ? capture.formatSince("stdout", checkpoint)
          : stdout?.format("stdout") ?? "",
        error,
        returnCode,
        ...(outputDelivered ? { outputStreamed: true } : {}),
        ...(terminationFailure ? { terminationFailure } : {}),
      });
      const settle = (code: number | null, terminationFailure?: string): void => {
        if (settled) {return;}
        settled = true;
        signal?.removeEventListener("abort", onAbort);
        finishOutput();
        if (terminationFailure !== undefined) {
          resolve(result(false, terminationFailure, 1, terminationFailure));
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
        termination = terminateOwnedTree(child, logger).then((failure) => {
          if (failure !== undefined) {
            logger.error(failure, { command, workingDir });
          }
          settle(exitCode, failure);
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

async function terminatePosixTree(pid: number, logger: Logger): Promise<string | undefined> {
  if (!processGroupExists(pid)) {return undefined;}
  signalProcessGroup(pid, "SIGTERM", logger);
  await delay(TERMINATION_GRACE_MS);
  if (!processGroupExists(pid)) {return undefined;}
  signalProcessGroup(pid, "SIGKILL", logger);
  await delay(TERMINATION_GRACE_MS);
  return processGroupExists(pid)
    ? `Process-group termination could not be confirmed within ${2 * TERMINATION_GRACE_MS}ms after SIGTERM and SIGKILL.`
    : undefined;
}

function terminateWindowsTree(pid: number): Promise<string | undefined> {
  return new Promise((resolve) => {
    let finished = false;
    const complete = (failure?: string): void => {
      if (finished) {return;}
      finished = true;
      clearTimeout(timer);
      resolve(failure);
    };
    let killer: ChildProcess;
    try {
      killer = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
    } catch (error) {
      resolve(`Process-tree termination failed to start: ${errMsg(error)}.`);
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
function terminateOwnedTree(child: ChildProcess, logger: Logger): Promise<string | undefined> {
  if (child.pid === undefined) {return Promise.resolve(undefined);}
  return process.platform === "win32"
    ? terminateWindowsTree(child.pid)
    : terminatePosixTree(child.pid, logger);
}
